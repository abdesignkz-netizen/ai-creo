import {
  appendConversation,
  getOrCreateLeadByPhone,
  hasNotification,
  updateLead,
} from "./leadService.js";
import { generateAiReply, detectGreeting, todayAlmatyDate } from "./aiService.js";
import { sendWhatsAppMessage } from "./whatsappService.js";
import { toChatId } from "./phoneService.js";
import {
  notifyClientReplied,
  notifyImportantEvent,
  notifyNewLead,
} from "./notificationService.js";
import { log } from "./logger.js";

const TRIVIAL_RE =
  /^(здравствуйте|здравстуйте|добрый день|добрый вечер|доброе утро|привет|хай|hello|hi|сколько стоит\??|цена\??|стоимость\??)[\s!.?]*$/i;

const SERVICE_RE =
  /сайт|лендинг|реклам|презентац|магазин|ai[\s-]?менеджер|google ads|tiktok/i;

function isTrivialMessage(message) {
  return TRIVIAL_RE.test(String(message || "").trim());
}

function mentionsService(message) {
  return SERVICE_RE.test(String(message || ""));
}

function mapPipelineStatus(result, current) {
  if (result?.pipeline_status) {
    return result.pipeline_status;
  }
  if (result?.lead_status === "hot") {
    return current === "new" ? "hot" : current === "qualified" ? "hot" : "hot";
  }
  if (result?.lead_status === "warm" && current === "new") {
    return "qualified";
  }
  return current || "new";
}

function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "" && value !== "unknown") {
      return value;
    }
  }
  return null;
}

function hasSubstantiveData(lead, result, message) {
  const service = pickValue(lead.service, result?.service);
  return Boolean(
    lead.company ||
      lead.clientName ||
      lead.requestSummary ||
      lead.budget ||
      lead.deadline ||
      (service && service !== "unknown") ||
      result?.brief_completed ||
      mentionsService(message) ||
      (!isTrivialMessage(message) && String(message).trim().length >= 18),
  );
}

function shouldNotifyNewLead(lead, result, message) {
  if (hasNotification(lead, "new_lead")) {
    return false;
  }
  if (lead.source === "manager_outbound") {
    return false;
  }
  if (isTrivialMessage(message) && !lead.company && !lead.clientName && !mentionsService(message)) {
    return false;
  }
  return hasSubstantiveData(lead, result, message);
}

export async function handleClientMessage({ chatId, message, senderName }) {
  log("CLIENT", { chatId, message: String(message || "").slice(0, 240) });

  const lead = await getOrCreateLeadByPhone(chatId, {
    source: "inbound",
    direction: "inbound",
  });

  let current = lead;
  if (senderName && !current.clientName) {
    current = await updateLead(current.leadId, { clientName: senderName });
  }

  if (current.aiMode === "HUMAN" || current.aiMode === "PAUSED") {
    await appendConversation(current.leadId, [{ role: "user", content: message }]);
    await notifyImportantEvent(
      current,
      "client_message_while_paused",
      `Клиент написал:\n«${String(message).slice(0, 400)}»`,
    );
    log("MODE CHANGE", {
      leadId: current.leadId,
      skippedReply: true,
      aiMode: current.aiMode,
    });
    return { skipped: true, reason: current.aiMode, leadId: current.leadId };
  }

  const history = current.conversationHistory || [];
  const { reply, result, latencyMs } = await generateAiReply({
    message,
    history,
    lead: current,
  });

  const nextStatus = mapPipelineStatus(result, current.status);
  const patch = {
    clientName: pickValue(result.client_name, current.clientName),
    company: pickValue(result.company, current.company),
    service: pickValue(result.service, current.service),
    requestSummary: pickValue(result.summary, result.requestSummary, current.requestSummary),
    budget: pickValue(result.budget, current.budget),
    deadline: pickValue(result.deadline, current.deadline),
    status: nextStatus,
  };

  if (detectGreeting(reply) && !current.lastGreetingDate) {
    patch.lastGreetingDate = todayAlmatyDate();
  } else if (detectGreeting(reply) && current.lastGreetingDate !== todayAlmatyDate()) {
    patch.lastGreetingDate = todayAlmatyDate();
  }

  current = await updateLead(current.leadId, patch);
  current = await appendConversation(current.leadId, [
    { role: "user", content: message },
    { role: "assistant", content: reply },
  ]);

  await sendWhatsAppMessage(toChatId(current.clientPhone) || chatId, reply);

  if (current.source === "manager_outbound" && !hasNotification(current, "client_replied")) {
    await notifyClientReplied(current, message);
    current = { ...current, notificationEvents: [...(current.notificationEvents || []), "client_replied"] };
  }

  if (shouldNotifyNewLead(current, result, message)) {
    await notifyNewLead(current);
  }

  const event = result?.manager_event;
  if (event && event !== "null") {
    await notifyImportantEvent(current, event, result.manager_event_note || result.summary);
  }

  log("AI RESPONSE", {
    leadId: current.leadId,
    latencyMs,
    status: current.status,
  });

  return { leadId: current.leadId, reply, result, latencyMs };
}
