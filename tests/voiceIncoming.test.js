import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getClientReply, parseAiReply } from "../services/aiReplyParser.js";
import {
  processAssistantActions,
  resetAssistantActionKeys,
} from "../services/assistantActions.js";
import {
  SAFE_VOICE_ERROR_REPLY,
  extractVoiceForBatch,
  ingestIncomingForBatch,
  isVoiceIncoming,
  isVoiceMessageType,
  resetVoiceIncomingForTests,
} from "../services/voiceIncoming.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

beforeEach(() => {
  resetVoiceIncomingForTests();
  resetAssistantActionKeys();
});

function textBody(text, id = "txt-1") {
  return {
    idMessage: id,
    typeWebhook: "incomingMessageReceived",
    senderData: { chatId: "77011112233@c.us", sender: "77011112233@c.us" },
    messageData: {
      typeMessage: "textMessage",
      textMessageData: { textMessage: text },
    },
  };
}

function voiceBody({ id = "voice-1", downloadUrl = "", typeMessage = "audioMessage" } = {}) {
  return {
    idMessage: id,
    typeWebhook: "incomingMessageReceived",
    senderData: { chatId: "77011112233@c.us", sender: "77011112233@c.us" },
    messageData: {
      typeMessage,
      fileMessageData: {
        downloadUrl,
        mimeType: "audio/ogg; codecs=opus",
        fileName: "ptt.ogg",
      },
    },
  };
}

function createVoiceDeps({ transcript = "Нужен сайт для клиники", failDownload = false, failTranscribe = false } = {}) {
  const calls = { download: 0, transcribe: 0, fetch: 0 };
  return {
    calls,
    deps: {
      downloadWhatsAppFileUrl: async () => {
        calls.download += 1;
        if (failDownload) {
          throw new Error("Green API HTTP 500");
        }
        return "https://files.example/voice.ogg";
      },
      fetch: async () => {
        calls.fetch += 1;
        if (failDownload) {
          return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return {
          ok: true,
          arrayBuffer: async () => Buffer.from("ogg-bytes"),
        };
      },
      writeFile: async () => {},
      unlink: async () => {},
      createReadStream: () => ({}),
      transcribeFile: async () => {
        calls.transcribe += 1;
        if (failTranscribe) {
          throw new Error("whisper timeout token=sk-secret path=/tmp/voice.ogg");
        }
        return transcript;
      },
    },
  };
}

test("text messages continue to be processed", async () => {
  const batch = [];
  const incoming = await ingestIncomingForBatch(textBody("Здравствуйте, нужен сайт"));
  assert.equal(incoming.kind, "text");
  assert.equal(incoming.batchText, "Здравствуйте, нужен сайт");
  if (incoming.ok) {
    batch.push(incoming.batchText);
  }
  assert.deepEqual(batch, ["Здравствуйте, нужен сайт"]);
});

test("a voice message is detected as audio", () => {
  assert.equal(isVoiceMessageType("audioMessage"), true);
  assert.equal(isVoiceIncoming(voiceBody()), true);
  assert.equal(isVoiceIncoming(textBody("привет")), false);
});

test("media is downloaded once and transcription is called once", async () => {
  const { calls, deps } = createVoiceDeps();
  const incoming = await extractVoiceForBatch(voiceBody({ downloadUrl: "" }), deps);
  assert.equal(incoming.ok, true);
  assert.equal(calls.download, 1);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.transcribe, 1);
});

test("the transcript is passed to the AI batch", async () => {
  const { deps } = createVoiceDeps({ transcript: "Нужен лендинг" });
  const incoming = await ingestIncomingForBatch(voiceBody({ id: "voice-ai" }), deps);
  assert.equal(incoming.normalizedMessage.type, "voice_transcript");
  assert.equal(incoming.normalizedMessage.text, "Нужен лендинг");
  assert.equal(incoming.normalizedMessage.sourceMessageId, "voice-ai");
  assert.match(incoming.batchText, /Нужен лендинг/);
});

test("the transcript is present in current_message_batch", async () => {
  const current_message_batch = [];
  const { deps } = createVoiceDeps({ transcript: "Сколько стоит сайт?" });
  const incoming = await ingestIncomingForBatch(voiceBody({ id: "voice-batch" }), deps);
  current_message_batch.push(incoming.batchText);
  assert.equal(current_message_batch.length, 1);
  assert.match(current_message_batch[0], /Сколько стоит сайт/);
  assert.equal(current_message_batch.join("\n").includes("Сколько стоит сайт"), true);
});

test("the client receives only reply after a voice transcript", async () => {
  const parsed = parseAiReply({
    reply: "Для какого бизнеса нужен сайт?",
    lead_status: "warm",
    service: "site",
    handoff: false,
    brief_completed: false,
    manager_event: "none",
    send_asset: "none",
    summary: "Клиент прислал голосовое про сайт",
  });
  const clientMessages = [];
  await processAssistantActions(
    {
      parsedResponse: parsed,
      conversation: {
        leadId: "LEAD-V1",
        clientPhone: "77011112233",
        notificationEvents: [],
        handoff_already_created: false,
      },
      incomingMessage: { id: "voice-reply", text: "Нужен сайт для клиники" },
      contact: { phone: "77011112233", chatId: "77011112233@c.us" },
    },
    {
      sendWhatsAppMessage: async (_chatId, text) => {
        clientMessages.push(text);
      },
      sendManagerMessage: async () => {},
      sendWhatsAppLocalFile: async () => {},
      updateLead: async (_id, patch) => patch,
      markNotification: async () => ({}),
      hasNotification: () => false,
      canNotifySalesManager: () => ({ ok: true }),
      inspectPresentationKp: async () => ({ ok: true, path: "/tmp/x.pdf" }),
    },
  );
  assert.deepEqual(clientMessages, [getClientReply(parsed)]);
  assert.equal(clientMessages[0].includes("lead_status"), false);
});

test("two technical retries of the same voice message do not double-process", async () => {
  const { calls, deps } = createVoiceDeps();
  const body = voiceBody({ id: "voice-dup" });
  await extractVoiceForBatch(body, deps);
  await extractVoiceForBatch(body, deps);
  assert.equal(calls.download, 1);
  assert.equal(calls.transcribe, 1);
});

test("an audio download error is handled safely", async () => {
  const { deps } = createVoiceDeps({ failDownload: true });
  const incoming = await extractVoiceForBatch(voiceBody({ id: "voice-dl" }), deps);
  assert.equal(incoming.ok, false);
  assert.equal(incoming.fallbackReply, SAFE_VOICE_ERROR_REPLY);
  assert.equal(incoming.fallbackReply.includes("Green API"), false);
  assert.equal(incoming.fallbackReply.includes("HTTP"), false);
});

test("a transcription error is not shown to the client as technical text", async () => {
  const { deps } = createVoiceDeps({ failTranscribe: true });
  const incoming = await extractVoiceForBatch(voiceBody({ id: "voice-tr", downloadUrl: "https://files.example/a.ogg" }), deps);
  assert.equal(incoming.ok, false);
  assert.equal(incoming.fallbackReply, SAFE_VOICE_ERROR_REPLY);
  assert.equal(incoming.fallbackReply.includes("whisper"), false);
  assert.equal(incoming.fallbackReply.includes("token"), false);
  assert.equal(incoming.fallbackReply.includes("/tmp/"), false);
});

test("system prompt, knowledge base and JSON schema stay unchanged", () => {
  const prompt = readFileSync(join(root, "prompts/system_prompt.txt"), "utf8");
  const knowledge = readFileSync(join(root, "knowledge/creolab_knowledge_base.txt"), "utf8");
  const parser = readFileSync(join(root, "services/aiReplyParser.js"), "utf8");
  const voice = readFileSync(join(root, "services/voiceIncoming.js"), "utf8");
  assert.equal(voice.includes("system_prompt.txt"), false);
  assert.equal(voice.includes("creolab_knowledge_base.txt"), false);
  assert.equal(parser.includes("validateAiReplySchema"), true);
  assert.equal(prompt.length > 0, true);
  assert.equal(knowledge.length > 0, true);
});

test("manager applications and PDF handling still work", async () => {
  const managerMessages = [];
  const files = [];
  const conversation = {
    leadId: "LEAD-V2",
    clientPhone: "77011112233",
    service: "presentation",
    requestSummary: "Презентация",
    notificationEvents: [],
    handoff_already_created: false,
    presentation_kp_already_sent: false,
  };
  await processAssistantActions(
    {
      parsedResponse: parseAiReply({
        reply: "Прикрепляю коммерческое предложение с комплектацией всех пакетов.",
        lead_status: "warm",
        service: "presentation",
        handoff: true,
        brief_completed: false,
        manager_event: "none",
        send_asset: "presentation_kp",
        summary: "Клиенту нужна презентация",
      }),
      conversation,
      incomingMessage: { id: "voice-kp", text: "Пришлите КП" },
      contact: { phone: "77011112233", chatId: "77011112233@c.us" },
    },
    {
      sendWhatsAppMessage: async () => {},
      sendManagerMessage: async (text) => {
        managerMessages.push(text);
      },
      sendWhatsAppLocalFile: async (_chatId, _path, options) => {
        files.push(options);
      },
      updateLead: async (_id, patch) => Object.assign(conversation, patch),
      markNotification: async (_id, key) => {
        conversation.notificationEvents = [...new Set([...(conversation.notificationEvents || []), key])];
        return conversation;
      },
      hasNotification: (lead, key) => Boolean(lead?.notificationEvents?.includes(key)),
      canNotifySalesManager: () => ({ ok: true, chatId: "77077471301@c.us" }),
      inspectPresentationKp: async () => ({ ok: true, path: "/tmp/presentation_kp.pdf" }),
    },
  );
  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0], /Новая заявка/);
  assert.equal(files.length, 1);
  assert.equal(conversation.handoff_already_created, true);
});
