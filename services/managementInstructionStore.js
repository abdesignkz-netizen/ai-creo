import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { getDataFile } from "./dataDir.js";
import { isInstructionExpired } from "./managementTime.js";
import { log } from "./logger.js";

const emptyStore = () => ({
  counter: 0,
  instructions: {},
});

let cache = null;
let writeChain = Promise.resolve();
let skipPersist = false;

function storePath() {
  return getDataFile("management_instructions.json");
}

async function readStore() {
  if (cache) {
    return cache;
  }

  try {
    const raw = await readFile(storePath(), "utf-8");
    const parsed = JSON.parse(raw);
    cache = {
      counter: Number(parsed.counter) || 0,
      instructions: parsed.instructions || {},
    };
  } catch {
    cache = emptyStore();
  }

  return cache;
}

async function persist(store) {
  cache = store;
  if (skipPersist) {
    return;
  }
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
  await writeFile(path, JSON.stringify(store, null, 2), "utf-8");
}

function enqueue(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch((error) => {
    log("MANAGEMENT STORE", { persistError: error.message });
  });
  return run;
}

function nowIso() {
  return new Date().toISOString();
}

function createId(counter) {
  return `MI-${String(counter).padStart(4, "0")}`;
}

export async function withManagementStore(mutator) {
  return enqueue(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await persist(store);
    return result;
  });
}

export async function saveManagementInstruction(input) {
  return withManagementStore((store) => {
    store.counter += 1;
    const id = input.id || createId(store.counter);
    const timestamp = nowIso();
    const record = {
      id,
      companyId: input.companyId || "default",
      managerPhone: input.managerPhone || "",
      originalMessage: input.originalMessage || "",
      normalizedIntent: input.normalizedIntent || "",
      instructionType: input.instructionType,
      scopeType: input.scopeType || "global",
      scopeId: input.scopeId || null,
      conditions: input.conditions || {},
      action: input.action || {},
      priority: Number(input.priority) || 20,
      validFrom: input.validFrom || timestamp,
      validUntil: input.validUntil ?? null,
      status: input.status || "active",
      supersedesInstructionId: input.supersedesInstructionId || null,
      supersededBy: null,
      canceledAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      executionResult: input.executionResult || null,
    };
    store.instructions[id] = record;

    if (record.supersedesInstructionId && store.instructions[record.supersedesInstructionId]) {
      store.instructions[record.supersedesInstructionId] = {
        ...store.instructions[record.supersedesInstructionId],
        status: "superseded",
        supersededBy: id,
        updatedAt: timestamp,
      };
    }

    return record;
  });
}

export async function updateManagementInstruction(id, patch) {
  return withManagementStore((store) => {
    const current = store.instructions[id];
    if (!current) {
      return null;
    }
    const next = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: nowIso(),
    };
    store.instructions[id] = next;
    return next;
  });
}

export async function cancelManagementInstruction(id, reason = "canceled") {
  return updateManagementInstruction(id, {
    status: "canceled",
    canceledAt: nowIso(),
    executionResult: reason,
  });
}

export async function listManagementInstructions() {
  const store = await readStore();
  return Object.values(store.instructions).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
}

export async function getManagementInstruction(id) {
  const store = await readStore();
  return store.instructions[id] || null;
}

export async function expireDueInstructions(now = new Date()) {
  const all = await listManagementInstructions();
  const due = all.filter(
    (item) => item.status === "active" && isInstructionExpired(item, now),
  );
  for (const item of due) {
    try {
      await updateManagementInstruction(item.id, { status: "expired" });
    } catch (error) {
      log("MANAGEMENT STORE", { expireError: error.message, id: item.id });
    }
  }
  return due.map((item) => item.id);
}

export async function listActiveManagementInstructions(now = new Date()) {
  await expireDueInstructions(now);
  const all = await listManagementInstructions();
  return all.filter((item) => item.status === "active" && !isInstructionExpired(item, now));
}

export function resetManagementStoreForTests() {
  cache = emptyStore();
  skipPersist = true;
}

export function usePersistentManagementStoreForTests() {
  skipPersist = false;
}
