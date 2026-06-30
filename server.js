import express from "express";
import dotenv from "dotenv";
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
app.use(express.json({ type: "application/json" }));

const PORT = process.env.PORT || 3000;
const sessions = new Map();
const MAX_HISTORY_MESSAGES = 100;
const pendingMessages = new Map();
const MESSAGE_BUFFER_MS = 10000;
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

async function loadPromptFiles() {
  const systemPromptPath = join(__dirname, "prompts", "system_prompt.txt");
  const knowledgePath = join(__dirname, "knowledge", "creolab_knowledge_base.txt");

  const [systemPrompt, knowledgeBase] = await Promise.all([
    readFile(systemPromptPath, "utf-8"),
    readFile(knowledgePath, "utf-8"),
  ]);

  return { systemPrompt, knowledgeBase };
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

function buildAiInput({ systemPrompt, knowledgeBase, history, message }) {
  return [
    systemPrompt.trim(),
    "",
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

app.post("/test-ai", async (req, res) => {
  const envError = validateEnv();
  if (envError) {
    return res.status(500).json({
      success: false,
      error: envError,
    });
  }

  const { message, sessionId = "test-user" } = req.body || {};
  const history = sessions.get(sessionId) || [];


  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      success: false,
      error: "Поле message обязательно и должно быть непустой строкой.",
    });
  }

  try {
    const { systemPrompt, knowledgeBase } = await loadPromptFiles();
    const input = buildAiInput({
      systemPrompt,
      knowledgeBase,
      history,
      message: message.trim(),
    });

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL,
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: input,
        },
      ],
    });

    const raw = response.output_text || "";

    let result;
    try {
      result = extractJsonFromText(raw);
    } catch {
      result = { ...FALLBACK_RESULT };
    }
    const updatedHistory = [
      ...history,
      { role: "user", content: message.trim() },
      { role: "assistant", content: result.reply || raw },
    ].slice(-MAX_HISTORY_MESSAGES);
    
    sessions.set(sessionId, updatedHistory);


    return res.json({
      success: true,
      raw,
      result,
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
    systemPrompt,
    knowledgeBase,
    history,
    message: message.trim(),
  });

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL,
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: input,
      },
    ],
  });

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

  sessions.set(sessionId, updatedHistory);

  return { reply, result };
}
async function transcribeAudioFromUrl(fileUrl) {
  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Не удалось скачать голосовое: ${await response.text()}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFilePath = join(os.tmpdir(), `voice-${Date.now()}.ogg`);

  await writeFile(tempFilePath, buffer);

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  try {
    const transcription = await openai.audio.transcriptions.create({
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

const messages = [...(existing?.messages || []), message.trim()];

const timer = setTimeout(async () => {
  try {
    const combinedMessage = messages.join("\n");

    const { reply, result } = await generateAiReply({
      sessionId,
      message: combinedMessage,
    });
    
    await sendWhatsAppMessage(chatId, reply);
    
    if (result?.handoff === true) {
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
    
    pendingMessages.delete(sessionId);
  } catch (error) {
    console.error("BUFFERED MESSAGE ERROR:", error);
    pendingMessages.delete(sessionId);
  }
}, MESSAGE_BUFFER_MS);

pendingMessages.set(sessionId, {
  messages,
  timer,
});

return res.json({
  success: true,
  buffered: true,
  messagesCount: messages.length,
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