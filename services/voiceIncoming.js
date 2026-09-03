import { createReadStream } from "fs";
import { unlink, writeFile } from "fs/promises";
import os from "os";
import { join } from "path";
import { getTranscriptionClient } from "./aiService.js";
import { log } from "./logger.js";
import { resolveIncomingIdentity } from "./phoneService.js";
import { extractIncomingText } from "./incomingExtract.js";
import { downloadWhatsAppFileUrl } from "./whatsappService.js";

const VOICE_TRANSCRIBE_MS = Number(process.env.VOICE_TRANSCRIBE_MS || 20000);

// Green API uses audioMessage for WhatsApp PTT / voice notes.
const VOICE_TYPES = new Set(["audioMessage", "audio", "voice", "ptt"]);

export const SAFE_VOICE_ERROR_REPLY =
  "Не получилось разобрать голосовое сообщение. Напишите, пожалуйста, текстом.";

const processedVoiceIds = new Map();

export function resetVoiceIncomingForTests() {
  processedVoiceIds.clear();
}

export function isVoiceMessageType(typeMessage, file = {}) {
  if (VOICE_TYPES.has(String(typeMessage || ""))) {
    return true;
  }
  const mime = String(file.mimeType || "").toLowerCase();
  const name = String(file.fileName || "").toLowerCase();
  return /audio\/(ogg|opus|mpeg|mp3|wav|aac|webm)/.test(mime) || /\.(ogg|opus|oga|mp3|wav)$/.test(name);
}

export function isVoiceIncoming(body = {}) {
  const typeMessage = body.messageData?.typeMessage || body.typeMessage;
  const file = body.messageData?.fileMessageData || {};
  return isVoiceMessageType(typeMessage, file);
}

export function incomingMessageIdOf(body = {}) {
  return String(body.idMessage || body.messageData?.idMessage || "").trim();
}

export function formatVoiceBatchText(transcript) {
  return `[Голосовое сообщение]: ${transcript}`;
}

export async function transcribeAudioFromUrl(fileUrl, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const write = deps.writeFile || writeFile;
  const createStream = deps.createReadStream || createReadStream;
  const remove = deps.unlink || unlink;
  const transcribeFile = deps.transcribeFile;

  const response = await fetchImpl(fileUrl, {
    signal: AbortSignal.timeout(VOICE_TRANSCRIBE_MS),
  });
  if (!response.ok) {
    throw new Error("VOICE_DOWNLOAD_FAILED");
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFilePath = join(os.tmpdir(), `voice-${Date.now()}.ogg`);
  await write(tempFilePath, buffer);

  try {
    if (transcribeFile) {
      return String((await transcribeFile(tempFilePath)) || "").trim();
    }
    const transcription = await getTranscriptionClient().audio.transcriptions.create({
      file: createStream(tempFilePath),
      model: "whisper-1",
    });
    return String(transcription.text || "").trim();
  } finally {
    await remove(tempFilePath).catch(() => {});
  }
}

export async function resolveVoiceFileUrl(body, deps = {}) {
  const file = body.messageData?.fileMessageData || {};
  const direct = String(file.downloadUrl || "").trim();
  if (direct) {
    return direct;
  }

  const identity = resolveIncomingIdentity(body);
  const chatId = identity.chatId || body.senderData?.chatId || body.chatId;
  const idMessage = incomingMessageIdOf(body);
  const download = deps.downloadWhatsAppFileUrl || downloadWhatsAppFileUrl;
  if (!chatId || !idMessage) {
    throw new Error("VOICE_SOURCE_MISSING");
  }
  return download(chatId, idMessage);
}

export async function extractVoiceForBatch(body, deps = {}) {
  const sourceMessageId = incomingMessageIdOf(body);
  if (sourceMessageId && processedVoiceIds.has(sourceMessageId)) {
    return processedVoiceIds.get(sourceMessageId);
  }

  try {
    const fileUrl = await resolveVoiceFileUrl(body, deps);
    const transcript = await transcribeAudioFromUrl(fileUrl, deps);
    if (!transcript) {
      const failed = {
        ok: false,
        fallbackReply: SAFE_VOICE_ERROR_REPLY,
        reason: "empty_transcript",
      };
      if (sourceMessageId) {
        processedVoiceIds.set(sourceMessageId, failed);
      }
      return failed;
    }

    const normalizedMessage = {
      type: "voice_transcript",
      text: transcript,
      sourceMessageId,
    };
    const result = {
      ok: true,
      normalizedMessage,
      batchText: formatVoiceBatchText(transcript),
    };
    if (sourceMessageId) {
      processedVoiceIds.set(sourceMessageId, result);
    }
    return result;
  } catch (error) {
    log("VOICE TRANSCRIBE ERROR", { reason: "voice_failed" });
    const failed = {
      ok: false,
      fallbackReply: SAFE_VOICE_ERROR_REPLY,
      reason: "voice_failed",
    };
    if (sourceMessageId) {
      processedVoiceIds.set(sourceMessageId, failed);
    }
    return failed;
  }
}

export async function ingestIncomingForBatch(body, deps = {}) {
  if (isVoiceIncoming(body)) {
    const voice = await extractVoiceForBatch(body, deps);
    if (!voice.ok) {
      return {
        ok: false,
        kind: "voice",
        fallbackReply: voice.fallbackReply,
        reason: voice.reason,
      };
    }
    return {
      ok: true,
      kind: "voice",
      batchText: voice.batchText,
      normalizedMessage: voice.normalizedMessage,
    };
  }

  const text = await extractIncomingText(body);
  return {
    ok: Boolean(text),
    kind: "text",
    batchText: text,
  };
}
