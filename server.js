import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import {
  generateAiReply,
  getAiModel,
  isAnyModelProvider,
} from "./services/aiService.js";
import { handleClientMessage, buildClientMessageWithMedia } from "./services/clientService.js";
import { handleFailedOutboundStatus, handleManagerMessage } from "./services/managerService.js";
import { extractIncomingText } from "./services/incomingExtract.js";
import { extractVoiceForBatch, isVoiceIncoming } from "./services/voiceIncoming.js";
import { noteOutgoingStatus, sendWhatsAppMessage } from "./services/whatsappService.js";
import {
  isManagerPhone,
  phoneFromChatId,
  resolveIncomingIdentity,
} from "./services/phoneService.js";
import { log } from "./services/logger.js";
import { getStorePath } from "./services/leadStore.js";
import { logAssistantRuntimeChecks } from "./services/appConfig.js";
import { isManagementController } from "./services/managementConfig.js";
import { registerPendingChatBumper } from "./services/clientOutboundGate.js";

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
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const pendingMessages = new Map();
const recentIncomingIds = new Map();
registerPendingChatBumper((chatId) => {
  const pending = pendingMessages.get(chatId);
  if (pending) {
    pending.version += 1;
  }
});
const MESSAGE_BUFFER_MS = Number(process.env.MESSAGE_BUFFER_MS || 2000);
const FOLLOWUP_BUFFER_MS = Math.max(800, Math.round(MESSAGE_BUFFER_MS / 2));
const FLUSH_TIMEOUT_MS = Number(process.env.FLUSH_TIMEOUT_MS || 90000);

function validateEnv() {
  if (isAnyModelProvider()) {
    if (!process.env.ANYMODEL_API_KEY) {
      return "ANYMODEL_API_KEY не задан. Скопируйте .env.example в .env и укажите ключ AnyModel.";
    }
    if (!process.env.ANYMODEL_MODEL) {
      return "ANYMODEL_MODEL не задан. Скопируйте .env.example в .env и укажите модель AnyModel.";
    }
    return null;
  }

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

const FORWARDABLE_MEDIA = new Set([
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
]);

function extractIncomingMedia(body) {
  const typeMessage = body?.messageData?.typeMessage || body?.typeMessage;
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
    chatIdFrom: resolveIncomingIdentity(body).chatId || body.senderData?.chatId || "",
  };
}

function rememberIncomingId(sessionId, idMessage) {
  if (!idMessage) {
    return false;
  }

  let seen = recentIncomingIds.get(sessionId);
  if (!seen) {
    seen = [];
    recentIncomingIds.set(sessionId, seen);
  }

  if (seen.includes(idMessage)) {
    return true;
  }

  seen.push(idMessage);
  if (seen.length > 80) {
    seen.splice(0, seen.length - 80);
  }
  return false;
}

function takePendingBundle(pending) {
  const messages = [...(pending.messages || [])];
  const media = [...(pending.media || [])];
  const idMessages = [...(pending.idMessages || [])];
  pending.messages = [];
  pending.media = [];
  pending.idMessages = [];
  return {
    messages,
    media,
    idMessages,
    version: pending.version,
    senderName: pending.senderName,
  };
}

function scheduleFlush(sessionId, chatId, delayMs = MESSAGE_BUFFER_MS) {
  const pending = pendingMessages.get(sessionId);
  if (!pending || pending.generating) {
    return;
  }

  if (pending.timer) {
    clearTimeout(pending.timer);
  }

  pending.timer = setTimeout(() => {
    flushPendingChat(sessionId, chatId).catch((error) => {
      console.error("BUFFERED MESSAGE ERROR:", error);
      pendingMessages.delete(sessionId);
    });
  }, delayMs);
}

async function flushPendingChat(sessionId, chatId) {
  const pending = pendingMessages.get(sessionId);
  if (!pending || pending.generating) {
    return;
  }

  pending.generating = true;
  pending.timer = null;

  const bundle = takePendingBundle(pending);
  const combinedMessage = buildClientMessageWithMedia(
    bundle.messages.join("\n"),
    bundle.media,
  );
  const startedAt = Date.now();
  let aborted = false;
  const watchdog = setTimeout(() => {
    const latest = pendingMessages.get(sessionId);
    if (latest?.generating) {
      log("FLUSH WATCHDOG", { sessionId, chatId });
      latest.generating = false;
      scheduleFlush(sessionId, chatId, FOLLOWUP_BUFFER_MS);
    }
  }, FLUSH_TIMEOUT_MS);

  try {
    if (!combinedMessage) {
      return;
    }

    if (isManagerPhone(chatId) || isManagementController(chatId)) {
      await handleManagerMessage({
        message: bundle.messages.join("\n"),
        media: bundle.media,
        senderChatId: chatId,
      });
    } else {
      const result = await handleClientMessage({
        chatId,
        message: bundle.messages.join("\n"),
        senderName: bundle.senderName,
        media: bundle.media,
        incomingMessageId: bundle.idMessages.filter(Boolean).join("+"),
        shouldAbort: () => {
          const latest = pendingMessages.get(sessionId);
          return Boolean(latest && latest.version !== bundle.version);
        },
      });
      aborted = Boolean(result?.aborted);
    }
  } finally {
    clearTimeout(watchdog);
    const latest = pendingMessages.get(sessionId);
    if (latest && (aborted || latest.version !== bundle.version)) {
      if (aborted) {
        latest.messages = [...bundle.messages, ...latest.messages];
        latest.media = [...bundle.media, ...latest.media];
        latest.idMessages = [...bundle.idMessages, ...(latest.idMessages || [])];
      }
      latest.generating = false;
      scheduleFlush(sessionId, chatId, FOLLOWUP_BUFFER_MS);
    } else {
      pendingMessages.delete(sessionId);
    }
  }

  log("AI RESPONSE", {
    chatId,
    role: isManagerPhone(chatId) || isManagementController(chatId) ? "MANAGER" : "CLIENT",
    bufferMs: MESSAGE_BUFFER_MS,
    aborted,
    totalMs: Date.now() - startedAt + MESSAGE_BUFFER_MS,
  });
}

async function processIncomingWebhook(body) {
  const identity = resolveIncomingIdentity(body);
  const chatId = identity.chatId;
  const senderName =
    body.senderData?.senderName || body.senderData?.chatName || "";
  const isManager =
    isManagerPhone(chatId) ||
    isManagerPhone(identity.phone) ||
    isManagementController(chatId) ||
    isManagementController(identity.phone);
  const sessionId = chatId;

  if (rememberIncomingId(sessionId, body.idMessage)) {
    return { skipped: "duplicate incoming" };
  }

  let message = "";
  let voiceNormalized = null;
  if (isVoiceIncoming(body)) {
    const voice = await extractVoiceForBatch(body);
    if (!voice.ok) {
      if (chatId) {
        try {
          await sendWhatsAppMessage(chatId, voice.fallbackReply);
        } catch (error) {
          log("VOICE FALLBACK ERROR", { error: error.message });
        }
      }
      return { skipped: "voice_failed" };
    }
    message = voice.batchText;
    voiceNormalized = voice.normalizedMessage?.type || "voice_transcript";
  } else {
    message = await extractIncomingText(body);
  }

  const media = extractIncomingMedia(body);

  if (!chatId || (!message && !media)) {
    log("WEBHOOK SKIP", { reason: "empty", chatId, type: body.messageData?.typeMessage });
    return { skipped: "no text message" };
  }

  const role = isManager ? "MANAGER" : "CLIENT";
  log(role, {
    phone: identity.phone || phoneFromChatId(chatId),
    buffered: true,
    hasFile: Boolean(media),
    voice: Boolean(voiceNormalized),
  });

  const existing = pendingMessages.get(sessionId);
  const pending = existing || {
    messages: [],
    media: [],
    idMessages: [],
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
  if (body.idMessage) {
    pending.idMessages = [...(pending.idMessages || []), body.idMessage];
  }
  pending.version += 1;
  pending.senderName = pending.senderName || senderName;
  pendingMessages.set(sessionId, pending);

  if (!pending.generating) {
    scheduleFlush(sessionId, chatId);
  }

  return {
    buffered: true,
    role,
    messagesCount: pending.messages.length,
  };
}

async function processWebhook(body) {
  if (body.typeWebhook === "outgoingMessageStatus") {
    noteOutgoingStatus({
      idMessage: body.idMessage,
      status: body.status,
      chatId: body.chatId,
      description: body.description,
    });
    await handleFailedOutboundStatus({
      chatId: body.chatId,
      status: body.status,
      description: body.description,
    });
    return { kind: "outgoing_status" };
  }

  if (body.typeWebhook !== "incomingMessageReceived") {
    return { skipped: "not incoming message" };
  }

  return processIncomingWebhook(body);
}

app.post("/webhook", (req, res) => {
  const body = req.body || {};
  console.log(
    "WEBHOOK RECEIVED:",
    Date.now(),
    "TYPE:",
    body.typeWebhook,
    "CHAT:",
    body.senderData?.chatId || body.chatId,
  );

  // Green API removes the notification from the queue only after HTTP 200.
  // Always ACK first: transcription or a hung send must not block later messages.
  res.json({ success: true, accepted: true });

  processWebhook(body).catch((error) => {
    console.error("WEBHOOK PROCESS ERROR:", error);
  });
});

app.listen(PORT, "0.0.0.0", () => {
  const provider = isAnyModelProvider() ? "anymodel" : "openai";
  console.log(`CREOLAB WhatsApp AI Sales Manager running on http://localhost:${PORT}`);
  console.log(`AI provider: ${provider}, model: ${getAiModel() || "not set"}`);
  console.log(`Lead store: ${getStorePath()}`);
  logAssistantRuntimeChecks().catch((error) => {
    console.error("CONFIG CHECK ERROR:", error.message);
  });

  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
  if (keepAliveUrl) {
    const ping = () => {
      fetch(`${String(keepAliveUrl).replace(/\/$/, "")}/`).catch(() => {});
    };
    setInterval(ping, 8 * 60 * 1000);
    console.log(`Keep-alive ping enabled for ${keepAliveUrl}`);
  }
});
