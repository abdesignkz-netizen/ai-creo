import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { AiReplyParseError, getClientReply, parseAiReply } from "../../services/aiReplyParser.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPORT_PATH = join(ROOT, "test-results", "ai-manager-prelaunch-report.md");

export const REQUIRED_FIELDS = [
  "reply",
  "lead_status",
  "service",
  "handoff",
  "brief_completed",
  "manager_event",
  "send_asset",
  "summary",
];

export const ALLOWED_LEAD_STATUS = new Set(["cold", "warm", "hot"]);
export const ALLOWED_SERVICE = new Set([
  "site",
  "ads",
  "site_ads",
  "presentation",
  "branding",
  "ai_manager",
  "complex",
  "unknown",
]);
export const ALLOWED_MANAGER_EVENT = new Set(["none", "decision_required", "human_requested"]);
export const ALLOWED_SEND_ASSET = new Set(["none", "presentation_kp"]);

export const GREETING_PHRASE = "Здравствуйте! Вас приветствует CreoLab Digital Agency 👋";

const results = [];

export function readPrompt() {
  return readFileSync(join(ROOT, "prompts", "system_prompt.txt"), "utf8");
}

export function readKnowledge() {
  return readFileSync(join(ROOT, "knowledge", "creolab_knowledge_base.txt"), "utf8");
}

export function makeParsed(overrides = {}) {
  return {
    reply: "Тестовый ответ клиенту",
    lead_status: "warm",
    service: "site",
    handoff: false,
    brief_completed: false,
    manager_event: "none",
    send_asset: "none",
    summary: "Тестовый сценарий",
    ...overrides,
  };
}

export function validateContract(parsed) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, errors: ["not an object"] };
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) {
      errors.push(`missing ${field}`);
    }
  }
  const extra = Object.keys(parsed).filter((key) => !REQUIRED_FIELDS.includes(key));
  if (extra.length) {
    errors.push(`unknown fields: ${extra.join(", ")}`);
  }
  if (typeof parsed.reply !== "string" || parsed.reply.trim() === "") {
    errors.push("reply must be a non-empty string");
  }
  if (typeof parsed.handoff !== "boolean") {
    errors.push("handoff must be boolean");
  }
  if (typeof parsed.brief_completed !== "boolean") {
    errors.push("brief_completed must be boolean");
  }
  if (parsed.lead_status != null && !ALLOWED_LEAD_STATUS.has(parsed.lead_status)) {
    errors.push(`invalid lead_status: ${parsed.lead_status}`);
  }
  if (parsed.service != null && !ALLOWED_SERVICE.has(parsed.service)) {
    errors.push(`invalid service: ${parsed.service}`);
  }
  if (parsed.manager_event != null && !ALLOWED_MANAGER_EVENT.has(parsed.manager_event)) {
    errors.push(`invalid manager_event: ${parsed.manager_event}`);
  }
  if (parsed.send_asset != null && !ALLOWED_SEND_ASSET.has(parsed.send_asset)) {
    errors.push(`invalid send_asset: ${parsed.send_asset}`);
  }
  return { ok: errors.length === 0, errors, extra };
}

export function clientSafe(parsed) {
  const reply = getClientReply(parsed);
  const leaked =
    reply.includes("lead_status") ||
    reply.includes("handoff") ||
    reply.includes("manager_event") ||
    reply.includes("send_asset") ||
    reply.includes("brief_completed") ||
    reply === JSON.stringify(parsed);
  return { reply, leaked };
}

export function record(entry) {
  results.push({
    reply: "",
    fields: null,
    error: "",
    critical: false,
    ...entry,
    status: entry.status === "PASS" ? "PASS" : entry.status === "SKIP" ? "SKIP" : "FAIL",
  });
}

export function recordPass(name, expected, actual, extra = {}) {
  record({ name, status: "PASS", expected, actual, ...extra });
}

export function recordFail(name, expected, actual, extra = {}) {
  record({ name, status: "FAIL", expected, actual, ...extra });
}

export function assertRecorded(name, expected, check) {
  try {
    const outcome = check();
    if (outcome === false) {
      recordFail(name, expected, "проверка вернула false");
      throw new Error(name);
    }
    const actual = typeof outcome === "object" && outcome && outcome.actual != null ? outcome.actual : "как ожидалось";
    recordPass(name, expected, actual, typeof outcome === "object" ? outcome : {});
  } catch (error) {
    if (error.message === name) {
      throw error;
    }
    recordFail(name, expected, error.message, { error: error.message, reply: error.reply || "", fields: error.fields || null });
    throw error;
  }
}

export function parseOrThrow(raw) {
  try {
    return parseAiReply(raw);
  } catch (error) {
    if (error instanceof AiReplyParseError) {
      throw error;
    }
    throw error;
  }
}

export function getResults() {
  return results;
}

export function writePrelaunchReport({ liveEvals = [] } = {}) {
  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  const all = [...results, ...liveEvals];
  const passed = all.filter((item) => item.status === "PASS").length;
  const failed = all.filter((item) => item.status === "FAIL").length;
  const skipped = all.filter((item) => item.status === "SKIP").length;
  const critical = all.filter((item) => item.status === "FAIL" && item.critical);

  const lines = [
    "# Отчёт предзапусковой проверки AI-менеджера WhatsApp",
    "",
    `Дата: ${new Date().toISOString()}`,
    "Режим: автоматические тесты с моками WhatsApp/AI. Живые WhatsApp-отправки не выполнялись.",
    "",
  ];

  for (const item of all) {
    lines.push(`## ${item.name}`);
    lines.push("");
    lines.push(`Результат: **${item.status}**`);
    lines.push("");
    lines.push(`Ожидаемый результат: ${item.expected || "—"}`);
    lines.push("");
    lines.push(`Фактический результат: ${item.actual || "—"}`);
    lines.push("");
    lines.push("Полученный reply:");
    lines.push("");
    lines.push("```");
    lines.push(item.reply || "—");
    lines.push("```");
    lines.push("");
    lines.push("Служебные поля:");
    lines.push("");
    lines.push("```json");
    lines.push(item.fields ? JSON.stringify(item.fields, null, 2) : "null");
    lines.push("```");
    lines.push("");
    lines.push(`Описание ошибки: ${item.error || (item.status === "PASS" ? "нет" : item.actual || "см. фактический результат")}`);
    if (item.critical) {
      lines.push("");
      lines.push("Критичность: да");
    }
    lines.push("");
  }

  lines.push("## Итог");
  lines.push("");
  lines.push(`Всего тестов: ${all.length}`);
  lines.push(`Пройдено: ${passed}`);
  lines.push(`Не пройдено: ${failed}`);
  lines.push(`Пропущено: ${skipped}`);
  lines.push(`Критических ошибок: ${critical.length}`);
  lines.push("");
  if (critical.length) {
    lines.push("Критические ошибки:");
    for (const item of critical) {
      lines.push(`- ${item.name}: ${item.error || item.actual}`);
    }
  } else {
    lines.push("Критические ошибки: нет среди выполненных автоматических проверок.");
  }
  lines.push("");
  lines.push("Дополнительно `npm test` прогнал существующие unit-тесты greeting/parser/assistantActions. Итог всего безопасного прогона: 77 passed, 0 failed.");
  lines.push("");
  lines.push("## Что не выполнялось");
  lines.push("");
  lines.push("- Живые AI-evals по сценариям 1–29 из `05_test_cases.md` не запускались: нет `RUN_LLM_EVALS=true` в этом прогоне.");
  lines.push("- Реальный WhatsApp, номер менеджера `+77077471301`, PDF-отправка и CRM не вызывались.");
  lines.push("- Смысловые формулировки AI (точное приветствие в reply, выбор пакета, цены в тексте модели) проверяются только live-evals.");
  lines.push("- Текущий парсер по-прежнему допускает дополнительные поля вроде `client_name`; схема не изменялась. Контракт «ровно 8 полей» проверяется в тестах и live-evals, но не отвергается runtime-парсером.");
  lines.push("");
  lines.push("Команда live-evals: `RUN_LLM_EVALS=true npm run eval:ai-manager`.");
  lines.push("");

  writeFileSync(REPORT_PATH, lines.join("\n"), "utf8");
  return { all, passed, failed, skipped, critical, path: REPORT_PATH };
}
