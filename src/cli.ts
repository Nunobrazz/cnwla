#!/usr/bin/env node

// Fast path: every TAB press re-invokes this script. Short-circuit before we
// import commander and all command modules so static completions don't pay
// their parse cost.
if (process.argv[2] === "__complete") {
  const idx = process.argv.indexOf("__complete");
  const words = process.argv.slice(idx + 1);
  const { complete } = await import("./lib/completion.js");
  const result = await complete(words);
  for (const d of result.directives) process.stdout.write(`__directive:${d}\n`);
  for (const s of result.suggestions) process.stdout.write(`${s}\n`);
  process.exit(0);
}

const { default: chalk } = await import("chalk");
const { Command } = await import("commander");
const { registerCompleteCommand } = await import("./commands/__complete.js");
const { registerCompletionCommand } = await import("./commands/completion.js");
const { registerConfigCommands } = await import("./commands/config.js");
const { registerCreateCommand } = await import("./commands/create.js");
const { registerExerciseCommand } = await import("./commands/exercise.js");
const { registerInitCommand } = await import("./commands/init.js");
const { registerPartiesCommands } = await import("./commands/parties.js");
const { registerQueryCommand } = await import("./commands/query.js");
const { registerWhoamiCommand } = await import("./commands/whoami.js");

const program = new Command();

program
  .name("cnwla")
  .description("cnwla — Canton Network Wrapped LedgerAPI. CLI for the JSON Ledger API v2.")
  .version("0.0.1")
  .option("--profile <name>", "profile to use (overrides CNWLA_PROFILE and config default)")
  .option("--config <path>", "path to config file (default: ~/.cnwla/config.yaml)");

registerConfigCommands(program);
registerInitCommand(program);
registerWhoamiCommand(program);
registerPartiesCommands(program);
registerQueryCommand(program);
registerCreateCommand(program);
registerExerciseCommand(program);
registerCompletionCommand(program);
registerCompleteCommand(program);

// Single top-level catch; every command just throws Error(msg). chalk respects
// NO_COLOR / TTY, so piped output stays plain.
program.parseAsync().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`cnwla ${chalk.red("error")}: ${msg}\n`);
  process.exit(1);
});
