// Heavy modules (config, auth, ledger, daml-source) are loaded lazily inside
// the completer functions that need them. Static completions (subcommand/flag
// names) must stay fast: every TAB press pays the import cost.
import type { Config } from "../config.js";
import type { LedgerClient } from "../lib/ledger.js";

export interface CompletionResult {
  suggestions: string[];
  directives: string[];
}

interface CompletionContext {
  configPath?: string;
  profileName?: string;
  cwd: string;
}

// Flag catalog per subcommand. Value = what completer fires for the flag's
// argument, or "bool" for zero-arg flags, or "opaque" for flags that take a
// value we don't know how to complete (but whose next token we must skip).
const FLAG_VALUE = "value";
const FLAG_BOOL = "bool";
type FlagKind =
  | "profile"
  | "file"
  | "template"
  | "format"
  | "parties"
  | "shell"
  | typeof FLAG_VALUE
  | typeof FLAG_BOOL;

const GLOBAL_FLAGS: Record<string, FlagKind> = {
  "--profile": "profile",
  "--config": "file",
};

// Keyed by cmdPath joined with " ". Empty key = top-level (no subcommand yet).
const COMMAND_FLAGS: Record<string, Record<string, FlagKind>> = {
  whoami: { "--format": "format" },
  "parties ls": { "--format": "format" },
  "config show": {},
  "config list": {},
  "config use": {},
  init: {
    "--token": FLAG_VALUE,
    "--token-env": FLAG_VALUE,
    "--token-url": FLAG_VALUE,
    "--client-id": FLAG_VALUE,
    "--username": FLAG_VALUE,
    "--password": FLAG_VALUE,
    "--token-env-pattern": FLAG_VALUE,
    "--username-pattern": FLAG_VALUE,
    "--password-env-pattern": FLAG_VALUE,
    "--exclude": FLAG_VALUE,
    "--prefix": FLAG_VALUE,
    "--force": FLAG_BOOL,
    "--dry-run": FLAG_BOOL,
    "--use": FLAG_VALUE,
    "-y": FLAG_BOOL,
    "--yes": FLAG_BOOL,
    "--skip-validate": FLAG_BOOL,
  },
  query: {
    "--template": "template",
    "--where": FLAG_VALUE,
    "--one": FLAG_BOOL,
    "--count": FLAG_BOOL,
    "--full": FLAG_BOOL,
    "--pick": FLAG_VALUE,
    "--format": "format",
  },
  create: {
    "--arg": FLAG_VALUE,
    "--act-as": "parties",
    "--read-as": "parties",
    "--workflow-id": FLAG_VALUE,
    "--command-id": FLAG_VALUE,
    "--pick": FLAG_VALUE,
    "--full": FLAG_BOOL,
    "--format": "format",
  },
  exercise: {
    "--arg": FLAG_VALUE,
    "--act-as": "parties",
    "--read-as": "parties",
    "--template": "template",
    "--workflow-id": FLAG_VALUE,
    "--command-id": FLAG_VALUE,
    "--full": FLAG_BOOL,
    "--tree": FLAG_BOOL,
    "--format": "format",
  },
  completion: {},
  "completion bash": {},
  "completion zsh": {},
  "completion install": { "--shell": "shell" },
};

const SUBCOMMANDS: Record<string, string[]> = {
  "": ["init", "whoami", "parties", "config", "query", "create", "exercise", "completion"],
  parties: ["ls"],
  config: ["show", "list", "use"],
  completion: ["bash", "zsh", "install"],
};

type PositionalKind = "cid" | "choice" | "template" | "profile" | "shell" | "url" | "none";

// Positional completer per cmdPath. Indexed by position. `null` fills gaps.
const POSITIONALS: Record<string, (PositionalKind | null)[]> = {
  "config use": ["profile"],
  init: ["url"],
  create: ["template", null],
  exercise: ["cid", "choice", null],
};

const FORMATS_BY_CMD: Record<string, string[]> = {
  whoami: ["text", "json", "party", "act-as", "read-as"],
  "parties ls": ["text", "json", "party"],
  query: ["text", "json", "ndjson"],
  create: ["text", "json", "ndjson"],
  exercise: ["text", "json", "ndjson"],
};

// ---- entry point ----------------------------------------------------------

export async function complete(words: string[]): Promise<CompletionResult> {
  try {
    return await dispatch(words);
  } catch {
    // Completion must never surface errors to the shell.
    return { suggestions: [], directives: [] };
  }
}

async function dispatch(words: string[]): Promise<CompletionResult> {
  const ctx: CompletionContext = { cwd: process.cwd() };
  // Drop the leading program name if the shell passed it (bash does).
  const raw = words.length > 0 && isProgramName(words[0]!) ? words.slice(1) : words;
  const cur = raw.length === 0 ? "" : raw[raw.length - 1]!;

  const { cmdPath, positionalIndex, positionals, prevFlag } = classify(raw, ctx);

  // Flag-value completion (prev token is a flag expecting a value).
  if (prevFlag) {
    return completeFlagValue(prevFlag, cur, cmdPath, ctx);
  }

  // `cur` is itself a flag — complete flag names for the current cmd.
  if (cur.startsWith("-")) {
    return { suggestions: completeFlags(cmdPath, cur), directives: [] };
  }

  // `cur` is an `@profile` ref (top-level value or inside a k=v fragment).
  if (cur.startsWith("@")) {
    const names = await listProfileNames(ctx);
    const prefix = cur.slice(1);
    return {
      suggestions: names.filter((n) => n.startsWith(prefix)).map((n) => `@${n}`),
      directives: ["nospace"],
    };
  }
  const eq = cur.indexOf("=");
  if (eq >= 0) {
    const key = cur.slice(0, eq);
    const val = cur.slice(eq + 1);
    if (val.startsWith("@")) {
      const names = await listProfileNames(ctx);
      const prefix = val.slice(1);
      return {
        suggestions: names.filter((n) => n.startsWith(prefix)).map((n) => `${key}=@${n}`),
        directives: ["nospace"],
      };
    }
    // Empty value: if we can figure out the field is a Party, pre-offer
    // @profile refs. Saves a keystroke on the common case.
    if (val === "" && cmdPath.length === 1 && cmdPath[0] === "create" && positionals.length >= 1) {
      const type = await fieldTypeFor(positionals[0]!, key, ctx);
      if (type && isPartyType(type)) {
        const names = await listProfileNames(ctx);
        return {
          suggestions: names.map((n) => `${key}=@${n}`),
          directives: ["nospace"],
        };
      }
    }
    return { suggestions: [], directives: [] };
  }

  // Positional dispatch.
  const key = cmdPath.join(" ");

  // `create <tmpl> field=...` — once past the template, suggest its fields.
  if (key === "create" && positionalIndex >= 1 && positionals.length >= 1) {
    const fields = await fieldsForTemplate(positionals[0]!, ctx);
    if (fields.length > 0) {
      const used = new Set(
        positionals.slice(1).map((t) => {
          const e = t.indexOf("=");
          return e >= 0 ? t.slice(0, e) : t;
        }),
      );
      const suggestions = fields
        .filter((f) => !used.has(f) && f.startsWith(cur))
        .map((f) => `${f}=`);
      return { suggestions, directives: ["nospace"] };
    }
  }

  const positional = POSITIONALS[key]?.[positionalIndex] ?? defaultPositional(cmdPath, positionalIndex);
  if (positional) {
    return completePositional(positional, cur, ctx);
  }

  // Subcommand expansion: if the current level has subcommands and we're at
  // the first positional slot, suggest them.
  const subs = SUBCOMMANDS[key];
  if (subs && positionalIndex === 0) {
    return { suggestions: subs.filter((s) => s.startsWith(cur)), directives: [] };
  }

  return { suggestions: [], directives: [] };
}

function isProgramName(tok: string): boolean {
  return tok === "cnwla" || tok.endsWith("/cnwla") || tok.endsWith("cli.ts") || tok.endsWith("cli.js");
}

function defaultPositional(cmdPath: string[], idx: number): PositionalKind | null {
  // Top-level subcommand slot handled by the SUBCOMMANDS table above.
  if (cmdPath.length === 0 && idx === 0) return null;
  return null;
}

// ---- classifier -----------------------------------------------------------

interface Classified {
  cmdPath: string[];
  positionalIndex: number; // index of `cur` among positional slots for cmdPath
  positionals: string[]; // values at each positional slot before cur
  prevFlag: { name: string; kind: FlagKind } | null; // when cur is the value for this flag
}

function classify(raw: string[], ctx: CompletionContext): Classified {
  // Everything before `cur` (the last element) is "already typed and complete".
  const done = raw.slice(0, -1);

  const cmdPath: string[] = [];
  const positionals: string[] = [];
  let positionalIndex = 0;
  let prevFlag: Classified["prevFlag"] = null;
  let skipNext = false;

  for (let i = 0; i < done.length; i++) {
    const tok = done[i]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (tok.startsWith("-")) {
      const [name, inline] = splitInlineValue(tok);
      const kind = lookupFlagKind(cmdPath, name);
      if (name === "--profile" || name === "--config") {
        if (inline !== undefined) {
          if (name === "--profile") ctx.profileName = inline;
          else ctx.configPath = inline;
        } else {
          const next = done[i + 1];
          if (next !== undefined) {
            if (name === "--profile") ctx.profileName = next;
            else ctx.configPath = next;
            skipNext = true;
          }
        }
        continue;
      }
      if (kind && kind !== FLAG_BOOL && inline === undefined) {
        skipNext = true;
      }
      continue;
    }
    // Non-flag: either advances cmdPath or increments positionalIndex.
    const key = cmdPath.join(" ");
    const subs = SUBCOMMANDS[key];
    if (subs && subs.includes(tok)) {
      cmdPath.push(tok);
      positionalIndex = 0;
      positionals.length = 0;
      continue;
    }
    positionals.push(tok);
    positionalIndex++;
  }

  // Now handle `cur`: is it a flag value continuation?
  if (done.length > 0) {
    const last = done[done.length - 1]!;
    if (last.startsWith("-") && !last.includes("=")) {
      const kind = lookupFlagKind(cmdPath, last);
      if (kind && kind !== FLAG_BOOL) {
        prevFlag = { name: last, kind };
      }
    }
  }

  return { cmdPath, positionalIndex, positionals, prevFlag };
}

function splitInlineValue(tok: string): [string, string | undefined] {
  const eq = tok.indexOf("=");
  if (eq < 0) return [tok, undefined];
  return [tok.slice(0, eq), tok.slice(eq + 1)];
}

function lookupFlagKind(cmdPath: string[], name: string): FlagKind | undefined {
  if (name in GLOBAL_FLAGS) return GLOBAL_FLAGS[name];
  // Try deepest cmdPath key, then walk up.
  for (let i = cmdPath.length; i >= 0; i--) {
    const key = cmdPath.slice(0, i).join(" ");
    const flags = COMMAND_FLAGS[key];
    if (flags && name in flags) return flags[name];
  }
  return undefined;
}

// ---- flag-name / flag-value completers -----------------------------------

function completeFlags(cmdPath: string[], cur: string): string[] {
  const flags = new Set<string>(Object.keys(GLOBAL_FLAGS));
  for (let i = 0; i <= cmdPath.length; i++) {
    const key = cmdPath.slice(0, i).join(" ");
    const m = COMMAND_FLAGS[key];
    if (m) for (const k of Object.keys(m)) flags.add(k);
  }
  return [...flags].filter((f) => f.startsWith(cur)).sort();
}

async function completeFlagValue(
  prevFlag: { name: string; kind: FlagKind },
  cur: string,
  cmdPath: string[],
  ctx: CompletionContext,
): Promise<CompletionResult> {
  switch (prevFlag.kind) {
    case "profile":
      return {
        suggestions: (await listProfileNames(ctx)).filter((p) => p.startsWith(cur)),
        directives: [],
      };
    case "file":
      return { suggestions: [], directives: ["filenames"] };
    case "format": {
      const key = cmdPath.join(" ");
      const opts = FORMATS_BY_CMD[key] ?? ["text", "json", "ndjson"];
      return { suggestions: opts.filter((o) => o.startsWith(cur)), directives: [] };
    }
    case "template":
      return { suggestions: await listTemplates(ctx, cur), directives: [] };
    case "parties":
      return completePartiesCsv(cur, ctx);
    case "shell":
      return { suggestions: ["bash", "zsh"].filter((s) => s.startsWith(cur)), directives: [] };
    default:
      return { suggestions: [], directives: [] };
  }
}

async function completePositional(
  kind: PositionalKind,
  cur: string,
  ctx: CompletionContext,
): Promise<CompletionResult> {
  switch (kind) {
    case "cid":
      return { suggestions: await listCids(ctx, cur), directives: [] };
    case "template":
      return { suggestions: await listTemplates(ctx, cur), directives: [] };
    case "profile":
      return {
        suggestions: (await listProfileNames(ctx)).filter((n) => n.startsWith(cur)),
        directives: [],
      };
    case "shell":
      return { suggestions: ["bash", "zsh"].filter((s) => s.startsWith(cur)), directives: [] };
    default:
      return { suggestions: [], directives: [] };
  }
}

// ---- data sources --------------------------------------------------------

async function tryLoadConfig(ctx: CompletionContext): Promise<Config | null> {
  try {
    const { loadConfig } = await import("../config.js");
    return loadConfig(ctx.configPath);
  } catch {
    return null;
  }
}

async function listProfileNames(ctx: CompletionContext): Promise<string[]> {
  const cfg = await tryLoadConfig(ctx);
  if (!cfg) return [];
  return Object.keys(cfg.profiles).sort();
}

async function buildClient(
  ctx: CompletionContext,
): Promise<{ client: LedgerClient; primaryParty: string | null } | null> {
  const cfg = await tryLoadConfig(ctx);
  if (!cfg) return null;
  try {
    const { resolveProfile } = await import("../config.js");
    const { getToken } = await import("../lib/auth.js");
    const { LedgerClient } = await import("../lib/ledger.js");
    const resolved = resolveProfile(cfg, ctx.profileName);
    const token = await withTimeout(getToken(resolved.profile), 800);
    const client = new LedgerClient({ url: resolved.profile.participant, token });
    const user = await withTimeout(client.getUser(resolved.profile.userId), 800);
    return { client, primaryParty: user.primaryParty };
  } catch {
    return null;
  }
}

// Read-only, no network: pulls `Template:shortCID` refs from the per-profile
// cache that `query`/`create`/`exercise` populate as the user sees cids. If
// the user hasn't run those commands yet, TAB stays empty — better than
// blocking the shell on a live ACS fetch.
async function listCids(ctx: CompletionContext, cur: string): Promise<string[]> {
  try {
    const { loadConfig, resolveProfile } = await import("../config.js");
    const { loadRefCache } = await import("../lib/ref-cache.js");
    const cfg = loadConfig(ctx.configPath);
    const { name } = resolveProfile(cfg, ctx.profileName);
    const cache = loadRefCache(name);
    const refs = Object.values(cache.contracts).map((c) => c.ref);
    const needle = cur.toLowerCase();
    return refs.filter((r) => r.toLowerCase().startsWith(needle)).sort();
  } catch {
    return [];
  }
}

// Resolve a user-typed template (short name, suffix, or full id) to its
// field list via local Daml source. Returns [] on ambiguity or unknown.
async function fieldsForTemplate(template: string, ctx: CompletionContext): Promise<string[]> {
  try {
    const { loadDamlTemplates } = await import("../lib/daml-source.js");
    const catalog = loadDamlTemplates(ctx.cwd);
    if (!catalog) return [];
    const matches = catalog.lookupEntriesBySuffix(template);
    if (matches.length !== 1) return [];
    return matches[0]!.fields.map((f) => f.name);
  } catch {
    return [];
  }
}

async function fieldTypeFor(
  template: string,
  fieldName: string,
  ctx: CompletionContext,
): Promise<string | null> {
  try {
    const { loadDamlTemplates } = await import("../lib/daml-source.js");
    const catalog = loadDamlTemplates(ctx.cwd);
    if (!catalog) return null;
    const matches = catalog.lookupEntriesBySuffix(template);
    if (matches.length !== 1) return null;
    const f = matches[0]!.fields.find((x) => x.name === fieldName);
    return f ? f.type : null;
  } catch {
    return null;
  }
}

// True for `Party` and `[Party]`. We don't handle record/nested types — those
// would need recursive resolution across templates; deferred until useful.
function isPartyType(type: string): boolean {
  const t = type.trim();
  return t === "Party" || /^\[\s*Party\s*\]$/.test(t);
}

// Return the template names the user can type. Each simple name (e.g. `Coin`)
// is offered on its own — that's what you write in Daml. Collisions (same
// simple name across modules) fall back to `Module:Template` so the user can
// disambiguate. If `cur` already contains a `:`, we match against the
// qualified forms (the user is explicitly narrowing by module).
async function listTemplates(ctx: CompletionContext, cur: string): Promise<string[]> {
  const bySimple = new Map<string, Set<string>>();
  const add = (mod: string, simple: string): void => {
    const qualified = `${mod}:${simple}`;
    let set = bySimple.get(simple);
    if (!set) {
      set = new Set<string>();
      bySimple.set(simple, set);
    }
    set.add(qualified);
  };

  // Local source (fast, no network).
  try {
    const { loadDamlTemplates } = await import("../lib/daml-source.js");
    const catalog = loadDamlTemplates(ctx.cwd);
    if (catalog) {
      for (const e of catalog.entries) add(e.module, e.template);
    }
  } catch {
    // ignore
  }
  // ACS (only if we can build a client quickly).
  const built = await buildClient(ctx);
  if (built?.primaryParty) {
    try {
      const records = await withTimeout(
        built.client.activeContracts({ party: built.primaryParty }),
        2000,
      );
      for (const r of records) {
        const parts = r.templateId.split(":");
        if (parts.length >= 3) {
          add(parts[parts.length - 2]!, parts[parts.length - 1]!);
        }
      }
    } catch {
      // ignore
    }
  }

  const simpleForms: string[] = [];
  const qualifiedForms: string[] = [];
  for (const [simple, qualifieds] of bySimple) {
    if (qualifieds.size === 1) {
      simpleForms.push(simple);
    } else {
      // Collision — force disambiguation: only the qualified forms appear.
      for (const q of qualifieds) simpleForms.push(q);
    }
    for (const q of qualifieds) qualifiedForms.push(q);
  }
  const pool = cur.includes(":") ? qualifiedForms : simpleForms;
  const needle = cur.toLowerCase();
  return pool.filter((s) => s.toLowerCase().startsWith(needle)).sort();
}

async function completePartiesCsv(
  cur: string,
  ctx: CompletionContext,
): Promise<CompletionResult> {
  // Parties flags accept CSV; complete the last segment.
  const lastComma = cur.lastIndexOf(",");
  const prefix = lastComma >= 0 ? cur.slice(0, lastComma + 1) : "";
  const partial = lastComma >= 0 ? cur.slice(lastComma + 1) : cur;

  // `@profile` refs resolve to parties via config.
  if (partial.startsWith("@")) {
    const names = await listProfileNames(ctx);
    const rest = partial.slice(1);
    return {
      suggestions: names.filter((n) => n.startsWith(rest)).map((n) => `${prefix}@${n}`),
      directives: ["nospace"],
    };
  }

  const built = await buildClient(ctx);
  if (!built) return { suggestions: [], directives: [] };
  try {
    const parties = await withTimeout(built.client.listParties(), 2000);
    return {
      suggestions: parties
        .map((p) => p.party)
        .filter((p) => p.startsWith(partial))
        .map((p) => `${prefix}${p}`)
        .sort(),
      directives: [],
    };
  } catch {
    return { suggestions: [], directives: [] };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

// ---- shell scripts -------------------------------------------------------

export const BASH_SCRIPT = `# cnwla bash completion
_cnwla_complete() {
  local cur words cword
  if type _get_comp_words_by_ref >/dev/null 2>&1; then
    _get_comp_words_by_ref -n =: cur words cword 2>/dev/null || true
  fi
  if [ -z "\${words+x}" ]; then
    cur="\${COMP_WORDS[COMP_CWORD]}"
    words=("\${COMP_WORDS[@]}")
    cword=\$COMP_CWORD
  fi
  local args=("\${words[@]:0:cword+1}")
  local out
  out=\$(cnwla __complete "\${args[@]}" 2>/dev/null) || return 0
  COMPREPLY=()
  local line
  while IFS= read -r line; do
    case "\$line" in
      __directive:nospace)
        if type compopt >/dev/null 2>&1; then compopt -o nospace 2>/dev/null; fi
        ;;
      __directive:filenames)
        if type compopt >/dev/null 2>&1; then compopt -o filenames 2>/dev/null; fi
        COMPREPLY=( \$(compgen -f -- "\$cur") )
        return 0
        ;;
      __directive:*) ;;
      "") ;;
      *) COMPREPLY+=("\$line") ;;
    esac
  done <<< "\$out"
}
complete -F _cnwla_complete cnwla
`;

export const ZSH_SCRIPT = `#compdef cnwla
_cnwla() {
  local -a words_passed
  words_passed=("\${(@)words[1,$CURRENT]}")
  local out
  out=\$(cnwla __complete "\${words_passed[@]}" 2>/dev/null) || return 0
  local -a candidates
  local line
  while IFS= read -r line; do
    case "\$line" in
      __directive:*) ;;
      "") ;;
      *) candidates+=("\$line") ;;
    esac
  done <<< "\$out"
  if (( \${#candidates} )); then
    compadd -a candidates
  fi
}
_cnwla "\$@"
`;
