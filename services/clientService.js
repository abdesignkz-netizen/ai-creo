import {
  appendConversation,
  getOrCreateLeadByPhone,
  hasNotification,
  popLastAssistantMessage,
  updateLead,
} from "./leadService.js";
import { generateAiReply, detectGreeting, todayAlmatyDate } from "./aiService.js";
import { isUsableClientReply } from "./aiReplyParser.js";
import { processAssistantActions } from "./assistantActions.js";
import {
  buildShouldGreetState,
  finalizeGreetingAfterSend,
  releaseGreeting,
  reserveGreeting,
} from "./greetingState.js";
import { sendWhatsAppMessage } from "./whatsappService.js";
import { toChatId } from "./phoneService.js";
import {
  assertClientSendAllowed,
  collectManagementEffects,
  formatActiveManagementPrompt,
} from "./managementControl.js";
import { shouldSkipForeignBotReply } from "./outboundReplyGuard.js";
import {
  notifyClientReplied,
  notifyImportantEvent,
} from "./notificationService.js";
import { log } from "./logger.js";

const chatLocks = new Map();

function withChatLock(chatId, task) {
  const key = String(chatId || "unknown");
  const run = (chatLocks.get(key) || Promise.resolve())
    .catch(() => {})
    .then(task);
  const tracked = run.finally(() => {
    if (chatLocks.get(key) === tracked) {
      chatLocks.delete(key);
    }
  });
  chatLocks.set(key, tracked);
  return run;
}

export function describeIncomingMedia(file) {
  if (!file) {
    return "";
  }

  const kind =
    file.type === "imageMessage" || file.type === "stickerMessage"
      ? "изображение"
      : file.type === "videoMessage"
        ? "видео"
        : file.type === "documentMessage"
          ? "файл"
          : "вложение";
  const name = String(file.fileName || "").trim();
  const caption = String(file.caption || "").trim();
  const label = name ? `${kind} «${name}»` : kind;
  return `[Клиент отправил ${label}]${caption ? `\n${caption}` : ""}`;
}

export function buildClientMessageWithMedia(message, media = []) {
  const text = String(message || "").trim();
  const mediaNotes = (Array.isArray(media) ? media : [])
    .map((file) => {
      const caption = String(file.caption || "").trim();
      const note = describeIncomingMedia({
        ...file,
        caption: caption && text.includes(caption) ? "" : caption,
      });
      return note;
    })
    .filter(Boolean);
  if (text && mediaNotes.every((note) => text.includes(note))) {
    return text;
  }
  return [...mediaNotes, text].filter(Boolean).join("\n").trim();
}

function normalizeForCompare(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSimilarReply(next, previous) {
  const a = normalizeForCompare(next);
  const b = normalizeForCompare(previous);
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  if (a.includes(b) || b.includes(a)) {
    return a.length > 24 && b.length > 24;
  }

  const stop = new Set([
    "это",
    "для",
    "или",
    "как",
    "что",
    "вам",
    "вас",
    "мы",
    "нас",
    "если",
    "здесь",
    "сюда",
    "этот",
    "этой",
    "также",
    "просто",
    "очень",
  ]);
  const tokens = (text) =>
    text.split(" ").filter((word) => word.length >= 4 && !stop.has(word));
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (!left.size || !right.size) {
    return false;
  }

  let overlap = 0;
  for (const word of left) {
    if (right.has(word)) {
      overlap += 1;
    }
  }

  if (overlap >= 3 && overlap / Math.min(left.size, right.size) >= 0.55) {
    return true;
  }

  const sameAsk = [
    /сайт[аеу]?.{0,20}реклам.{0,20}презентац/i,
    /отправ.{0,24}картин/i,
    /картинк[уиа].{0,24}отправ/i,
  ];
  return sameAsk.some((pattern) => pattern.test(next) && pattern.test(previous));
}

const CLOSED_PIPELINE = new Set(["won", "lost", "paused"]);

export function mapPipelineStatus(result, current) {
  let next;
  if (result?.pipeline_status) {
    next = result.pipeline_status;
  } else if (result?.lead_status === "hot") {
    next = "hot";
  } else if (result?.lead_status === "warm" && current === "new") {
    next = "qualified";
  } else {
    next = current || "new";
  }

  if (current === "hot" && next !== "hot" && !CLOSED_PIPELINE.has(next)) {
    return "hot";
  }
  return next;
}

function pickValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "" && value !== "unknown") {
      return value;
    }
  }
  return null;
}

function buildActionStateInstruction(lead) {
  const kpSent =
    lead.presentation_kp_already_sent === true ||
    hasNotification(lead, "presentation_kp_sent");
  return [
    `handoff_already_created=${lead.handoff_already_created === true ? "true" : "false"}`,
    `presentation_kp_already_sent=${kpSent ? "true" : "false"}`,
    `decision_event_already_registered=${lead.decision_event_already_registered === true ? "true" : "false"}`,
    `brief_completed=${lead.brief_completed === true ? "true" : "false"}`,
    `current_lead_status=${lead.status || "new"}`,
  ].join(" ");
}

async function handleClientMessageUnlocked({
  chatId,
  message,
  senderName,
  media = [],
  shouldAbort,
  incomingMessageId,
}) {
  const fullMessage = buildClientMessageWithMedia(message, media);
  log("CLIENT", {
    chatId,
    message: fullMessage.slice(0, 240),
    files: (Array.isArray(media) ? media : []).map((file) => file.fileName || file.type),
  });

  if (!fullMessage) {
    return { skipped: true, reason: "empty" };
  }

  const lead = await getOrCreateLeadByPhone(chatId, {
    source: "inbound",
    direction: "inbound",
  });

  let current = lead;
  if (senderName && !current.clientName) {
    current = await updateLead(current.leadId, { clientName: senderName });
  }

  const inboundBotGuard = shouldSkipForeignBotReply({
    lead: current,
    incomingText: fullMessage,
  });
  if (inboundBotGuard.skip) {
    await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
    await notifyImportantEvent(
      current,
      "foreign_bot_menu",
      [
        "Номер ответил автоменю или чужим WhatsApp-ботом.",
        "AI не стал подыгрывать их командам и клиенту ничего не отправил.",
        "",
        `Текст:\n«${fullMessage.slice(0, 400)}»`,
      ].join("\n"),
    );
    log("AI RESPONSE", {
      leadId: current.leadId,
      skippedReply: true,
      reason: inboundBotGuard.reason,
    });
    return { skipped: true, reason: inboundBotGuard.reason, leadId: current.leadId };
  }

  if (current.aiMode === "HUMAN" || current.aiMode === "PAUSED") {
    await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
    await notifyImportantEvent(
      current,
      "client_message_while_paused",
      `Клиент написал:\n«${fullMessage.slice(0, 400)}»`,
    );
    log("MODE CHANGE", {
      leadId: current.leadId,
      skippedReply: true,
      aiMode: current.aiMode,
    });
    return { skipped: true, reason: current.aiMode, leadId: current.leadId };
  }

  if (shouldAbort?.()) {
    return { aborted: true, leadId: current.leadId };
  }

  const history = current.conversationHistory || [];
  const lastAi = current.lastAIMessage || "";
  const appState = buildShouldGreetState(current);
  const reservedGreeting = appState.should_greet ? reserveGreeting(current.leadId) : false;
  if (appState.should_greet && !reservedGreeting) {
    appState.should_greet = false;
  }
  const actionStateInstruction = buildActionStateInstruction(current);
  let extraInstruction = actionStateInstruction;
  try {
    const managementPrompt = await formatActiveManagementPrompt(current);
    if (managementPrompt) {
      extraInstruction = `${actionStateInstruction}\n${managementPrompt}`;
    }
  } catch (error) {
    log("MANAGEMENT POLICY", { promptError: error.message, leadId: current.leadId });
  }
  let reply;
  let result;
  let latencyMs;
  try {
    ({ reply, result, latencyMs } = await generateAiReply({
      message: fullMessage,
      history,
      lead: current,
      extraInstruction,
      appState,
    }));
  } catch (error) {
    if (reservedGreeting) {
      releaseGreeting(current.leadId);
    }
    throw error;
  }

  if (shouldAbort?.()) {
    if (reservedGreeting) {
      releaseGreeting(current.leadId);
    }
    return { aborted: true, leadId: current.leadId };
  }

  if (isSimilarReply(reply, lastAi)) {
    ({ reply, result, latencyMs } = await generateAiReply({
      message: fullMessage,
      history,
      lead: current,
      extraInstruction: [
        extraInstruction,
        `Ты уже отправил клиенту: «${lastAi}».`,
        "Не повторяй те же вопросы и формулировки.",
        "Не проси прислать файл, картинку или данные, которые уже есть в истории.",
        "Ответь по-новому с учётом всех свежих сообщений и вложений.",
      ]
        .filter(Boolean)
        .join(" "),
      appState,
    }));
  }

  if (shouldAbort?.()) {
    if (reservedGreeting) {
      releaseGreeting(current.leadId);
    }
    return { aborted: true, leadId: current.leadId };
  }

  if (isSimilarReply(reply, lastAi)) {
    if (reservedGreeting) {
      releaseGreeting(current.leadId);
    }
    await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
    log("AI RESPONSE", {
      leadId: current.leadId,
      skippedReply: true,
      reason: "repeat",
    });
    return { skipped: true, reason: "repeat", leadId: current.leadId };
  }

  const generatedBotGuard = shouldSkipForeignBotReply({
    lead: current,
    incomingText: fullMessage,
    generatedReply: reply,
  });
  if (generatedBotGuard.skip) {
    if (reservedGreeting) {
      releaseGreeting(current.leadId);
    }
    await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
    await notifyImportantEvent(
      current,
      "foreign_bot_menu",
      [
        "AI хотел ответить в логике чужого меню. Такое сообщение клиенту не отправлено.",
        "",
        `Текст клиента:\n«${fullMessage.slice(0, 280)}»`,
      ].join("\n"),
    );
    log("AI RESPONSE", {
      leadId: current.leadId,
      skippedReply: true,
      reason: generatedBotGuard.reason,
    });
    return { skipped: true, reason: generatedBotGuard.reason, leadId: current.leadId };
  }

  if (result?.parse_error || !isUsableClientReply(reply)) {
    if (reservedGreeting) {
      releaseGreeting(current.leadId);
    }
    log("AI PARSE ERROR", {
      leadId: current.leadId,
      skippedReply: true,
      reason: "invalid_ai_json",
    });
    return { skipped: true, reason: "invalid_ai_json", leadId: current.leadId };
  }

  const nextStatus = mapPipelineStatus(result, current.status);
  const patch = {
    clientName: pickValue(result.client_name, current.clientName),
    company: pickValue(result.company, current.company),
    service: pickValue(result.service, current.service),
    requestSummary: pickValue(result.summary, result.requestSummary, current.requestSummary),
    budget: pickValue(result.budget, current.budget),
    deadline: pickValue(result.deadline, current.deadline),
    status: nextStatus,
    brief_completed: current.brief_completed === true ? true : result.brief_completed === true,
  };

  if (detectGreeting(reply) && !current.lastGreetingDate) {
    patch.lastGreetingDate = todayAlmatyDate();
  } else if (detectGreeting(reply) && current.lastGreetingDate !== todayAlmatyDate()) {
    patch.lastGreetingDate = todayAlmatyDate();
  }

  const destChatId = toChatId(current.clientPhone) || chatId;
  try {
    const projected = { ...current, ...patch };
    const effects = await collectManagementEffects(projected);
    if (effects.patch) {
      Object.assign(patch, effects.patch);
    }

    current = await updateLead(current.leadId, patch);

    const preSendGate = await assertClientSendAllowed(current, reply);
    if (!preSendGate.allowed || shouldAbort?.()) {
      if (reservedGreeting) {
        releaseGreeting(current.leadId);
      }
      await appendConversation(current.leadId, [{ role: "user", content: fullMessage }]);
      log("AI RESPONSE", {
        leadId: current.leadId,
        skippedReply: true,
        reason: preSendGate.reason || "aborted",
        blocked: !preSendGate.allowed,
      });
      return {
        skipped: true,
        blocked: !preSendGate.allowed,
        reason: preSendGate.reason || "aborted",
        leadId: current.leadId,
      };
    }

    current = await appendConversation(current.leadId, [
      { role: "user", content: fullMessage },
      { role: "assistant", content: reply },
    ]);

    const finalGate = await assertClientSendAllowed(current, reply);
    if (!finalGate.allowed || shouldAbort?.()) {
      if (reservedGreeting) {
        releaseGreeting(current.leadId);
      }
      await popLastAssistantMessage(current.leadId);
      log("AI RESPONSE", {
        leadId: current.leadId,
        skippedReply: true,
        reason: finalGate.reason || "aborted",
        blocked: !finalGate.allowed,
      });
      return {
        skipped: true,
        blocked: !finalGate.allowed,
        reason: finalGate.reason || "aborted",
        leadId: current.leadId,
      };
    }

    await sendWhatsAppMessage(destChatId, reply);
    const greetingResult = await finalizeGreetingAfterSend({
      leadId: current.leadId,
      shouldGreet: reservedGreeting,
      sendSucceeded: true,
      updateLead,
    });
    if (greetingResult.persisted) {
      current = { ...current, greeting_sent: true };
    }
  } catch (error) {
    await finalizeGreetingAfterSend({
      leadId: current.leadId,
      shouldGreet: reservedGreeting,
      sendSucceeded: false,
      updateLead,
    });
    throw error;
  }

  try {
    await processAssistantActions({
      parsedResponse: result,
      conversation: current,
      incomingMessage: {
        text: fullMessage,
        id: incomingMessageId,
      },
      contact: {
        phone: current.clientPhone,
        chatId: destChatId,
        name: current.clientName,
      },
      replyAlreadySent: true,
    });
  } catch (error) {
    log("ASSISTANT ACTION ERROR", {
      leadId: current.leadId,
      error: error.message,
    });
  }

  if (current.source === "manager_outbound" && !hasNotification(current, "client_replied")) {
    await notifyClientReplied(current, fullMessage);
    current = { ...current, notificationEvents: [...(current.notificationEvents || []), "client_replied"] };
  }

  log("AI RESPONSE", {
    leadId: current.leadId,
    latencyMs,
    status: current.status,
  });

  return { leadId: current.leadId, reply, result, latencyMs };
}

export async function handleClientMessage(args) {
  return withChatLock(args.chatId, () => handleClientMessageUnlocked(args));
}
