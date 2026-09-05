import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getOrCreateLeadByPhone, updateLead } from "../services/leadService.js";
import { resetLeadStoreForTests } from "../services/leadStore.js";
import { resetManagerSessionForTests, setLastFocus } from "../services/managerSession.js";
import {
  abortPendingClientChat,
  blockClientOutbound,
  isClientOutboundBlocked,
  resetClientOutboundGateForTests,
} from "../services/clientOutboundGate.js";
import { isManagementControlEnabled } from "../services/managementConfig.js";
import {
  assertClientSendAllowed,
  collectManagementEffects,
  evaluateClientSendPolicy,
  handleManagementControl,
  matchDiscountCap,
  selectRelevantInstructions,
} from "../services/managementControl.js";
import { interpretManagementMessageByRules } from "../services/managementParser.js";
import {
  listActiveManagementInstructions,
  resetManagementStoreForTests,
} from "../services/managementInstructionStore.js";
import { parseValidityPeriod } from "../services/managementTime.js";

const MANAGER = "77077471301";
const MANAGER_CHAT = `${MANAGER}@c.us`;
const CLIENT = "77011112233";

async function enableManagement() {
  process.env.MANAGEMENT_WHATSAPP_CONTROL_ENABLED = "true";
  process.env.SALES_MANAGER_WHATSAPP = "+77077471301";
  process.env.MANAGER_ALIASES = "Асхат:+77011111111,Айдос:+77022222222";
}

function disableManagement() {
  process.env.MANAGEMENT_WHATSAPP_CONTROL_ENABLED = "false";
  delete process.env.MANAGER_ALIASES;
}

async function applyMessage(message, extras = {}) {
  const replies = [];
  const result = await handleManagementControl({
    message,
    senderChatId: extras.senderChatId || MANAGER_CHAT,
    notify: async (text) => {
      replies.push(text);
    },
    parseWithAi: extras.parseWithAi,
  });
  return { result, replies };
}

beforeEach(async () => {
  resetManagementStoreForTests();
  resetLeadStoreForTests();
  resetManagerSessionForTests();
  resetClientOutboundGateForTests();
  await enableManagement();
});

test("feature flag off: layer does not handle messages and send stays allowed", async () => {
  disableManagement();
  assert.equal(isManagementControlEnabled(), false);
  const { result, replies } = await applyMessage("Не предлагай сегодня скидку больше 10%.");
  assert.equal(result.handled, false);
  assert.deepEqual(replies, []);
  const gate = await assertClientSendAllowed({
    leadId: "LEAD-0001",
    clientPhone: CLIENT,
    aiMode: "AUTO",
  }, "Могу дать скидку 25%");
  assert.equal(gate.allowed, true);
});

test("scenario 1: today discount cap is saved and blocks higher offers", async () => {
  const { result, replies } = await applyMessage("Не предлагай сегодня скидку больше 10%.");
  assert.equal(result.handled, true);
  assert.match(replies[0], /Принял.*максимальная скидка — 10%/i);

  const active = await listActiveManagementInstructions();
  assert.equal(active.length, 1);
  assert.equal(active[0].action.kind, "max_discount");
  assert.equal(active[0].action.percent, 10);
  assert.equal(active[0].scopeType, "global");
  assert.ok(active[0].validUntil);

  const ordinary = { clientPhone: CLIENT, budget: "300 000", aiMode: "AUTO" };
  const cap = matchDiscountCap(ordinary, active);
  assert.equal(cap.action.percent, 10);
  assert.equal(
    evaluateClientSendPolicy({
      lead: ordinary,
      reply: "Могу предложить скидку 15%",
      instructions: active,
    }).allowed,
    false,
  );
  assert.equal(
    evaluateClientSendPolicy({
      lead: ordinary,
      reply: "Могу предложить скидку 10%",
      instructions: active,
    }).allowed,
    true,
  );
});

test("scenario 2: budget handoff rule really assigns the client", async () => {
  const { replies } = await applyMessage("Клиентов с бюджетом выше 1 млн сразу передавай Асхату.");
  assert.match(replies[0], /Принял.*выше 1 млн.*Асхату/i);

  const lead = await getOrCreateLeadByPhone(CLIENT, { source: "inbound" });
  await updateLead(lead.leadId, { budget: "1,2 млн" });
  const effects = await collectManagementEffects({ ...lead, budget: "1,2 млн", aiMode: "AUTO" });
  assert.equal(effects.patch.aiMode, "HUMAN");
  assert.equal(effects.patch.assignedManager, "Асхат");
  assert.equal(effects.patch.assignedManagerPhone, "77011111111");

  const updated = await updateLead(lead.leadId, effects.patch);
  assert.equal(updated.aiMode, "HUMAN");
  assert.equal(updated.assignedManager, "Асхат");
});

test("scenario 3: pause focused client blocks outbound", async () => {
  const lead = await getOrCreateLeadByPhone(CLIENT, { source: "inbound" });
  await setLastFocus({ managerPhone: MANAGER, phone: lead.clientPhone, leadId: lead.leadId, name: "Иван" });

  const { replies } = await applyMessage("Этому клиенту пока ничего не отвечай.");
  assert.match(replies[0], /Остановил.*паузу/i);

  const fresh = await getOrCreateLeadByPhone(CLIENT);
  assert.equal(fresh.aiMode, "PAUSED");
  assert.equal(isClientOutboundBlocked(CLIENT), true);

  const gate = evaluateClientSendPolicy({
    lead: fresh,
    reply: "Давайте созвонимся",
    instructions: await listActiveManagementInstructions(),
    blocked: true,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "paused");
});

test("scenario 4: resume plus one-off task", async () => {
  const lead = await getOrCreateLeadByPhone(CLIENT, { source: "inbound" });
  await updateLead(lead.leadId, { aiMode: "PAUSED", status: "paused" });
  await setLastFocus({ managerPhone: MANAGER, phone: lead.clientPhone, leadId: lead.leadId, name: "Иван" });
  blockClientOutbound(CLIENT, "manager_stop");

  const { replies } = await applyMessage("Продолжай. Предложи ему созвон завтра после 15:00.");
  assert.match(replies[0], /Принял.*Возобновляю диалог и предложу/i);
  assert.match(replies[0], /созвон завтра после 15:00/i);

  const fresh = await getOrCreateLeadByPhone(CLIENT);
  assert.equal(fresh.aiMode, "AUTO");
  assert.equal(isClientOutboundBlocked(CLIENT), false);

  const active = await listActiveManagementInstructions();
  assert.ok(active.some((item) => item.instructionType === "one_off"));
});

test("scenario 5: list only active rules", async () => {
  await applyMessage("Не предлагай сегодня скидку больше 10%.");
  await applyMessage("Клиентов с бюджетом выше 1 млн сразу передавай Асхату.");
  const { replies } = await applyMessage("Какие мои правила сейчас действуют?");
  assert.match(replies[0], /скидка — 10%/i);
  assert.match(replies[0], /Асхату/i);
  assert.doesNotMatch(replies[0], /canceled|expired|MI-/i);
});

test("scenario 6: explain uses the real saved instruction", async () => {
  await applyMessage("Клиентов с бюджетом выше 1 млн сразу передавай Асхату.");
  const lead = await getOrCreateLeadByPhone(CLIENT, { source: "inbound" });
  const effects = await collectManagementEffects({ ...lead, budget: "1,4 млн", aiMode: "AUTO" });
  await updateLead(lead.leadId, { ...effects.patch, budget: "1,4 млн" });
  await setLastFocus({ managerPhone: MANAGER, phone: CLIENT, leadId: lead.leadId, name: "Иван" });

  const { replies } = await applyMessage("Почему ты передал этого клиента Асхату?");
  assert.match(replies[0], /Асхату/i);
  assert.match(replies[0], /1 млн|1,4|бюджет/i);
});

test("scenario 7: stop after generate blocks queued send", async () => {
  const lead = await getOrCreateLeadByPhone(CLIENT, { source: "inbound" });
  await setLastFocus({ managerPhone: MANAGER, phone: CLIENT, leadId: lead.leadId });

  let bumped = 0;
  const { registerPendingChatBumper } = await import("../services/clientOutboundGate.js");
  registerPendingChatBumper(() => {
    bumped += 1;
  });

  const { replies } = await applyMessage("Стоп. Ничего ему не отправляй.");
  assert.match(replies[0], /Остановил/i);
  assert.ok(bumped >= 1);
  assert.equal(isClientOutboundBlocked(CLIENT), true);

  const gate = await assertClientSendAllowed(
    { ...lead, aiMode: "PAUSED" },
    "Уже готовый ответ клиенту",
  );
  assert.equal(gate.allowed, false);
});

test("scenario 8: global 10% and 2m exception 15% coexist", async () => {
  await applyMessage("Сегодня скидка максимум 10%.");
  await applyMessage("Для клиентов от 2 млн можешь давать до 15%.");

  const active = await listActiveManagementInstructions();
  assert.equal(active.filter((item) => item.action?.kind === "max_discount").length, 2);

  const ordinary = matchDiscountCap({ budget: "400000", aiMode: "AUTO" }, active);
  const rich = matchDiscountCap({ budget: "2 млн", aiMode: "AUTO" }, active);
  assert.equal(ordinary.action.percent, 10);
  assert.equal(rich.action.percent, 15);
});

test("scenario 9: last assignment wins", async () => {
  const lead = await getOrCreateLeadByPhone(CLIENT, { source: "inbound" });
  await setLastFocus({ managerPhone: MANAGER, phone: CLIENT, leadId: lead.leadId, name: "Иван" });

  await applyMessage("Этого клиента передай Асхату.");
  let fresh = await getOrCreateLeadByPhone(CLIENT);
  assert.equal(fresh.assignedManager, "Асхат");

  await applyMessage("Нет, передай его Айдосу.");
  fresh = await getOrCreateLeadByPhone(CLIENT);
  assert.equal(fresh.assignedManager, "Айдос");
  assert.equal(fresh.assignedManagerPhone, "77022222222");
  assert.equal(fresh.aiMode, "HUMAN");
});

test("scenario 10: flag off keeps existing send policy identical", async () => {
  disableManagement();
  const policy = evaluateClientSendPolicy({
    enabled: false,
    lead: { aiMode: "AUTO", budget: "2 млн" },
    reply: "скидка 30%",
    instructions: [{ status: "active", action: { kind: "max_discount", percent: 10 }, scopeType: "global" }],
    blocked: true,
  });
  assert.equal(policy.allowed, true);
});

test("paraphrases of pause resolve to the same intent", () => {
  const variants = [
    "Стоп.",
    "Остановись.",
    "Поставь клиента на паузу.",
    "Не трогай эту заявку.",
  ];
  for (const message of variants) {
    const parsed = interpretManagementMessageByRules(message, {
      focus: { phone: CLIENT, leadId: "LEAD-0001" },
    });
    assert.equal(parsed.handled, true, message);
    assert.equal(parsed.instructions[0].instructionType, "pause", message);
  }
});

test("ambiguous expensive client asks a clarification, not a fake rule", () => {
  const parsed = interpretManagementMessageByRules("Дорогих клиентов теперь сразу передавай менеджеру.");
  assert.equal(parsed.kind, "clarify");
  assert.match(parsed.clarification, /от какой суммы/i);
});

test("confirmation is not returned by parser before apply", () => {
  const parsed = interpretManagementMessageByRules("Не предлагай сегодня скидку больше 10%.");
  assert.equal(parsed.kind, "apply");
  assert.equal(parsed.instructions[0].action.percent, 10);
});

test("today validity expires after end of day", () => {
  const now = new Date("2026-09-05T10:00:00+05:00");
  const period = parseValidityPeriod("Не предлагай сегодня скидку больше 10%.", now);
  assert.ok(period.validUntil);
  assert.ok(new Date(period.validUntil).getTime() > now.getTime());
  assert.ok(new Date(period.validUntil).getTime() < new Date("2026-09-06T06:00:00+05:00").getTime());
});

test("unauthorized number is ignored even if flag is on", async () => {
  const { result, replies } = await applyMessage("Стоп. Никому не отвечай.", {
    senderChatId: "77099998877@c.us",
  });
  assert.equal(result.handled, false);
  assert.deepEqual(replies, []);
});

test("abort gate stops a ready reply without fail-open after confirmed stop", async () => {
  abortPendingClientChat(CLIENT, "manager_stop");
  const gate = evaluateClientSendPolicy({
    lead: { aiMode: "AUTO", clientPhone: CLIENT },
    reply: "Готовый ответ",
    instructions: [],
    blocked: true,
  });
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, "aborted");
});

test("relevant instructions do not dump unrelated global history into a client", () => {
  const selected = selectRelevantInstructions(
    [
      {
        id: "MI-1",
        status: "canceled",
        scopeType: "global",
        action: { kind: "max_discount", percent: 5 },
        priority: 20,
      },
      {
        id: "MI-2",
        status: "active",
        scopeType: "client",
        scopeId: "77000000000",
        action: { kind: "pause" },
        priority: 80,
      },
      {
        id: "MI-3",
        status: "active",
        scopeType: "global",
        action: { kind: "max_discount", percent: 10 },
        priority: 20,
        normalizedIntent: "максимальная скидка — 10%",
      },
    ],
    { clientPhone: CLIENT, aiMode: "AUTO" },
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, "MI-3");
});
