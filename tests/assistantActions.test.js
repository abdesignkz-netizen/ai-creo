import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  PRESENTATION_KP_FILENAME,
  processAssistantActions,
  resetAssistantActionKeys,
} from "../services/assistantActions.js";
import { parseAiReply } from "../services/aiReplyParser.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER_CHAT_ID = "77077471301@c.us";
const LOCAL_PDF_PATH = "/Users/ashat/Documents/CreoLab/whatsap ai/assets/private/presentation_kp.pdf";

beforeEach(() => {
  resetAssistantActionKeys();
  process.env.SALES_MANAGER_WHATSAPP = "+77077471301";
  process.env.PRESENTATION_KP_PATH = "assets/private/presentation_kp.pdf";
});

function baseParsed(overrides = {}) {
  return parseAiReply({
    reply: "Для какого бизнеса нужен сайт?",
    lead_status: "warm",
    service: "site",
    handoff: false,
    brief_completed: false,
    manager_event: "none",
    send_asset: "none",
    summary: "Клиенту нужен сайт",
    ...overrides,
  });
}

function createConversation(overrides = {}) {
  return {
    leadId: "LEAD-0001",
    clientPhone: "77011112233",
    clientName: "Алия",
    service: "site",
    requestSummary: "Клиенту нужен сайт",
    status: "qualified",
    aiMode: "AUTO",
    notificationEvents: [],
    handoff_already_created: false,
    presentation_kp_already_sent: false,
    decision_event_already_registered: false,
    human_requested: false,
    ...overrides,
  };
}

function createHarness(conversations = []) {
  const store = new Map(conversations.map((item) => [item.leadId, item]));
  const clientMessages = [];
  const managerMessages = [];
  const files = [];

  const deps = {
    sendWhatsAppMessage: async (chatId, text) => {
      if (chatId === MANAGER_CHAT_ID) {
        managerMessages.push({ chatId, text });
        return { idMessage: "mgr" };
      }
      clientMessages.push({ chatId, text });
      return { idMessage: "cli" };
    },
    sendWhatsAppLocalFile: async (chatId, filePath, options = {}) => {
      files.push({ chatId, filePath, ...options });
      return { idMessage: "file" };
    },
    sendManagerMessage: async (text) => {
      managerMessages.push({ chatId: MANAGER_CHAT_ID, text });
      return { idMessage: "mgr" };
    },
    updateLead: async (leadId, patch) => {
      const lead = store.get(leadId);
      const next = { ...lead, ...(typeof patch === "function" ? patch(lead) : patch) };
      store.set(leadId, next);
      Object.assign(lead, next);
      return next;
    },
    markNotification: async (leadId, eventKey) => {
      const lead = store.get(leadId);
      const events = new Set(lead.notificationEvents || []);
      events.add(eventKey);
      lead.notificationEvents = [...events];
      store.set(leadId, lead);
      return lead;
    },
    hasNotification: (lead, eventKey) => Boolean(lead?.notificationEvents?.includes(eventKey)),
    getSalesManagerChatId: () => MANAGER_CHAT_ID,
    getPresentationKpPath: () => LOCAL_PDF_PATH,
    inspectPresentationKp: async () => ({ ok: true, path: LOCAL_PDF_PATH }),
    canNotifySalesManager: () => ({ ok: true, phone: "77077471301", chatId: MANAGER_CHAT_ID }),
  };

  return { store, clientMessages, managerMessages, files, deps };
}

async function runActions({ parsed, conversation, incoming, deps, replyAlreadySent = false }) {
  return processAssistantActions(
    {
      parsedResponse: parsed,
      conversation,
      incomingMessage: incoming,
      contact: {
        phone: conversation.clientPhone,
        chatId: `${conversation.clientPhone}@c.us`,
        name: conversation.clientName,
      },
      replyAlreadySent,
    },
    deps,
  );
}

test("handoff = true sends an application to the manager", async () => {
  const conversation = createConversation();
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({ handoff: true }),
    conversation,
    incoming: { id: "msg-1", text: "Нужен сайт для клиники" },
    deps,
  });

  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /🔔 Новая заявка CreoLab/);
  assert.match(managerMessages[0].text, /Алия/);
  assert.match(managerMessages[0].text, /\+77011112233/);
  assert.match(managerMessages[0].text, /Сайт/);
  assert.equal(conversation.handoff_already_created, true);
});

test("handoff = false sends nothing to the manager", async () => {
  const conversation = createConversation();
  const { managerMessages, files, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({ handoff: false }),
    conversation,
    incoming: { id: "msg-2", text: "Нужен сайт" },
    deps,
  });

  assert.equal(managerMessages.length, 0);
  assert.equal(files.length, 0);
  assert.equal(conversation.handoff_already_created, false);
});

test("the same application is not sent twice", async () => {
  const conversation = createConversation();
  const { managerMessages, deps } = createHarness([conversation]);
  const parsed = baseParsed({ handoff: true });
  const incoming = { id: "msg-3", text: "Нужен сайт для клиники" };

  await runActions({ parsed, conversation, incoming, deps });
  await runActions({ parsed, conversation, incoming, deps });

  assert.equal(managerMessages.length, 1);
  assert.equal(conversation.handoff_already_created, true);
});

test("a send error does not set handoff_already_created = true", async () => {
  const conversation = createConversation();
  const { deps } = createHarness([conversation]);
  deps.sendManagerMessage = async () => {
    throw new Error("WhatsApp timeout");
  };

  await runActions({
    parsed: baseParsed({ handoff: true }),
    conversation,
    incoming: { id: "msg-4", text: "Нужен сайт" },
    deps,
  });

  assert.equal(conversation.handoff_already_created, false);
});

test("decision_required sends a manager notification", async () => {
  const conversation = createConversation({
    requestSummary: "Нужен индивидуальный расчёт",
  });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({
      manager_event: "decision_required",
      summary: "Нужен индивидуальный расчёт",
    }),
    conversation,
    incoming: { id: "msg-5", text: "Можете сделать дешевле?" },
    deps,
  });

  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /⚠️ Требуется решение менеджера/);
  assert.match(managerMessages[0].text, /индивидуальный расчёт/);
  assert.equal(conversation.decision_event_already_registered, true);
});

test("the same unresolved decision event is not duplicated", async () => {
  const conversation = createConversation({
    requestSummary: "Нужна скидка 20%",
  });
  const { managerMessages, deps } = createHarness([conversation]);
  const parsed = baseParsed({
    manager_event: "decision_required",
    summary: "Нужна скидка 20%",
  });
  const incoming = { id: "msg-6", text: "Дайте скидку" };

  await runActions({ parsed, conversation, incoming, deps });
  await runActions({ parsed, conversation, incoming: { id: "msg-7", text: "Ну и как со скидкой?" }, deps });

  assert.equal(managerMessages.length, 1);
});

test("human_requested sends the priority notification and enables HUMAN mode", async () => {
  const conversation = createConversation();
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({
      handoff: true,
      manager_event: "human_requested",
      summary: "Клиент просит специалиста",
    }),
    conversation,
    incoming: { id: "msg-8", text: "Передайте менеджеру" },
    deps,
  });

  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /👤 Клиент просит живого менеджера/);
  assert.match(managerMessages[0].text, /новая заявка/i);
  assert.equal(conversation.aiMode, "HUMAN");
  assert.equal(conversation.human_requested, true);
  assert.equal(conversation.handoff_already_created, true);
});

test("manager_event = none sends nothing to the manager", async () => {
  const conversation = createConversation();
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({ manager_event: "none", handoff: false }),
    conversation,
    incoming: { id: "msg-9", text: "Здравствуйте" },
    deps,
  });
  assert.equal(managerMessages.length, 0);
});

test("handoff and decision_required create one combined message", async () => {
  const conversation = createConversation({
    requestSummary: "Нужен нестандартный срок",
  });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({
      handoff: true,
      manager_event: "decision_required",
      summary: "Нужен нестандартный срок",
    }),
    conversation,
    incoming: { id: "msg-10", text: "Нужно за 3 дня" },
    deps,
  });

  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /🔔 Новая заявка — требуется решение/);
  assert.equal(conversation.handoff_already_created, true);
  assert.equal(conversation.decision_event_already_registered, true);
});

test("the client receives only reply", async () => {
  const conversation = createConversation();
  const { clientMessages, deps } = createHarness([conversation]);
  const parsed = baseParsed({
    handoff: true,
    manager_event: "decision_required",
    send_asset: "none",
    summary: "Клиенту нужен сайт",
  });
  await runActions({
    parsed,
    conversation,
    incoming: { id: "msg-11", text: "Нужен сайт" },
    deps,
  });

  assert.equal(clientMessages.length, 1);
  assert.equal(clientMessages[0].text, parsed.reply);
  assert.equal(clientMessages[0].text.includes("lead_status"), false);
  assert.equal(clientMessages[0].text.includes("handoff"), false);
  assert.notEqual(clientMessages[0].text, JSON.stringify(parsed));
});

test("presentation_kp sends text, then PDF", async () => {
  const conversation = createConversation({ service: "presentation" });
  const { clientMessages, files, deps } = createHarness([conversation]);
  const order = [];
  deps.sendWhatsAppMessage = async (chatId, text) => {
    order.push("text");
    clientMessages.push({ chatId, text });
  };
  deps.sendWhatsAppLocalFile = async (chatId, filePath, options = {}) => {
    order.push("pdf");
    files.push({ chatId, filePath, ...options });
  };

  await runActions({
    parsed: baseParsed({
      reply: "Прикрепляю коммерческое предложение с комплектацией всех пакетов.",
      service: "presentation",
      send_asset: "presentation_kp",
    }),
    conversation,
    incoming: { id: "msg-12", text: "Пришлите КП" },
    deps,
  });

  assert.deepEqual(order, ["text", "pdf"]);
  assert.equal(clientMessages.length, 1);
  assert.equal(files.length, 1);
  assert.equal(files[0].fileName, PRESENTATION_KP_FILENAME);
  assert.equal(conversation.presentation_kp_already_sent, true);
});

test("PDF is not sent if the reply text fails", async () => {
  const conversation = createConversation();
  const { files, deps } = createHarness([conversation]);
  deps.sendWhatsAppMessage = async () => {
    throw new Error("send failed");
  };

  await runActions({
    parsed: baseParsed({ send_asset: "presentation_kp" }),
    conversation,
    incoming: { id: "msg-13", text: "Пришлите КП" },
    deps,
  });

  assert.equal(files.length, 0);
  assert.equal(conversation.presentation_kp_already_sent, false);
});

test("a PDF error leaves presentation_kp_already_sent = false", async () => {
  const conversation = createConversation();
  const { deps } = createHarness([conversation]);
  deps.sendWhatsAppLocalFile = async () => {
    throw new Error("upload failed");
  };

  await runActions({
    parsed: baseParsed({ send_asset: "presentation_kp" }),
    conversation,
    incoming: { id: "msg-14", text: "Пришлите КП" },
    deps,
    replyAlreadySent: true,
  });

  assert.equal(conversation.presentation_kp_already_sent, false);
});

test("a technical retry of the same incoming message does not resend the PDF", async () => {
  const conversation = createConversation();
  const { files, deps } = createHarness([conversation]);
  const parsed = baseParsed({ send_asset: "presentation_kp" });
  const incoming = { id: "msg-15", text: "Пришлите КП" };

  await runActions({ parsed, conversation, incoming, deps, replyAlreadySent: true });
  await runActions({ parsed, conversation, incoming, deps, replyAlreadySent: true });

  assert.equal(files.length, 1);
});

test("a new client request can send the PDF again", async () => {
  const conversation = createConversation({ presentation_kp_already_sent: true });
  const { files, deps } = createHarness([conversation]);
  const parsed = baseParsed({ send_asset: "presentation_kp" });

  await runActions({
    parsed,
    conversation,
    incoming: { id: "msg-16", text: "Пришлите КП ещё раз" },
    deps,
    replyAlreadySent: true,
  });
  await runActions({
    parsed,
    conversation,
    incoming: { id: "msg-17", text: "И ещё раз то же КП" },
    deps,
    replyAlreadySent: true,
  });

  assert.equal(files.length, 2);
});

test("send_asset = none attaches nothing", async () => {
  const conversation = createConversation();
  const { files, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({ send_asset: "none" }),
    conversation,
    incoming: { id: "msg-18", text: "Сколько стоит сайт?" },
    deps,
  });
  assert.equal(files.length, 0);
});

test("the local path does not go to WhatsApp", async () => {
  const conversation = createConversation();
  const { clientMessages, managerMessages, files, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({
      handoff: true,
      send_asset: "presentation_kp",
      summary: "Клиенту нужна презентация",
    }),
    conversation,
    incoming: { id: "msg-19", text: "Пришлите КП" },
    deps,
  });

  const leaked = [...clientMessages.map((item) => item.text), ...managerMessages.map((item) => item.text)]
    .join("\n");
  assert.equal(leaked.includes("assets/private"), false);
  assert.equal(leaked.includes("PRESENTATION_KP_PATH"), false);
  assert.equal(leaked.includes(LOCAL_PDF_PATH), false);
  assert.equal(files[0].fileName.includes("assets/private"), false);
  assert.equal(files[0].fileName, PRESENTATION_KP_FILENAME);
  assert.equal(files[0].caption, undefined);
});

test("notifications go to +77077471301", async () => {
  const conversation = createConversation();
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: baseParsed({ handoff: true }),
    conversation,
    incoming: { id: "msg-20", text: "Нужен сайт" },
    deps,
  });
  assert.equal(managerMessages[0].chatId, MANAGER_CHAT_ID);
});

test("state of different clients is not mixed", async () => {
  const first = createConversation({ leadId: "LEAD-0001", clientPhone: "77011112233" });
  const second = createConversation({
    leadId: "LEAD-0002",
    clientPhone: "77019998877",
    clientName: "Марат",
  });
  const { managerMessages, deps } = createHarness([first, second]);

  await runActions({
    parsed: baseParsed({ handoff: true, summary: "Заявка Алии" }),
    conversation: first,
    incoming: { id: "msg-21", text: "Нужен сайт" },
    deps,
  });

  assert.equal(first.handoff_already_created, true);
  assert.equal(second.handoff_already_created, false);
  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /Алия/);
  assert.equal(managerMessages[0].text.includes("Марат"), false);
});

test("system prompt, knowledge base and JSON schema were not changed by this handler", () => {
  const prompt = readFileSync(join(root, "prompts/system_prompt.txt"), "utf8");
  const knowledge = readFileSync(join(root, "knowledge/creolab_knowledge_base.txt"), "utf8");
  const handler = readFileSync(join(root, "services/assistantActions.js"), "utf8");
  const parsed = baseParsed();

  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "reply"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "lead_status"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "service"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "handoff"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "brief_completed"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "manager_event"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "send_asset"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "summary"), true);
  assert.equal(handler.includes("system_prompt.txt"), false);
  assert.equal(handler.includes("creolab_knowledge_base.txt"), false);
  assert.equal(prompt.includes("SEND_ASSET"), true);
  assert.equal(knowledge.length > 0, true);
});
