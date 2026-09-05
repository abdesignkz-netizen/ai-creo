import {
  extractAllPhones,
  extractPhoneCandidate,
} from "./phoneService.js";
import { parseLeadId } from "./leadService.js";
import { findManagerAlias, normalizePersonName } from "./managementConfig.js";
import { formatBudgetLabel, parseBudgetAmount, parseValidityPeriod } from "./managementTime.js";
import {
  isBroadcastCommand,
  isConfirmSend,
  isFileSendCommand,
} from "./managerCommandService.js";
import { parseManagementInstructionWithAi } from "./aiService.js";
import { log } from "./logger.js";

const EXACT_SEND_RE = /(?:отправь|напиши дословно|передай дословно)\s*:\s*/i;

const QUERY_RULES_RE =
  /какие\s+(мои\s+)?правил|какие\s+правил.*действуют|что\s+сейчас\s+действует|активные\s+правил/i;
const QUERY_STATUS_RE =
  /что\s+ты\s+сейчас\s+делаешь|кого\s+ты\s+сейчас\s+обрабатываешь|кто\s+на\s+паузе|каких\s+клиентов\s+на\s+паузе|какие\s+клиенты\s+на\s+паузе/i;
const QUERY_TASKS_RE =
  /что\s+я\s+(тебе\s+)?сегодня\s+поручал|какие\s+правил.*изменил|история\s+поручен/i;
const QUERY_EXPLAIN_RE =
  /почему\s+ты|зачем\s+ты\s+(передал|предложил|написал|остановил)/i;
const QUERY_HANDOFFS_RE = /кого\s+сегодня\s+передал|кого\s+передал\s+менеджер/i;
const PAUSE_RE =
  /^(стоп|остановись|останови|пауза)([.!\s]|$)|не\s+отвечай|ничего\s+(ему|ей|клиенту|этому)?\s*не\s+(отвечай|отправляй|пиши)|поставь(?:те)?\s+(клиента\s+)?на\s+паузу|не\s+трогай\s+(эту\s+заявку|этого\s+клиента|его)|пока\s+ничего\s+(ему|ей|клиенту)?\s*не\s+(отвечай|отправляй|пиши)|заявк\w*\s+пока\s+не\s+обрабатывай/i;
const RESUME_RE = /продолжай|возобнови|сними(?:те)?\s+паузу|можно\s+отвечать|работай\s+дальше/i;
const CANCEL_RULE_RE = /отмени(?:те)?\s+(это\s+)?правил|убери(?:те)?\s+(это\s+)?правил|больше\s+не\s+действу/i;
const CLIENT_SCOPE_RE =
  /этому\s+клиенту|этот\s+клиент|этой\s+заявк|этому\s+лиду|(^|[\s,])(ему|ей)([\s,.]|$)|только\s+этому/i;
const GLOBAL_SCOPE_RE = /никому|всем\s+клиент|глобальн|на\s+всех/i;
const EXPENSIVE_AMBIGUOUS_RE = /дорогих\s+клиент|дорогого\s+клиент/i;

export function isOperationalManagerMessage(message) {
  const text = String(message || "").trim();
  if (!text) {
    return false;
  }
  return (
    isBroadcastCommand(text) ||
    isConfirmSend(text) ||
    isFileSendCommand(text) ||
    EXACT_SEND_RE.test(text)
  );
}

function priorityForScope(scopeType) {
  if (scopeType === "client") {
    return 80;
  }
  if (scopeType === "group") {
    return 50;
  }
  if (scopeType === "channel") {
    return 40;
  }
  return 20;
}

function extractDiscountPercent(text) {
  const match =
    String(text || "").match(/скидк\w*[^%\d]{0,24}(\d{1,2})\s*%/i) ||
    String(text || "").match(/(?:максимум|не\s+больше|не\s+выше|до)\s*(\d{1,2})\s*%/i) ||
    String(text || "").match(/(\d{1,2})\s*%/);
  return match ? Number(match[1]) : null;
}

function extractBudgetThreshold(text) {
  const withUnit = String(text || "").match(
    /(?:бюджет\w*\s*(?:выше|от|больше)?|(?:^|[\s,])(?:от|выше|больше))\s*(\d+(?:[.,]\d+)?)\s*(млн|миллион|тыс|тысяч)/i,
  );
  if (withUnit) {
    return parseBudgetAmount(`${withUnit[1]} ${withUnit[2]}`);
  }
  return null;
}

function extractAssigneeName(text) {
  const match = String(text || "").match(
    /переда(?:й|вай|йте)\s+(?:его|её|ее|клиент\w*|заявк\w*|лид\w*)?\s*(?:сразу\s+)?(?:менеджеру\s+)?([A-Za-zА-Яа-яЁё-]+)/i,
  );
  if (match?.[1] && !/менеджеру|человеку|мне/i.test(match[1])) {
    return match[1];
  }
  const named = String(text || "").match(
    /переда(?:й|вай|йте)\s+([A-Za-zА-Яа-яЁё-]+)/i,
  );
  if (named?.[1] && !/его|ее|её|мне|заявку|клиента|лид/i.test(named[1])) {
    return named[1];
  }
  return null;
}

function looksLikeSelfAssign(text) {
  return /этот\s+лид\s+теперь\s+на\s+мне|забери\s+клиента|передай\s+мне|теперь\s+на\s+мне/i.test(
    String(text || ""),
  );
}

function looksLikeDiscountRule(text) {
  if (!/(\d{1,2})\s*%/.test(text)) {
    return false;
  }
  return /скидк|можно\s+дать|давать\s+до|давай\s+до|дай\s+до|не\s+больше|не\s+выше|максимум/i.test(text);
}

function looksLikeHandoffRule(text) {
  return /переда(?:й|вай|йте)|отдай\s+заявк/i.test(text);
}

function detectChannel(text) {
  if (/instagram|инстаграм/i.test(text)) {
    return "instagram";
  }
  if (/сайт|заявк\w*\s+с\s+сайт/i.test(text)) {
    return "site";
  }
  return null;
}

function resolveScope({ text, phone, leadId, focus }) {
  const channel = detectChannel(text);
  if (channel && /заявк|канал|инстаграм|instagram/i.test(text)) {
    return { scopeType: "channel", scopeId: channel };
  }

  const budget = extractBudgetThreshold(text);
  if (budget && /клиент/i.test(text) && !CLIENT_SCOPE_RE.test(text)) {
    return {
      scopeType: "group",
      scopeId: `budget>=${budget}`,
      conditions: { budgetMin: budget },
    };
  }

  if (GLOBAL_SCOPE_RE.test(text) || (!CLIENT_SCOPE_RE.test(text) && !phone && !leadId && !focus?.phone)) {
    if (looksLikeDiscountRule(text) || /никому|всем/i.test(text) || (!CLIENT_SCOPE_RE.test(text) && !phone)) {
      if (!CLIENT_SCOPE_RE.test(text) && !phone && !leadId) {
        return { scopeType: "global", scopeId: null, conditions: budget ? { budgetMin: budget } : {} };
      }
    }
  }

  if (phone || leadId || CLIENT_SCOPE_RE.test(text) || focus?.phone) {
    return {
      scopeType: "client",
      scopeId: phone || leadId || focus?.phone || focus?.leadId || null,
      conditions: {},
    };
  }

  if (budget) {
    return {
      scopeType: "group",
      scopeId: `budget>=${budget}`,
      conditions: { budgetMin: budget },
    };
  }

  return { scopeType: "global", scopeId: null, conditions: {} };
}

function buildInstruction({
  message,
  instructionType,
  action,
  scope,
  now,
  normalizedIntent,
  extraConditions = {},
}) {
  const validity = parseValidityPeriod(message, now);
  const conditions = { ...(scope.conditions || {}), ...extraConditions };
  const scopeType = conditions.budgetMin && scope.scopeType === "global" ? "group" : scope.scopeType;
  const scopeId =
    scopeType === "group" && conditions.budgetMin && !scope.scopeId
      ? `budget>=${conditions.budgetMin}`
      : scope.scopeId;

  return {
    instructionType,
    scopeType,
    scopeId,
    conditions,
    action,
    priority: priorityForScope(scopeType),
    validFrom: validity.validFrom,
    validUntil: validity.validUntil,
    periodLabel: validity.periodLabel,
    normalizedIntent,
    originalMessage: String(message || "").trim(),
  };
}

export function interpretManagementMessageByRules(message, context = {}) {
  const text = String(message || "").trim();
  if (!text || isOperationalManagerMessage(text)) {
    return { handled: false, source: "rules" };
  }

  const now = context.now || new Date();
  const phones = extractAllPhones(text);
  const phone = phones[0] || extractPhoneCandidate(text) || null;
  const leadId = parseLeadId(text);
  const focus = context.focus || null;
  const scope = resolveScope({ text, phone, leadId, focus });

  if (QUERY_RULES_RE.test(text)) {
    return { handled: true, kind: "query", query: "active_rules", source: "rules" };
  }
  if (QUERY_STATUS_RE.test(text)) {
    return { handled: true, kind: "query", query: "status", source: "rules" };
  }
  if (QUERY_TASKS_RE.test(text)) {
    return { handled: true, kind: "query", query: "tasks_today", source: "rules" };
  }
  if (QUERY_HANDOFFS_RE.test(text)) {
    return { handled: true, kind: "query", query: "handoffs_today", source: "rules" };
  }
  if (QUERY_EXPLAIN_RE.test(text)) {
    return {
      handled: true,
      kind: "query",
      query: "explain",
      phone: phone || focus?.phone || null,
      leadId: leadId || focus?.leadId || null,
      source: "rules",
    };
  }

  if (EXPENSIVE_AMBIGUOUS_RE.test(text) && extractBudgetThreshold(text) == null) {
    return {
      handled: true,
      kind: "clarify",
      clarification: "Уточните, пожалуйста: от какой суммы считать клиента дорогим?",
      source: "rules",
    };
  }

  if (CANCEL_RULE_RE.test(text)) {
    return {
      handled: true,
      kind: "apply",
      instructions: [
        buildInstruction({
          message: text,
          instructionType: "cancel_rule",
          action: { kind: "cancel", target: "latest_matching" },
          scope,
          now,
          normalizedIntent: "Отменить текущее правило",
        }),
      ],
      source: "rules",
    };
  }

  if (PAUSE_RE.test(text)) {
    const targetScope =
      GLOBAL_SCOPE_RE.test(text) && !CLIENT_SCOPE_RE.test(text)
        ? { scopeType: "global", scopeId: null, conditions: {} }
        : {
            scopeType: "client",
            scopeId: phone || leadId || focus?.phone || focus?.leadId || null,
            conditions: {},
          };
    if (targetScope.scopeType === "client" && !targetScope.scopeId) {
      return {
        handled: true,
        kind: "clarify",
        clarification: "Уточните, какого клиента поставить на паузу — имя или номер.",
        source: "rules",
      };
    }
    return {
      handled: true,
      kind: "apply",
      instructions: [
        buildInstruction({
          message: text,
          instructionType: "pause",
          action: { kind: "pause" },
          scope: targetScope,
          now,
          normalizedIntent:
            targetScope.scopeType === "global"
              ? "Приостановить автоответы всем клиентам"
              : "Поставить клиента на паузу и ничего не отправлять",
        }),
      ],
      source: "rules",
    };
  }

  if (RESUME_RE.test(text)) {
    const targetScope = {
      scopeType: "client",
      scopeId: phone || leadId || focus?.phone || focus?.leadId || null,
      conditions: {},
    };
    if (!targetScope.scopeId && !GLOBAL_SCOPE_RE.test(text)) {
      return {
        handled: true,
        kind: "clarify",
        clarification: "Уточните, какого клиента возобновить.",
        source: "rules",
      };
    }
    const leftover = text
      .replace(RESUME_RE, " ")
      .replace(/^[.\s,]+/, "")
      .trim();
    const instructions = [
      buildInstruction({
        message: text,
        instructionType: "resume",
        action: { kind: "resume", task: leftover || null },
        scope: GLOBAL_SCOPE_RE.test(text)
          ? { scopeType: "global", scopeId: null, conditions: {} }
          : targetScope,
        now,
        normalizedIntent: leftover
          ? `Возобновить диалог и выполнить: ${leftover}`
          : "Возобновить диалог",
      }),
    ];
    if (leftover && leftover.length >= 6) {
      instructions.push(
        buildInstruction({
          message: leftover,
          instructionType: "one_off",
          action: { kind: "one_off", task: leftover },
          scope: targetScope.scopeId
            ? targetScope
            : { scopeType: "client", scopeId: focus?.phone || null, conditions: {} },
          now,
          normalizedIntent: leftover,
        }),
      );
    }
    return { handled: true, kind: "apply", instructions, source: "rules" };
  }

  if (looksLikeDiscountRule(text)) {
    const percent = extractDiscountPercent(text);
    if (percent == null) {
      return {
        handled: true,
        kind: "clarify",
        clarification: "Уточните, пожалуйста, какой максимальный процент скидки поставить.",
        source: "rules",
      };
    }
    const budget = extractBudgetThreshold(text);
    const discountScope = budget
      ? { scopeType: "group", scopeId: `budget>=${budget}`, conditions: { budgetMin: budget } }
      : CLIENT_SCOPE_RE.test(text) || phone
        ? {
            scopeType: "client",
            scopeId: phone || focus?.phone || null,
            conditions: {},
          }
        : { scopeType: "global", scopeId: null, conditions: {} };
    const period = parseValidityPeriod(text, now);
    const budgetLabel = budget ? `клиентам с бюджетом от ${formatBudgetLabel(budget)} ` : "";
    const when = period.periodLabel === "пока не отменю" ? "" : `${period.periodLabel} `;
    return {
      handled: true,
      kind: "apply",
      instructions: [
        buildInstruction({
          message: text,
          instructionType: "create_rule",
          action: { kind: "max_discount", percent },
          scope: discountScope,
          now,
          extraConditions: budget ? { budgetMin: budget } : {},
          normalizedIntent: `${when}${budgetLabel}максимальная скидка — ${percent}%`.replace(/\s+/g, " ").trim(),
        }),
      ],
      source: "rules",
    };
  }

  if (looksLikeHandoffRule(text) || looksLikeSelfAssign(text)) {
    const assigneeName = looksLikeSelfAssign(text) ? "мне" : extractAssigneeName(text);
    if (!assigneeName) {
      return {
        handled: true,
        kind: "clarify",
        clarification: "Уточните, кому передать клиента.",
        source: "rules",
      };
    }

    let alias = null;
    if (assigneeName !== "мне") {
      alias = findManagerAlias(assigneeName) || null;
      if (!alias && context.aliases) {
        alias =
          context.aliases.find(
            (item) => normalizePersonName(item.name) === normalizePersonName(assigneeName),
          ) || null;
      }
      if (!alias) {
        return {
          handled: true,
          kind: "clarify",
          clarification: `Не нашёл сотрудника «${assigneeName}» в справочнике. Добавьте его в MANAGER_ALIASES или укажите номер.`,
          source: "rules",
        };
      }
    }

    const budget = extractBudgetThreshold(text);
    const handoffScope = budget
      ? { scopeType: "group", scopeId: `budget>=${budget}`, conditions: { budgetMin: budget } }
      : {
          scopeType: "client",
          scopeId: phone || leadId || focus?.phone || focus?.leadId || null,
          conditions: {},
        };

    if (handoffScope.scopeType === "client" && !handoffScope.scopeId) {
      return {
        handled: true,
        kind: "clarify",
        clarification: "Уточните, какого клиента передать — имя или номер.",
        source: "rules",
      };
    }

    const assignTo = alias?.name || (assigneeName === "мне" ? context.managerName || "руководителю" : assigneeName);
    const assignToLabel = assigneeName === "мне" ? assignTo : assigneeName;
    const assignToPhone = alias?.phone || context.managerPhone || null;
    const budgetLabel = budget ? `клиентов с бюджетом выше ${formatBudgetLabel(budget)} ` : "клиента ";
    return {
      handled: true,
      kind: "apply",
      instructions: [
        buildInstruction({
          message: text,
          instructionType: budget ? "create_rule" : "handoff",
          action: {
            kind: "handoff",
            assignTo,
            assignToLabel,
            assignToPhone,
          },
          scope: handoffScope,
          now,
          extraConditions: budget ? { budgetMin: budget } : {},
          normalizedIntent: budget
            ? `${budgetLabel}сразу передавать ${assignToLabel}`
            : `Передать клиента ${assignToLabel}`,
        }),
      ],
      source: "rules",
    };
  }

  const statusByName = text.match(/что\s+там\s+с\s+([A-Za-zА-Яа-яЁё-]+)/i);
  if (statusByName?.[1]) {
    return {
      handled: true,
      kind: "query",
      query: "lead_status",
      nameHint: statusByName[1],
      phone,
      leadId,
      source: "rules",
    };
  }

  return { handled: false, source: "rules" };
}

function normalizeAiInstruction(raw, message, now) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const action = raw.action && typeof raw.action === "object" ? raw.action : { kind: "text_rule", text: message };
  return {
    instructionType: raw.instructionType || "create_rule",
    scopeType: raw.scopeType || "global",
    scopeId: raw.scopeId || null,
    conditions: raw.conditions || {},
    action,
    priority: Number(raw.priority) || priorityForScope(raw.scopeType || "global"),
    validFrom: raw.validFrom || parseValidityPeriod(message, now).validFrom,
    validUntil: raw.validUntil ?? parseValidityPeriod(message, now).validUntil,
    periodLabel: raw.periodLabel || parseValidityPeriod(message, now).periodLabel,
    normalizedIntent: raw.normalizedIntent || String(message || "").trim(),
    originalMessage: String(message || "").trim(),
  };
}

export async function interpretManagementMessage(message, context = {}) {
  const byRules = interpretManagementMessageByRules(message, context);
  if (byRules.handled) {
    return byRules;
  }

  if (isOperationalManagerMessage(message) || context.skipAi) {
    return { handled: false, source: "rules" };
  }

  const looksManageable =
    /правил|скидк|переда|пауз|стоп|не\s+предлагай|не\s+давай|возобнов|продолж|почему|статус|приоритет|стратег/i.test(
      String(message || ""),
    );
  if (!looksManageable || typeof context.parseWithAi !== "function" && !context.allowAi) {
    return { handled: false, source: "rules" };
  }

  try {
    const parsed =
      typeof context.parseWithAi === "function"
        ? await context.parseWithAi(message, context)
        : await parseManagementInstructionWithAi(message, context);
    if (parsed?.needsClarification && parsed.clarification) {
      return {
        handled: true,
        kind: "clarify",
        clarification: parsed.clarification,
        source: "ai",
      };
    }
    const instructions = (parsed?.instructions || [])
      .map((item) => normalizeAiInstruction(item, message, context.now || new Date()))
      .filter(Boolean);
    if (!instructions.length) {
      return { handled: false, source: "ai" };
    }
    return { handled: true, kind: "apply", instructions, source: "ai" };
  } catch (error) {
    log("MANAGEMENT PARSE", { aiFallback: true, error: error.message });
    return { handled: false, source: "ai_error" };
  }
}

export function sameRuleKey(a, b) {
  if (!a || !b) {
    return false;
  }
  const actionA = a.action?.kind || "";
  const actionB = b.action?.kind || "";
  if (actionA !== actionB) {
    return false;
  }
  if ((a.scopeType || "global") !== (b.scopeType || "global")) {
    return false;
  }
  if (String(a.scopeId || "") !== String(b.scopeId || "")) {
    return false;
  }
  const budgetA = a.conditions?.budgetMin ?? null;
  const budgetB = b.conditions?.budgetMin ?? null;
  return budgetA === budgetB;
}

