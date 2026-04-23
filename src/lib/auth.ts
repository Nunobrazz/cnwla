import type { Profile } from "../config.js";

export async function getToken(profile: Profile): Promise<string> {
  if (profile.auth.mode === "shared-secret") {
    return profile.auth.token ?? "";
  }

  const { tokenUrl, clientId, username, password } = profile.auth;
  const body = new URLSearchParams({
    client_id: clientId,
    username,
    password,
    grant_type: "password",
    scope: "openid",
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`token endpoint ${tokenUrl} → ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { access_token?: unknown };
  if (typeof json.access_token !== "string") {
    throw new Error(`token endpoint returned no access_token: ${JSON.stringify(json)}`);
  }
  return json.access_token;
}
