import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { getDataFile } from "./dataDir.js";

const STORE_PATH = getDataFile("manager-session.json");

let pendingOutbound = null;
let lastSend = null;
let lastFocusByManager = {};
let loaded = false;
let skipPersist = false;

async function ensureLoaded() {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const raw = await readFile(STORE_PATH, "utf-8");
    const data = JSON.parse(raw);
    pendingOutbound = data.pendingOutbound || null;
    lastSend = data.lastSend || null;
    lastFocusByManager = data.lastFocusByManager || {};
  } catch {
    pendingOutbound = null;
    lastSend = null;
    lastFocusByManager = {};
  }
}

async function persist() {
  if (skipPersist) {
    return;
  }
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(
    STORE_PATH,
    JSON.stringify({ pendingOutbound, lastSend, lastFocusByManager }, null, 2),
    "utf-8",
  );
}

export async function setPendingOutbound(payload) {
  await ensureLoaded();
  const phones = Array.isArray(payload.phones)
    ? payload.phones.filter(Boolean)
    : payload.phone
      ? [payload.phone]
      : [];

  pendingOutbound = {
    kind: payload.kind || (phones.length > 1 ? "broadcast" : "single"),
    phone: payload.phone || phones[0] || "",
    phones,
    draft: payload.draft || "",
    instruction: payload.instruction || "",
    fileCaption: payload.fileCaption || "",
    files: Array.isArray(payload.files) ? payload.files : [],
    createdAt: Date.now(),
  };
  await persist();
}

export async function getPendingOutbound() {
  await ensureLoaded();
  if (!pendingOutbound) {
    return null;
  }
  if (Date.now() - pendingOutbound.createdAt > 30 * 60 * 1000) {
    pendingOutbound = null;
    await persist();
    return null;
  }
  return pendingOutbound;
}

export async function clearPendingOutbound() {
  await ensureLoaded();
  pendingOutbound = null;
  await persist();
}

export async function setLastSend(payload) {
  await ensureLoaded();
  lastSend = {
    phone: payload.phone,
    ok: Boolean(payload.ok),
    text: payload.text || "",
    error: payload.error || "",
    createdAt: Date.now(),
  };
  await persist();
}

export async function getLastSend() {
  await ensureLoaded();
  return lastSend;
}

export async function setLastFocus(payload = {}) {
  await ensureLoaded();
  const key = String(payload.managerPhone || "default");
  lastFocusByManager[key] = {
    phone: payload.phone || "",
    leadId: payload.leadId || "",
    name: payload.name || "",
    updatedAt: Date.now(),
  };
  await persist();
  return lastFocusByManager[key];
}

export async function getLastFocus(managerPhone) {
  await ensureLoaded();
  const key = String(managerPhone || "default");
  return lastFocusByManager[key] || lastFocusByManager.default || null;
}

export function resetManagerSessionForTests() {
  pendingOutbound = null;
  lastSend = null;
  lastFocusByManager = {};
  loaded = true;
  skipPersist = true;
}
