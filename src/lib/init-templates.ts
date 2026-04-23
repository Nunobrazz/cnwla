import jwt from "jsonwebtoken";
import * as YAML from "yaml";

// Templates each return a YAML Document ready to be written to disk.
// Using Document (CST) instead of plain JS preserves comments we inject so
// users see explanatory hints in the generated file.

export type TemplateName = "cn-quickstart" | "shared-secret" | "oauth2" | "no-auth";

export const TEMPLATES: readonly TemplateName[] = [
  "cn-quickstart",
  "shared-secret",
  "oauth2",
  "no-auth",
] as const;

export function isTemplateName(s: string): s is TemplateName {
  return (TEMPLATES as readonly string[]).includes(s);
}

export interface TemplateOpts {
  // Prompts are `async () => string` injected by the caller so templates
  // are unit-testable without a live TTY.
  prompt?: (message: string, defaultValue: string) => Promise<string>;
  // Used by shared-secret: "mint the JWT and embed it?" yes|no.
  confirm?: (message: string, defaultYes: boolean) => Promise<boolean>;
}

export interface TemplateResult {
  doc: YAML.Document;
  // A short message to print after writing (e.g. env vars to set, next steps).
  postWriteNote?: string;
  // True when the template knows its profiles can't be validated yet (e.g.
  // oauth2 skeleton with placeholders). Init skips post-write whoami.
  skipValidation?: boolean;
}

export async function buildTemplate(
  name: TemplateName,
  opts: TemplateOpts = {},
): Promise<TemplateResult> {
  switch (name) {
    case "no-auth":
      return buildNoAuth();
    case "oauth2":
      return buildOauth2Skeleton();
    case "shared-secret":
      return buildSharedSecret(opts);
    case "cn-quickstart":
      return buildCnQuickstart();
  }
}

// Stubs — real bodies land in B2–B5.

// Minimal setup for sandboxes that run with no ledger auth (e.g. `dpm
// sandbox`, `daml sandbox`). Generates a single profile; user can rename /
// duplicate as they go.
function buildNoAuth(): TemplateResult {
  const raw = `# cnwla config — NO-AUTH template
#
# WARNING: this config only works against participants launched with
# empty auth-services (e.g. dpm sandbox, daml sandbox). It will NOT work
# against cn-quickstart's LocalNet or any deployment that mounts a JWT
# verifier. If you get 401/403 errors, switch templates:
#   cnwla init --template cn-quickstart     (shared-secret LocalNet)
#   cnwla init --template oauth2            (OIDC / Keycloak / Auth0)

currentProfile: default

profiles:
  default:
    participant: http://127.0.0.1:6864
    auth: { mode: shared-secret }   # no token → empty Authorization header
    userId: participant_admin
`;
  const doc = YAML.parseDocument(raw);
  return {
    doc,
    postWriteNote:
      `no-auth template — assumes participant runs with empty auth-services.\n` +
      `if /v2/users returns 401, switch templates.`,
  };
}

// Commented skeleton for real OAuth2/OIDC deployments. No prompts, no
// network calls. User fills in the <placeholder> values then runs
// `cnwla whoami` to verify. Here we could fetch get v2/users and poupate with the correct users ?
function buildOauth2Skeleton(): TemplateResult {
  const raw = `# cnwla config — OAuth2 template
#
# Fill in every <placeholder> below. Each profile represents one human                                                                                                                                                                                                    
# user authenticated via the OAuth2 Resource Owner Password Credentials                                                                                                                                                                                                                     
# (ROPC) grant. For service-account / backend auth (client_credentials
# grant), see 'cnwla init --template client-credentials' (coming soon).                                                                                                                                                                                                                     
#                                                                                                                                                                                                                                                                                           
# IDENTITY LAYERS (two different systems, often the same name):                                                                                                                                                                                                                             
#   username      The user's login name at the OIDC provider (Keycloak/Auth0/...).                                                                                                                                                                                                          
#                 This is what you'd type on an IdP login form.                                                                                                                                                                                                                             
#   userId        The ledger user id on the Canton participant. cnwla calls                                                                                                                                                                                                                 
#                 /v2/users/<userId> to resolve the primary party and rights.                                                                                                                                                                                                               
#                 Usually matches 'username', but not required to.                                                                                                                                                                                                                          
#                                                                                                                                                                                                                                                                                           
# WHERE TO FIND EACH VALUE:                                                                                                                                                                                                                                                                 
#   participant   The URL of the Canton JSON API v2 endpoint for this user.                                                                                                                                                                                                                 
#                   e.g. http://localhost:2975 (LocalNet app-user)                                                                                                                                                                                                                          
#   tokenUrl      Your OIDC provider's token endpoint. For Keycloak:                                                                                                                                                                                                                        
#                   <scheme>://<host>/realms/<realm>/protocol/openid-connect/token                                                                                                                                                                                                          
#                 Use https:// in production; http:// only for local dev.                                                                                                                                                                                                                   
#   clientId      The OIDC client id registered for cnwla (or a pre-existing                                                                                                                                                                                                                
#                 client set up by your admin — e.g. 'app-user-unsafe').                                                                                                                                                                                                                    
#   password      Reference an env var so the secret never lands in the yaml.                                                                                                                                                                                                               
#                 DO NOT inline plaintext passwords in this file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                
#
# After filling in: run \`cnwla whoami\` to verify.

currentProfile: <profile-name>

profiles:
  <profile-name>:
    participant: <participant-url>
    auth:
      mode: oauth2
      tokenUrl: <token-url>
      clientId: <client-id>
      username: <username>
      password: \${env:<PROFILE_NAME>_PASSWORD}
    userId: <user-id>

  # Duplicate the block above for each additional user. Example:
  # bob:
  #   participant: <participant-url>
  #   auth:
  #     mode: oauth2
  #     tokenUrl: <token-url>
  #     clientId: <client-id>
  #     username: bob
  #     password: \${env:BOB_PASSWORD}
  #   userId: bob
`;
  const doc = YAML.parseDocument(raw);
  return {
    doc,
    skipValidation: true,
    postWriteNote:
      `⚠ oauth2 skeleton — fill in <placeholder> values, then:\n` +
      `  export <PROFILE_NAME>_PASSWORD=…\n` +
      `  cnwla whoami\n` +
      `run cnwla whoami to verify once populated.`,
  };
}

// Self-signed HS256 JWT setup for dev/LocalNet participants. Four prompts
// (all default to sensible values); optionally mints the JWT and embeds it
// so the user can run `cnwla whoami` right away.
async function buildSharedSecret(opts: TemplateOpts): Promise<TemplateResult> {
  const participant = opts.prompt
    ? await opts.prompt("Participant URL", "http://localhost:2975")
    : "http://localhost:2975";
  const secret = opts.prompt ? await opts.prompt("HMAC secret", "unsafe") : "unsafe";
  const userId = opts.prompt
    ? await opts.prompt("Ledger user id", "app-user-backend")
    : "app-user-backend";
  const audience = opts.prompt
    ? await opts.prompt("Audience", "https://canton.network.global")
    : "https://canton.network.global";
  const shouldMint = opts.confirm
    ? await opts.confirm("Mint JWT and embed it in the yaml?", true)
    : true;

  const token = shouldMint ? mintHs256(userId, audience, secret) : null;

  const authBlock = token
    ? `    auth:
      mode: shared-secret
      token: ${token}
`
    : `    auth:
      mode: shared-secret
      # No token yet. To mint one later:
      #   node -e "console.log(require('jsonwebtoken').sign({sub:'${userId}',aud:['${audience}']},'${secret}',{algorithm:'HS256',expiresIn:'30d'}))"
      # then paste it below as: token: <minted-jwt>
`;

  const raw = `# cnwla config — SHARED-SECRET template (HS256 JWT)
#
# Self-signed JWT for dev / LocalNet participants that trust an HMAC shared
# secret. NOT for production. Rotate the token by re-running init or editing
# the \`token:\` line in place.

currentProfile: default

profiles:
  default:
    participant: ${participant}
${authBlock}    userId: ${userId}
`;

  const doc = YAML.parseDocument(raw);
  return {
    doc,
    postWriteNote: shouldMint
      ? `shared-secret template with a freshly minted JWT — ready to use.`
      : `shared-secret template without a minted token. Fill in the \`token:\` line before running commands.`,
  };
}

// HS256 JWT minting via jsonwebtoken. Caller validates inputs upstream.
function mintHs256(sub: string, audience: string, secret: string): string {
  return jwt.sign({ sub, aud: [audience] }, secret, {
    algorithm: "HS256",
    expiresIn: "30d",
  });
}

// cn-quickstart preset: three profiles (app-user, app-provider, sv) on the
// quickstart's default ports, each with a freshly minted HS256 JWT signed
// with the well-known "unsafe" secret. Zero flags — known-good defaults
// baked in. If you need OAuth2 against the quickstart, use --template oauth2
// and fill in the skeleton.
function buildCnQuickstart(): TemplateResult {
  const secret = "unsafe";
  const audience = "https://canton.network.global";
  const roles: Array<{ profile: string; port: number; userId: string }> = [
    { profile: "app-user", port: 2975, userId: "app-user-backend" },
    { profile: "app-provider", port: 3975, userId: "app-provider-backend" },
    { profile: "sv", port: 4975, userId: "sv-backend" },
  ];

  const profileBlocks = roles
    .map((r) => {
      const token = mintHs256(r.userId, audience, secret);
      return `  ${r.profile}:
    participant: http://localhost:${r.port}
    auth:
      mode: shared-secret
      token: ${token}
    userId: ${r.userId}`;
    })
    .join("\n");

  const raw = `# cnwla config — CN-QUICKSTART template
#
# Three profiles wired up against cn-quickstart's default LocalNet:
#   app-user      → http://localhost:2975  (user: app-user-backend)
#   app-provider  → http://localhost:3975  (user: app-provider-backend)
#   sv            → http://localhost:4975  (user: sv-backend)
#
# All three use shared-secret auth with the well-known "unsafe" secret
# and a freshly-minted HS256 JWT embedded below. This matches the default
# quickstart LocalNet configuration. Rotate by re-running:
#   cnwla init --template cn-quickstart --force
#
# For OAuth2 against the quickstart, use --template oauth2 and fill in the
# skeleton with your Keycloak realm details.

currentProfile: app-user

profiles:
${profileBlocks}
`;

  const doc = YAML.parseDocument(raw);
  return {
    doc,
    postWriteNote:
      `cn-quickstart template ready. Profiles: app-user / app-provider / sv.\n` +
      `Test with: cnwla whoami`,
  };
}
