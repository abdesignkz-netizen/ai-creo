import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { writeFile, unlink } from "fs/promises";
import { createReadStream } from "fs";
import os from "os";
import { join } from "path";
import { generateAiReply, getOpenAIClient } from "./services/aiService.js";
import { handleClientMessage } from "./services/clientService.js";
import { handleManagerMessage } from "./services/managerService.js";
import {
  extractPhoneCandidate,
  extractPhoneFromVcard,
  isManagerPhone,
  phoneFromChatId,
} from "./services/phoneService.js";
import { log } from "./services/logger.js";

dotenv.config();

const app = express();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5176",
  "http://localhost:4173",
  "https://creolab.kz",
  "https://www.creolab.kz",
  "https://site.creolab.kz",
  process.env.FRONTEND_ORIGIN,
].filter(Boolean);

const leadUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 8,
    fileSize: 12 * 1024 * 1024,
  },
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
  }),
);
app.use(express.json({ type: "application/json", limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const pendingMessages = new Map();
const MESSAGE_BUFFER_MS = Number(process.env.MESSAGE_BUFFER_MS || 800);

function validateEnv() {
  if (!process.env.OPENAI_API_KEY) {
    return "OPENAI_API_KEY не задан. Скопируйте .env.example в .env и укажите ключ OpenAI.";
  }
  if (!process.env.OPENAI_MODEL) {
    return "OPENAI_MODEL не задан. Скопируйте .env.example в .env и укажите доступную модель OpenAI.";
  }
  return null;
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, maxLength);
}

function formatAlmatyDateTime(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function getTelegramCredentials() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }
  if (!chatId) {
    throw new Error("TELEGRAM_CHAT_ID is not configured");
  }

  return { token, chatId };
}

async function sendTelegramMessage(message) {
  const { token, chatId } = getTelegramCredentials();

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    },
  );

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    console.error("Telegram API error:", data || `HTTP ${response.status}`);
    throw new Error("Telegram API request failed");
  }

  return data;
}

async function sendTelegramDocument(file, caption = "") {
  const { token, chatId } = getTelegramCredentials();
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption.slice(0, 900));
  form.append(
    "document",
    new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
    file.originalname || "file",
  );

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendDocument`,
    {
      method: "POST",
      body: form,
    },
  );

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    console.error("Telegram sendDocument error:", data || `HTTP ${response.status}`);
    throw new Error("Telegram document upload failed");
  }
  return data;
}

function buildLeadTelegramMessage({
  name,
  phone,
  service,
  comment,
  pageUrl,
  source,
  presentationType,
  deadline,
  fileNames,
}) {
  const isPresentation =
    source === "presentation" ||
    /\/presentation/i.test(pageUrl || "") ||
    /презентац/i.test(service || "");

  const lines = [
    isPresentation
      ? "🟢 Новая заявка · Презентации CREOLAB"
      : "🟢 Новая заявка с сайта CREOLAB",
    "",
    `Имя: ${name}`,
    `Телефон: ${phone}`,
  ];

  if (service) lines.push(`Услуга: ${service}`);
  if (presentationType) lines.push(`Тип презентации: ${presentationType}`);
  if (deadline) lines.push(`Срок: ${deadline}`);
  if (comment) lines.push(`Комментарий: ${comment}`);
  if (fileNames?.length) lines.push(`Файлы: ${fileNames.join(", ")}`);

  lines.push("");
  if (pageUrl) lines.push(`Страница: ${pageUrl}`);
  lines.push(`Время: ${formatAlmatyDateTime()}`);

  return lines.join("\n").slice(0, 4000);
}

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    message: "CREOLAB WhatsApp AI Sales Manager is running",
  });
});

app.post("/api/lead", leadUpload.array("files", 8), async (req, res) => {
  try {
    const website = cleanText(req.body?.website, 200);
    if (website) {
      return res.json({ success: true });
    }

    const name = cleanText(req.body?.name, 120);
    const phone = cleanText(req.body?.phone, 40);
    const service = cleanText(req.body?.service, 200);
    const comment = cleanText(req.body?.comment, 3500);
    const pageUrl = cleanText(req.body?.pageUrl, 500);
    const source = cleanText(req.body?.source, 80);
    const presentationType = cleanText(
      req.body?.presentationType || req.body?.type,
      120,
    );
    const deadline = cleanText(req.body?.deadline, 120);
    const files = Array.isArray(req.files) ? req.files : [];
    const fileNames = files.map((f) => f.originalname).filter(Boolean);

    if (!name || !phone) {
      return res.status(400).json({
        success: false,
        message: "Укажите имя и номер телефона",
      });
    }

    const message = buildLeadTelegramMessage({
      name,
      phone,
      service,
      comment,
      pageUrl,
      source,
      presentationType,
      deadline,
      fileNames,
    });

    await sendTelegramMessage(message);

    for (const file of files) {
      try {
        await sendTelegramDocument(file, `${name} · ${phone}`);
      } catch (fileError) {
        console.error("LEAD FILE TELEGRAM ERROR:", fileError);
      }
    }

    return res.json({
      success: true,
      message: "Заявка успешно отправлена",
    });
  } catch (error) {
    console.error("LEAD TELEGRAM ERROR:", error);
    return res.status(500).json({
      success: false,
      message: "Не удалось отправить заявку",
    });
  }
});

app.post("/test-ai", async (req, res) => {
  const envError = validateEnv();
  if (envError) {
    return res.status(500).json({
      success: false,
      error: envError,
    });
  }

  const { message, sessionId = "test-user", history = [] } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: "Поле message обязательно и должно быть непустой строкой.",
    });
  }

  try {
    const { raw, result, latencyMs } = await generateAiReply({
      message: message.trim(),
      history,
      lead: { leadId: sessionId, aiMode: "AUTO", status: "new" },
    });

    return res.json({
      success: true,
      raw,
      result,
      latencyMs,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Ошибка при обращении к OpenAI API.",
      details: error.message,
    });
  }
});

async function transcribeAudioFromUrl(fileUrl) {
  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Не удалось скачать голосовое: ${await response.text()}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFilePath = join(os.tmpdir(), `voice-${Date.now()}.ogg`);

  await writeFile(tempFilePath, buffer);

  try {
    const transcription = await getOpenAIClient().audio.transcriptions.create({
      file: createReadStream(tempFilePath),
      model: "whisper-1",
    });

    return transcription.text || "";
  } finally {
    await unlink(tempFilePath).catch(() => {});
  }
}

async function extractIncomingText(body) {
  const typeMessage = body?.messageData?.typeMessage;
  const parts = [];

  if (typeMessage === "textMessage") {
    parts.push(body.messageData?.textMessageData?.textMessage || "");
  } else if (typeMessage === "extendedTextMessage") {
    const extra = body.messageData?.extendedTextMessageData || {};
    parts.push(extra.text || extra.description || extra.title || "");
  } else if (typeMessage === "quotedMessage") {
    parts.push(body.messageData?.extendedTextMessageData?.text || "");
  } else if (typeMessage === "audioMessage") {
    const fileUrl = body.messageData?.fileMessageData?.downloadUrl;
    if (fileUrl) {
      const text = await transcribeAudioFromUrl(fileUrl);
      if (text) parts.push(`[Голосовое сообщение]: ${text}`);
    }
  } else if (typeMessage === "contactMessage") {
    const contact = body.messageData?.contactMessageData || {};
    const phone =
      extractPhoneFromVcard(contact.vcard) ||
      extractPhoneCandidate(contact.displayName || "");
    if (phone) parts.push(phone);
    if (contact.displayName) parts.push(contact.displayName);
  }

  const caption = body.messageData?.fileMessageData?.caption;
  if (caption) parts.push(caption);

  return parts.filter(Boolean).join("\n").trim();
}

const FORWARDABLE_MEDIA = new Set([
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
]);

function extractIncomingMedia(body) {
  const typeMessage = body?.messageData?.typeMessage;
  if (!FORWARDABLE_MEDIA.has(typeMessage)) {
    return null;
  }

  const file = body.messageData?.fileMessageData || {};
  if (!file.downloadUrl && !body.idMessage) {
    return null;
  }

  return {
    type: typeMessage,
    url: file.downloadUrl || "",
    fileName: file.fileName || "",
    mimeType: file.mimeType || "",
    caption: file.caption || "",
    idMessage: body.idMessage || "",
    chatIdFrom: body.senderData?.chatId || "",
  };
}

async function flushPendingChat(sessionId, chatId) {
  const pending = pendingMessages.get(sessionId);
  if (!pending || pending.generating) {
    return;
  }

  pending.generating = true;
  pending.timer = null;

  const version = pending.version;
  const combinedMessage = pending.messages.join("\n");
  const startedAt = Date.now();

  try {
    if (isManagerPhone(chatId)) {
      await handleManagerMessage({
        message: combinedMessage,
        media: pending.media || [],
        senderChatId: chatId,
      });
    } else {
      await handleClientMessage({
        chatId,
        message: combinedMessage,
        senderName: pending.senderName,
      });
    }
  } finally {
    const latest = pendingMessages.get(sessionId);
    if (latest && latest.version !== version) {
      latest.generating = false;
      return flushPendingChat(sessionId, chatId);
    }
    pendingMessages.delete(sessionId);
  }

  log("AI RESPONSE", {
    chatId,
    role: isManagerPhone(chatId) ? "MANAGER" : "CLIENT",
    bufferMs: MESSAGE_BUFFER_MS,
    totalMs: Date.now() - startedAt + MESSAGE_BUFFER_MS,
  });
}

app.post("/webhook", async (req, res) => {
  console.log("WEBHOOK RECEIVED:", Date.now());
  try {
    const body = req.body;

    console.log(
      "TYPE:",
      body.typeWebhook,
      "CHAT:",
      body.senderData?.chatId,
    );

    if (body.typeWebhook !== "incomingMessageReceived") {
      return res.json({ success: true, skipped: "not incoming message" });
    }

    const chatId = body.senderData?.chatId;
    const senderName =
      body.senderData?.senderName || body.senderData?.chatName || "";
    const message = await extractIncomingText(body);
    const media = extractIncomingMedia(body);
    const isManager = isManagerPhone(chatId);

    if (!chatId || (!message && !media)) {
      return res.json({ success: true, skipped: "no text message" });
    }

    if (!isManager && !message) {
      return res.json({ success: true, skipped: "no text message" });
    }

    const role = isManager ? "MANAGER" : "CLIENT";
    log(role, { phone: phoneFromChatId(chatId), buffered: true, hasFile: Boolean(media) });

    const sessionId = chatId;
    const existing = pendingMessages.get(sessionId);

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const pending = existing || {
      messages: [],
      media: [],
      version: 0,
      generating: false,
      timer: null,
    };

    if (message.trim()) {
      pending.messages = [...pending.messages, message.trim()];
    }
    if (media) {
      pending.media = [...(pending.media || []), media];
    }
    pending.version += 1;
    pending.senderName = pending.senderName || senderName;

    if (!pending.generating) {
      pending.timer = setTimeout(() => {
        flushPendingChat(sessionId, chatId).catch((error) => {
          console.error("BUFFERED MESSAGE ERROR:", error);
          pendingMessages.delete(sessionId);
        });
      }, MESSAGE_BUFFER_MS);
    }

    pendingMessages.set(sessionId, pending);

    return res.json({
      success: true,
      buffered: true,
      role,
      messagesCount: pending.messages.length,
    });
  } catch (error) {
    console.error("WEBHOOK ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`CREOLAB WhatsApp AI Sales Manager running on http://localhost:${PORT}`);
});
