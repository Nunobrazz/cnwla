import type { Command } from "commander";
import { loadConfig, resolveProfile } from "../config.js";
import { getToken } from "../lib/auth.js";
import {
  DEFAULT_FIELDS,
  emit,
  emitOne,
  FORMATS,
  formatScalar,
  isFullTemplateId,
  lookupField,
  project,
  resolveField,
  templateSuffix,
  type DisplayRecord,
} from "../lib/display.js";
import { LedgerClient, type ContractRecord } from "../lib/ledger.js";
import { PartyResolver } from "../lib/party-ref.js";

interface QueryOpts {
  template?: string;
  where?: string;
  one?: boolean;
  pick?: string;
  count?: boolean;
  full?: boolean;
  format: string;
}

export function registerQueryCommand(program: Command): void {
  program
    .command("query")
    .description("Query active contracts visible to the current profile's party")
    .option(
      "--template <id>",
      "Filter by template. Full id (#pkg:Module:Entity or hash:Module:Entity) or short name (Coin, Delegation:Coin, :Delegation:Coin)",
    )
    .option("--where <filter>", "Client-side filter: key=value,key=value (AND)")
    .option("--one", "Fail if result count != 1 (safety assertion for scripts)")
    .option("--pick <field>", "Emit a single field's value per contract, one per line")
    .option("--count", "Emit just the count of matches")
    .option("--full", "Include every field the API returns")
    .option("--format <fmt>", "text | json | ndjson", "text")
    .action(async (opts: QueryOpts) => {
      if (!FORMATS.has(opts.format)) {
        throw new Error(`unknown --format: ${opts.format} (expected: ${[...FORMATS].join(" | ")})`);
      }

      const globalOpts = program.opts<{ profile?: string; config?: string }>();
      const config = loadConfig(globalOpts.config);
      const { name: profileName, profile } = resolveProfile(config, globalOpts.profile);
      const token = await getToken(profile);
      const client = new LedgerClient({ url: profile.participant, token });

      const user = await client.getUser(profile.userId);
      if (!user.primaryParty) {
        throw new Error(
          `profile '${profileName}' maps to user '${profile.userId}' which has no primaryParty. ` +
            `Use a profile whose user owns a party.`,
        );
      }

      const template = opts.template;
      const serverTemplate = template && isFullTemplateId(template) ? template : undefined;
      const clientSuffix =
        template && !isFullTemplateId(template) ? templateSuffix(template) : undefined;

      const all = await client.activeContracts({
        party: user.primaryParty,
        ...(serverTemplate !== undefined ? { templateId: serverTemplate } : {}),
      });

      let narrowed = all;
      if (clientSuffix !== undefined) {
        const needle = clientSuffix.toLowerCase();
        narrowed = all.filter((r) => r.templateId.toLowerCase().endsWith(needle));
        const distinct = [...new Set(narrowed.map((r) => r.templateId))];
        if (distinct.length > 1) {
          throw new Error(
            `--template '${template}' is ambiguous — matches multiple templates:\n  ` +
              distinct.map((d) => `- ${d}`).join("\n  ") +
              `\nPass the full id (e.g. '#package:Module:Entity').`,
          );
        }
      }

      let whereExpr = opts.where;
      if (whereExpr) {
        const resolver = new PartyResolver(config);
        whereExpr = await resolveWhereRefs(whereExpr, resolver);
      }
      const filtered = whereExpr ? narrowed.filter((r) => matchWhere(r, whereExpr!)) : narrowed;

      if (opts.one && filtered.length !== 1) {
        throw new Error(`--one: expected 1 match, got ${filtered.length}`);
      }

      // Remember the contracts the user is about to see — feeds the ref
      // cache that `cnwla exercise <TAB>` and cid-ref resolution read from.
      const { rememberContracts } = await import("../lib/ref-cache.js");
      rememberContracts(
        profileName,
        filtered.map((r) => ({ contractId: r.contractId, templateId: r.templateId })),
      );

      if (opts.count) {
        console.log(filtered.length);
        return;
      }

      if (opts.pick) {
        for (const r of filtered) {
          console.log(formatScalar(resolveField(r, opts.pick)));
        }
        return;
      }

      const projected: DisplayRecord[] = filtered.map((r) =>
        opts.full ? r : project(r, DEFAULT_FIELDS),
      );
      if (opts.one) {
        emitOne(opts.format, projected[0]!);
      } else {
        emit(opts.format, projected);
      }
    });
}

async function resolveWhereRefs(expr: string, resolver: PartyResolver): Promise<string> {
  const pairs = expr.split(",").map((p) => p.trim()).filter(Boolean);
  const resolved: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) {
      resolved.push(pair);
      continue;
    }
    const key = pair.slice(0, eq);
    const val = pair.slice(eq + 1).trim();
    const newVal = await resolver.resolveRef(val);
    resolved.push(`${key}=${newVal}`);
  }
  return resolved.join(",");
}

function matchWhere(record: ContractRecord, expr: string): boolean {
  const pairs = expr.split(",").map((p) => p.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new Error(`bad --where clause: '${pair}' (expected key=value)`);
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    const actual = lookupField(record, key);
    // Missing field → not-a-match rather than error, so queries over mixed
    // template sets work without specifying --template.
    if (actual === undefined) return false;
    if (!valueMatches(actual, val)) return false;
  }
  return true;
}

function valueMatches(actual: unknown, expected: string): boolean {
  // Arrays match by membership (`signatories=alice` → alice is in the list).
  if (Array.isArray(actual)) return actual.some((x) => String(x) === expected);
  if (actual === null || actual === undefined) return expected === "";
  return String(actual) === expected;
}
