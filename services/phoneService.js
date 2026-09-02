const DEFAULT_MANAGER_PHONE = "77077471301";

export function normalizePhone(input) {
  if (input === undefined || input === null) {
    return null;
  }

  const raw = String(input).trim();
  if (!raw) {
    return null;
  }

  const withoutChat = raw.replace(/@(c\.us|s\.whatsapp\.net|g\.us|lid)$/i, "");
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

export function extractPhoneFromVcard(vcard) {
  const match = String(vcard || "").match(/TEL[^:]*:([+\d\s()-]+)/i);
  return match ? normalizePhone(match[1]) : null;
}

export function extractAllPhones(text) {
  const raw = String(text || "");
  const found = [];

  const linkRe = /(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{10,15})/gi;
  for (const match of raw.matchAll(linkRe)) {
    const phone = normalizePhone(match[1]);
    if (phone) {
      found.push(phone);
    }
  }

  const kzRe = /(?:\+?7|8)[\s-]?\(?7\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g;
  for (const match of raw.matchAll(kzRe)) {
    const phone = normalizePhone(match[0]);
    if (phone) {
      found.push(phone);
    }
  }

  return [...new Set(found)];
}

export function extractPhoneCandidate(text) {
  const fromList = extractAllPhones(text)[0];
  if (fromList) {
    return fromList;
  }

  const firstToken = String(text || "").trim().split(/\s+/)[0];
  return normalizePhone(firstToken);
}

export function stripPhoneFromText(text) {
  return stripAllPhonesFromText(text);
}

export function stripAllPhonesFromText(text) {
  return String(text || "")
    .replace(/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?\d{10,15}/gi, " ")
    .replace(/(?:\+?7|8)[\s-]?\(?7\d{2}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g, " ")
    .replace(/\bLEAD-\d+\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function getManagerPhones() {
  const fromEnv = [process.env.MANAGER_PHONE, process.env.MANAGER_CHAT_ID]
    .filter(Boolean)
    .join(",");
  const raw = fromEnv || DEFAULT_MANAGER_PHONE;

  const phones = raw
    .split(/[,;]+/)
    .map((item) => normalizePhone(item))
    .filter(Boolean);

  return [...new Set(phones)];
}

export function getManagerPhone() {
  return getManagerPhones()[0] || null;
}

export function getManagerChatId() {
  const phone = getManagerPhone();
  return phone ? toChatId(phone) : null;
}

export function isManagerPhone(input) {
  const incoming = normalizePhone(input);
  return Boolean(incoming && getManagerPhones().includes(incoming));
}

export function resolveIncomingIdentity(body = {}) {
  const senderData = body.senderData || {};
  const candidates = [
    senderData.sender,
    senderData.chatId,
    senderData.senderPn,
    senderData.wid,
    body.chatId,
    body.senderId,
  ].filter(Boolean);

  for (const item of candidates) {
    const phone = normalizePhone(item);
    if (phone) {
      return {
        phone,
        chatId: toChatId(phone),
        rawChatId: senderData.chatId || body.chatId || item,
      };
    }
  }

  const rawChatId = senderData.chatId || senderData.sender || body.chatId || null;
  return {
    phone: null,
    chatId: rawChatId,
    rawChatId,
  };
}
