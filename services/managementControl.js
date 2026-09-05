import {
  addManagerInstruction,
  getLeadById,
  getLeadByPhone,
  getOrCreateLeadByPhone,
  listActiveLeads,
  listAllLeads,
  updateLead,
} from "./leadService.js";
import { getLastFocus, setLastFocus } from "./managerSession.js";
import {
  abortPendingClientChat,
  clearClientOutboundBlock,
  isClientOutboundBlocked,
} from "./clientOutboundGate.js";
import {
  isManagementControlEnabled,
  isManagementController,
  parseManagerAliases,
} from "./managementConfig.js";
import {
  cancelManagementInstruction,
  listActiveManagementInstructions,
  listManagementInstructions,
  saveManagementInstruction,
} from "./managementInstructionStore.js";
import { interpretManagementMessage, sameRuleKey } from "./managementParser.js";
import { formatBudgetLabel, parseBudgetAmount } from "./managementTime.js";
import { formatPhoneDisplay, normalizePhone, toChatId } from "./phoneService.js";
import { log } from "./logger.js";

function instructionMatchesLead(instruction, lead) {
  if (!instruction || instruction.status && instruction.status !== "active") {
    return false;
  }
  const scopeType = instruction.scopeType || "global";
  if (scopeType === "global") {
    return true;
  }
  if (scopeType === "client") {
    const scopeId = String(instruction.scopeId || "");
    return Boolean(
      scopeId &&
        (scopeId === lead?.leadId ||
          normalizePhone(scopeId) === normalizePhone(lead?.clientPhone)),
    );
  }
  if (scopeType === "group") {
    const min = Number(instruction.conditions?.budgetMin);
    if (!Number.isFinite(min)) {
      return true;
    }
    const budget = parseBudgetAmount(lead?.budget);
    return budget != null && budget >= min;
  }
  if (scopeType === "channel") {
    const channel = String(instruction.scopeId || instruction.conditions?.channel || "").toLowerCase();
    const source = String(lead?.source || lead?.channel || "").toLowerCase();
    return Boolean(channel && source.includes(channel));
  }
  return false;
}

export function selectRelevantInstructions(instructions, lead) {
  return (instructions || [])
    .filter((item) => item.status === "active")
    .filter((item) => instructionMatchesLead(item, lead))
    .sort((a, b) => {
      const priority = (b.priority || 0) - (a.priority || 0);
      if (priority !== 0) {
        return priority;
      }
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
}

export function matchDiscountCap(lead, instructions) {
  const relevant = selectRelevantInstructions(instructions, lead).filter(
    (item) => item.action?.kind === "max_discount" && Number(item.action.percent) >= 0,
  );
  if (!relevant.length) {
    return null;
  }
  return relevant[0];
}

export function matchHandoffRule(lead, instructions) {
  const relevant = selectRelevantInstructions(instructions, lead).filter(
    (item) => item.action?.kind === "handoff",
  );
  return relevant[0] || null;
}

export function matchPauseRule(lead, instructions) {
  return (
    selectRelevantInstructions(instructions, lead).find(
      (item) => item.instructionType === "pause" || item.action?.kind === "pause",
    ) || null
  );
}

export function extractOfferedDiscounts(text) {
  const found = [];
  const re = /(\d{1,2})\s*%/g;
  let match = re.exec(String(text || ""));
  while (match) {
    found.push(Number(match[1]));
    match = re.exec(String(text || ""));
  }
  return found;
}

export function evaluateClientSendPolicy({
  lead,
  reply = "",
  instructions = [],
  blocked = false,
  enabled = true,
}) {
  if (!enabled) {
    return { allowed: true };
  }

  if (lead?.aiMode === "PAUSED" || lead?.aiMode === "HUMAN") {
    return {
      allowed: false,
      reason: lead.aiMode === "HUMAN" ? "human" : "paused",
      instructionId: lead.lastManagementAction?.instructionId || null,
    };
  }

  if (blocked) {
    return {
      allowed: false,
      reason: "aborted",
      instructionId: lead?.lastManagementAction?.instructionId || null,
    };
  }

  const pause = matchPauseRule(lead, instructions);
  if (pause) {
    return { allowed: false, reason: "paused", instructionId: pause.id };
  }

  const cap = matchDiscountCap(lead, instructions);
  if (cap && reply) {
    const offered = extractOfferedDiscounts(reply);
    const max = Number(cap.action.percent);
    if (offered.some((value) => value > max)) {
      return {
        allowed: false,
        reason: "discount_cap",
        instructionId: cap.id,
        max,
      };
    }
  }

  return { allowed: true, instructionId: cap?.id || null };
}

export async function assertClientSendAllowed(lead, reply = "") {
  if (!isManagementControlEnabled()) {
    return { allowed: true };
  }

  try {
    const fresh = lead?.leadId ? (await getLeadById(lead.leadId)) || lead : lead;
    const instructions = await listActiveManagementInstructions();
    return evaluateClientSendPolicy({
      lead: fresh,
      reply,
      instructions,
      blocked: isClientOutboundBlocked(fresh?.clientPhone),
      enabled: true,
    });
  } catch (error) {
    log("MANAGEMENT POLICY", { error: error.message, failSafe: true });
    if (
      lead?.aiMode === "PAUSED" ||
      lead?.aiMode === "HUMAN" ||
      isClientOutboundBlocked(lead?.clientPhone)
    ) {
      return { allowed: false, reason: "failsafe_block" };
    }
    return { allowed: true, failOpen: true };
  }
}

export async function formatActiveManagementPrompt(lead) {
  if (!isManagementControlEnabled()) {
    return "";
  }
  try {
    const instructions = selectRelevantInstructions(
      await listActiveManagementInstructions(),
      lead,
    ).filter((item) =>
      ["create_rule", "update_rule", "restrict", "one_off", "handoff"].includes(item.instructionType),
    );
    if (!instructions.length) {
      return "";
    }
    const lines = instructions.map((item) => `- ${item.normalizedIntent || item.originalMessage}`);
    return [
      "АКТУАЛЬНЫЕ ПРАВИЛА РУКОВОДИТЕЛЯ (выше обычного сценария, ниже системных запретов):",
      ...lines,
    ].join("\n");
  } catch (error) {
    log("MANAGEMENT POLICY", { promptError: error.message });
    return "";
  }
}

export async function collectManagementEffects(lead) {
  if (!isManagementControlEnabled() || !lead) {
    return { patch: null, handoff: null };
  }

  try {
    const instructions = await listActiveManagementInstructions();
    const pause = matchPauseRule(lead, instructions);
    if (pause) {
      return {
        patch: {
          aiMode: "PAUSED",
          status: lead.status === "paused" ? lead.status : "paused",
          lastManagementAction: {
            type: "pause",
            instructionId: pause.id,
            at: new Date().toISOString(),
            note: pause.normalizedIntent,
          },
        },
        handoff: null,
      };
    }

    const handoff = matchHandoffRule(lead, instructions);
    if (handoff) {
      return {
        patch: {
          aiMode: "HUMAN",
          human_requested: true,
          assignedManager: handoff.action.assignTo || null,
          assignedManagerPhone: handoff.action.assignToPhone || null,
          lastManagementAction: {
            type: "handoff",
            instructionId: handoff.id,
            at: new Date().toISOString(),
            note: handoff.normalizedIntent,
          },
        },
        handoff,
      };
    }

    return { patch: null, handoff: null };
  } catch (error) {
    log("MANAGEMENT POLICY", { effectsError: error.message });
    return { patch: null, handoff: null };
  }
}

function findSuperseded(existing, incoming) {
  return (existing || []).find(
    (item) => item.status === "active" && sameRuleKey(item, incoming),
  );
}

async function resolveTargetLead(instruction, context = {}) {
  const scopeId = instruction.scopeId;
  if (scopeId) {
    const byPhone = await getLeadByPhone(scopeId);
    if (byPhone) {
      return byPhone;
    }
    const byId = await getLeadById(scopeId);
    if (byId) {
      return byId;
    }
    if (normalizePhone(scopeId)) {
      return getOrCreateLeadByPhone(scopeId, {
        source: "manager_outbound",
        direction: "outbound",
      });
    }
  }
  if (context.focus?.leadId) {
    const focused = await getLeadById(context.focus.leadId);
    if (focused) {
      return focused;
    }
  }
  if (context.focus?.phone) {
    return getLeadByPhone(context.focus.phone);
  }
  return null;
}

async function rememberFocus(lead, managerPhone) {
  if (!lead) {
    return;
  }
  await setLastFocus({
    managerPhone,
    phone: lead.clientPhone,
    leadId: lead.leadId,
    name: lead.clientName || lead.company || "",
  });
}

async function applyPause(instruction, context) {
  if (instruction.scopeType === "global") {
    const leads = await listActiveLeads();
    for (const lead of leads) {
      abortPendingClientChat(lead.clientPhone, "manager_stop");
      await updateLead(lead.leadId, {
        aiMode: "PAUSED",
        status: "paused",
        lastManagementAction: {
          type: "pause",
          instructionId: instruction.id || null,
          at: new Date().toISOString(),
          note: instruction.normalizedIntent,
        },
      });
      await addManagerInstruction(lead.leadId, { type: "SET_MODE", value: "PAUSED" });
    }
    return { count: leads.length };
  }

  const lead = await resolveTargetLead(instruction, context);
  if (!lead) {
    throw new Error("Клиент для паузы не найден");
  }
  abortPendingClientChat(lead.clientPhone, "manager_stop");
  const updated = await updateLead(lead.leadId, {
    aiMode: "PAUSED",
    status: "paused",
    lastManagementAction: {
      type: "pause",
      instructionId: instruction.id || null,
      at: new Date().toISOString(),
      note: instruction.normalizedIntent,
    },
  });
  await addManagerInstruction(lead.leadId, { type: "SET_MODE", value: "PAUSED" });
  await rememberFocus(updated, context.managerPhone);
  return { lead: updated };
}

async function applyResume(instruction, context) {
  const lead = await resolveTargetLead(instruction, context);
  if (!lead) {
    throw new Error("Клиент для возобновления не найден");
  }
  clearClientOutboundBlock(lead.clientPhone);
  const updated = await updateLead(lead.leadId, {
    aiMode: "AUTO",
    status: lead.status === "paused" ? "new" : lead.status,
    lastManagementAction: {
      type: "resume",
      instructionId: instruction.id || null,
      at: new Date().toISOString(),
      note: instruction.normalizedIntent,
    },
  });
  await addManagerInstruction(lead.leadId, { type: "SET_MODE", value: "AUTO" });
  await rememberFocus(updated, context.managerPhone);
  return { lead: updated };
}

async function applyHandoff(instruction, context) {
  if (instruction.scopeType !== "client") {
    return { ruleOnly: true };
  }
  const lead = await resolveTargetLead(instruction, context);
  if (!lead) {
    throw new Error("Клиент для передачи не найден");
  }
  abortPendingClientChat(lead.clientPhone, "manager_handoff");
  const updated = await updateLead(lead.leadId, {
    aiMode: "HUMAN",
    human_requested: true,
    assignedManager: instruction.action?.assignTo || null,
    assignedManagerPhone: instruction.action?.assignToPhone || null,
    lastManagementAction: {
      type: "handoff",
      instructionId: instruction.id || null,
      at: new Date().toISOString(),
      note: instruction.normalizedIntent,
    },
  });
  await addManagerInstruction(lead.leadId, {
    type: "SET_MODE",
    value: "HUMAN",
  });
  await rememberFocus(updated, context.managerPhone);
  return { lead: updated };
}

function formatConfirmation(applied) {
  const first = applied[0];
  if (!first) {
    return "Принял.";
  }

  const item = first.instruction;
  const action = item.action || {};

  if (item.instructionType === "pause") {
    return item.scopeType === "global"
      ? "Остановил. Автоответы приостановлены."
      : "Остановил. Клиент поставлен на паузу.";
  }

  if (item.instructionType === "resume") {
    const task = applied.find((entry) => entry.instruction.instructionType === "one_off");
    if (task?.instruction.action?.task) {
      return `Принял. Возобновляю диалог и ${toFirstPersonFuture(task.instruction.action.task)}.`;
    }
    return "Принял. Возобновляю диалог.";
  }

  if (action.kind === "max_discount") {
    const when = item.periodLabel && item.periodLabel !== "пока не отменю" ? `${capitalize(item.periodLabel)} ` : "";
    const group = item.conditions?.budgetMin
      ? `Для клиентов с бюджетом от ${formatBudgetLabel(item.conditions.budgetMin)} `
      : "";
    if (group) {
      return `Принял. ${group}можно давать скидку до ${action.percent}%.`;
    }
    return `Принял. ${when}максимальная скидка — ${action.percent}%.`.replace(/\s+/g, " ").trim();
  }

  if (action.kind === "handoff") {
    const assignee = action.assignToLabel || action.assignTo;
    if (item.conditions?.budgetMin) {
      return `Принял. Клиентов с бюджетом выше ${formatBudgetLabel(item.conditions.budgetMin)} буду сразу передавать ${assignee}.`;
    }
    return `Принял. Клиента передаю ${assignee}.`;
  }

  if (item.instructionType === "cancel_rule") {
    return "Принял. Правило отменено.";
  }

  return `Принял. ${item.normalizedIntent || "Команда активна."}`;
}

function capitalize(text) {
  const value = String(text || "");
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function decapitalize(text) {
  const value = String(text || "").trim();
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : "";
}

function toFirstPersonFuture(text) {
  return decapitalize(text)
    .replace(/[.]+$/g, "")
    .replace(/^предложи(?=[\s.,]|$)/i, "предложу")
    .replace(/^напиши(?=[\s.,]|$)/i, "напишу")
    .replace(/^скажи(?=[\s.,]|$)/i, "скажу")
    .replace(/^отправь(?=[\s.,]|$)/i, "отправлю");
}

async function applyInstruction(instruction, context) {
  const existing = await listActiveManagementInstructions();
  const superseded = findSuperseded(existing, instruction);
  if (instruction.instructionType === "cancel_rule") {
    const target =
      superseded ||
      existing.find((item) => {
        if (instruction.scopeType === "client") {
          return instructionMatchesLead(item, { clientPhone: instruction.scopeId, leadId: instruction.scopeId });
        }
        return item.scopeType === instruction.scopeType;
      });
    if (!target) {
      throw new Error("Нет активного правила, которое можно отменить");
    }
    await cancelManagementInstruction(target.id, "canceled_by_manager");
    return { instruction: { ...instruction, id: target.id }, saved: target };
  }

  if (instruction.instructionType === "pause") {
    const side = await applyPause(instruction, context);
    let saved;
    try {
      saved = await saveManagementInstruction({
        ...instruction,
        managerPhone: context.managerPhone,
        originalMessage: context.originalMessage,
        status: "active",
        executionResult: "activated",
      });
    } catch (error) {
      log("MANAGEMENT CONTROL", { saveAfterPauseFailed: true, error: error.message });
      saved = { id: null, ...instruction, status: "active" };
    }
    if (side.lead && saved.id) {
      await updateLead(side.lead.leadId, {
        lastManagementAction: {
          ...(side.lead.lastManagementAction || {}),
          instructionId: saved.id,
        },
      });
    }
    return { instruction: { ...instruction, id: saved.id }, saved };
  }

  if (instruction.instructionType === "resume") {
    const side = await applyResume(instruction, context);
    const saved = await saveManagementInstruction({
      ...instruction,
      managerPhone: context.managerPhone,
      originalMessage: context.originalMessage,
      status: "active",
      executionResult: "activated",
    });
    if (side.lead) {
      await updateLead(side.lead.leadId, {
        lastManagementAction: {
          ...(side.lead.lastManagementAction || {}),
          instructionId: saved.id,
        },
      });
    }
    return { instruction: { ...instruction, id: saved.id }, saved };
  }

  if (instruction.action?.kind === "handoff" && instruction.scopeType === "client") {
    const side = await applyHandoff(instruction, context);
    const saved = await saveManagementInstruction({
      ...instruction,
      managerPhone: context.managerPhone,
      originalMessage: context.originalMessage,
      supersedesInstructionId: superseded?.id || null,
      status: "active",
      executionResult: "activated",
    });
    if (side.lead) {
      await updateLead(side.lead.leadId, {
        assignedManager: instruction.action.assignTo,
        assignedManagerPhone: instruction.action.assignToPhone,
        lastManagementAction: {
          type: "handoff",
          instructionId: saved.id,
          at: new Date().toISOString(),
          note: instruction.normalizedIntent,
        },
      });
    }
    return { instruction: { ...instruction, id: saved.id }, saved };
  }

  const saved = await saveManagementInstruction({
    ...instruction,
    managerPhone: context.managerPhone,
    originalMessage: context.originalMessage,
    supersedesInstructionId: superseded?.id || null,
    status: "active",
    executionResult: "activated",
  });
  return { instruction: { ...instruction, id: saved.id }, saved };
}

function startOfTodayIso(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

async function answerQuery(parsed, context) {
  if (parsed.query === "active_rules") {
    const active = (await listActiveManagementInstructions()).filter((item) =>
      ["create_rule", "update_rule", "restrict", "handoff", "pause", "one_off"].includes(
        item.instructionType,
      ),
    );
    if (!active.length) {
      return "Сейчас нет активных правил руководителя.";
    }
    return ["Сейчас действуют:", "", ...active.map((item, index) => `${index + 1}. ${item.normalizedIntent}`)].join(
      "\n",
    );
  }

  if (parsed.query === "status") {
    const leads = await listActiveLeads();
    const paused = leads.filter((lead) => lead.aiMode === "PAUSED");
    const working = leads.filter((lead) => lead.aiMode === "AUTO");
    return [
      `Сейчас в работе: ${working.length}.`,
      `На паузе: ${paused.length}.`,
      paused.length
        ? `Пауза: ${paused.map((lead) => lead.clientName || formatPhoneDisplay(lead.clientPhone)).join(", ")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.query === "tasks_today") {
    const since = startOfTodayIso();
    const items = (await listManagementInstructions()).filter(
      (item) => item.createdAt >= since && item.instructionType !== "status_query",
    );
    if (!items.length) {
      return "Сегодня управляющих поручений ещё не было.";
    }
    return ["Сегодня вы поручали:", "", ...items.map((item, index) => `${index + 1}. ${item.normalizedIntent}`)].join(
      "\n",
    );
  }

  if (parsed.query === "handoffs_today") {
    const since = startOfTodayIso();
    const leads = await listAllLeads();
    const handed = leads.filter(
      (lead) =>
        lead.assignedManager &&
        lead.lastManagementAction?.type === "handoff" &&
        String(lead.lastManagementAction.at || "") >= since,
    );
    if (!handed.length) {
      return "Сегодня никого не передавал менеджерам.";
    }
    return [
      "Сегодня передал:",
      ...handed.map(
        (lead) =>
          `• ${lead.clientName || formatPhoneDisplay(lead.clientPhone)} → ${lead.assignedManager}`,
      ),
    ].join("\n");
  }

  if (parsed.query === "lead_status") {
    const leads = await listAllLeads();
    const hint = String(parsed.nameHint || "").toLowerCase();
    const lead =
      (parsed.phone && (await getLeadByPhone(parsed.phone))) ||
      (parsed.leadId && (await getLeadById(parsed.leadId))) ||
      leads.find((item) => String(item.clientName || "").toLowerCase().includes(hint));
    if (!lead) {
      return "Клиент не найден. Укажите имя или номер.";
    }
    await rememberFocus(lead, context.managerPhone);
    return [
      `${lead.clientName || formatPhoneDisplay(lead.clientPhone)}`,
      `Статус: ${lead.status}`,
      `Режим AI: ${lead.aiMode}`,
      `Бюджет: ${lead.budget || "не выяснено"}`,
      lead.lastClientMessage
        ? `Последнее сообщение клиента: ${String(lead.lastClientMessage).slice(0, 280)}`
        : "Ждём следующее сообщение клиента.",
    ].join("\n");
  }

  if (parsed.query === "explain") {
    const lead =
      (parsed.phone && (await getLeadByPhone(parsed.phone))) ||
      (parsed.leadId && (await getLeadById(parsed.leadId))) ||
      (context.focus?.leadId && (await getLeadById(context.focus.leadId))) ||
      (context.focus?.phone && (await getLeadByPhone(context.focus.phone)));
    if (!lead?.lastManagementAction?.instructionId) {
      return "По этому клиенту нет записанной управляющей причины. Я опирался на стандартный сценарий.";
    }
    const instruction = (await listManagementInstructions()).find(
      (item) => item.id === lead.lastManagementAction.instructionId,
    );
    if (!instruction) {
      return `Последнее действие: ${lead.lastManagementAction.note || lead.lastManagementAction.type}.`;
    }
    const when = new Date(instruction.createdAt).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Almaty",
    });
    if (lead.lastManagementAction.type === "handoff") {
      const assignee =
        instruction.action?.assignToLabel || lead.assignedManager || instruction.action?.assignTo;
      return `Я передал клиента ${assignee}, потому что действует ваше правило от ${when}: ${instruction.normalizedIntent}. ${
        lead.budget ? `У клиента указан бюджет ${lead.budget}.` : ""
      }`.trim();
    }
    return `Причина: ваше правило от ${when} — ${instruction.normalizedIntent}.`;
  }

  return "Не нашёл данных по этому запросу.";
}

export async function handleManagementControl({
  message,
  senderChatId,
  notify,
  parseWithAi,
} = {}) {
  if (!isManagementControlEnabled()) {
    return { handled: false };
  }
  if (!isManagementController(senderChatId)) {
    return { handled: false };
  }

  const managerPhone = normalizePhone(senderChatId);
  let focus = null;
  try {
    focus = await getLastFocus(managerPhone);
  } catch (error) {
    log("MANAGEMENT CONTROL", { focusError: error.message });
  }

  let parsed;
  try {
    parsed = await interpretManagementMessage(message, {
      focus,
      managerPhone,
      aliases: parseManagerAliases(),
      allowAi: true,
      parseWithAi,
    });
  } catch (error) {
    log("MANAGEMENT CONTROL", { parseError: error.message });
    return { handled: false };
  }

  if (!parsed.handled) {
    return { handled: false };
  }

  if (parsed.kind === "clarify") {
    await notify(parsed.clarification);
    return { handled: true, result: { ok: true, kind: "clarify" } };
  }

  if (parsed.kind === "query") {
    try {
      const answer = await answerQuery(parsed, { managerPhone, focus });
      await notify(answer);
      return { handled: true, result: { ok: true, kind: "query" } };
    } catch (error) {
      log("MANAGEMENT CONTROL", { queryError: error.message });
      await notify("Не удалось прочитать текущее состояние. Повторите запрос.");
      return { handled: true, result: { ok: false, kind: "query_error" } };
    }
  }

  try {
    const applied = [];
    for (const instruction of parsed.instructions || []) {
      applied.push(
        await applyInstruction(instruction, {
          managerPhone,
          originalMessage: message,
          focus,
        }),
      );
    }
    const confirmation = formatConfirmation(applied);
    await notify(confirmation);
    return {
      handled: true,
      result: { ok: true, kind: "applied", ids: applied.map((item) => item.saved?.id).filter(Boolean) },
    };
  } catch (error) {
    log("MANAGEMENT CONTROL", { applyError: error.message });
    await notify(`Не удалось активировать команду: ${error.message}`);
    return { handled: true, result: { ok: false, kind: "apply_error" } };
  }
}

export function findLeadByNameHint(leads, hint) {
  const needle = String(hint || "").toLowerCase().trim();
  if (!needle) {
    return null;
  }
  return (
    (leads || []).find((lead) => String(lead.clientName || "").toLowerCase().includes(needle)) ||
    null
  );
}

export { toChatId };
