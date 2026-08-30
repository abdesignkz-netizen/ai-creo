import { getManagerChatId, normalizePhone } from "./phoneService.js";
import { log } from "./logger.js";

function getGreenApiBase() {
  const idInstance = process.env.GREEN_API_INSTANCE_ID;
  const apiToken = process.env.GREEN_API_TOKEN;
  if (!idInstance || !apiToken) {
    throw new Error("Green API не настроен");
  }
  return {
    idInstance,
    apiToken,
    base: `https://7107.api.greenapi.com/waInstance${idInstance}`,
  };
}

export async function sendWhatsAppMessage(chatId, message) {
  const { apiToken, base } = getGreenApiBase();
  const url = `${base}/sendMessage/${apiToken}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chatId,
      message,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log("GREEN API ERROR", { chatId, status: response.status });
    throw new Error(errorText || `Green API HTTP ${response.status}`);
  }

  return response.json();
}

export async function sendManagerMessage(message) {
  const chatId = getManagerChatId();
  if (!chatId) {
    throw new Error("MANAGER_PHONE не задан");
  }
  return sendWhatsAppMessage(chatId, message);
}

export async function checkWhatsAppNumber(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return { exists: false, reason: "Некорректный номер" };
  }

  try {
    const { apiToken, base } = getGreenApiBase();
    const url = `${base}/checkWhatsapp/${apiToken}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phoneNumber: Number(normalized),
      }),
    });

    if (!response.ok) {
      return { exists: true, skipped: true };
    }

    const data = await response.json().catch(() => null);
    if (data && data.existsWhatsapp === false) {
      return { exists: false, reason: "Номер не зарегистрирован в WhatsApp" };
    }
    return { exists: true };
  } catch {
    return { exists: true, skipped: true };
  }
}

export function getManagerDestination() {
  return getManagerChatId();
}
