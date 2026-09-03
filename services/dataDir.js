import { dirname, join } from "path";
import { fileURLToPath } from "url";

const defaultDataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export function getDataDir() {
  const fromEnv = String(process.env.DATA_DIR || "").trim();
  return fromEnv || defaultDataDir;
}

export function getDataFile(fileName) {
  return join(getDataDir(), fileName);
}
