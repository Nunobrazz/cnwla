import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Sentinel string written to the user's rc file. Kept stable so we can detect
// a prior install and avoid duplicate appends.
const EVAL_MARKER = "cnwla completion";

export type SupportedShell = "bash" | "zsh";

export interface InstallResult {
  shell: SupportedShell;
  rcPath: string;
  alreadyInstalled: boolean;
}

export function detectShell(envShell: string | undefined = process.env["SHELL"]): SupportedShell | null {
  if (!envShell) return null;
  const name = path.basename(envShell);
  if (name === "bash") return "bash";
  if (name === "zsh") return "zsh";
  return null;
}

export function rcFileFor(shell: SupportedShell, home: string = os.homedir()): string {
  return path.join(home, shell === "bash" ? ".bashrc" : ".zshrc");
}

export function alreadyInstalled(rcPath: string): boolean {
  if (!fs.existsSync(rcPath)) return false;
  const content = fs.readFileSync(rcPath, "utf8");
  return content.includes(EVAL_MARKER);
}

export function installToRc(shell: SupportedShell, rcPath: string): InstallResult {
  if (alreadyInstalled(rcPath)) {
    return { shell, rcPath, alreadyInstalled: true };
  }
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const snippet = `\n# cnwla tab-completion\neval "$(cnwla completion ${shell})"\n`;
  const prev = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  const sep = prev.length === 0 || prev.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(rcPath, prev + sep + snippet);
  return { shell, rcPath, alreadyInstalled: false };
}

export interface ExportResult {
  rcPath: string;
  alreadyPointingHere: boolean;
  replacedPrevious: boolean;
}

// Ensure `export CNWLA_CONFIG=<configPath>` is present in rcPath. Any prior
// `export CNWLA_CONFIG=...` line is replaced so the user has exactly one
// pointer. Idempotent: re-running with the same configPath is a no-op.
export function addConfigExport(rcPath: string, configPath: string): ExportResult {
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const prev = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf8") : "";
  const targetLine = `export CNWLA_CONFIG=${shellQuote(configPath)}`;
  const existingRe = /^\s*export\s+CNWLA_CONFIG=.*$/gm;
  const existingMatches = prev.match(existingRe) ?? [];
  const alreadyPointingHere = existingMatches.some((l) =>
    l.trim() === targetLine,
  );
  if (alreadyPointingHere) {
    return { rcPath, alreadyPointingHere: true, replacedPrevious: false };
  }
  if (existingMatches.length > 0) {
    const next = prev.replace(existingRe, targetLine);
    fs.writeFileSync(rcPath, next);
    return { rcPath, alreadyPointingHere: false, replacedPrevious: true };
  }
  const sep = prev.length === 0 || prev.endsWith("\n") ? "" : "\n";
  const snippet = `\n# cnwla default config\n${targetLine}\n`;
  fs.writeFileSync(rcPath, prev + sep + snippet);
  return { rcPath, alreadyPointingHere: false, replacedPrevious: false };
}

// Quote the path for use inside a shell double-quoted string. Paths with $
// or ` need escaping; spaces and most punctuation are fine inside quotes.
function shellQuote(p: string): string {
  return `"${p.replace(/(["\\$`])/g, "\\$1")}"`;
}

// Interactive one-shot: offer to append the completion eval line to the
// user's rc file. No persisted "already asked" flag — the rc file itself is
// the source of truth: if the eval line is there, skip; otherwise ask. That
// keeps machine-local state (did I install it?) out of the project yaml.
export async function maybePromptInstallCompletion(
  opts: { yes?: boolean } = {},
): Promise<void> {
  try {
    if (opts.yes) return;
    const isInteractive = process.stdin.isTTY === true && process.stderr.isTTY === true;
    if (!isInteractive) return;

    const shell = detectShell();
    if (!shell) return;
    const rcPath = rcFileFor(shell);
    if (alreadyInstalled(rcPath)) return;

    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const answer = (
      await rl.question(`cnwla: install tab-completion for ${shell}? [Y/n] `)
    )
      .trim()
      .toLowerCase();
    rl.close();
    if (answer === "" || answer === "y" || answer === "yes") {
      installToRc(shell, rcPath);
      process.stderr.write(
        `added cnwla completion to ${rcPath}\n` +
          `\n→ your current shell hasn't loaded the new binding yet. Pick one:\n` +
          `    source ${rcPath}          # apply to this shell now\n` +
          `    exec ${shell}                    # restart this shell in place\n` +
          `  (or just open a new terminal tab)\n`,
      );
    }
  } catch {
    // Never block the command on this prompt.
  }
}
