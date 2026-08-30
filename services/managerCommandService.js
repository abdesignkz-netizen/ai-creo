import { extractPhoneCandidate, normalizePhone, stripPhoneFromText } from "./phoneService.js";
import { parseLeadId } from "./leadService.js";
import { parseManagerCommandWithAi } from "./aiService.js";
import { log } from "./logger.js";

const EXACT_RE =
  /(?:отправь|напиши дословно|передай дословно)\s*:\s*([\s\S]+)/i;

function cleanAction(action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  const type = String(action.type || "").trim().toUpperCase();
  if (!type) {
    return null;
  }
  return {
    type,
    value: action.value ?? null,
    text: action.text ?? null,
  };
}

function parseByRules(message) {
  const text = String(message || "").trim();
  const leadId = parseLeadId(text);
  const phone = extractPhoneCandidate(text);
  const actions = [];

  if (/активные лиды|покажи лиды/i.test(text)) {
    actions.push({ type: "LIST_LEADS", value: null, text: null });
  }

  if (
    /что с\s+(lead-\d+|\+?[78][\d\s()-]{9,})|((lead-\d+)|(?:\+?[78]\d[\d\s()-]{8,})).+(что с ним|статус|как там)/i.test(
      text,
    ) ||
    /^(что с|статус|как там)\s/i.test(text)
  ) {
    actions.push({ type: "STATUS_QUERY", value: leadId || phone, text: null });
  }

  if (/остановись|пока не пиши/i.test(text)) {
    actions.push({ type: "SET_MODE", value: "PAUSED", text: null });
  }

  if (/продолжай|верни ai/i.test(text)) {
    actions.push({ type: "SET_MODE", value: "AUTO", text: null });
  }

  if (/отправил\??|ушло\??|дошло\??|отправилось\??|что написал/i.test(text)) {
    actions.push({ type: "LAST_SEND_STATUS", value: null, text: null });
  }

  if (phone && /сюда|на этот номер|вот сюда/i.test(text)) {
    actions.push({ type: "SEND_HERE", value: phone, text: null });
  }

  if (/передай мне|забери клиента|human/i.test(text)) {
    actions.push({ type: "SET_MODE", value: "HUMAN", text: null });
  }

  const exact = text.match(EXACT_RE);
  if (exact) {
    actions.push({
      type: "EXACT_MESSAGE",
      value: null,
      text: exact[1].trim(),
    });
  }

  const minPrice = text.match(/ниже\s+(\d[\d\s]*)\s*не опускайся|мин(?:имальн)?(?:ая)?\s*цен[аы]\s*(\d[\d\s]*)/i);
  if (minPrice) {
    const raw = minPrice[1] || minPrice[2];
    actions.push({
      type: "SET_MIN_PRICE",
      value: Number(String(raw).replace(/\s/g, "")),
      text: null,
    });
  }

  if (/скидк[ау]\s+(?:максимум\s+)?(\d{1,2})\s*%/i.test(text)) {
    const percent = text.match(/(\d{1,2})\s*%/);
    actions.push({
      type: "ADD_INSTRUCTION",
      value: `Максимальная скидка ${percent?.[1] || ""}%`,
      text: null,
    });
  }

  const leftover = stripPhoneFromText(text).replace(/[!?.,]+/g, "").trim();
  if (phone && leftover.length === 0) {
    actions.push({ type: "SEND_HERE", value: phone, text: null });
  }

  const composeHint =
    !exact &&
    /(скажи|объясни|предложи|уточни|узнай|напомин|нвпомин|попробуй|сделай акцент|отправь|закрой|доведи|подробност|заявк|напиши|свяжись|на этот номер|на указанный)/i.test(
      text,
    );
  if (composeHint) {
    actions.push({
      type: "AI_COMPOSE",
      value: stripPhoneFromText(text),
      text: null,
    });
  }

  return {
    leadId,
    phone,
    actions,
    source: "rules",
  };
}

function rulesAreComplete(parsed) {
  const types = new Set((parsed.actions || []).map((item) => item.type));
  if (types.has("LIST_LEADS") || types.has("LAST_SEND_STATUS")) {
    return true;
  }
  if (types.has("SEND_HERE") && parsed.phone) {
    return true;
  }
  if (types.has("STATUS_QUERY") && (parsed.phone || parsed.leadId)) {
    return true;
  }
  if (types.has("EXACT_MESSAGE") && (parsed.phone || parsed.leadId)) {
    return true;
  }
  if (types.has("SET_MODE") && (parsed.phone || parsed.leadId) && parsed.actions.length === 1) {
    return true;
  }
  if (
    (types.has("AI_COMPOSE") || types.has("ASK_CLIENT") || types.has("SET_MIN_PRICE")) &&
    (parsed.phone || parsed.leadId)
  ) {
    return true;
  }
  return false;
}

export async function parseManagerCommand(message) {
  const fallback = parseByRules(message);

  if (rulesAreComplete(fallback)) {
    log("MANAGER COMMAND", {
      leadId: fallback.leadId,
      phone: fallback.phone,
      actions: fallback.actions.map((item) => item.type),
      source: "rules",
    });
    return fallback;
  }

  try {
    const parsed = await parseManagerCommandWithAi(message);
    const actions = (parsed.actions || []).map(cleanAction).filter(Boolean);
    const merged = {
      leadId: parseLeadId(parsed.leadId) || fallback.leadId,
      phone: normalizePhone(parsed.phone) || fallback.phone,
      actions: actions.length ? actions : fallback.actions,
      source: "ai",
    };

    if (!merged.actions.length && fallback.actions.length) {
      merged.actions = fallback.actions;
    }

    log("MANAGER COMMAND", {
      leadId: merged.leadId,
      phone: merged.phone,
      actions: merged.actions.map((item) => item.type),
      source: merged.source,
    });
    return merged;
  } catch (error) {
    log("MANAGER COMMAND", { parseFallback: true, error: error.message });
    return fallback;
  }
}

const COMMAND_HINT_RE =
  /отправь|напиши|скажи|узнай|уточни|предложи|напомни|подробност|заявк|свяжись|остановись|продолжай|ниже|скидк|что с|активные лиды|покажи лиды/i;

const CONFIRM_SEND_RE =
  /(отправь|перешли|направь).*(номер|туда|клиенту|не сюда|это сообщение)|^(да[,.]?\s*)(отправь|перешли)?$/i;

export function looksLikeManagerCommand(message, senderPhone) {
  const text = String(message || "").trim();
  const target = extractPhoneCandidate(text);
  if (target && target !== normalizePhone(senderPhone) && COMMAND_HINT_RE.test(text)) {
    return true;
  }
  if (CONFIRM_SEND_RE.test(text)) {
    return true;
  }
  return /активные лиды|покажи лиды/i.test(text);
}

export function isConfirmSend(message) {
  return CONFIRM_SEND_RE.test(String(message || "").trim());
}

export function describeActions(actions) {
  return (actions || [])
    .map((action) => {
      if (action.type === "SET_MIN_PRICE") {
        return `Минимальная цена: ${Number(action.value).toLocaleString("ru-RU")} ₸`;
      }
      if (action.type === "SET_GOAL") {
        return `Цель: ${action.value}`;
      }
      if (action.type === "SET_MODE") {
        return `Режим: ${action.value}`;
      }
      if (action.type === "EXACT_MESSAGE") {
        return `Точная отправка: «${String(action.text || "").slice(0, 80)}»`;
      }
      if (action.type === "AI_COMPOSE" || action.type === "ASK_CLIENT") {
        return `Сообщение клиенту по смыслу: ${action.value || action.text || ""}`;
      }
      if (action.type === "ADD_INSTRUCTION") {
        return `Инструкция: ${action.value}`;
      }
      if (action.type === "STATUS_QUERY") {
        return "Запрос статуса";
      }
      if (action.type === "LIST_LEADS") {
        return "Список активных лидов";
      }
      if (action.type === "LAST_SEND_STATUS") {
        return "Проверка последней отправки";
      }
      if (action.type === "SEND_HERE") {
        return `Отправить на ${action.value}`;
      }
      return action.type;
    })
    .filter(Boolean);
}
