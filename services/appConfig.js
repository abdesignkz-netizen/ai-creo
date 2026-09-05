import { access, constants } from "fs/promises";
import { dirname, isAbsolute, join } from "path";
import { fileURLToPath } from "url";
import { normalizePhone, toChatId } from "./phoneService.js";
import { log } from "./logger.js";
import { isManagementControlEnabled } from "./managementConfig.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PRESENTATION_KP_RELATIVE = "assets/private/presentation_kp.pdf";

export function getProjectRoot() {
  return PROJECT_ROOT;
}

export function getSalesManagerWhatsApp() {
  return String(
    process.env.SALES_MANAGER_WHATSAPP ||
      process.env.MANAGER_PHONE ||
      process.env.MANAGER_CHAT_ID ||
      "",
  ).trim();
}

export function getPresentationKpEnvPath() {
  return String(process.env.PRESENTATION_KP_PATH || "").trim();
}

export function getPresentationKpPath() {
  const configured = getPresentationKpEnvPath();
  if (!configured) {
    return "";
  }
  return isAbsolute(configured) ? configured : join(PROJECT_ROOT, configured);
}

export function getBotPhone() {
  return normalizePhone(
    process.env.BOT_PHONE || process.env.GREEN_API_PHONE || process.env.GREEN_API_WID || "",
  );
}

export function getSalesManagerPhone() {
  return normalizePhone(getSalesManagerWhatsApp());
}

export function getSalesManagerChatId() {
  const phone = getSalesManagerPhone();
  return phone ? toChatId(phone) : null;
}

export function inspectSalesManagerWhatsApp() {
  const raw = getSalesManagerWhatsApp();
  if (!raw) {
    return {
      ok: false,
      reason: "missing",
      message:
        "SALES_MANAGER_WHATSAPP не задан. Укажите номер живого менеджера в .env, например +77077471301.",
    };
  }

  const phone = normalizePhone(raw);
  if (!phone) {
    return {
      ok: false,
      reason: "invalid",
      message: "SALES_MANAGER_WHATSAPP имеет некорректный формат.",
    };
  }

  const bot = getBotPhone();
  if (bot && bot === phone) {
    return {
      ok: false,
      reason: "same_as_bot",
      message:
        "Номер WhatsApp-бота совпадает с SALES_MANAGER_WHATSAPP. Нужен отдельный номер получателя заявок.",
    };
  }

  return {
    ok: true,
    phone,
    chatId: toChatId(phone),
  };
}

export function canNotifySalesManager(clientPhoneOrChatId) {
  const manager = inspectSalesManagerWhatsApp();
  if (!manager.ok) {
    return manager;
  }

  const client = normalizePhone(clientPhoneOrChatId);
  if (client && client === manager.phone) {
    return {
      ok: false,
      reason: "same_as_client",
      message: "Номер менеджера совпадает с номером клиента. Уведомление самому себе не отправляется.",
    };
  }

  return manager;
}

export async function inspectPresentationKp() {
  const configured = getPresentationKpEnvPath();
  const expected = join(PROJECT_ROOT, DEFAULT_PRESENTATION_KP_RELATIVE);

  if (!configured) {
    return {
      ok: false,
      reason: "missing_path",
      message: `PRESENTATION_KP_PATH не задан. Положите presentation_kp.pdf в ${expected} и укажите PRESENTATION_KP_PATH=${DEFAULT_PRESENTATION_KP_RELATIVE}.`,
      expectedPath: expected,
    };
  }

  const resolved = getPresentationKpPath();
  if (!resolved.toLowerCase().endsWith(".pdf")) {
    return {
      ok: false,
      reason: "not_pdf",
      message: `PRESENTATION_KP_PATH должен указывать на файл .pdf. Ожидается ${expected}.`,
      expectedPath: expected,
      path: resolved,
    };
  }

  try {
    await access(resolved, constants.R_OK);
    return {
      ok: true,
      path: resolved,
    };
  } catch {
    return {
      ok: false,
      reason: "missing_file",
      message: `PDF не найден или недоступен для чтения. Положите presentation_kp.pdf сюда: ${resolved}`,
      expectedPath: resolved,
      path: resolved,
    };
  }
}

export async function logAssistantRuntimeChecks() {
  const manager = inspectSalesManagerWhatsApp();
  const pdf = await inspectPresentationKp();

  if (!manager.ok) {
    log("CONFIG", { salesManager: manager.message, reason: manager.reason });
  } else {
    log("CONFIG", { salesManager: "configured" });
  }

  if (!pdf.ok) {
    log("CONFIG", { presentationKp: pdf.message, reason: pdf.reason });
  } else {
    log("CONFIG", { presentationKp: "configured" });
  }

  log("CONFIG", {
    managementWhatsAppControl: isManagementControlEnabled() ? "enabled" : "disabled",
  });

  return { manager, pdf };
}
