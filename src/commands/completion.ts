import type { Command } from "commander";
import { BASH_SCRIPT, ZSH_SCRIPT } from "../lib/completion.js";
import {
  detectShell,
  installToRc,
  rcFileFor,
  type SupportedShell,
} from "../lib/install-completion.js";

export function registerCompletionCommand(program: Command): void {
  const completion = program
    .command("completion")
    .description("Shell tab-completion: print scripts or install them");

  // `cnwla completion bash|zsh` — print the script (what users `eval` or source).
  completion
    .command("bash")
    .description("Print the bash completion script to stdout")
    .action(() => {
      process.stdout.write(BASH_SCRIPT);
    });

  completion
    .command("zsh")
    .description("Print the zsh completion script to stdout")
    .action(() => {
      process.stdout.write(ZSH_SCRIPT);
    });

  // `cnwla completion install` — append the eval line to the shell's rc file.
  completion
    .command("install")
    .description("Append the completion eval line to your shell's rc file")
    .option("--shell <name>", "bash | zsh (default: $SHELL)")
    .action((opts: { shell?: string }) => {
      const shell = coerceShell(opts.shell) ?? detectShell();
      if (!shell) {
        throw new Error(
          `could not detect shell. Pass --shell bash|zsh (current $SHELL: ${process.env["SHELL"] ?? "unset"}).`,
        );
      }
      const rcPath = rcFileFor(shell);
      const result = installToRc(shell, rcPath);
      if (result.alreadyInstalled) {
        process.stderr.write(`already installed in ${rcPath}\n`);
        return;
      }
      process.stderr.write(
        `added cnwla completion to ${rcPath}\n` +
          `\n→ your current shell hasn't loaded the new binding yet. Pick one:\n` +
          `    source ${rcPath}          # apply to this shell now\n` +
          `    exec ${shell}                    # restart this shell in place\n` +
          `  (or just open a new terminal tab)\n`,
      );
    });
}

function coerceShell(name: string | undefined): SupportedShell | null {
  if (name === "bash" || name === "zsh") return name;
  if (name === undefined) return null;
  throw new Error(`unsupported shell: ${name} (supported: bash | zsh)`);
}
