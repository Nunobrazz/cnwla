import type { Command } from "commander";
import { loadConfig, resolveProfile } from "../config.js";
import { getToken } from "../lib/auth.js";
import {
  DEFAULT_FIELDS,
  emitOne,
  FORMATS,
  formatScalar,
  isFullTemplateId,
  project,
  resolveField,
  templateSuffix,
  type DisplayRecord,
} from "../lib/display.js";
import { assembleArgs, parseField } from "../lib/arg-parse.js";
import { loadDamlTemplates } from "../lib/daml-source.js";
import { LedgerClient } from "../lib/ledger.js";
import { PartyResolver } from "../lib/party-ref.js";

interface CreateOpts {
  arg?: string;
  actAs?: string;
  readAs?: string;
  workflowId?: string;
  commandId?: string;
  pick?: string;
  full?: boolean;
  format: string;
}

export function registerCreateCommand(program: Command): void {
  program
    .command("create <template> [fields...]")
    .description("Create a contract instance and return the created record")
    .option("--arg <json>", "Contract arguments as a JSON object (alternative to positional k=v fields)")
    .option("--act-as <parties>", "Parties to sign as, comma-separated (default: profile's primaryParty)")
    .option("--read-as <parties>", "Extra read-as parties, comma-separated")
    .option("--workflow-id <id>", "Workflow id tag (default: empty)")
    .option("--command-id <id>", "Command id / idempotency key (default: fresh UUID)")
    .option("--pick <field>", "Emit a single field's value")
    .option("--full", "Include every field the API returns")
    .option("--format <fmt>", "text | json | ndjson", "text")
    .action(async (template: string, fields: string[], opts: CreateOpts) => {
      if (!FORMATS.has(opts.format)) {
        throw new Error(`unknown --format: ${opts.format} (expected: ${[...FORMATS].join(" | ")})`);
      }

      if (opts.arg !== undefined && fields.length > 0) {
        throw new Error(`pass args positionally (key=value) OR via --arg, not both`);
      }

      let createArguments: Record<string, unknown>;
      if (opts.arg !== undefined) {
        try {
          createArguments = JSON.parse(opts.arg) as Record<string, unknown>;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`--arg is not valid JSON: ${msg}`);
        }
        if (
          createArguments === null ||
          typeof createArguments !== "object" ||
          Array.isArray(createArguments)
        ) {
          throw new Error(
            `--arg must be a JSON object, got ${Array.isArray(createArguments) ? "array" : typeof createArguments}`,
          );
        }
      } else {
        createArguments = assembleArgs(fields.map(parseField));
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

      const resolver = new PartyResolver(config);
      const resolvedArgs = (await resolver.resolveDeep(createArguments)) as Record<string, unknown>;
      const actAs = opts.actAs
        ? await resolver.resolvePartyList(opts.actAs)
        : [user.primaryParty];
      const readAs = opts.readAs ? await resolver.resolvePartyList(opts.readAs) : undefined;

      const templateId = await resolveTemplateId(client, user.primaryParty, template);

      let created;
      try {
        created = await client.submitCreate({
          templateId,
          createArguments: resolvedArgs,
          userId: profile.userId,
          actAs,
          ...(readAs !== undefined ? { readAs } : {}),
          ...(opts.workflowId !== undefined ? { workflowId: opts.workflowId } : {}),
          ...(opts.commandId !== undefined ? { commandId: opts.commandId } : {}),
        });
      } catch (err) {
        if (err instanceof Error) {
          const summary = [
            `  request:`,
            `    templateId:      ${templateId}`,
            `    actAs:           ${actAs.join(", ")}`,
            `    createArguments: ${JSON.stringify(resolvedArgs)}`,
          ].join("\n");
          err.message = `${err.message}\n${summary}`;
        }
        throw err;
      }

      const { rememberContract } = await import("../lib/ref-cache.js");
      rememberContract(profileName, created.contractId, created.templateId);

      if (opts.pick) {
        console.log(formatScalar(resolveField(created, opts.pick)));
        return;
      }

      const projected: DisplayRecord = opts.full ? created : project(created, DEFAULT_FIELDS);
      emitOne(opts.format, projected);
    });
}

// Resolution order: full-id passthrough → ACS scan → local Daml source. ACS
// first because deployed state is authoritative; source is the fallback for
// first-ever creates (no instances yet to infer from).
async function resolveTemplateId(
  client: LedgerClient,
  party: string,
  template: string,
): Promise<string> {
  if (isFullTemplateId(template)) return template;

  const all = await client.activeContracts({ party });
  const needle = templateSuffix(template).toLowerCase();
  const acsMatches = [...new Set(all.map((r) => r.templateId))].filter((id) =>
    id.toLowerCase().endsWith(needle),
  );

  if (acsMatches.length === 1) return acsMatches[0]!;
  if (acsMatches.length > 1) {
    throw new Error(
      `template '${template}' is ambiguous — matches multiple templates visible on this participant:\n  ` +
        acsMatches.map((d) => `- ${d}`).join("\n  ") +
        `\nPass the full id (e.g. '#package:Module:Entity').`,
    );
  }

  // ACS empty — try local Daml source as fallback (for first-time creates).
  const catalog = loadDamlTemplates();
  if (catalog) {
    const sourceMatches = catalog.lookupBySuffix(template);
    if (sourceMatches.length === 1) return sourceMatches[0]!;
    if (sourceMatches.length > 1) {
      throw new Error(
        `template '${template}' is ambiguous — matches multiple templates in local source (${catalog.project.damlYamlPath}):\n  ` +
          sourceMatches.map((d) => `- ${d}`).join("\n  ") +
          `\nPass the full id (e.g. '#package:Module:Entity').`,
      );
    }
  }

  const tried = catalog
    ? `Tried:\n  - active contracts visible to your party — no match\n  - local source at ${catalog.project.damlYamlPath} — no match`
    : `Tried:\n  - active contracts visible to your party — no match\n  - local Daml source — no daml.yaml found walking up from cwd`;
  throw new Error(
    `no template matching '${template}' found on this participant.\n${tried}\nPass the full id (e.g. '#example:Delegation:${template}').`,
  );
}
