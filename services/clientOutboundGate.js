import { normalizePhone, phoneFromChatId, toChatId } from "./phoneService.js";

const blocked = new Map();
let pendingBumper = null;

function phoneKey(input) {
  return normalizePhone(input) || normalizePhone(phoneFromChatId(input)) || String(input || "").trim();
}

export function registerPendingChatBumper(fn) {
  pendingBumper = typeof fn === "function" ? fn : null;
}

export function blockClientOutbound(phone, reason = "manager_stop") {
  const key = phoneKey(phone);
  if (!key) {
    return;
  }
  blocked.set(key, { reason, at: Date.now() });
}

export function clearClientOutboundBlock(phone) {
  const key = phoneKey(phone);
  if (key) {
    blocked.delete(key);
  }
}

export function isClientOutboundBlocked(phone) {
  const key = phoneKey(phone);
  return Boolean(key && blocked.has(key));
}

export function getClientOutboundBlock(phone) {
  const key = phoneKey(phone);
  return key ? blocked.get(key) || null : null;
}

export function abortPendingClientChat(chatIdOrPhone, reason = "manager_stop") {
  const phone = normalizePhone(chatIdOrPhone) || phoneFromChatId(chatIdOrPhone);
  if (phone) {
    blockClientOutbound(phone, reason);
  }
  const chatId = toChatId(chatIdOrPhone) || chatIdOrPhone;
  if (chatId && pendingBumper) {
    pendingBumper(chatId);
  }
}

export function resetClientOutboundGateForTests() {
  blocked.clear();
  pendingBumper = null;
}
