import type { Command } from "commander";
import { loadConfig, resolveProfile } from "../config.js";
import { getToken } from "../lib/auth.js";
import { LedgerClient, type UserRights } from "../lib/ledger.js";

interface WhoamiOutput {
  profile: string;
  participant: string;

  userId: string;
  primaryParty: string | null;
  rights: UserRights;
}

const FORMATS = new Set(["text", "json", "party", "act-as", "read-as"]);

export function registerWhoamiCommand(program: Command): void {
  program
    .command("whoami")
    .description("Print the current profile's identity and rights")
    .option("--format <fmt>", "text | json | party | act-as | read-as", "text")
    .action(async (opts: { format: string }) => {
      if (!FORMATS.has(opts.format)) {
        throw new Error(`unknown --format: ${opts.format} (expected: ${[...FORMATS].join(" | ")})`);
      }
      const globalOpts = program.opts<{ profile?: string; config?: string }>();
      const config = loadConfig(globalOpts.config);
      const { name, profile } = resolveProfile(config, globalOpts.profile);
      const token = await getToken(profile);
      const client = new LedgerClient({ url: profile.participant, token });
      const [user, rights] = await Promise.all([
        client.getUser(profile.userId),
        client.getUserRights(profile.userId),
      ]);
      emit(opts.format, {
        profile: name,
        participant: profile.participant,
        userId: user.id,
        primaryParty: user.primaryParty,
        rights,
      });
    });
}

function emit(fmt: string, data: WhoamiOutput): void {
  switch (fmt) {
    case "json":
      console.log(JSON.stringify(data));
      return;
    case "party":
      if (!data.primaryParty) throw new Error(`user ${data.userId} has no primary party`);
      console.log(data.primaryParty);
      return;
    case "act-as":
      for (const p of data.rights.actAs) console.log(p);
      return;
    case "read-as":
      for (const p of data.rights.readAs) console.log(p);
      return;
    case "text":
      console.log(`profile:      ${data.profile}`);
      console.log(`participant:  ${data.participant}`);
      console.log(`userId:       ${data.userId}`);
      console.log(`primaryParty: ${data.primaryParty ?? "(none)"}`);
      console.log(`rights:`);
      console.log(`  CanActAs:   ${formatList(data.rights.actAs)}`);
      console.log(`  CanReadAs:  ${formatList(data.rights.readAs)}`);
      console.log(`  admin:      ${data.rights.admin}`);
      return;
  }
}

function formatList(parties: string[]): string {
  return parties.length === 0 ? "(none)" : parties.join(", ");
}


