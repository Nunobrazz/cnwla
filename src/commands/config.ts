import type { Command } from "commander";
import * as fs from "node:fs";
import * as YAML from "yaml";
import { loadConfig, resolveConfigPath } from "../config.js";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Inspect and modify the active config");

  config
    .command("show")
    .description("Print the active config file path and selected profile")
    .action(() => {
      const globalOpts = program.opts<{ profile?: string; config?: string }>();
      const filePath = resolveConfigPath(globalOpts.config);
      const cfg = loadConfig(globalOpts.config);
      const selected = globalOpts.profile ?? process.env["CNWLA_PROFILE"] ?? cfg.currentProfile;
      console.log(`config:          ${filePath}`);
      console.log(`currentProfile:  ${cfg.currentProfile ?? "(unset)"}`);
      console.log(`selected now:    ${selected ?? "(none)"}`);
      console.log(`profiles:        ${Object.keys(cfg.profiles).join(", ")}`);
    });

  config
    .command("list")
    .description("List profiles; '*' marks currentProfile")
    .action(() => {
      const globalOpts = program.opts<{ config?: string }>();
      const cfg = loadConfig(globalOpts.config);
      const current = cfg.currentProfile;
      for (const name of Object.keys(cfg.profiles)) {
        console.log(`${name === current ? "*" : " "} ${name}`);
      }
    });

  config
    .command("use <profile>")
    .description("Set currentProfile in the active config file")
    .action((name: string) => {
      const globalOpts = program.opts<{ config?: string }>();
      const filePath = resolveConfigPath(globalOpts.config);
      const cfg = loadConfig(globalOpts.config);
      if (!cfg.profiles[name]) {
        const avail = Object.keys(cfg.profiles).join(", ");
        throw new Error(`unknown profile: ${name}. Available: ${avail}`);
      }
      if (!fs.existsSync(filePath)) {
        throw new Error(
          `cannot edit: no config file at ${filePath} (currently using CNWLA_* env fallback)`,
        );
      }
      const raw = fs.readFileSync(filePath, "utf8");
      const doc = YAML.parseDocument(raw);
      doc.set("currentProfile", name);
      fs.writeFileSync(filePath, doc.toString());
      console.log(`currentProfile → ${name}  (${filePath})`);
    });
}
