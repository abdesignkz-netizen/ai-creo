import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AiReplyParseError,
  getClientReply,
  isUsableClientReply,
  parseAiReply,
  pickInternalAiFields,
} from "../services/aiReplyParser.js";

const valid = {
  reply: "Для какого бизнеса нужен сайт?",
  lead_status: "warm",
  service: "site",
  handoff: false,
  brief_completed: false,
  manager_event: "none",
  send_asset: "none",
  summary: "Клиенту нужен сайт",
};

test("valid JSON gives the client only reply", () => {
  const parsed = parseAiReply(JSON.stringify(valid));
  const whatsappText = getClientReply(parsed);
  assert.equal(whatsappText, "Для какого бизнеса нужен сайт?");
  assert.equal(isUsableClientReply(whatsappText), true);
});

test("service fields never go to WhatsApp", () => {
  const parsed = parseAiReply(valid);
  const whatsappText = getClientReply(parsed);
  assert.equal(whatsappText.includes("lead_status"), false);
  assert.equal(whatsappText.includes("handoff"), false);
  assert.equal(whatsappText.includes("brief_completed"), false);
  assert.equal(whatsappText.includes("manager_event"), false);
  assert.equal(whatsappText.includes("send_asset"), false);
  assert.equal(whatsappText.includes("summary"), false);
  assert.equal(whatsappText.includes("{"), false);
  assert.notEqual(whatsappText, JSON.stringify(parsed));
});

test("JSON with text before or after the object is rejected", () => {
  assert.throws(() => parseAiReply(`note ${JSON.stringify(valid)}`), AiReplyParseError);
  assert.throws(() => parseAiReply(`${JSON.stringify(valid)} trailing`), AiReplyParseError);
});

test("missing reply is rejected", () => {
  const { reply, ...rest } = valid;
  assert.throws(() => parseAiReply(JSON.stringify(rest)), /AI_JSON_REPLY_MISSING/);
  assert.equal(reply, valid.reply);
});

test("empty reply is rejected", () => {
  assert.throws(() => parseAiReply(JSON.stringify({ ...valid, reply: "   " })), /AI_JSON_REPLY_EMPTY/);
});

test("invalid JSON is not forwarded to the client", () => {
  assert.throws(() => parseAiReply("{reply:"), AiReplyParseError);
  assert.equal(isUsableClientReply(""), false);
  assert.equal(isUsableClientReply(undefined), false);
});

test("internal fields stay available to event handlers", () => {
  const parsed = parseAiReply({
    ...valid,
    client_name: "Алия",
    pipeline_status: "qualified",
  });
  const {
    reply,
    lead_status,
    service,
    handoff,
    brief_completed,
    manager_event,
    send_asset,
    summary,
  } = pickInternalAiFields(parsed);

  assert.equal(reply, valid.reply);
  assert.equal(lead_status, "warm");
  assert.equal(service, "site");
  assert.equal(handoff, false);
  assert.equal(brief_completed, false);
  assert.equal(manager_event, "none");
  assert.equal(send_asset, "none");
  assert.equal(summary, "Клиенту нужен сайт");
  assert.equal(parsed.client_name, "Алия");
  assert.equal(parsed.pipeline_status, "qualified");
});
