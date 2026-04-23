import type { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import * as YAML from "yaml";
import { findLocalConfig, loadConfig, type Config, type Profile } from "../config.js";
import { getToken } from "../lib/auth.js";
import { findDamlProject } from "../lib/daml-source.js";
import { LedgerClient } from "../lib/ledger.js";

interface InitOpts {
  template?: string;
  token?: string;
  tokenEnv?: string;
  tokenUrl?: string;
  clientId?: string;
  username?: string;
  password?: string;
  // Per-profile patterns. `{USERID}` in the pattern is replaced with the
  // upper-snake-case userId (for env vars) or the literal userId (for
  // usernames). Empty / unset → fall back to the shared flag values.
  tokenEnvPattern?: string;
  usernamePattern?: string;
  passwordEnvPattern?: string;
  exclude?: string;
  prefix?: string;
  force?: boolean;
  dryRun?: boolean;
  use?: string | boolean;
  yes?: boolean;
  skipValidate?: boolean;
}

export function registerInitCommand(program: Command): void {
  program
    .command("init [url]")
    .description("Bootstrap a cnwla config (discovery from a participant, or via --template)")
    .option(
      "--template <name>",
      "Use a preset template (cn-quickstart | shared-secret | oauth2 | no-auth) instead of discovery",
    )
    .option("--token <jwt>", "Literal JWT (used for discovery and inlined in generated profiles)")
    .option(
      "--token-env <var>",
      "Env var holding the JWT; generated profiles reference ${env:VAR}",
    )
    .option("--token-url <url>", "OAuth2 token endpoint (presence of this flag selects OAuth2 mode)")
    .option("--client-id <id>", "OAuth2 client id")
    .option("--username <name>", "OAuth2 username")
    .option("--password <pwd>", "OAuth2 password")
    .option(
      "--token-env-pattern <pat>",
      "Per-profile env var pattern for shared-secret tokens (e.g. '{USERID}_JWT')",
    )
    .option(
      "--username-pattern <pat>",
      "Per-profile OAuth2 username pattern (e.g. '{USERID}')",
    )
    .option(
      "--password-env-pattern <pat>",
      "Per-profile OAuth2 password env var pattern (e.g. '{USERID}_PASSWORD')",
    )
    .option("--exclude <patterns>", "Comma-separated user-id glob patterns to skip")
    .option("--prefix <str>", "Prefix for generated profile names", "")
    .option("--force", "Overwrite existing profiles with the same name")
    .option("--dry-run", "Print the yaml that would be written; don't write")
    .option(
      "--use [name]",
      "After writing, set currentProfile (to [name] if given; else first non-admin discovered user)",
    )
    .option("-y, --yes", "Skip the interactive path prompt; use the default")
    .option("--skip-validate", "Don't probe each generated profile after writing")
    .action(async (urlArg: string | undefined, opts: InitOpts) => {
      const globalOpts = program.opts<{ config?: string }>();
      let url = urlArg;

      const isTTY = process.stdin.isTTY === true && process.stderr.isTTY === true;

      // Wizard: bare `cnwla init` in a TTY with no directives → offer a
      // numbered menu and route into the corresponding template/discovery.
      // Silently skipped in non-TTY (CI) so current error paths still fire.
      const bare =
        !url &&
        !opts.template &&
        !opts.token &&
        !opts.tokenEnv &&
        !opts.tokenUrl &&
        !opts.yes;
      if (bare && isTTY) {
        const wizardResult = await runWizard();
        if (wizardResult.template) opts.template = wizardResult.template;
        if (wizardResult.url) url = wizardResult.url;
      }

      const defaultPath = computeInitTarget(globalOpts.config);
      const shouldPrompt = isTTY && !opts.yes && !globalOpts.config && !opts.dryRun;
      const filePath = shouldPrompt ? await promptForPath(defaultPath) : defaultPath;

      // Template path — build a yaml skeleton and short-circuit discovery.
      if (opts.template !== undefined) {
        const { isTemplateName, TEMPLATES } = await import("../lib/init-templates.js");
        if (!isTemplateName(opts.template)) {
          throw new Error(
            `unknown template: ${opts.template}. Supported: ${TEMPLATES.join(" | ")}`,
          );
        }
        await runTemplate(opts.template, filePath, opts);
        return;
      }

      const existing: Config = fs.existsSync(filePath)
        ? loadConfig(filePath)
        : { profiles: {} };

      const urlFromExisting = existing.currentProfile
        ? existing.profiles[existing.currentProfile]?.participant
        : undefined;
      let resolvedUrl = url ?? urlFromExisting;
      if (!resolvedUrl && isTTY && !opts.yes) {
        // No explicit URL, no existing config to inherit from — ask. Default
        // to $CNWLA_PARTICIPANT_URL if the user set one up for env-based
        // auth, else the canonical local-sandbox URL.
        const defaultUrl =
          process.env["CNWLA_PARTICIPANT_URL"] && process.env["CNWLA_PARTICIPANT_URL"].length > 0
            ? process.env["CNWLA_PARTICIPANT_URL"]
            : "http://127.0.0.1:6864";
        resolvedUrl = await promptForUrl(defaultUrl);
      }
      if (!resolvedUrl) {
        throw new Error(
          "no participant URL. Pass it positionally (e.g. `cnwla init http://127.0.0.1:6864`), " +
            "set CNWLA_PARTICIPANT_URL, or run interactively to be prompted.",
        );
      }

      const discoveryAuth = buildDiscoveryAuth(opts);

      const discoveryToken = await getToken({
        participant: resolvedUrl,
        userId: "__discover__",
        auth: discoveryAuth,
      });

      const client = new LedgerClient({ url: resolvedUrl, token: discoveryToken });
      const users = await client.listUsers();

      const excludePatterns = (opts.exclude ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(globToRegex);
      const filtered = users.filter(
        (u) => !u.isDeactivated && !excludePatterns.some((re) => re.test(u.id)),
      );

      if (filtered.length === 0) {
        console.log(`no users to generate on ${resolvedUrl} (after filters)`);
        return;
      }

      const prefix = opts.prefix ?? "";
      const generated: Record<string, Profile> = {};
      for (const u of filtered) {
        generated[`${prefix}${u.id}`] = {
          participant: resolvedUrl,
          auth: buildProfileAuth(opts, u.id),
          userId: u.id,
        };
      }

      const conflicts = Object.keys(generated).filter((n) => existing.profiles[n]);
      if (conflicts.length && !opts.force) {
        throw new Error(
          `these profiles already exist in ${filePath}: ${conflicts.join(", ")}. ` +
            `Use --force to overwrite, or re-run and pick a different path at the prompt.`,
        );
      }

      // Load the raw existing file as a Document so we can edit its CST and
      // preserve comments, ordering, and whitespace on write. New files start
      // from an empty document with a `profiles:` map ready to populate.
      let doc: YAML.Document;
      if (fs.existsSync(filePath)) {
        doc = YAML.parseDocument(fs.readFileSync(filePath, "utf8"));
        // Ensure `profiles:` is a real YAMLMap we can setIn() into; replace
        // a null / scalar value if needed.
        const profilesNode = doc.get("profiles", true);
        if (!profilesNode || !YAML.isMap(profilesNode)) {
          doc.set("profiles", doc.createNode({}));
        }
      } else {
        doc = new YAML.Document({ profiles: {} });
      }

      for (const [name, profileObj] of Object.entries(generated)) {
        doc.setIn(["profiles", name], doc.createNode(profileObj));
      }

      if (opts.use !== undefined) {
        const target =
          typeof opts.use === "string"
            ? opts.use
            : (filtered.find((u) => u.primaryParty) ?? filtered[0])?.id;
        if (!target) throw new Error("no user found for --use");
        const fullName = `${prefix}${target}`;
        if (!doc.hasIn(["profiles", fullName])) {
          throw new Error(`cannot --use ${fullName}: not among discovered profiles`);
        }
        doc.set("currentProfile", fullName);
      }

      const summary = [
        `participant: ${resolvedUrl}`,
        `discovered ${users.length} user${users.length === 1 ? "" : "s"}; generating ${filtered.length} profile${filtered.length === 1 ? "" : "s"}:`,
        ...filtered.map(
          (u) =>
            `  + ${prefix}${u.id.padEnd(20)} ${u.primaryParty ? `primary: ${u.primaryParty}` : "(no primary party)"}`,
        ),
      ].join("\n");
      console.error(summary);

      const serialized = doc.toString();
      if (opts.dryRun) {
        console.log(serialized);
        return;
      }
      fs.writeFileSync(filePath, serialized);
      console.error(`wrote ${filePath}`);

      // If patterns are in use, list the env vars each profile expects so the
      // user can set them before running a command.
      const envVarsNeeded = new Set<string>();
      if (opts.tokenEnvPattern) {
        for (const u of filtered) {
          envVarsNeeded.add(applyPattern(opts.tokenEnvPattern, u.id, "ENV_VAR"));
        }
      }
      if (opts.passwordEnvPattern) {
        for (const u of filtered) {
          envVarsNeeded.add(applyPattern(opts.passwordEnvPattern, u.id, "ENV_VAR"));
        }
      }
      if (envVarsNeeded.size > 0) {
        console.error(`\nset these env vars to use the generated profiles:`);
        for (const v of [...envVarsNeeded].sort()) console.error(`  export ${v}=…`);
      }

      // Validate each generated profile reaches its participant and looks up
      // its user. Skipped when env-var patterns are in use (the required env
      // vars likely aren't set yet) or when the user asked for --skip-validate.
      if (!opts.skipValidate && envVarsNeeded.size === 0) {
        await validateProfiles(filePath, Object.keys(generated));
      }

      await maybePinConfigToShell(filePath, { yes: opts.yes === true });

      const { maybePromptInstallCompletion } = await import(
        "../lib/install-completion.js"
      );
      await maybePromptInstallCompletion({ yes: opts.yes === true });
    });
}

export function computeInitTarget(explicit: string | undefined): string {
  if (explicit) return explicit;
  // We intentionally don't fall back to CNWLA_CONFIG here. That env var
  // points at a config to *read* from any directory (set by the "pin to
  // shell" prompt). Init is about *creating* a config for the current
  // project — dragging the user back to the pinned file when they're cd'd
  // elsewhere is surprising.
  //
  // Precedence: (cnwla.config.yaml must be in same dir as daml.yaml)
  //   1. existing cnwla.config.yaml found by walk-up → merge into it
  //   2. a daml.yaml nearby → propose cnwla.config.yaml next to it
  //   3. fall back to cwd
  const existingInTree = findLocalConfig(process.cwd());
  if (existingInTree) return existingInTree;
  const daml = findDamlProject(process.cwd());
  if (daml) return path.join(daml.rootDir, "cnwla.config.yaml");
  return path.join(process.cwd(), "cnwla.config.yaml");
}

async function promptForPath(defaultPath: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `write profiles to [${defaultPath}] (enter to accept, or type a path): `,
    );
    const chosen = answer.trim() || defaultPath;
    return path.resolve(chosen);
  } finally {
    rl.close();
  }
}

async function promptForUrl(defaultUrl: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `participant URL [${defaultUrl}] (enter to accept, or type a URL): `,
    );
    return answer.trim() || defaultUrl;
  } finally {
    rl.close();
  }
}

// Infer the auth mode from which flags the user passed. No explicit
// `--auth-mode` switch — same principle as runtime auth detection in the
// config loader. Three outcomes:
//   --token / --token-env      → shared-secret
//   any --token-url / oauth2 flag  → oauth2 (all four oauth flags required)
//   nothing                    → sandbox (no token)
// Conflicting combinations (e.g. both --token and --token-url) throw.
type AuthShape =
  | { kind: "sandbox" }
  | { kind: "shared-secret-literal"; token: string }
  | { kind: "shared-secret-env"; envVar: string }
  | { kind: "oauth2"; tokenUrl: string; clientId: string; username: string; password: string };

function detectAuth(opts: InitOpts): AuthShape {
  const hasSharedSecret = Boolean(opts.token || opts.tokenEnv);
  const oauthFlags: Array<[string, string | undefined]> = [
    ["--token-url", opts.tokenUrl],
    ["--client-id", opts.clientId],
    ["--username", opts.username],
    ["--password", opts.password],
  ];
  const anyOauth = oauthFlags.some(([, v]) => v !== undefined);

  if (hasSharedSecret && anyOauth) {
    throw new Error(
      "ambiguous auth: you passed both a shared-secret flag (--token / --token-env) " +
        "and one or more OAuth2 flags. Pick one.",
    );
  }
  if (opts.token && opts.tokenEnv) {
    throw new Error("pass either --token or --token-env, not both");
  }

  if (opts.token) return { kind: "shared-secret-literal", token: opts.token };
  if (opts.tokenEnv) return { kind: "shared-secret-env", envVar: opts.tokenEnv };

  if (anyOauth) {
    const missing = oauthFlags.filter(([, v]) => v === undefined).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `OAuth2 auth detected (via ${oauthFlags.find(([, v]) => v !== undefined)![0]}) but missing: ${missing.join(", ")}`,
      );
    }
    return {
      kind: "oauth2",
      tokenUrl: opts.tokenUrl!,
      clientId: opts.clientId!,
      username: opts.username!,
      password: opts.password!,
    };
  }
  return { kind: "sandbox" };
}

function buildDiscoveryAuth(opts: InitOpts): Profile["auth"] {
  const auth = detectAuth(opts);
  switch (auth.kind) {
    case "sandbox":
      return { mode: "shared-secret" };
    case "shared-secret-literal":
      return { mode: "shared-secret", token: auth.token };
    case "shared-secret-env": {
      const val = process.env[auth.envVar];
      if (!val) {
        throw new Error(`env var ${auth.envVar} referenced by --token-env is not set`);
      }
      return { mode: "shared-secret", token: val };
    }
    case "oauth2":
      return {
        mode: "oauth2",
        tokenUrl: auth.tokenUrl,
        clientId: auth.clientId,
        username: auth.username,
        password: auth.password,
      };
  }
}

// Build the auth block that lands in each generated profile. The `userId`
// lets per-profile patterns (e.g. `{USERID}_PASSWORD`) expand to per-user
// env-refs so we don't inline one shared credential across every profile.
function buildProfileAuth(opts: InitOpts, userId: string): Profile["auth"] {
  const auth = detectAuth(opts);
  switch (auth.kind) {
    case "sandbox":
      return { mode: "shared-secret" };
    case "shared-secret-literal":
      return { mode: "shared-secret", token: auth.token };
    case "shared-secret-env": {
      // If a pattern is provided, expand it to a per-profile env-ref. Otherwise
      // every profile inherits the single shared env-ref (legacy behaviour).
      const envVar = opts.tokenEnvPattern
        ? applyPattern(opts.tokenEnvPattern, userId, "ENV_VAR")
        : auth.envVar;
      return { mode: "shared-secret", token: `\${env:${envVar}}` };
    }
    case "oauth2": {
      const username = opts.usernamePattern
        ? applyPattern(opts.usernamePattern, userId, "AS_IS")
        : auth.username;
      const password = opts.passwordEnvPattern
        ? `\${env:${applyPattern(opts.passwordEnvPattern, userId, "ENV_VAR")}}`
        : auth.password;
      return {
        mode: "oauth2",
        tokenUrl: auth.tokenUrl,
        clientId: auth.clientId,
        username,
        password,
      };
    }
  }
}

// `{USERID}` → the userId, normalised for the target context:
//   ENV_VAR: upper-cased, non-alnum → `_`   (alice-dev → ALICE_DEV)
//   AS_IS:   verbatim                        (alice-dev → alice-dev)
function applyPattern(pattern: string, userId: string, kind: "ENV_VAR" | "AS_IS"): string {
  const sub =
    kind === "ENV_VAR" ? userId.toUpperCase().replace(/[^A-Z0-9]/g, "_") : userId;
  return pattern.replace(/\{USERID\}/g, sub);
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}


// After writing the config, offer to append `export CNWLA_CONFIG=<path>` to
// the user's rc file so `cnwla` uses this config from any directory.
async function maybePinConfigToShell(
  configPath: string,
  opts: { yes: boolean },
): Promise<void> {
  try {
    if (opts.yes) return;
    const isInteractive = process.stdin.isTTY === true && process.stderr.isTTY === true;
    if (!isInteractive) return;

    const { detectShell, rcFileFor, addConfigExport } = await import(
      "../lib/install-completion.js"
    );
    const shell = detectShell();
    if (!shell) return;
    const rcPath = rcFileFor(shell);

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = (
      await rl.question(
        `cnwla: set CNWLA_CONFIG=${configPath} in ${rcPath}? [Y/n] `,
      )
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (answer !== "" && answer !== "y" && answer !== "yes") return;

    const result = addConfigExport(rcPath, configPath);
    if (result.alreadyPointingHere) {
      console.error(`${rcPath} already points CNWLA_CONFIG here`);
      return;
    }
    if (result.replacedPrevious) {
      console.error(`updated CNWLA_CONFIG in ${rcPath}`);
    } else {
      console.error(`added CNWLA_CONFIG export to ${rcPath}`);
    }
    console.error(
      `\n→ your current shell hasn't loaded the new value yet. Pick one:\n` +
        `    source ${rcPath}          # apply to this shell now\n` +
        `    exec ${shell}                    # restart this shell in place\n` +
        `  (or just open a new terminal tab)`,
    );
  } catch {
    // Never block init on this prompt.
  }
}

// Numbered menu that fires when the user runs bare `cnwla init` in a TTY.
// Routes into the right template or back into discovery based on the choice.
async function runWizard(): Promise<{ template?: string; url?: string }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      "What kind of Canton setup are you connecting to?\n" +
        "  1) cn-quickstart LocalNet (shared-secret, 3 profiles)\n" +
        "  2) Sandbox with no auth (dpm sandbox, daml sandbox)\n" +
        "  3) Custom LocalNet / dev with shared-secret auth\n" +
        "  4) Production with OAuth2 (write a skeleton to fill in)\n" +
        "  5) I have a running participant — discover users from it\n",
    );
    const pick = (await rl.question("Pick [1-5]: ")).trim();
    switch (pick) {
      case "1":
        return { template: "cn-quickstart" };
      case "2":
        return { template: "no-auth" };
      case "3":
        return { template: "shared-secret" };
      case "4":
        return { template: "oauth2" };
      case "5": {
        const defaultUrl =
          process.env["CNWLA_PARTICIPANT_URL"] && process.env["CNWLA_PARTICIPANT_URL"].length > 0
            ? process.env["CNWLA_PARTICIPANT_URL"]
            : "http://127.0.0.1:6864";
        const entered = (
          await rl.question(`Participant URL [${defaultUrl}]: `)
        ).trim();
        return { url: entered.length === 0 ? defaultUrl : entered };
      }
      default:
        throw new Error(`unrecognised choice '${pick}'. Re-run and pick 1-5.`);
    }
  } finally {
    rl.close();
  }
}

// Ping each profile's participant with its token and verify the ledger
// user exists. Prints ✓ per OK, ⚠ per failure, with a short reason. Never
// throws — validation is informational, the yaml has already been written.
async function validateProfiles(filePath: string, profileNames: string[]): Promise<void> {
  if (profileNames.length === 0) return;

  let cfg: Config;
  try {
    cfg = loadConfig(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`⚠ could not load written config to validate: ${msg}`);
    return;
  }

  // Cap each probe so a slow / hung participant can't wedge init forever.
  const PROBE_TIMEOUT_MS = 3000;
  console.error(`\nvalidating ${profileNames.length} profile${profileNames.length === 1 ? "" : "s"}…`);

  // Run probes in parallel so total time == slowest probe, not the sum.
  const results = await Promise.all(
    profileNames.map(async (name) => {
      const profile = cfg.profiles[name];
      if (!profile) {
        console.error(`⚠ ${name.padEnd(20)} → profile not in written config`);
        return { name, ok: false, kind: "config" as const };
      }
      try {
        const token = await withTimeout(getToken(profile), PROBE_TIMEOUT_MS, "token mint");
        const client = new LedgerClient({ url: profile.participant, token });
        const user = await withTimeout(
          client.getUser(profile.userId),
          PROBE_TIMEOUT_MS,
          "/v2/users lookup",
        );
        const pp = user.primaryParty ?? "(no primary party)";
        console.error(`✓ ${name.padEnd(20)} → ${pp}`);
        return { name, ok: true, kind: "ok" as const };
      } catch (err) {
        const msg = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
        console.error(`⚠ ${name.padEnd(20)} → ${msg}`);
        const timedOut = msg.includes("timed out");
        return { name, ok: false, kind: timedOut ? ("timeout" as const) : ("other" as const) };
      }
    }),
  );

  // If every probe timed out the participant likely rejects the token shape
  // silently (e.g. OAuth2-required participant receiving an HS256 token with
  // no reachable JWKS). Nudge the user toward the right template.
  const allTimedOut = results.length > 0 && results.every((r) => r.kind === "timeout");
  if (allTimedOut) {
    console.error(
      `\n` +
        `All probes timed out. This usually means the participant requires a\n` +
        `different auth mode than this template assumes — e.g. your cn-quickstart\n` +
        `is running in OAuth2 mode while this yaml uses shared-secret. Try:\n` +
        `  cnwla init --template oauth2 --force\n` +
        `and fill in your Keycloak realm details.`,
    );
  } else {
    console.error(`\n→ run \`cnwla whoami [--profile <name>]\` any time to re-check.`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// Dispatch to one of the template builders. Shared plumbing: write the
// result, optionally print a post-write note, run the pin/completion
// prompts, maybe validate.
async function runTemplate(
  name: "cn-quickstart" | "shared-secret" | "oauth2" | "no-auth",
  filePath: string,
  opts: InitOpts,
): Promise<void> {
  const { buildTemplate } = await import("../lib/init-templates.js");

  const ttyPrompt = async (message: string, defaultValue: string): Promise<string> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ans = (
        await rl.question(`${message} [${defaultValue}]: `)
      ).trim();
      return ans.length === 0 ? defaultValue : ans;
    } finally {
      rl.close();
    }
  };

  const ttyConfirm = async (message: string, defaultYes: boolean): Promise<boolean> => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const hint = defaultYes ? "[Y/n]" : "[y/N]";
      const ans = (await rl.question(`${message} ${hint} `)).trim().toLowerCase();
      if (ans === "") return defaultYes;
      return ans === "y" || ans === "yes";
    } finally {
      rl.close();
    }
  };

  const isTTY = process.stdin.isTTY === true && process.stderr.isTTY === true;
  const canPrompt = isTTY && !opts.yes;

  const result = await buildTemplate(name, {
    ...(canPrompt ? { prompt: ttyPrompt, confirm: ttyConfirm } : {}),
  });

  const serialized = result.doc.toString();
  if (opts.dryRun) {
    console.log(serialized);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, serialized);
  console.error(`wrote ${filePath}`);
  if (result.postWriteNote) console.error(result.postWriteNote);

  // Skip validation for templates that wrote <placeholder> values (oauth2):
  // calling whoami would always fail with an auth error users haven't wired
  // up yet. For every other template, probe each generated profile.
  if (!result.skipValidation && !opts.skipValidate) {
    const cfg = loadConfig(filePath);
    await validateProfiles(filePath, Object.keys(cfg.profiles));
  }

  await maybePinConfigToShell(filePath, { yes: opts.yes === true });

  const { maybePromptInstallCompletion } = await import("../lib/install-completion.js");
  await maybePromptInstallCompletion({ yes: opts.yes === true });
}
