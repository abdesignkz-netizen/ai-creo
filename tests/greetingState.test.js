import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildAiInput } from "../services/aiService.js";
import {
  buildShouldGreetState,
  finalizeGreetingAfterSend,
  hasGreetingBeenSent,
  isGreetingReserved,
  releaseGreeting,
  reserveGreeting,
  resetGreetingReservationsForTests,
} from "../services/greetingState.js";

beforeEach(() => {
  resetGreetingReservationsForTests();
});

test("first message: should_greet is true when greeting_sent is false", () => {
  const lead = { leadId: "LEAD-0001", greeting_sent: false };
  assert.deepEqual(buildShouldGreetState(lead), { should_greet: true });
  assert.equal(hasGreetingBeenSent(lead), false);
});

test("subsequent message: should_greet is false after greeting_sent", () => {
  const lead = { leadId: "LEAD-0001", greeting_sent: true };
  assert.deepEqual(buildShouldGreetState(lead), { should_greet: false });
  assert.equal(hasGreetingBeenSent(lead), true);
});

test("existing lastGreetingDate is treated as greeting already sent", () => {
  const lead = { leadId: "LEAD-0002", lastGreetingDate: "2026-09-03" };
  assert.equal(hasGreetingBeenSent(lead), true);
  assert.deepEqual(buildShouldGreetState(lead), { should_greet: false });
});

test("two fast first messages: only one reserved greeting", () => {
  const lead = { leadId: "LEAD-0003", greeting_sent: false };
  const first = buildShouldGreetState(lead);
  assert.equal(first.should_greet, true);
  assert.equal(reserveGreeting(lead.leadId), true);
  assert.deepEqual(buildShouldGreetState(lead), { should_greet: false });
  assert.equal(reserveGreeting(lead.leadId), false);
  assert.equal(isGreetingReserved(lead.leadId), true);
});

test("failed send does not persist greeting_sent", async () => {
  const lead = { leadId: "LEAD-0004", greeting_sent: false };
  const updates = [];
  reserveGreeting(lead.leadId);

  const failed = await finalizeGreetingAfterSend({
    leadId: lead.leadId,
    shouldGreet: true,
    sendSucceeded: false,
    updateLead: async (_id, patch) => {
      updates.push(patch);
    },
  });

  assert.deepEqual(failed, { greeting_sent: false, persisted: false });
  assert.deepEqual(updates, []);
  assert.equal(isGreetingReserved(lead.leadId), false);
  assert.deepEqual(buildShouldGreetState(lead), { should_greet: true });
});

test("successful send persists greeting_sent true", async () => {
  const lead = { leadId: "LEAD-0005", greeting_sent: false };
  const updates = [];
  reserveGreeting(lead.leadId);

  const saved = await finalizeGreetingAfterSend({
    leadId: lead.leadId,
    shouldGreet: true,
    sendSucceeded: true,
    updateLead: async (_id, patch) => {
      updates.push(patch);
      Object.assign(lead, patch);
    },
  });

  assert.deepEqual(saved, { greeting_sent: true, persisted: true });
  assert.deepEqual(updates, [{ greeting_sent: true }]);
  assert.equal(lead.greeting_sent, true);
  assert.deepEqual(buildShouldGreetState(lead), { should_greet: false });
});

test("should_greet is passed separately from the client message", () => {
  const message = "Нужен сайт";
  const first = buildAiInput({
    knowledgeBase: "kb",
    history: [],
    message,
    lead: { greeting_sent: false },
    appState: { should_greet: true },
  });
  const next = buildAiInput({
    knowledgeBase: "kb",
    history: [{ role: "user", content: message }],
    message: "сколько стоит",
    lead: { greeting_sent: true },
    appState: { should_greet: false },
  });

  assert.match(first, /=== APPLICATION STATE ===\n\{"should_greet":true\}/);
  assert.match(next, /=== APPLICATION STATE ===\n\{"should_greet":false\}/);
  assert.match(first, /=== ПОСЛЕДНЕЕ СООБЩЕНИЕ КЛИЕНТА ===\nНужен сайт/);
  assert.equal(first.includes("Нужен сайт{\"should_greet\""), false);
  releaseGreeting("unused");
});
