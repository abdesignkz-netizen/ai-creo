export class AiReplyParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "AiReplyParseError";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseStrictJson(raw) {
  if (isPlainObject(raw)) {
    return raw;
  }
  if (typeof raw !== "string") {
    throw new AiReplyParseError("AI_JSON_NOT_STRING");
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AiReplyParseError("AI_JSON_EMPTY");
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AiReplyParseError("AI_JSON_INVALID");
  }

  if (!isPlainObject(parsed)) {
    throw new AiReplyParseError("AI_JSON_NOT_OBJECT");
  }

  return parsed;
}

export function validateAiReplySchema(parsed) {
  if (!isPlainObject(parsed)) {
    throw new AiReplyParseError("AI_JSON_NOT_OBJECT");
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "reply")) {
    throw new AiReplyParseError("AI_JSON_REPLY_MISSING");
  }
  if (typeof parsed.reply !== "string") {
    throw new AiReplyParseError("AI_JSON_REPLY_TYPE");
  }
  if (parsed.reply.trim() === "") {
    throw new AiReplyParseError("AI_JSON_REPLY_EMPTY");
  }
  if (parsed.lead_status != null && typeof parsed.lead_status !== "string") {
    throw new AiReplyParseError("AI_JSON_LEAD_STATUS_TYPE");
  }
  if (parsed.service != null && typeof parsed.service !== "string") {
    throw new AiReplyParseError("AI_JSON_SERVICE_TYPE");
  }
  if (parsed.handoff != null && typeof parsed.handoff !== "boolean") {
    throw new AiReplyParseError("AI_JSON_HANDOFF_TYPE");
  }
  if (parsed.brief_completed != null && typeof parsed.brief_completed !== "boolean") {
    throw new AiReplyParseError("AI_JSON_BRIEF_TYPE");
  }
  if (parsed.manager_event != null && typeof parsed.manager_event !== "string") {
    throw new AiReplyParseError("AI_JSON_MANAGER_EVENT_TYPE");
  }
  if (parsed.send_asset != null && typeof parsed.send_asset !== "string") {
    throw new AiReplyParseError("AI_JSON_SEND_ASSET_TYPE");
  }
  if (parsed.summary != null && typeof parsed.summary !== "string") {
    throw new AiReplyParseError("AI_JSON_SUMMARY_TYPE");
  }

  return parsed;
}

export function parseAiReply(raw) {
  return validateAiReplySchema(parseStrictJson(raw));
}

export function getClientReply(parsed) {
  return String(parsed.reply).trim();
}

export function isUsableClientReply(reply) {
  return typeof reply === "string" && reply.trim() !== "";
}

export function pickInternalAiFields(parsed) {
  const {
    reply,
    lead_status,
    service,
    handoff,
    brief_completed,
    manager_event,
    send_asset,
    summary,
    ...rest
  } = parsed;
  return {
    reply,
    lead_status,
    service,
    handoff,
    brief_completed,
    manager_event,
    send_asset,
    summary,
    ...rest,
  };
}
