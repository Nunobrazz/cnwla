import type { ContractRecord } from "./ledger.js";
import { computeRef } from "./ref-cache.js";

export const FORMATS = new Set(["text", "json", "ndjson"]);

// "ref" is a virtual display field — computed from templateId + contractId.
// Appears first so users reading `cnwla query` output can eyeball what to
// type into `cnwla exercise`. Not part of the underlying API shape.
export const DEFAULT_FIELDS: (keyof ContractRecord | "ref")[] = [
  "ref",
  "contractId",
  "templateId",
  "signatories",
  "observers",
  "argument",
];

export type DisplayField = keyof ContractRecord | "ref";
export type DisplayRecord = Partial<ContractRecord> & { ref?: string };

export function project(record: ContractRecord, fields: DisplayField[]): DisplayRecord {
  const out: DisplayRecord = {};
  for (const f of fields) {
    if (f === "ref") out.ref = computeRef(record.templateId, record.contractId);
    else (out as Record<string, unknown>)[f] = record[f];
  }
  return out;
}

export function projectForDisplay(record: ContractRecord, full: boolean): DisplayRecord {
  if (!full) return project(record, DEFAULT_FIELDS);
  const withRef: DisplayRecord = { ref: computeRef(record.templateId, record.contractId), ...record };
  return withRef;
}

export function emit(fmt: string, records: DisplayRecord[]): void {
  switch (fmt) {
    case "json":
      console.log(JSON.stringify(records, null, 2));
      return;
    case "ndjson":
      for (const r of records) console.log(JSON.stringify(r));
      return;
    case "text":
      if (records.length === 0) return;
      for (let i = 0; i < records.length; i++) {
        if (i > 0) console.log("");
        emitTextBlock(records[i]!);
      }
      return;
  }
}

export function emitOne(fmt: string, record: DisplayRecord): void {
  switch (fmt) {
    case "json":
      console.log(JSON.stringify(record, null, 2));
      return;
    case "ndjson":
      console.log(JSON.stringify(record));
      return;
    case "text":
      emitTextBlock(record);
      return;
  }
}

export function emitTextBlock(record: DisplayRecord): void {
  const keyWidth = Math.max(...Object.keys(record).map((k) => k.length)) + 2;
  for (const [k, v] of Object.entries(record)) {
    const label = `${k}:`.padEnd(keyWidth);
    if (k === "argument" && v && typeof v === "object") {
      console.log("argument:");
      emitNested(v as Record<string, unknown>, "  ");
    } else if (Array.isArray(v)) {
      console.log(`${label}${v.join(", ")}`);
    } else if (v === null || v === undefined) {
      console.log(`${label}`);
    } else if (typeof v === "object") {
      console.log(`${label}${JSON.stringify(v)}`);
    } else {
      console.log(`${label}${String(v)}`);
    }
  }
}

function emitNested(obj: Record<string, unknown>, indent: string): void {
  const keyWidth = Math.max(...Object.keys(obj).map((k) => k.length)) + 2;
  for (const [k, v] of Object.entries(obj)) {
    const label = `${k}:`.padEnd(keyWidth);
    if (Array.isArray(v)) {
      if (v.length === 0) {
        console.log(`${indent}${k}: []`);
      } else {
        console.log(`${indent}${k}:`);
        for (const item of v) {
          if (typeof item === "object" && item !== null) {
            console.log(`${indent}  - ${JSON.stringify(item)}`);
          } else {
            console.log(`${indent}  - ${String(item)}`);
          }
        }
      }
    } else if (v !== null && typeof v === "object") {
      console.log(`${indent}${k}:`);
      emitNested(v as Record<string, unknown>, indent + "  ");
    } else {
      console.log(`${indent}${label}${v === null || v === undefined ? "" : String(v)}`);
    }
  }
}

// Two lookup variants by design: `--where` tolerates missing fields (so a
// filter across mixed templates doesn't error on contracts without the field),
// but `--pick` names a field explicitly, so a miss is an error with the
// available field list.
export function lookupField(record: ContractRecord, name: string): unknown {
  if (name === "ref") return computeRef(record.templateId, record.contractId);
  if (name.includes(".")) {
    const parts = name.split(".");
    let cur: unknown = record;
    for (const p of parts) {
      if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[p];
      else return undefined;
    }
    return cur;
  }
  const rec = record as unknown as Record<string, unknown>;
  if (name !== "argument" && name in rec) return rec[name];
  if (record.argument && name in record.argument) return record.argument[name];
  return undefined;
}

export function resolveField(record: ContractRecord, name: string): unknown {
  const v = lookupField(record, name);
  if (v !== undefined) return v;
  const rec = record as unknown as Record<string, unknown>;
  const topKeys = Object.keys(rec).filter((k) => k !== "argument");
  const argKeys = Object.keys(record.argument ?? {});
  throw new Error(
    `unknown field: ${name}. Available: ${[...topKeys, ...argKeys].join(", ")}`,
  );
}

export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// `#name:...` or a hash prefix of ≥40 hex chars + `:`. Shorter hex is
// ambiguous with short-name suffix matching, so we require at least 40.
export function isFullTemplateId(t: string): boolean {
  return t.startsWith("#") || /^[0-9a-f]{40,}:/.test(t);
}

export function templateSuffix(pattern: string): string {
  return pattern.startsWith(":") ? pattern : ":" + pattern;
}
