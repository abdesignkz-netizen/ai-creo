const KZ_PHONE_RE =
  /(?:\+?7|8)[\s-]?\(?7\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/;

export function normalizePhone(input) {
  if (input === undefined || input === null) {
    return null;
  }

  const raw = String(input).trim();
  if (!raw) {
    return null;
  }

  const withoutChat = raw.replace(/@c\.us$/i, "");
  const digits = withoutChat.replace(/\D/g, "");

  if (!digits) {
    return null;
  }

  let phone = digits;

  if (phone.length === 11 && phone.startsWith("8")) {
    phone = `7${phone.slice(1)}`;
  } else if (phone.length === 10) {
    phone = `7${phone}`;
  }

  if (phone.length === 11 && phone.startsWith("7")) {
    return phone;
  }

  return null;
}

export function toChatId(input) {
  const phone = normalizePhone(input);
  return phone ? `${phone}@c.us` : null;
}

export function phoneFromChatId(chatId) {
  return normalizePhone(chatId);
}

export function formatPhoneDisplay(input) {
  const phone = normalizePhone(input);
  if (!phone) {
    return "не выяснено";
  }

  return `+${phone[0]} ${phone.slice(1, 4)} ${phone.slice(4, 7)} ${phone.slice(7, 9)} ${phone.slice(9)}`;
}

export function extractPhoneCandidate(text) {
  const raw = String(text || "");
  const match = raw.match(KZ_PHONE_RE);
  if (match) {
    return normalizePhone(match[0]);
  }

  const firstToken = raw.trim().split(/\s+/)[0];
  return normalizePhone(firstToken);
}

export function stripPhoneFromText(text) {
  return String(text || "")
    .replace(KZ_PHONE_RE, " ")
    .replace(/\bLEAD-\d+\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getManagerPhone() {
  return (
    normalizePhone(process.env.MANAGER_PHONE) ||
    normalizePhone(process.env.MANAGER_CHAT_ID) ||
    null
  );
}

export function getManagerChatId() {
  const phone = getManagerPhone();
  return phone ? toChatId(phone) : null;
}

export function isManagerPhone(input) {
  const managerPhone = getManagerPhone();
  const incoming = normalizePhone(input);
  return Boolean(managerPhone && incoming && managerPhone === incoming);
}
