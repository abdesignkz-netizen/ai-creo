import { isManagerPhone, normalizePhone } from "./phoneService.js";

function envFlag(name) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function isManagementControlEnabled() {
  return envFlag("MANAGEMENT_WHATSAPP_CONTROL_ENABLED");
}

export function getManagementControllerPhones() {
  const raw = String(process.env.MANAGEMENT_CONTROLLER_PHONES || "").trim();
  if (!raw) {
    return [];
  }
  return [...new Set(raw.split(/[,;]+/).map((item) => normalizePhone(item)).filter(Boolean))];
}

export function isManagementController(input) {
  if (!isManagementControlEnabled()) {
    return false;
  }
  const extra = getManagementControllerPhones();
  if (extra.length) {
    const phone = normalizePhone(input);
    return Boolean(phone && extra.includes(phone));
  }
  return isManagerPhone(input);
}

export function parseManagerAliases(raw = process.env.MANAGER_ALIASES) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }

  return text
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const split = part.split(":");
      if (split.length < 2) {
        return null;
      }
      const phone = normalizePhone(split[split.length - 1]);
      const name = split.slice(0, -1).join(":").trim();
      if (!name || !phone) {
        return null;
      }
      return { name, phone };
    })
    .filter(Boolean);
}

export function findManagerAlias(nameHint) {
  const needle = normalizePersonName(nameHint);
  if (!needle) {
    return null;
  }
  return (
    parseManagerAliases().find((item) => {
      const name = normalizePersonName(item.name);
      return name === needle || name.startsWith(needle) || needle.startsWith(name);
    }) || null
  );
}

export function normalizePersonName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, "")
    .trim();
}
