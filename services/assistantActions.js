import { getClientReply } from "./aiReplyParser.js";
import {
  canNotifySalesManager,
  getPresentationKpPath,
  getSalesManagerChatId,
  inspectPresentationKp,
} from "./appConfig.js";
import { hasNotification, markNotification, updateLead } from "./leadService.js";
import { log } from "./logger.js";
import { normalizePhone, toChatId } from "./phoneService.js";
import { sendManagerMessage, sendWhatsAppLocalFile, sendWhatsAppMessage } from "./whatsappService.js";

export const SERVICE_LABELS = {
  site: "Сайт",
  ads: "Реклама",
  site_ads: "Сайт и реклама",
  presentation: "Презентация",
  branding: "Логотип и брендинг",
  ai_manager: "AI-менеджер WhatsApp",
  complex: "Комплексный проект",
  unknown: "Услуга пока не определена",
};

export const PRESENTATION_KP_FILENAME = "CreoLab_Коммерческое_предложение.pdf";

const processedActionKeys = new Set();

export function resetAssistantActionKeys() {
  processedActionKeys.clear();
}

export function labelService(service) {
  if (!service || service === "unknown") {
    return SERVICE_LABELS.unknown;
  }
  return SERVICE_LABELS[service] || SERVICE_LABELS.unknown;
}

export function conversationIdOf(conversation) {
  return conversation?.leadId || conversation?.conversationId || conversation?.id || "";
}

export function incomingMessageIdOf(incomingMessage) {
  if (!incomingMessage || typeof incomingMessage === "string") {
    return "";
  }
  return String(incomingMessage.id || incomingMessage.idMessage || "").trim();
}

export function lastClientText(incomingMessage) {
  if (typeof incomingMessage === "string") {
    return incomingMessage.trim();
  }
  return String(incomingMessage?.text || incomingMessage?.message || "").trim();
}

export function clientDisplayName(conversation, contact) {
  const name = String(conversation?.clientName || contact?.name || "").trim();
  return name || "не указано";
}

export function formatClientWhatsApp(contact, conversation) {
  const phone = normalizePhone(contact?.phone || conversation?.clientPhone);
  return phone ? `+${phone}` : "не указано";
}

export function handoffKey(conversationId) {
  return `handoff:${conversationId}`;
}

export function decisionEventKey(conversationId, summary) {
  const issue =
    String(summary || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "unspecified";
  return `manager-event:${conversationId}:decision_required:${issue}`;
}

export function humanRequestedKey(conversationId, incomingMessageId) {
  return `manager-event:${conversationId}:human_requested:${incomingMessageId || "once"}`;
}

export function assetKey(incomingMessageId) {
  return `asset:${incomingMessageId}:presentation_kp`;
}

export function hasHandoffAlready(conversation) {
  const id = conversationIdOf(conversation);
  return (
    conversation?.handoff_already_created === true ||
    hasConversationNotification(conversation, handoffKey(id))
  );
}

export function hasDecisionEvent(conversation, summary) {
  const id = conversationIdOf(conversation);
  return hasConversationNotification(conversation, decisionEventKey(id, summary));
}

function hasConversationNotification(conversation, eventKey) {
  return Boolean(conversation?.notificationEvents?.includes(eventKey));
}

function clientChatIdOf(contact, conversation) {
  return contact?.chatId || toChatId(contact?.phone || conversation?.clientPhone);
}

function buildClientCard({ conversation, incomingMessage, contact, includeStatus = false }) {
  const summary = String(conversation?.requestSummary || incomingMessage?.summary || "").trim();
  const lines = [
    `Клиент: ${clientDisplayName(conversation, contact)}`,
    `WhatsApp: ${formatClientWhatsApp(contact, conversation)}`,
    `Услуга: ${labelService(conversation?.service)}`,
  ];
  if (includeStatus) {
    lines.push(`Статус: ${conversation?.lead_status || conversation?.status || "не указано"}`);
  }
  return {
    lines,
    summary: summary || "Дополнительная информация пока не собрана",
    lastMessage: lastClientText(incomingMessage) || "не указано",
  };
}

export function formatHandoffMessage({ conversation, incomingMessage, contact }) {
  const card = buildClientCard({ conversation, incomingMessage, contact, includeStatus: true });
  return [
    "🔔 Новая заявка CreoLab",
    "",
    ...card.lines,
    "",
    "Краткая информация:",
    card.summary,
    "",
    "Последнее сообщение клиента:",
    card.lastMessage,
  ].join("\n");
}

export function formatDecisionMessage({ conversation, incomingMessage, contact }) {
  const card = buildClientCard({ conversation, incomingMessage, contact });
  const reason = String(conversation?.requestSummary || "").trim() || "Требуется решение менеджера";
  return [
    "⚠️ Требуется решение менеджера",
    "",
    ...card.lines,
    "",
    "Причина:",
    reason,
    "",
    "Последнее сообщение клиента:",
    card.lastMessage,
  ].join("\n");
}

export function formatCombinedHandoffDecisionMessage({ conversation, incomingMessage, contact }) {
  const card = buildClientCard({ conversation, incomingMessage, contact, includeStatus: true });
  const reason = String(conversation?.requestSummary || "").trim() || "Требуется решение менеджера";
  return [
    "🔔 Новая заявка — требуется решение",
    "",
    ...card.lines,
    "",
    "Причина:",
    reason,
    "",
    "Последнее сообщение клиента:",
    card.lastMessage,
  ].join("\n");
}

export function formatHumanRequestedMessage({ conversation, incomingMessage, contact, includeHandoff = false }) {
  const card = buildClientCard({
    conversation,
    incomingMessage,
    contact,
    includeStatus: includeHandoff,
  });
  const summary = String(conversation?.requestSummary || "").trim() || "Дополнительная информация пока не собрана";
  const lines = [
    "👤 Клиент просит живого менеджера",
    "",
    ...card.lines,
  ];
  if (includeHandoff) {
    lines.push("", "Создана новая заявка.");
  }
  lines.push("", "Краткая информация:", summary, "", "Последнее сообщение клиента:", card.lastMessage);
  return lines.join("\n");
}

function rememberKey(eventKey) {
  if (!eventKey) {
    return false;
  }
  if (processedActionKeys.has(eventKey)) {
    return false;
  }
  processedActionKeys.add(eventKey);
  return true;
}

function forgetKey(eventKey) {
  if (eventKey) {
    processedActionKeys.delete(eventKey);
  }
}

async function withOneRetry(task) {
  try {
    return await task();
  } catch (error) {
    log("ASSISTANT ACTION RETRY", { error: error.message });
    return task();
  }
}

async function persistConversation(conversation, patch, deps) {
  Object.assign(conversation, patch);
  if (!conversation.leadId) {
    return conversation;
  }
  const next = await deps.updateLead(conversation.leadId, patch);
  if (next) {
    Object.assign(conversation, next);
  }
  return conversation;
}

async function persistEvent(conversation, eventKey, extraPatch, deps) {
  const events = new Set(conversation.notificationEvents || []);
  events.add(eventKey);
  const patch = {
    ...(extraPatch || {}),
    notificationEvents: [...events],
  };
  if (conversation.leadId) {
    await deps.markNotification(conversation.leadId, eventKey);
  }
  return persistConversation(conversation, patch, deps);
}

function resolveDeps(overrides = {}) {
  return {
    sendWhatsAppMessage: overrides.sendWhatsAppMessage || sendWhatsAppMessage,
    sendWhatsAppLocalFile: overrides.sendWhatsAppLocalFile || sendWhatsAppLocalFile,
    sendManagerMessage: overrides.sendManagerMessage || sendManagerMessage,
    updateLead: overrides.updateLead || updateLead,
    markNotification: overrides.markNotification || markNotification,
    hasNotification: overrides.hasNotification || hasNotification,
    getSalesManagerChatId: overrides.getSalesManagerChatId || getSalesManagerChatId,
    getPresentationKpPath: overrides.getPresentationKpPath || getPresentationKpPath,
    inspectPresentationKp: overrides.inspectPresentationKp || inspectPresentationKp,
    canNotifySalesManager: overrides.canNotifySalesManager || canNotifySalesManager,
  };
}

async function sendClientReply({ parsedResponse, contact, conversation, replyAlreadySent }, deps) {
  if (replyAlreadySent) {
    return { sent: true, skipped: true };
  }

  const reply = getClientReply(parsedResponse);
  const chatId = clientChatIdOf(contact, conversation);
  if (!chatId) {
    throw new Error("Нет WhatsApp чата клиента");
  }

  await withOneRetry(() => deps.sendWhatsAppMessage(chatId, reply));
  return { sent: true, skipped: false };
}

async function notifyManager(text, { conversation, contact, eventKey }, deps) {
  if (eventKey && (processedActionKeys.has(eventKey) || deps.hasNotification(conversation, eventKey))) {
    return false;
  }

  const allowed = deps.canNotifySalesManager(contact?.phone || conversation?.clientPhone);
  if (!allowed.ok) {
    log("ASSISTANT ACTION ERROR", {
      leadId: conversation?.leadId,
      action: "manager_notify",
      reason: allowed.reason,
    });
    return false;
  }

  if (!rememberKey(eventKey)) {
    return false;
  }

  try {
    await withOneRetry(() => deps.sendManagerMessage(text));
    return true;
  } catch (error) {
    forgetKey(eventKey);
    log("ASSISTANT ACTION ERROR", {
      leadId: conversation?.leadId,
      action: "manager_notify",
      error: error.message,
    });
    return false;
  }
}

async function processManagerActions({
  parsedResponse,
  conversation,
  incomingMessage,
  contact,
}, deps) {
  const handoff = parsedResponse.handoff === true;
  const managerEvent = String(parsedResponse.manager_event || "none").trim();
  const conversationId = conversationIdOf(conversation);
  const incomingId = incomingMessageIdOf(incomingMessage);
  const context = {
    conversation: {
      ...conversation,
      service: parsedResponse.service || conversation.service,
      requestSummary: parsedResponse.summary || conversation.requestSummary,
      lead_status: parsedResponse.lead_status || conversation.status,
    },
    incomingMessage,
    contact,
  };

  if (managerEvent === "human_requested") {
    const eventKey = humanRequestedKey(conversationId, incomingId);
    const shouldCreateHandoff = handoff && !hasHandoffAlready(conversation);
    const sent = await notifyManager(
      formatHumanRequestedMessage({
        ...context,
        includeHandoff: shouldCreateHandoff,
      }),
      { conversation, contact, eventKey },
      deps,
    );
    if (!sent) {
      return;
    }

    const patch = {
      human_requested: true,
      aiMode: "HUMAN",
    };
    if (shouldCreateHandoff) {
      patch.handoff_already_created = true;
      await persistEvent(conversation, handoffKey(conversationId), patch, deps);
    }
    await persistEvent(conversation, eventKey, patch, deps);
    return;
  }

  if (handoff && managerEvent === "decision_required") {
    const alreadyHandoff = hasHandoffAlready(conversation);
    const alreadyDecision = hasDecisionEvent(conversation, parsedResponse.summary);
    if (alreadyHandoff && alreadyDecision) {
      return;
    }
    if (alreadyHandoff) {
      const eventKey = decisionEventKey(conversationId, parsedResponse.summary);
      const sent = await notifyManager(formatDecisionMessage(context), { conversation, contact, eventKey }, deps);
      if (sent) {
        await persistEvent(conversation, eventKey, { decision_event_already_registered: true }, deps);
      }
      return;
    }
    if (alreadyDecision) {
      const eventKey = handoffKey(conversationId);
      const sent = await notifyManager(formatHandoffMessage(context), { conversation, contact, eventKey }, deps);
      if (sent) {
        await persistEvent(conversation, eventKey, { handoff_already_created: true }, deps);
      }
      return;
    }

    const decisionKey = decisionEventKey(conversationId, parsedResponse.summary);
    const combinedKey = `${handoffKey(conversationId)}+${decisionKey}`;
    const sent = await notifyManager(formatCombinedHandoffDecisionMessage(context), {
      conversation,
      contact,
      eventKey: combinedKey,
    }, deps);
    if (!sent) {
      return;
    }
    await persistEvent(conversation, handoffKey(conversationId), { handoff_already_created: true }, deps);
    await persistEvent(conversation, decisionKey, { decision_event_already_registered: true }, deps);
    return;
  }

  if (handoff && !hasHandoffAlready(conversation)) {
    const eventKey = handoffKey(conversationId);
    const sent = await notifyManager(formatHandoffMessage(context), { conversation, contact, eventKey }, deps);
    if (sent) {
      await persistEvent(conversation, eventKey, { handoff_already_created: true }, deps);
    }
  }

  if (managerEvent === "decision_required") {
    const eventKey = decisionEventKey(conversationId, parsedResponse.summary);
    if (hasDecisionEvent(conversation, parsedResponse.summary)) {
      return;
    }
    const sent = await notifyManager(formatDecisionMessage(context), { conversation, contact, eventKey }, deps);
    if (sent) {
      await persistEvent(conversation, eventKey, { decision_event_already_registered: true }, deps);
    }
  }
}

async function processSendAsset({
  parsedResponse,
  conversation,
  incomingMessage,
  contact,
  replySent,
}, deps) {
  const sendAsset = String(parsedResponse.send_asset || "none").trim();
  if (!replySent || sendAsset !== "presentation_kp") {
    return;
  }

  const incomingId = incomingMessageIdOf(incomingMessage);
  if (!incomingId) {
    log("ASSISTANT ACTION ERROR", {
      leadId: conversation?.leadId,
      action: "send_asset",
      reason: "missing_incoming_id",
    });
    return;
  }

  const eventKey = assetKey(incomingId);
  if (processedActionKeys.has(eventKey) || deps.hasNotification(conversation, eventKey)) {
    return;
  }

  const pdf = await deps.inspectPresentationKp();
  if (!pdf.ok) {
    log("ASSISTANT ACTION ERROR", {
      leadId: conversation?.leadId,
      action: "send_asset",
      reason: pdf.reason,
    });
    return;
  }

  const chatId = clientChatIdOf(contact, conversation);
  if (!chatId) {
    log("ASSISTANT ACTION ERROR", {
      leadId: conversation?.leadId,
      action: "send_asset",
      reason: "missing_client_chat",
    });
    return;
  }

  if (!rememberKey(eventKey)) {
    return;
  }

  try {
    await withOneRetry(() =>
      deps.sendWhatsAppLocalFile(chatId, pdf.path || deps.getPresentationKpPath(), {
        fileName: PRESENTATION_KP_FILENAME,
      }),
    );
    await persistEvent(conversation, eventKey, { presentation_kp_already_sent: true }, deps);
    if (conversation.leadId) {
      await persistEvent(conversation, "presentation_kp_sent", { presentation_kp_already_sent: true }, deps);
    }
  } catch (error) {
    forgetKey(eventKey);
    log("ASSISTANT ACTION ERROR", {
      leadId: conversation?.leadId,
      action: "send_asset",
      error: error.message,
    });
  }
}

export async function processAssistantActions(
  { parsedResponse, conversation, incomingMessage, contact, replyAlreadySent = false },
  overrides = {},
) {
  const deps = resolveDeps(overrides);
  const working = conversation || {};

  let replySent = replyAlreadySent;
  try {
    const replyResult = await sendClientReply(
      { parsedResponse, contact, conversation: working, replyAlreadySent },
      deps,
    );
    replySent = Boolean(replyResult.sent);
  } catch (error) {
    log("ASSISTANT ACTION ERROR", {
      leadId: working.leadId,
      action: "client_reply",
      error: error.message,
    });
    return {
      replySent: false,
      conversation: working,
    };
  }

  try {
    await processManagerActions(
      { parsedResponse, conversation: working, incomingMessage, contact },
      deps,
    );
  } catch (error) {
    log("ASSISTANT ACTION ERROR", {
      leadId: working.leadId,
      action: "manager",
      error: error.message,
    });
  }

  try {
    await processSendAsset(
      {
        parsedResponse,
        conversation: working,
        incomingMessage,
        contact,
        replySent,
      },
      deps,
    );
  } catch (error) {
    log("ASSISTANT ACTION ERROR", {
      leadId: working.leadId,
      action: "send_asset",
      error: error.message,
    });
  }

  return {
    replySent,
    conversation: working,
  };
}
