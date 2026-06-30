import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

  const { message, history = [] } = req.body || {};

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
      input,
    });

    const raw = response.output_text || "";

    let result;
    try {
      result = extractJsonFromText(raw);
    } catch {
      result = { ...FALLBACK_RESULT };
    }

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

app.listen(PORT, () => {
  console.log(`CREOLAB WhatsApp AI Sales Manager running on http://localhost:${PORT}`);
});
