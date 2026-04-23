import type { Command } from "commander";
import { loadConfig, resolveProfile } from "../config.js";
import { getToken } from "../lib/auth.js";
import { LedgerClient, type PartyDetails } from "../lib/ledger.js";

const FORMATS = new Set(["text", "json", "party"]);

export function registerPartiesCommands(program: Command): void {
  const parties = program.command("parties").description("Party management");

  parties
    .command("ls")
    .description("List parties allocated on the current profile's participant")
    .option("--format <fmt>", "text | json | party", "text")
    .action(async (opts: { format: string }) => {
      if (!FORMATS.has(opts.format)) {
        throw new Error(`unknown --format: ${opts.format} (expected: ${[...FORMATS].join(" | ")})`);
      }
      const globalOpts = program.opts<{ profile?: string; config?: string }>();
      const config = loadConfig(globalOpts.config);
      const { profile } = resolveProfile(config, globalOpts.profile);
      const token = await getToken(profile);
      const client = new LedgerClient({ url: profile.participant, token });
      const parties = await client.listParties();
      emit(opts.format, parties);
    });
}

function emit(fmt: string, parties: PartyDetails[]): void {
  switch (fmt) {
    case "json":
      console.log(JSON.stringify(parties));
      return;
    case "party":
      for (const p of parties) console.log(p.party);
      return;
    case "text":
      if (parties.length === 0) {
        console.log("(no parties)");
        return;
      }
      const width = Math.max(...parties.map((p) => p.party.length));
      for (const p of parties) {
        console.log(`${p.party.padEnd(width)}  ${p.isLocal ? "local" : "remote"}`);
      }
      return;
  }
}
