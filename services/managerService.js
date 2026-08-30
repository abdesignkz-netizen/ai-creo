import {
  addManagerInstruction,
  appendConversation,
  getLeadById,
  getLeadByPhone,
  getOrCreateLeadByPhone,
  listActiveLeads,
  updateLead,
} from "./leadService.js";
import { parseManagerCommand, describeActions, isConfirmSend } from "./managerCommandService.js";
import { composeClientMessage } from "./aiService.js";
import { checkWhatsAppNumber, sendWhatsAppMessage } from "./whatsappService.js";
import { formatPhoneDisplay, isManagerPhone, toChatId } from "./phoneService.js";
import { notifyManagerRaw } from "./notificationService.js";
import {
  clearPendingOutbound,
  getLastSend,
  getPendingOutbound,
  setLastSend,
  setPendingOutbound,
} from "./managerSession.js";
import { log } from "./logger.js";

function formatLeadSummary(lead) {
  const name = lead.clientName || "не выяснено";
  const company = lead.company ? ` / ${lead.company}` : "";
  return [
    formatPhoneDisplay(lead.clientPhone),
    "",
    `Клиент: ${name}${company}`,
    lead.leadId ? `Лид: ${lead.leadId}` : null,
    `Услуга: ${lead.service || "не выяснено"}`,
    `Статус: ${lead.status}`,
    `Режим AI: ${lead.aiMode}`,
    "",
    `КП / резюме: ${lead.requestSummary || "не выяснено"}`,
    `Бюджет: ${lead.budget || "не выяснено"}`,
    `Срок: ${lead.deadline || "не выяснено"}`,
    lead.minPrice ? `Мин. цена: ${Number(lead.minPrice).toLocaleString("ru-RU")} ₸` : null,
    lead.goal ? `Цель: ${lead.goal}` : null,
    "",
    "Текущая ситуация:",
    lead.lastClientMessage
      ? `последнее сообщение клиента: ${lead.lastClientMessage.slice(0, 280)}`
      : "ожидаем следующее сообщение клиента.",
    "",
    "Следующий рекомендуемый шаг:",
    lead.aiMode === "HUMAN"
      ? "клиент у менеджера, AI не отвечает."
      : lead.aiMode === "PAUSED"
        ? "снимите паузу командой «продолжай», если нужно возобновить AI."
        : "AI продолжает квалификацию и ведёт к следующему шагу.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatActiveLeads(leads) {
  if (!leads.length) {
    return "АКТИВНЫЕ ЛИДЫ\n\nСейчас активных лидов нет.";
  }

  const lines = leads.map((lead) => {
    const name = lead.clientName || lead.company || formatPhoneDisplay(lead.clientPhone);
    return `${formatPhoneDisplay(lead.clientPhone)} — ${name} — ${lead.service || "не выяснено"} — ${lead.status}`;
  });

  return ["АКТИВНЫЕ ЛИДЫ", "", ...lines].join("\n");
}

async function resolveLead({ leadId, phone, createIfMissing, extras }) {
  if (phone) {
    const existing = await getLeadByPhone(phone);
    if (existing) {
      return existing;
    }
    if (createIfMissing) {
      return getOrCreateLeadByPhone(phone, extras);
    }
  }

  if (leadId) {
    const byId = await getLeadById(leadId);
    if (byId) {
      return byId;
    }
  }

  return null;
}

async function sendToClient({ lead, text, phone }) {
  const destinationPhone = lead?.clientPhone || phone;
  const chatId = toChatId(destinationPhone);
  if (!chatId) {
    throw new Error("Не удалось определить номер получателя");
  }

  const check = await checkWhatsAppNumber(destinationPhone);
  if (check.exists === false) {
    throw new Error(check.reason || "Номер недоступен в WhatsApp");
  }

  try {
    const sent = await sendWhatsAppMessage(chatId, text);
    await setLastSend({
      phone: destinationPhone,
      ok: true,
      text,
    });
    log("DIRECT SEND", {
      leadId: lead?.leadId,
      phone: destinationPhone,
      chars: text.length,
      idMessage: sent?.idMessage,
    });
  } catch (error) {
    await setLastSend({
      phone: destinationPhone,
      ok: false,
      text,
      error: error.message,
    });
    log("GREEN API ERROR", { phone: destinationPhone, error: error.message });
    throw error;
  }

  return { chatId, phone: destinationPhone };
}

function dedupeActions(actions) {
  const sendTypes = new Set(["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"]);
  const other = actions.filter((item) => !sendTypes.has(item.type));
  const sends = actions.filter((item) => sendTypes.has(item.type));
  if (sends.some((item) => item.type === "EXACT_MESSAGE")) {
    return [...other, sends.find((item) => item.type === "EXACT_MESSAGE")];
  }
  if (sends.length) {
    return [...other, sends[0]];
  }
  return other;
}

function confirmationText({ lead, actions, sentText, sentPhone }) {
  const header = formatPhoneDisplay(lead?.clientPhone || sentPhone);
  const details = describeActions(actions);
  const lines = ["✅ " + header, "", "Принято."];

  if (details.length) {
    lines.push("", ...details);
  }

  if (sentText) {
    lines.push("", `WhatsApp принял сообщение для клиента: «${sentText.slice(0, 240)}»`);
  }

  if (lead?.aiMode === "HUMAN") {
    lines.push("", "AI больше не отвечает этому клиенту.");
  } else if (lead?.aiMode === "PAUSED") {
    lines.push("", "AI временно не пишет этому клиенту.");
  } else {
    lines.push("", "AI продолжает вести клиента автоматически.");
  }

  return lines.join("\n");
}

async function deliverToClient({ phone, text, instruction }) {
  const targetPhone = phone;
  if (!targetPhone || !text) {
    throw new Error("Нет номера или текста для отправки");
  }

  await sendToClient({ text, phone: targetPhone });

  let lead = await getLeadByPhone(targetPhone);
  if (!lead) {
    lead = await getOrCreateLeadByPhone(targetPhone, {
      source: "manager_outbound",
      direction: "outbound",
    });
    log("OUTBOUND LEAD", { leadId: lead.leadId, phone: targetPhone });
  }

  lead = await appendConversation(lead.leadId, [
    { role: "assistant", content: text },
  ]);

  if (instruction) {
    await addManagerInstruction(lead.leadId, {
      type: "AI_COMPOSE",
      value: instruction,
    });
    lead = await getLeadById(lead.leadId);
  }

  await clearPendingOutbound();
  return lead;
}

export async function handleManagerMessage({ message, senderChatId }) {
  if (senderChatId && !isManagerPhone(senderChatId)) {
    log("MANAGER", { rejected: true, sender: senderChatId });
    return { ok: false, error: "not_manager" };
  }

  log("MANAGER", { message: String(message || "").slice(0, 300) });
  const notify = (text) => notifyManagerRaw(text, senderChatId);

  const pending = await getPendingOutbound();
  if (isConfirmSend(message) && pending?.phone) {
    try {
      const text =
        pending.draft ||
        (await composeClientMessage({
          lead: (await getLeadByPhone(pending.phone)) || { clientPhone: pending.phone },
          instruction: pending.instruction || "Напиши клиенту короткое первое сообщение и уточни детали заявки.",
        }));
      const lead = await deliverToClient({
        phone: pending.phone,
        text,
        instruction: pending.instruction,
      });
      await notify(
        confirmationText({
          lead,
          actions: [{ type: "AI_COMPOSE", value: pending.instruction }],
          sentText: text,
          sentPhone: pending.phone,
        }),
      );
      return { ok: true, sent: true, leadId: lead.leadId };
    } catch (error) {
      await notify(
        [
          "❌ Не удалось отправить сообщение",
          "",
          `Номер: ${formatPhoneDisplay(pending.phone)}`,
          `Причина: ${error.message}`,
        ].join("\n"),
      );
      return { ok: false, error: error.message };
    }
  }

  const parsed = await parseManagerCommand(message);
  let actions = dedupeActions(parsed.actions || []);

  if (
    parsed.phone &&
    !actions.some((item) =>
      ["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"].includes(item.type),
    ) &&
    /узнай|уточни|подробност|заявк|напиши|скажи|предложи|свяжись|отправь|напомин/i.test(message)
  ) {
    actions = [
      ...actions,
      { type: "AI_COMPOSE", value: message, text: null },
    ];
  }

  if (actions.some((item) => item.type === "LIST_LEADS")) {
    const leads = await listActiveLeads();
    await notify(formatActiveLeads(leads));
    return { ok: true, kind: "list" };
  }

  if (actions.some((item) => item.type === "LAST_SEND_STATUS")) {
    const last = await getLastSend();
    if (!last) {
      await notify("Пока не было попытки отправки клиенту.");
      return { ok: true, kind: "last_send" };
    }
    await notify(
      last.ok
        ? `✅ Последняя отправка прошла.\n\nНомер: ${formatPhoneDisplay(last.phone)}\nСообщение: «${String(last.text).slice(0, 240)}»`
        : `❌ Последняя отправка не прошла.\n\nНомер: ${formatPhoneDisplay(last.phone)}\nПричина: ${last.error}`,
    );
    return { ok: last.ok, kind: "last_send" };
  }

  if (actions.some((item) => item.type === "SEND_HERE") && parsed.phone) {
    const draft = await getPendingOutbound();
    if (draft?.draft) {
      try {
        const lead = await deliverToClient({
          phone: parsed.phone,
          text: draft.draft,
          instruction: draft.instruction,
        });
        await notify(
          confirmationText({
            lead,
            actions: [{ type: "AI_COMPOSE", value: draft.instruction }],
            sentText: draft.draft,
            sentPhone: parsed.phone,
          }),
        );
        return { ok: true, sent: true, leadId: lead.leadId };
      } catch (error) {
        await notify(
          [
            "❌ Не удалось отправить сообщение",
            "",
            `Номер: ${formatPhoneDisplay(parsed.phone)}`,
            `Причина: ${error.message}`,
          ].join("\n"),
        );
        return { ok: false, error: error.message };
      }
    }

    await setPendingOutbound({ phone: parsed.phone, draft: "", instruction: "" });
    await notify(
      `Номер принят: ${formatPhoneDisplay(parsed.phone)}\n\nНапишите, что отправить. Например:\n${parsed.phone} напомни про запуск проекта`,
    );
    return { ok: true, kind: "target" };
  }

  const needsSend = actions.some((item) =>
    ["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"].includes(item.type),
  );
  let lead = await resolveLead({
    leadId: parsed.leadId,
    phone: parsed.phone,
    createIfMissing: false,
  });

  if (actions.some((item) => item.type === "STATUS_QUERY")) {
    if (!lead) {
      await notify("❌ Клиент не найден. Укажите номер телефона.");
      return { ok: false };
    }
    await notify(formatLeadSummary(lead));
    return { ok: true, kind: "status", leadId: lead.leadId };
  }

  if (!lead && !parsed.phone && !parsed.leadId) {
    await notify(
      "Не понял, к какому клиенту относится команда. Достаточно указать номер телефона.",
    );
    return { ok: false };
  }

  if (!lead && parsed.leadId && !parsed.phone) {
    await notify(`❌ ${parsed.leadId} не найден.`);
    return { ok: false };
  }

  let sentText = null;

  for (const action of actions) {
    if (action.type === "SET_MODE") {
      const mode = String(action.value || "AUTO").toUpperCase();
      if (!lead && parsed.phone) {
        lead = await getOrCreateLeadByPhone(parsed.phone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      if (!lead) {
        continue;
      }
      lead = await updateLead(lead.leadId, {
        aiMode: mode,
        status: mode === "PAUSED" ? "paused" : lead.status === "paused" && mode === "AUTO" ? "new" : lead.status,
      });
      await addManagerInstruction(lead.leadId, {
        type: "SET_MODE",
        value: mode,
      });
      log("MODE CHANGE", { leadId: lead.leadId, aiMode: mode });
    }

    if (action.type === "SET_MIN_PRICE" && (lead || parsed.phone)) {
      if (!lead) {
        lead = await getOrCreateLeadByPhone(parsed.phone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      lead = await updateLead(lead.leadId, { minPrice: Number(action.value) || lead.minPrice });
      await addManagerInstruction(lead.leadId, {
        type: "SET_MIN_PRICE",
        value: Number(action.value),
      });
    }

    if (action.type === "SET_GOAL" && (lead || parsed.phone)) {
      if (!lead) {
        lead = await getOrCreateLeadByPhone(parsed.phone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      lead = await updateLead(lead.leadId, { goal: action.value });
      await addManagerInstruction(lead.leadId, {
        type: "SET_GOAL",
        value: action.value,
      });
    }

    if (action.type === "ADD_INSTRUCTION" && (lead || parsed.phone)) {
      if (!lead) {
        lead = await getOrCreateLeadByPhone(parsed.phone, {
          source: "manager_outbound",
          direction: "outbound",
        });
      }
      await addManagerInstruction(lead.leadId, {
        type: "ADD_INSTRUCTION",
        value: action.value,
      });
      lead = await getLeadById(lead.leadId);
    }

    if (["EXACT_MESSAGE", "AI_COMPOSE", "ASK_CLIENT"].includes(action.type)) {
      const targetPhone = lead?.clientPhone || parsed.phone;
      if (!targetPhone) {
        await notify("❌ Не указан номер клиента для отправки.");
        return { ok: false };
      }

      if (!lead) {
        // create only after successful send
      }

      try {
        const instruction = action.value || action.text || message;
        if (action.type === "EXACT_MESSAGE") {
          sentText = String(action.text || "").trim();
        } else {
          sentText = await composeClientMessage({
            lead: lead || { clientPhone: targetPhone, service: /презентац/i.test(message) ? "presentation" : lead?.service },
            instruction,
          });
        }

        if (!sentText) {
          throw new Error("Пустой текст сообщения");
        }

        await setPendingOutbound({
          phone: targetPhone,
          draft: sentText,
          instruction,
        });

        lead = await deliverToClient({
          phone: targetPhone,
          text: sentText,
          instruction: action.type === "EXACT_MESSAGE" ? "" : instruction,
        });
      } catch (error) {
        await notify(
          [
            "❌ Не удалось отправить сообщение",
            "",
            `Номер: ${formatPhoneDisplay(targetPhone)}`,
            `Причина: ${error.message}`,
          ].join("\n"),
        );
        return { ok: false, error: error.message };
      }
    }
  }

  if (!actions.length && !needsSend) {
    if (lead) {
      await addManagerInstruction(lead.leadId, {
        type: "ADD_INSTRUCTION",
        value: message,
      });
    } else {
      await notify(
        "Не понял команду. Пример: 87071234567 узнай бюджет",
      );
      return { ok: false };
    }
  }

  try {
    await notify(
      confirmationText({
        lead,
        actions: actions.length ? actions : [{ type: "ADD_INSTRUCTION", value: message }],
        sentText,
        sentPhone: parsed.phone,
      }),
    );
  } catch (error) {
    log("NOTIFICATION", { confirmFailed: true, error: error.message });
  }

  return { ok: true, leadId: lead?.leadId, sent: Boolean(sentText) };
}
