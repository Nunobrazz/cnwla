import type { Config } from "../config.js";
import { resolveProfile } from "../config.js";
import { getToken } from "./auth.js";
import { LedgerClient } from "./ledger.js";

// Per-invocation cache so the same `@bob` appearing N times costs one
// /v2/users/{id} roundtrip.
export class PartyResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly config: Config) {}

  async resolveRef(value: string): Promise<string> {
    if (!value.startsWith("@")) return value;
    // `@@foo` → literal `@foo` (escape for data that really starts with `@`).
    if (value.startsWith("@@")) return value.slice(1);
    const name = value.slice(1);
    if (name === "") {
      throw new Error(`empty profile reference: '@' must be followed by a profile name`);
    }
    const cached = this.cache.get(name);
    if (cached !== undefined) return cached;

    if (!this.config.profiles[name]) {
      const available = Object.keys(this.config.profiles).join(", ");
      throw new Error(`unknown profile: '@${name}'. Available: ${available}`);
    }
    const { profile } = resolveProfile(this.config, name);
    const token = await getToken(profile);
    const client = new LedgerClient({ url: profile.participant, token });
    const user = await client.getUser(profile.userId);
    if (!user.primaryParty) {
      throw new Error(
        `profile '${name}' maps to user '${profile.userId}' which has no primaryParty; cannot resolve '@${name}'`,
      );
    }
    this.cache.set(name, user.primaryParty);
    return user.primaryParty;
  }

  async resolveDeep(value: unknown): Promise<unknown> {
    if (typeof value === "string") return this.resolveRef(value);
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const v of value) out.push(await this.resolveDeep(v));
      return out;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await this.resolveDeep(v);
      }
      return out;
    }
    return value;
  }

  async resolvePartyList(csv: string): Promise<string[]> {
    const parts = csv.split(",").map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    for (const p of parts) out.push(await this.resolveRef(p));
    return out;
  }
}
