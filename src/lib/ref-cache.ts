import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Per-profile "seen contracts" cache. Populated by any command that surfaces
// a contract to the user (query, create, exercise/created-events). Used by
// TAB completion (`listCids`) and by ref resolution in `cnwla exercise`.
// Never fetched eagerly — grows as the user works.

export interface CachedContract {
  templateId: string;
  ref: string;
}

export interface RefCacheFile {
  version: 1;
  contracts: Record<string, CachedContract>;
}

const VERSION = 1;

export function cacheDir(): string {
  const xdg = process.env["XDG_CACHE_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "cnwla");
}

export function cacheFilePath(profile: string): string {
  return path.join(cacheDir(), `refs-${sanitize(profile)}.json`);
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function loadRefCache(profile: string): RefCacheFile {
  const file = cacheFilePath(profile);
  if (!fs.existsSync(file)) return { version: VERSION, contracts: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === VERSION &&
      typeof (parsed as { contracts?: unknown }).contracts === "object"
    ) {
      return parsed as RefCacheFile;
    }
    return { version: VERSION, contracts: {} };
  } catch {
    return { version: VERSION, contracts: {} };
  }
}

function saveRefCache(profile: string, cache: RefCacheFile): void {
  const file = cacheFilePath(profile);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch {
    // best effort — the cache is a performance aid, never load-bearing
  }
}

// `contractId` → last 6 hex chars. Short enough to type, long enough that
// collisions across tens of thousands of contracts are rare.
export function computeRef(templateId: string, contractId: string): string {
  const simple = simpleTemplateName(templateId);
  const suffix = contractId.slice(-6);
  return `${simple}:${suffix}`;
}

function simpleTemplateName(templateId: string): string {
  const parts = templateId.split(":");
  return parts[parts.length - 1] ?? templateId;
}

export function rememberContract(profile: string, contractId: string, templateId: string): void {
  if (!contractId || !templateId) return;
  const cache = loadRefCache(profile);
  cache.contracts[contractId] = { templateId, ref: computeRef(templateId, contractId) };
  saveRefCache(profile, cache);
}

export function rememberContracts(
  profile: string,
  items: Array<{ contractId: string; templateId: string }>,
): void {
  if (items.length === 0) return;
  const cache = loadRefCache(profile);
  for (const item of items) {
    if (!item.contractId || !item.templateId) continue;
    cache.contracts[item.contractId] = {
      templateId: item.templateId,
      ref: computeRef(item.templateId, item.contractId),
    };
  }
  saveRefCache(profile, cache);
}

export function forgetContract(profile: string, contractId: string): void {
  const cache = loadRefCache(profile);
  if (!(contractId in cache.contracts)) return;
  delete cache.contracts[contractId];
  saveRefCache(profile, cache);
}
