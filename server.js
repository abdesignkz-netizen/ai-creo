import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import OpenAI from "openai";
import { readFile, writeFile, unlink } from "fs/promises";
import { createReadStream } from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5176",
  "http://localhost:4173",
  "https://creolab.kz",
  "https://www.creolab.kz",
  "https://site.creolab.kz", // Netlify / кастомный домен — при смене URL обновите или задайте FRONTEND_ORIGIN
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
const sessions = new Map();
const MAX_HISTORY_MESSAGES = Number(process.env.MAX_HISTORY_MESSAGES || 24);
const pendingMessages = new Map();
const MESSAGE_BUFFER_MS = Number(process.env.MESSAGE_BUFFER_MS || 800);
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "low";
let cachedPromptFiles = null;
let openaiClient = null;
const FALLBACK_RESULT = {
  reply: "Не смог корректно обработать ответ. Передам менеджеру.",
  lead_status: "warm",
  service: "unknown",
  handoff: true,
  summary: "AI вернул некорректный JSON, нужна ручная проверка.",
  parse_error: true,
};

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

function getOpenAIClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  return openaiClient;
}

async function loadPromptFiles() {
  if (cachedPromptFiles) {
    return cachedPromptFiles;
  }

  const systemPromptPath = join(__dirname, "prompts", "system_prompt.txt");
  const knowledgePath = join(__dirname, "knowledge", "creolab_knowledge_base.txt");

  const [systemPrompt, knowledgeBase] = await Promise.all([
    readFile(systemPromptPath, "utf-8"),
    readFile(knowledgePath, "utf-8"),
  ]);

  cachedPromptFiles = { systemPrompt, knowledgeBase };
  return cachedPromptFiles;
}

function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return "История диалога пуста.";
  }

  return history
    .map((item, index) => {
      const role = item.role || "unknown";
      const content = item.content || "";
      return `${index + 1}. [${role}]: ${content}`;
    })
    .join("\n");
}

function buildAiInput({ knowledgeBase, history, message }) {
  return [
    "=== БАЗА ЗНАНИЙ ===",
    knowledgeBase.trim(),
    "",
    "=== ИСТОРИЯ ДИАЛОГА ===",
    formatHistory(history),
    "",
    "=== ПОСЛЕДНЕЕ СООБЩЕНИЕ КЛИЕНТА ===",
    message,
    "",
    "Ответь строго JSON без markdown и без пояснений вне JSON.",
  ].join("\n");
}

function extractJsonFromText(text) {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error("JSON not found");
  }
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

  const { message, sessionId = "test-user" } = req.body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: "Поле message обязательно и должно быть непустой строкой.",
    });
  }

  try {
    const { raw, result, latencyMs, nextHistory } = await generateAiReply({
      sessionId,
      message: message.trim(),
    });
    commitAiHistory(sessionId, nextHistory);

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

async function sendWhatsAppMessage(chatId, message) {
  const idInstance = process.env.GREEN_API_INSTANCE_ID;
  const apiToken = process.env.GREEN_API_TOKEN;

  const url = `https://7107.api.greenapi.com/waInstance${idInstance}/sendMessage/${apiToken}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chatId,
      message,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Green API sendMessage error: ${errorText}`);
  }

  return response.json();
}


async function generateAiReply({ sessionId, message }) {
  const history = sessions.get(sessionId) || [];
  const { systemPrompt, knowledgeBase } = await loadPromptFiles();

  const input = buildAiInput({
    knowledgeBase,
    history,
    message: message.trim(),
  });

  const startedAt = Date.now();
  const response = await getOpenAIClient().responses.create({
    model: process.env.OPENAI_MODEL,
    instructions: systemPrompt,
    reasoning: {
      effort: OPENAI_REASONING_EFFORT,
    },
    input: [
      {
        role: "user",
        content: input,
      },
    ],
  });
  const latencyMs = Date.now() - startedAt;

  const raw = response.output_text || "";

  let result;
  try {
    result = extractJsonFromText(raw);
  } catch {
    result = { ...FALLBACK_RESULT };
  }

  const reply = result.reply || "Понял. Давайте уточним детали.";

  const updatedHistory = [
    ...history,
    { role: "user", content: message.trim() },
    { role: "assistant", content: reply },
  ].slice(-MAX_HISTORY_MESSAGES);

  console.log("AI_REPLY", {
    sessionId,
    latencyMs,
    model: process.env.OPENAI_MODEL,
    reasoningEffort: OPENAI_REASONING_EFFORT,
    inputChars: input.length,
    historyMessages: history.length,
  });

  return { reply, result, raw, latencyMs, nextHistory: updatedHistory };
}

function commitAiHistory(sessionId, nextHistory) {
  if (nextHistory) {
    sessions.set(sessionId, nextHistory);
  }
}
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

  if (typeMessage === "textMessage") {
    return body.messageData?.textMessageData?.textMessage || "";
  }

  if (typeMessage === "extendedTextMessage") {
    return body.messageData?.extendedTextMessageData?.text || "";
  }

  if (typeMessage === "audioMessage") {
    const fileUrl = body.messageData?.fileMessageData?.downloadUrl;

    if (!fileUrl) return "";

    const text = await transcribeAudioFromUrl(fileUrl);
    return text ? `[Голосовое сообщение]: ${text}` : "";
  }

  return "";
}

async function sendHandoffIfNeeded(chatId, result) {
  if (result?.handoff !== true) {
    return;
  }

  const phone = chatId.replace("@c.us", "");
  const leadMessage = `
🔥 Новый горячий лид

Телефон:
+${phone}

Услуга:
${result.service || "не указана"}

Резюме:
${result.summary || "нет резюме"}
`;

  await sendWhatsAppMessage("77077471301@c.us", leadMessage);
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

  const { reply, result, latencyMs, nextHistory } = await generateAiReply({
    sessionId,
    message: combinedMessage,
  });

  const current = pendingMessages.get(sessionId);
  if (!current) {
    return;
  }

  if (current.version !== version) {
    current.generating = false;
    console.log("AI_REPLY_UPDATED", { chatId, version, nextVersion: current.version });
    return flushPendingChat(sessionId, chatId);
  }

  commitAiHistory(sessionId, nextHistory);
  await sendWhatsAppMessage(chatId, reply);
  await sendHandoffIfNeeded(chatId, result);
  pendingMessages.delete(sessionId);

  console.log("WHATSAPP_REPLY", {
    chatId,
    bufferMs: MESSAGE_BUFFER_MS,
    aiMs: latencyMs,
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
      body.senderData?.chatId
    );

    console.log("GREEN API WEBHOOK:", JSON.stringify(body, null, 2));

    if (body.typeWebhook !== "incomingMessageReceived") {
      return res.json({ success: true, skipped: "not incoming message" });
    }

    const chatId = body.senderData?.chatId;
    const message = await extractIncomingText(body);

    if (!chatId || !message) {
      return res.json({ success: true, skipped: "no text message" });
    }

    const sessionId = chatId;
    const existing = pendingMessages.get(sessionId);

    if (existing?.timer) {
      clearTimeout(existing.timer);
    }

    const pending = existing || {
      messages: [],
      version: 0,
      generating: false,
      timer: null,
    };

    pending.messages = [...pending.messages, message.trim()];
    pending.version += 1;

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