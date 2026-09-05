import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { log } from "./logger.js";
import { getDataFile } from "./dataDir.js";

function storePath() {
  return getDataFile("leads.json");
}

const emptyStore = () => ({
  counter: 0,
  leads: {},
  phoneIndex: {},
});

let cache = null;
let writeChain = Promise.resolve();
let skipPersist = false;

async function readStore() {
  if (cache) {
    return cache;
  }

  try {
    const raw = await readFile(storePath(), "utf-8");
    const parsed = JSON.parse(raw);
    cache = {
      counter: Number(parsed.counter) || 0,
      leads: parsed.leads || {},
      phoneIndex: parsed.phoneIndex || {},
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
    log("LEAD UPDATE", { persistError: error.message });
  });
  return run;
}

export async function withStore(mutator) {
  return enqueue(async () => {
    const store = await readStore();
    const result = await mutator(store);
    await persist(store);
    return result;
  });
}

export async function getStoreSnapshot() {
  const store = await readStore();
  return store;
}

export function getStorePath() {
  return storePath();
}

export function resetLeadStoreForTests(initial) {
  cache = initial || emptyStore();
  skipPersist = true;
}
