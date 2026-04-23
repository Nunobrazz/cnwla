import type { Command } from "commander";
import { loadConfig, resolveProfile } from "../config.js";
import { assembleArgs, parseField } from "../lib/arg-parse.js";
import { getToken } from "../lib/auth.js";
import { loadDamlTemplates } from "../lib/daml-source.js";
import { isFullTemplateId, templateSuffix } from "../lib/display.js";
import {
  bucketize,
  renderFlatJson,
  renderFlatText,
  renderTreeJson,
  renderTreeText,
} from "../lib/exercise-result.js";
import { LedgerClient } from "../lib/ledger.js";
import { PartyResolver } from "../lib/party-ref.js";

const FORMATS = new Set(["text", "json", "ndjson"]);

interface ExerciseOpts {
  arg?: string;
  actAs?: string;
  readAs?: string;
  template?: string;
  workflowId?: string;
  commandId?: string;
  full?: boolean;
  tree?: boolean;
  format: string;
}

export function registerExerciseCommand(program: Command): void {
  program
    .command("exercise <cid> <choice> [fields...]")
    .description("Exercise a choice on a contract and return the resulting events")
    .option("--arg <json>", "Choice arguments as a JSON object (alternative to positional k=v)")
    .option(
      "--act-as <parties>",
      "Parties to sign as, comma-separated (default: profile's primaryParty)",
    )
    .option("--read-as <parties>", "Extra read-as parties, comma-separated")
    .option(
      "--template <id>",
      "Skip cid→templateId auto-resolution and use this id (full form required)",
    )
    .option("--workflow-id <id>", "Workflow id tag (default: empty)")
    .option("--command-id <id>", "Command id / idempotency key (default: fresh UUID)")
    .option("--full", "Include every field the API returns")
    .option("--tree", "Render events as a causal tree")
    .option("--format <fmt>", "text | json | ndjson", "text")
    .action(
      async (cid: string, choice: string, fields: string[], opts: ExerciseOpts) => {
        if (!FORMATS.has(opts.format)) {
          throw new Error(
            `unknown --format: ${opts.format} (expected: ${[...FORMATS].join(" | ")})`,
          );
        }
        if (!cid || cid.trim() === "") {
          throw new Error(
            `empty contract id. Did a shell variable fail to expand? (e.g. an unset $CID)`,
          );
        }
        if (!choice || choice.trim() === "") {
          throw new Error(`empty choice name`);
        }
        if (opts.tree && opts.format === "ndjson") {
          throw new Error("--tree is incompatible with --format ndjson; use --format json");
        }
        if (opts.arg !== undefined && fields.length > 0) {
          throw new Error(`pass args positionally (key=value) OR via --arg, not both`);
        }
        for (const f of fields) {
          const eq = f.indexOf("=");
          if (eq > 0 && f.slice(eq + 1).trim() === "") {
            throw new Error(
              `empty value for '${f.slice(0, eq)}'. Did a shell variable fail to expand?`,
            );
          }
        }

        let choiceArgument: Record<string, unknown>;
        if (opts.arg !== undefined) {
          try {
            choiceArgument = JSON.parse(opts.arg) as Record<string, unknown>;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`--arg is not valid JSON: ${msg}`);
          }
          if (
            choiceArgument === null ||
            typeof choiceArgument !== "object" ||
            Array.isArray(choiceArgument)
          ) {
            throw new Error(
              `--arg must be a JSON object, got ${Array.isArray(choiceArgument) ? "array" : typeof choiceArgument}`,
            );
          }
        } else {
          choiceArgument = assembleArgs(fields.map(parseField));
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
        const resolvedArg = (await resolver.resolveDeep(choiceArgument)) as Record<
          string,
          unknown
        >;
        const actAs = opts.actAs
          ? await resolver.resolvePartyList(opts.actAs)
          : [user.primaryParty];
        const readAs = opts.readAs ? await resolver.resolvePartyList(opts.readAs) : undefined;

        // Accept a short ref (`Coin:d4bc7e`, or a bare cid suffix) in place
        // of a full cid. Cache-first, ACS fallback.
        const { resolveCidRef } = await import("../lib/cid-ref.js");
        const resolvedCid = await resolveCidRef(client, user.primaryParty, profileName, cid);

        // JSON API's ExerciseCommand wants both contractId and templateId.
        // Users normally only have the cid, so we look the template up via
        // /v2/events/events-by-contract-id. `--template` skips that hop.
        let templateId: string;
        if (opts.template !== undefined) {
          if (isFullTemplateId(opts.template)) {
            templateId = opts.template;
          } else {
            const catalog = loadDamlTemplates();
            const sourceMatches = catalog
              ? catalog.lookupBySuffix(opts.template)
              : [];
            if (sourceMatches.length === 1) {
              templateId = sourceMatches[0]!;
            } else if (sourceMatches.length > 1) {
              throw new Error(
                `--template '${opts.template}' is ambiguous in local source:\n  ` +
                  sourceMatches.map((d) => `- ${d}`).join("\n  ") +
                  `\nPass the full id (e.g. '#package:Module:Entity').`,
              );
            } else {
              throw new Error(
                `--template '${opts.template}' is a short name but couldn't be resolved. ` +
                  `Pass a full id like '#package:Module:Entity' or run from a directory with the matching daml.yaml project.`,
              );
            }
          }
        } else {
          templateId = await client.resolveTemplateByCid(resolvedCid, [user.primaryParty]);
        }

        let result;
        try {
          result = await client.submitExercise({
            templateId,
            contractId: resolvedCid,
            choice,
            choiceArgument: resolvedArg,
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
              `    choice:         ${choice}`,
              `    templateId:     ${templateId}`,
              `    contractId:     ${resolvedCid}`,
              `    actAs:          ${actAs.join(", ")}`,
              `    choiceArgument: ${JSON.stringify(resolvedArg)}`,
            ].join("\n");
            err.message = `${err.message}\n${summary}`;
          }
          throw err;
        }

        // Update the ref cache with whatever this transaction changed.
        const { rememberContracts, forgetContract } = await import("../lib/ref-cache.js");
        const createdEvents = result.events.filter(
          (e): e is typeof e & { kind: "Created" } => e.kind === "Created",
        );
        rememberContracts(
          profileName,
          createdEvents.map((e) => ({ contractId: e.contractId, templateId: e.templateId })),
        );
        for (const e of result.events) {
          if (e.kind === "Archived" || (e.kind === "Exercised" && e.consuming)) {
            forgetContract(profileName, e.contractId);
          }
        }

        if (opts.format === "text") {
          if (opts.tree) renderTreeText(result, opts.full ?? false);
          else renderFlatText(result, opts.full ?? false);
          return;
        }
        if (opts.format === "json") {
          const payload = opts.tree
            ? renderTreeJson(result, opts.full ?? false)
            : renderFlatJson(result, opts.full ?? false);
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        // ndjson
        const { exercised, archived, created } = bucketize(result);
        for (const e of exercised) console.log(JSON.stringify({ event: "Exercised", ...e }));
        for (const a of archived) console.log(JSON.stringify({ event: "Archived", ...a }));
        for (const c of created) console.log(JSON.stringify({ event: "Created", ...c }));
      },
    );
}
