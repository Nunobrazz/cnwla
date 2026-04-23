import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { z } from "zod";

const OAuth2Auth = z.object({
  mode: z.literal("oauth2"),
  tokenUrl: z.string(),
  clientId: z.string(),
  username: z.string(),
  password: z.string(),
});

const SharedSecretAuth = z.object({
  mode: z.literal("shared-secret"),
  token: z.string().optional(),
});

const Auth = z.discriminatedUnion("mode", [OAuth2Auth, SharedSecretAuth]);

const ProfileSchema = z.object({
  participant: z.string(),
  auth: Auth,
  userId: z.string(),
});

const ConfigSchema = z.object({
  currentProfile: z.string().optional(),
  profiles: z.record(z.string(), ProfileSchema),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema>;

const ENV_RE = /\$\{env:([A-Z_][A-Z0-9_]*)\}/g;

function interpolateEnv(raw: string): string {
  return raw.replace(ENV_RE, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`env var ${name} referenced in config but not set`);
    }
    return v;
  });
}

export function resolveConfigPath(configPath?: string): string {
  return configPath ?? defaultConfigPath();
}

// Precedence: flag (handled at the call site) > env var > walk-up from cwd >
// ~/.cnwla/config.yaml. Walk-up lets a repo carry its own project config
// (like .git) without polluting the user's global one.
export function defaultConfigPath(): string {
  const envOverride = process.env["CNWLA_CONFIG"];
  if (envOverride) return envOverride;
  const local = findLocalConfig(process.cwd());
  if (local) return local;
  return path.join(os.homedir(), ".cnwla", "config.yaml");
}

export function findLocalConfig(startDir: string): string | null {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, "cnwla.config.yaml");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfig(configPath?: string): Config {
  const filePath = configPath ?? defaultConfigPath();
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    return ConfigSchema.parse(YAML.parse(raw));
  }
  const envProfile = profileFromEnv();
  if (envProfile) {
    return { currentProfile: "env", profiles: { env: envProfile } };
  }
  throw new Error(
    `no config at ${filePath} and CNWLA_PARTICIPANT_URL is not set. ` +
      `Create ~/.cnwla/config.yaml (see cnwla.config.example.yaml) or set CNWLA_* env vars.`,
  );
}

function profileFromEnv(): Profile | null {
  const url = process.env["CNWLA_PARTICIPANT_URL"];
  const mode = process.env["CNWLA_AUTH_MODE"];
  const userId = process.env["CNWLA_USER_ID"];
  if (!url || !mode || !userId) return null;

  if (mode === "oauth2") {
    const tokenUrl = process.env["CNWLA_AUTH_TOKEN_URL"];
    const clientId = process.env["CNWLA_AUTH_CLIENT_ID"];
    const username = process.env["CNWLA_AUTH_USERNAME"];
    const password = process.env["CNWLA_AUTH_PASSWORD"];
    if (!tokenUrl || !clientId || !username || !password) {
      throw new Error("oauth2 mode requires CNWLA_AUTH_{TOKEN_URL,CLIENT_ID,USERNAME,PASSWORD}");
    }
    return {
      participant: url,
      userId,
      auth: { mode: "oauth2", tokenUrl, clientId, username, password },
    };
  }

  if (mode === "shared-secret") {
    const token = process.env["CNWLA_AUTH_TOKEN"];
    if (!token) throw new Error("shared-secret mode requires CNWLA_AUTH_TOKEN");
    return { participant: url, userId, auth: { mode: "shared-secret", token } };
  }

  throw new Error(`unknown CNWLA_AUTH_MODE: ${mode} (expected: oauth2 | shared-secret)`);
}

export function resolveProfile(
  config: Config,
  selector?: string,
): { name: string; profile: Profile } {
  const name = selector ?? process.env["CNWLA_PROFILE"] ?? config.currentProfile;
  const available = Object.keys(config.profiles);
  if (!name) {
    throw new Error(
      `no profile selected. Pass --profile, set CNWLA_PROFILE, or set currentProfile. Available: ${available.join(", ")}`,
    );
  }
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`unknown profile: ${name}. Available: ${available.join(", ")}`);
  }
  return { name, profile: interpolateProfile(profile) };
}

// Lazy: only the selected profile gets ${env:...} expanded. Other profiles in
// the file may reference env vars that aren't set (e.g. a prod profile loaded
// while working on dev) without blocking config load.
function interpolateProfile(p: Profile): Profile {
  const auth: Profile["auth"] =
    p.auth.mode === "oauth2"
      ? {
          mode: "oauth2",
          tokenUrl: interpolateEnv(p.auth.tokenUrl),
          clientId: interpolateEnv(p.auth.clientId),
          username: interpolateEnv(p.auth.username),
          password: interpolateEnv(p.auth.password),
        }
      : p.auth.token !== undefined
        ? { mode: "shared-secret", token: interpolateEnv(p.auth.token) }
        : { mode: "shared-secret" };
  return {
    participant: interpolateEnv(p.participant),
    userId: interpolateEnv(p.userId),
    auth,
  };
}
