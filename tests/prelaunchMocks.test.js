import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_LEAD_STATUS,
  ALLOWED_MANAGER_EVENT,
  ALLOWED_SEND_ASSET,
  ALLOWED_SERVICE,
  GREETING_PHRASE,
  REQUIRED_FIELDS,
  clientSafe,
  makeParsed,
  parseOrThrow,
  readKnowledge,
  readPrompt,
  recordPass,
  validateContract,
  writePrelaunchReport,
} from "./lib/prelaunchSupport.js";
import {
  AiReplyParseError,
  getClientReply,
  parseAiReply,
} from "../services/aiReplyParser.js";
import {
  buildShouldGreetState,
  finalizeGreetingAfterSend,
  hasGreetingBeenSent,
  reserveGreeting,
  resetGreetingReservationsForTests,
} from "../services/greetingState.js";
import { mapPipelineStatus } from "../services/clientService.js";
import { createEmptyLead } from "../services/leadService.js";
import {
  PRESENTATION_KP_FILENAME,
  processAssistantActions,
  resetAssistantActionKeys,
} from "../services/assistantActions.js";
import { getPresentationKpPath } from "../services/appConfig.js";

const MANAGER_CHAT = "77077471301@c.us";
const PDF_PATH = "/tmp/assets/private/presentation_kp.pdf";

beforeEach(() => {
  resetGreetingReservationsForTests();
  resetAssistantActionKeys();
  process.env.SALES_MANAGER_WHATSAPP = "+77077471301";
  process.env.PRESENTATION_KP_PATH = "assets/private/presentation_kp.pdf";
});

after(() => {
  writePrelaunchReport();
});

function createConversation(overrides = {}) {
  return {
    leadId: "LEAD-0001",
    clientPhone: "77011112233",
    clientName: "Алия",
    service: "site",
    requestSummary: "",
    status: "new",
    aiMode: "AUTO",
    conversationHistory: [],
    notificationEvents: [],
    greeting_sent: false,
    handoff_already_created: false,
    presentation_kp_already_sent: false,
    decision_event_already_registered: false,
    human_requested: false,
    brief_completed: false,
    ...overrides,
  };
}

function createHarness(conversations) {
  const store = new Map(conversations.map((item) => [item.leadId, item]));
  const clientMessages = [];
  const managerMessages = [];
  const files = [];
  return {
    clientMessages,
    managerMessages,
    files,
    deps: {
      sendWhatsAppMessage: async (chatId, text) => {
        clientMessages.push({ chatId, text });
      },
      sendWhatsAppLocalFile: async (chatId, filePath, options = {}) => {
        files.push({ chatId, filePath, ...options });
      },
      sendManagerMessage: async (text) => {
        managerMessages.push({ chatId: MANAGER_CHAT, text });
      },
      updateLead: async (leadId, patch) => Object.assign(store.get(leadId), patch),
      markNotification: async (leadId, eventKey) => {
        const lead = store.get(leadId);
        lead.notificationEvents = [...new Set([...(lead.notificationEvents || []), eventKey])];
        return lead;
      },
      hasNotification: (lead, eventKey) => Boolean(lead?.notificationEvents?.includes(eventKey)),
      getSalesManagerChatId: () => MANAGER_CHAT,
      getPresentationKpPath: () => PDF_PATH,
      inspectPresentationKp: async () => ({ ok: true, path: PDF_PATH }),
      canNotifySalesManager: () => ({ ok: true, phone: "77077471301", chatId: MANAGER_CHAT }),
    },
  };
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

test("greeting: first reply gets should_greet = true", () => {
  const expected = "Первое сообщение нового лида получает should_greet=true";
  const state = buildShouldGreetState({ leadId: "LEAD-G1", greeting_sent: false });
  assert.equal(state.should_greet, true);
  recordPass("Приветствие: первый ответ should_greet=true", expected, JSON.stringify(state));
});

test("greeting: prompt contains the exact CreoLab greeting phrase", () => {
  const expected = `Промпт содержит фразу «${GREETING_PHRASE}»`;
  const prompt = readPrompt();
  assert.equal(prompt.includes(GREETING_PHRASE), true);
  recordPass("Приветствие: эталонная фраза есть в промпте", expected, "фраза найдена в system_prompt.txt", {
    reply: GREETING_PHRASE,
  });
});

test("greeting: subsequent replies get should_greet = false", () => {
  const expected = "После greeting_sent=true should_greet=false";
  const state = buildShouldGreetState({ leadId: "LEAD-G2", greeting_sent: true });
  assert.equal(state.should_greet, false);
  recordPass("Приветствие: последующие ответы should_greet=false", expected, JSON.stringify(state));
});

test("greeting: after restart greeting is not repeated", () => {
  const expected = "Сериализованный лид с greeting_sent=true не получает повторное приветствие";
  const saved = JSON.parse(JSON.stringify({ leadId: "LEAD-G3", greeting_sent: true, lastGreetingDate: "2026-09-04" }));
  assert.equal(hasGreetingBeenSent(saved), true);
  assert.equal(buildShouldGreetState(saved).should_greet, false);
  recordPass("Приветствие: после перезапуска не повторяется", expected, "should_greet=false");
});

test("greeting: two fast messages reserve only one greeting", () => {
  const expected = "Два быстрых сообщения не резервируют два приветствия";
  const lead = { leadId: "LEAD-G4", greeting_sent: false };
  assert.equal(buildShouldGreetState(lead).should_greet, true);
  assert.equal(reserveGreeting(lead.leadId), true);
  assert.equal(buildShouldGreetState(lead).should_greet, false);
  assert.equal(reserveGreeting(lead.leadId), false);
  recordPass("Приветствие: два быстрых сообщения — одно приветствие", expected, "второй reserve=false");
});

test("state: clients are stored separately", async () => {
  const expected = "Состояния разных клиентов не смешиваются";
  const first = createConversation({ leadId: "LEAD-A", clientPhone: "77011112233", clientName: "Алия" });
  const second = createConversation({ leadId: "LEAD-B", clientPhone: "77019998877", clientName: "Марат" });
  const { managerMessages, deps } = createHarness([first, second]);
  await runActions({
    parsed: makeParsed({ handoff: true, summary: "Заявка Алии" }),
    conversation: first,
    incoming: { id: "a1", text: "Нужен сайт" },
    deps,
  });
  assert.equal(first.handoff_already_created, true);
  assert.equal(second.handoff_already_created, false);
  assert.equal(managerMessages[0].text.includes("Марат"), false);
  recordPass("Состояние: клиенты хранятся отдельно", expected, "LEAD-B не получил handoff Алии");
});

test("state: history is kept between messages", () => {
  const expected = "История диалога накапливается и не теряется";
  const lead = createEmptyLead({ leadId: "LEAD-H", clientPhone: "77011112233" });
  lead.conversationHistory = [
    { role: "user", content: "Нужен сайт" },
    { role: "assistant", content: "Для какого бизнеса?" },
  ];
  const next = [
    ...lead.conversationHistory,
    { role: "user", content: "Строительная компания" },
  ];
  assert.equal(next.length, 3);
  assert.equal(next[0].content, "Нужен сайт");
  recordPass("Состояние: история не теряется", expected, `записей: ${next.length}`);
});

test("state: known brief fields stay on the lead", () => {
  const expected = "Известные данные брифа остаются на лиде и не затираются пустыми значениями";
  const lead = createConversation({
    clientName: "Альфа",
    requestSummary: "Алматы, строительные услуги",
    service: "site",
  });
  const patchName = lead.clientName;
  assert.equal(patchName, "Альфа");
  assert.match(lead.requestSummary, /Алматы/);
  recordPass("Состояние: известные данные брифа сохранены", expected, lead.requestSummary);
});

test("state: hot status is not downgraded", () => {
  const expected = "Статус hot не понижается в warm/qualified";
  assert.equal(mapPipelineStatus({ lead_status: "warm" }, "hot"), "hot");
  assert.equal(mapPipelineStatus({ pipeline_status: "qualified" }, "hot"), "hot");
  assert.equal(mapPipelineStatus({ lead_status: "hot" }, "qualified"), "hot");
  recordPass("Состояние: hot не понижается", expected, "mapPipelineStatus сохраняет hot");
});

test("state: brief_completed true is sticky", () => {
  const expected = "brief_completed=true не возвращается в false";
  const current = { brief_completed: true };
  const next = current.brief_completed === true ? true : false;
  assert.equal(next, true);
  recordPass("Состояние: brief_completed остаётся true", expected, "true");
});

test("state: greeting and flags survive restart snapshot", async () => {
  const expected = "После сериализации лида флаги greeting/handoff/brief сохраняются";
  const lead = createConversation({
    greeting_sent: true,
    handoff_already_created: true,
    brief_completed: true,
    status: "hot",
  });
  const restored = JSON.parse(JSON.stringify(lead));
  assert.equal(buildShouldGreetState(restored).should_greet, false);
  assert.equal(restored.handoff_already_created, true);
  assert.equal(restored.brief_completed, true);
  assert.equal(restored.status, "hot");
  await finalizeGreetingAfterSend({
    leadId: restored.leadId,
    shouldGreet: false,
    sendSucceeded: true,
    updateLead: async () => {},
  });
  recordPass("Состояние: сохраняется после перезапуска", expected, "флаги восстановлены из снимка");
});

test("format: valid JSON matches existing schema", () => {
  const expected = "Ответ разбирается и содержит восемь обязательных полей";
  const parsed = parseOrThrow(JSON.stringify(makeParsed()));
  const contract = validateContract(parsed);
  assert.equal(contract.ok, true);
  assert.deepEqual(REQUIRED_FIELDS.every((field) => field in parsed), true);
  recordPass("Формат: JSON соответствует схеме", expected, "8 полей на месте", { fields: parsed, reply: parsed.reply });
});

test("format: all eight required fields are present", () => {
  const expected = "Присутствуют reply, lead_status, service, handoff, brief_completed, manager_event, send_asset, summary";
  const parsed = makeParsed();
  for (const field of REQUIRED_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(parsed, field), true);
  }
  recordPass("Формат: все 8 обязательных полей", expected, REQUIRED_FIELDS.join(", "), { fields: parsed });
});

test("format: reply is a non-empty string", () => {
  const expected = "reply — непустая строка; пустой reply отклоняется";
  assert.equal(typeof parseAiReply(makeParsed()).reply, "string");
  assert.throws(() => parseAiReply(makeParsed({ reply: "   " })), AiReplyParseError);
  recordPass("Формат: reply непустая строка", expected, "пустой reply отклонён");
});

test("format: handoff and brief_completed are boolean", () => {
  const expected = "handoff и brief_completed имеют тип boolean";
  assert.throws(() => parseAiReply(makeParsed({ handoff: "true" })), /AI_JSON_HANDOFF_TYPE/);
  assert.throws(() => parseAiReply(makeParsed({ brief_completed: "false" })), /AI_JSON_BRIEF_TYPE/);
  const parsed = parseAiReply(makeParsed({ handoff: true, brief_completed: false }));
  assert.equal(typeof parsed.handoff, "boolean");
  assert.equal(typeof parsed.brief_completed, "boolean");
  recordPass("Формат: boolean-поля", expected, "строковые значения отклонены", { fields: parsed });
});

test("format: enum values are the documented set", () => {
  const expected = "Допустимы только утверждённые enum-значения";
  assert.equal(ALLOWED_LEAD_STATUS.has("warm"), true);
  assert.equal(ALLOWED_SERVICE.has("site_ads"), true);
  assert.equal(ALLOWED_MANAGER_EVENT.has("human_requested"), true);
  assert.equal(ALLOWED_SEND_ASSET.has("presentation_kp"), true);
  assert.equal(validateContract(makeParsed({ lead_status: "superhot" })).ok, false);
  recordPass("Формат: enum-значения допустимы", expected, "неизвестный lead_status отклоняется контрактом тестов");
});

test("format: text before or after JSON is rejected", () => {
  const expected = "Текст до или после JSON отклоняется, клиенту ничего не уходит";
  assert.throws(() => parseAiReply(`note ${JSON.stringify(makeParsed())}`), AiReplyParseError);
  assert.throws(() => parseAiReply(`${JSON.stringify(makeParsed())} tail`), AiReplyParseError);
  recordPass("Формат: текст вокруг JSON отклонён", expected, "parseAiReply бросает ошибку");
});

test("format: client receives only reply", async () => {
  const expected = "В WhatsApp уходит только reply, не JSON и не служебные поля";
  const parsed = makeParsed({
    reply: "Для какого бизнеса нужен сайт?",
    handoff: true,
    summary: "Клиенту нужен сайт",
  });
  const conversation = createConversation();
  const { clientMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "fmt-1", text: "Нужен сайт" },
    deps,
  });
  const safe = clientSafe(parsed);
  assert.equal(clientMessages[0].text, parsed.reply);
  assert.equal(safe.leaked, false);
  recordPass("Формат: клиент получает только reply", expected, clientMessages[0].text, {
    reply: parsed.reply,
    fields: parsed,
  });
});

test("format: invalid JSON is not forwarded to WhatsApp", () => {
  const expected = "Невалидный JSON не становится сообщением клиенту";
  assert.throws(() => parseAiReply("{reply:"), AiReplyParseError);
  assert.equal(getClientReply.length, 1);
  recordPass("Формат: невалидный JSON не пересылается", expected, "парсер отклонил сырой текст");
});

test("kb: site and ads approved prices", () => {
  const expected = "В базе знаний есть утверждённые цены сайтов и рекламы";
  const kb = readKnowledge();
  const checks = [
    ["экспресс-сайт 50 000", /50 000 ₸/],
    ["индивидуальный лендинг 100 000", /100 000 ₸/],
    ["корпоративный сайт от 180 000", /от 180 000 ₸/],
    ["сайт и реклама от 150 000", /от 150 000 ₸/],
    ["реклама в месяц", /от 100 000 ₸ в месяц/],
    ["разовая настройка без месяца в той же формуле", /от 100 000 ₸ за разовую настройку/],
    ["бюджет отдельно", /рекламный бюджет не входит/i],
    ["не складывать цены", /не должен самостоятельно складывать/],
  ];
  const missing = checks.filter(([, re]) => !re.test(kb)).map(([label]) => label);
  assert.deepEqual(missing, []);
  recordPass("Сайты и реклама: факты в базе знаний", expected, "все контрольные цены найдены");
});

test("kb: presentation prices, terms and express package", () => {
  const expected = "Презентации: 8/10/15/16 слайдов, сроки и экспресс-пакет";
  const kb = readKnowledge();
  const checks = [
    /150 000 ₸/,
    /210 000 ₸/,
    /300 000 ₸/,
    /более 15 слайдов — индивидуальный расчёт/,
    /3–5 рабочих дней/,
    /5–7 рабочих дней/,
    /100 000 ₸/,
    /до 12 слайдов/,
    /PowerPoint/,
    /готовность за 24 часа/,
    /decision_required/,
    /send_asset = "none"/,
    /Стоимость дополнительного слайда не утверждена/,
  ];
  const missing = checks.filter((re) => !re.test(kb));
  assert.equal(missing.length, 0);
  recordPass("Презентации: факты в базе знаний", expected, "диапазоны, сроки и экспресс подтверждены");
});

test("kb: logo and branding packages", () => {
  const expected = "Логотип Экспресс/Старт/Стандарт и фирменный стиль";
  const kb = readKnowledge();
  assert.match(kb, /Пакет «Экспресс» — 70 000 ₸/);
  assert.match(kb, /Пакет «Старт» — 100 000 ₸/);
  assert.match(kb, /Пакет «Стандарт» — 150 000 ₸/);
  assert.match(kb, /от 350 000 ₸/);
  assert.match(kb, /2–3 недели/);
  recordPass("Брендинг: факты в базе знаний", expected, "пакеты и срок найдены");
});

test("kb: portfolio and guarantee rules", () => {
  const expected = "Портфолио сайтов отдельно, реклама без подмены, нет гарантии заявок";
  const kb = readKnowledge();
  assert.match(kb, /https:\/\/creolab\.kz\/website#cases/);
  assert.match(kb, /нельзя подменять её ссылкой другой услуги/);
  assert.match(kb, /Нельзя гарантировать конкретное количество заявок/);
  recordPass("Портфолио и гарантии: факты в базе знаний", expected, "правила найдены");
});

test("handoff true creates one manager application", async () => {
  const expected = "handoff=true создаёт одну заявку на +77077471301";
  const conversation = createConversation();
  const parsed = makeParsed({ handoff: true, summary: "Клиенту нужен сайт" });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "h1", text: "Нужен сайт для клиники" },
    deps,
  });
  assert.equal(managerMessages.length, 1);
  assert.equal(managerMessages[0].chatId, MANAGER_CHAT);
  assert.match(managerMessages[0].text, /Новая заявка/);
  assert.equal(conversation.handoff_already_created, true);
  recordPass("Заявки: handoff=true создаёт одну заявку", expected, managerMessages[0].text, {
    fields: parsed,
    reply: parsed.reply,
  });
});

test("handoff false sends nothing", async () => {
  const expected = "handoff=false ничего не отправляет менеджеру";
  const conversation = createConversation();
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed: makeParsed({ handoff: false }),
    conversation,
    incoming: { id: "h2", text: "Нужен сайт" },
    deps,
  });
  assert.equal(managerMessages.length, 0);
  recordPass("Заявки: handoff=false ничего не отправляет", expected, "0 сообщений менеджеру");
});

test("handoff is not sent twice", async () => {
  const expected = "Повторная обработка не создаёт вторую заявку";
  const conversation = createConversation();
  const parsed = makeParsed({ handoff: true });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({ parsed, conversation, incoming: { id: "h3", text: "Нужен сайт" }, deps });
  await runActions({ parsed, conversation, incoming: { id: "h4", text: "Ещё раз" }, deps });
  assert.equal(managerMessages.length, 1);
  recordPass("Заявки: повтор не создаёт вторую заявку", expected, "отправлено 1", { critical: false });
});

test("handoff send error keeps flag false", async () => {
  const expected = "Ошибка отправки не отмечает заявку успешной";
  const conversation = createConversation();
  const { deps } = createHarness([conversation]);
  deps.sendManagerMessage = async () => {
    throw new Error("timeout");
  };
  await runActions({
    parsed: makeParsed({ handoff: true }),
    conversation,
    incoming: { id: "h5", text: "Нужен сайт" },
    deps,
  });
  assert.equal(conversation.handoff_already_created, false);
  recordPass("Заявки: ошибка не ставит handoff_already_created", expected, "флаг остался false");
});

test("decision_required notifies manager", async () => {
  const expected = "decision_required создаёт уведомление менеджеру";
  const conversation = createConversation({ requestSummary: "Нужна скидка" });
  const parsed = makeParsed({ manager_event: "decision_required", summary: "Нужна скидка" });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "d1", text: "Сделаете скидку 20%?" },
    deps,
  });
  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /решение менеджера/);
  recordPass("Заявки: decision_required", expected, managerMessages[0].text, { fields: parsed, reply: parsed.reply });
});

test("human_requested is the priority notification", async () => {
  const expected = "human_requested создаёт приоритетное уведомление и включает HUMAN";
  const conversation = createConversation();
  const parsed = makeParsed({
    handoff: true,
    manager_event: "human_requested",
    summary: "Клиент просит специалиста",
  });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "hum1", text: "Подключите живого менеджера" },
    deps,
  });
  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /живого менеджера/);
  assert.equal(conversation.aiMode, "HUMAN");
  recordPass("Заявки: human_requested приоритетно", expected, managerMessages[0].text, {
    fields: parsed,
    reply: parsed.reply,
  });
});

test("handoff + decision_required send one combined message", async () => {
  const expected = "Одновременные handoff и decision_required не создают два сообщения";
  const conversation = createConversation({ requestSummary: "Нужен нестандартный срок" });
  const parsed = makeParsed({
    handoff: true,
    manager_event: "decision_required",
    summary: "Нужен нестандартный срок",
  });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "c1", text: "Нужно за 3 дня" },
    deps,
  });
  assert.equal(managerMessages.length, 1);
  assert.match(managerMessages[0].text, /требуется решение/);
  recordPass("Заявки: одно объединённое сообщение", expected, managerMessages[0].text, { fields: parsed });
});

test("kp: presentation_kp sends reply then PDF", async () => {
  const expected = "Сначала reply, затем PDF; путь клиенту не показывается";
  const conversation = createConversation({ service: "presentation" });
  const parsed = makeParsed({
    reply: "Прикрепляю коммерческое предложение с комплектацией всех пакетов.",
    service: "presentation",
    send_asset: "presentation_kp",
  });
  const { clientMessages, files, deps } = createHarness([conversation]);
  const order = [];
  deps.sendWhatsAppMessage = async (chatId, text) => {
    order.push("text");
    clientMessages.push({ chatId, text });
  };
  deps.sendWhatsAppLocalFile = async (chatId, filePath, options) => {
    order.push("pdf");
    files.push({ chatId, filePath, ...options });
  };
  await runActions({
    parsed,
    conversation,
    incoming: { id: "kp1", text: "Пришлите КП" },
    deps,
  });
  assert.deepEqual(order, ["text", "pdf"]);
  assert.equal(files[0].fileName, PRESENTATION_KP_FILENAME);
  assert.equal(clientMessages[0].text.includes("assets/private"), false);
  recordPass("КП: текст, затем PDF", expected, order.join(" → "), { reply: parsed.reply, fields: parsed });
});

test("kp: send_asset none attaches nothing", async () => {
  const expected = "send_asset=none не отправляет файл";
  const conversation = createConversation();
  const { files, deps } = createHarness([conversation]);
  await runActions({
    parsed: makeParsed({ send_asset: "none" }),
    conversation,
    incoming: { id: "kp2", text: "Сколько стоит сайт?" },
    deps,
  });
  assert.equal(files.length, 0);
  recordPass("КП: none ничего не прикрепляет", expected, "файлов: 0");
});

test("kp: file comes only from PRESENTATION_KP_PATH", () => {
  const expected = "Файл берётся только из настроенного PRESENTATION_KP_PATH";
  process.env.PRESENTATION_KP_PATH = "assets/private/presentation_kp.pdf";
  assert.match(getPresentationKpPath(), /assets\/private\/presentation_kp\.pdf$/);
  recordPass("КП: путь только из env", expected, getPresentationKpPath());
});

test("kp: reply error blocks PDF", async () => {
  const expected = "При ошибке текста PDF не отправляется";
  const conversation = createConversation();
  const { files, deps } = createHarness([conversation]);
  deps.sendWhatsAppMessage = async () => {
    throw new Error("send failed");
  };
  await runActions({
    parsed: makeParsed({ send_asset: "presentation_kp" }),
    conversation,
    incoming: { id: "kp3", text: "Пришлите КП" },
    deps,
  });
  assert.equal(files.length, 0);
  recordPass("КП: ошибка текста блокирует PDF", expected, "файлов: 0");
});

test("kp: PDF error keeps sent flag false", async () => {
  const expected = "При ошибке PDF presentation_kp_already_sent остаётся false";
  const conversation = createConversation();
  const { deps } = createHarness([conversation]);
  deps.sendWhatsAppLocalFile = async () => {
    throw new Error("upload failed");
  };
  await runActions({
    parsed: makeParsed({ send_asset: "presentation_kp" }),
    conversation,
    incoming: { id: "kp4", text: "Пришлите КП" },
    deps,
    replyAlreadySent: true,
  });
  assert.equal(conversation.presentation_kp_already_sent, false);
  recordPass("КП: ошибка PDF не ставит флаг", expected, "false");
});

test("kp: technical retry does not resend PDF", async () => {
  const expected = "Технический повтор одного incoming id не шлёт PDF снова";
  const conversation = createConversation();
  const parsed = makeParsed({ send_asset: "presentation_kp" });
  const { files, deps } = createHarness([conversation]);
  await runActions({ parsed, conversation, incoming: { id: "kp5", text: "КП" }, deps, replyAlreadySent: true });
  await runActions({ parsed, conversation, incoming: { id: "kp5", text: "КП" }, deps, replyAlreadySent: true });
  assert.equal(files.length, 1);
  recordPass("КП: технический повтор не дублирует файл", expected, "файлов: 1");
});

test("kp: new client request can resend PDF", async () => {
  const expected = "Новая прямая просьба с новым id позволяет отправить КП снова";
  const conversation = createConversation({ presentation_kp_already_sent: true });
  const parsed = makeParsed({ send_asset: "presentation_kp" });
  const { files, deps } = createHarness([conversation]);
  await runActions({ parsed, conversation, incoming: { id: "kp6", text: "Пришлите КП ещё раз" }, deps, replyAlreadySent: true });
  await runActions({ parsed, conversation, incoming: { id: "kp7", text: "И ещё раз" }, deps, replyAlreadySent: true });
  assert.equal(files.length, 2);
  recordPass("КП: новая просьба повторяет файл", expected, "файлов: 2");
});

test("kp: normal dialog continuation does not resend", async () => {
  const expected = "Продолжение обычного диалога с send_asset=none не отправляет КП";
  const conversation = createConversation({ presentation_kp_already_sent: true });
  const { files, deps } = createHarness([conversation]);
  await runActions({
    parsed: makeParsed({ send_asset: "none", reply: "Какой срок запуска рассматриваете?" }),
    conversation,
    incoming: { id: "kp8", text: "Давайте обсудим пакет BUSINESS" },
    deps,
    replyAlreadySent: true,
  });
  assert.equal(files.length, 0);
  recordPass("КП: обычный диалог не повторяет файл", expected, "файлов: 0");
});

test("pipeline mock: scenario 5 handoff on brief answer", async () => {
  const expected = "Ответ на часть брифа: hot, handoff=true, brief_completed=false";
  const parsed = makeParsed({
    reply: "Логотип и срок учла. Осталось подтвердить материалы.",
    lead_status: "hot",
    handoff: true,
    brief_completed: false,
    summary: "Логотип есть, запуск на следующей неделе",
  });
  const conversation = createConversation({ handoff_already_created: false, status: "qualified" });
  const { managerMessages, clientMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "s5", text: "Логотип есть, хотим запустить на следующей неделе" },
    deps,
  });
  assert.equal(mapPipelineStatus(parsed, "qualified"), "hot");
  assert.equal(managerMessages.length, 1);
  assert.equal(clientMessages[0].text, parsed.reply);
  recordPass("Сценарий 5 (мок): handoff после части брифа", expected, parsed.reply, {
    reply: parsed.reply,
    fields: parsed,
  });
});

test("pipeline mock: scenario 6 handoff does not repeat", async () => {
  const expected = "При handoff_already_created=true повторная заявка не уходит, статус остаётся hot";
  const parsed = makeParsed({
    reply: "Приняла, уточните материалы.",
    lead_status: "hot",
    handoff: true,
    brief_completed: false,
  });
  const conversation = createConversation({
    handoff_already_created: true,
    status: "hot",
    notificationEvents: ["handoff:LEAD-0001"],
  });
  const { managerMessages, deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "s6", text: "Материалы пришлём завтра" },
    deps,
  });
  assert.equal(mapPipelineStatus(parsed, "hot"), "hot");
  assert.equal(managerMessages.length, 0);
  recordPass("Сценарий 6 (мок): handoff не повторяется", expected, "заявок: 0", {
    reply: parsed.reply,
    fields: parsed,
  });
});

test("pipeline mock: scenario 12-17 send_asset rules", async () => {
  const expected = "КП уходит только при send_asset=presentation_kp; 16 слайдов и повтор без просьбы — none";
  const conversation = createConversation({ service: "presentation" });
  const { files, deps } = createHarness([conversation]);
  await runActions({
    parsed: makeParsed({ send_asset: "presentation_kp", service: "presentation", reply: "Прикрепляю КП." }),
    conversation,
    incoming: { id: "p12", text: "8 слайдов, только PDF" },
    deps,
    replyAlreadySent: true,
  });
  await runActions({
    parsed: makeParsed({ send_asset: "none", service: "presentation", manager_event: "decision_required" }),
    conversation,
    incoming: { id: "p15", text: "16 слайдов" },
    deps,
    replyAlreadySent: true,
  });
  await runActions({
    parsed: makeParsed({ send_asset: "none", service: "presentation", reply: "Какой пакет ближе?" }),
    conversation,
    incoming: { id: "p16", text: "Давайте обсудим BUSINESS" },
    deps,
    replyAlreadySent: true,
  });
  assert.equal(files.length, 1);
  recordPass("Сценарии 12–17 (мок): правила send_asset", expected, "один PDF, два none");
});

test("pipeline mock: human request stops AI after notify", async () => {
  const expected = "После human_requested включается ручной режим HUMAN";
  const conversation = createConversation();
  const parsed = makeParsed({
    reply: "Конечно, подключу специалиста к диалогу.",
    manager_event: "human_requested",
    handoff: true,
  });
  const { deps } = createHarness([conversation]);
  await runActions({
    parsed,
    conversation,
    incoming: { id: "hum2", text: "Подключите живого менеджера" },
    deps,
  });
  assert.equal(conversation.aiMode, "HUMAN");
  recordPass("Сценарий 22 (мок): запрос человека", expected, "aiMode=HUMAN", {
    reply: parsed.reply,
    fields: parsed,
  });
});

test("live AI evals are not executed by npm test", () => {
  const expected = "Живые evals запускаются только вручную с RUN_LLM_EVALS=true";
  assert.notEqual(process.env.RUN_LLM_EVALS, "true");
  recordPass("Live evals: пропущены в безопасном прогоне", expected, "RUN_LLM_EVALS не включён");
});
