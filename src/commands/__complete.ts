import type { Command } from "commander";
import { complete } from "../lib/completion.js";

export function registerCompleteCommand(program: Command): void {
  // Hidden subcommand: the shell wrapper calls it with raw words. We bypass
  // commander's option parsing (via process.argv directly) because those
  // words may legitimately contain any flags the user is mid-typing.
  program
    .command("__complete [words...]", { hidden: true })
    .allowUnknownOption(true)
    .action(async () => {
      const all = process.argv.slice(2);
      const idx = all.indexOf("__complete");
      const words = idx >= 0 ? all.slice(idx + 1) : [];
      const result = await complete(words);
      for (const d of result.directives) process.stdout.write(`__directive:${d}\n`);
      for (const s of result.suggestions) process.stdout.write(`${s}\n`);
    });
}
