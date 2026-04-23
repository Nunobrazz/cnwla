import type { LedgerClient } from "./ledger.js";
import { computeRef, loadRefCache, rememberContracts } from "./ref-cache.js";

// Full contract ids are hex, typically 68+ chars. A "ref" the user types
// is either `Template:shortCID`, a bare cid-suffix, or the full cid itself.
// We look them up against the seen-it-before cache first (fast, no network)
// and fall back to a live ACS query so unseen contracts still resolve.

export async function resolveCidRef(
  client: LedgerClient,
  party: string,
  profile: string,
  input: string,
): Promise<string> {
  // Only strings shaped like a ref (`Template:suffix`) get resolved. Anything
  // else is treated as the literal contract id the user meant — submit will
  // error if it's wrong. This avoids heuristics misfiring on full cids.
  if (!input.includes(":")) return input;

  const cache = loadRefCache(profile);
  const hits = matchInCache(cache.contracts, input);
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw ambiguous(input, hits);

  // Cache miss — fall back to a live ACS scan so unseen contracts still work.
  const records = await client.activeContracts({ party });
  rememberContracts(
    profile,
    records.map((r) => ({ contractId: r.contractId, templateId: r.templateId })),
  );
  const live = records.filter((r) => matchesRef(r.templateId, r.contractId, input));
  if (live.length === 1) return live[0]!.contractId;
  if (live.length > 1) {
    throw ambiguous(
      input,
      live.map((r) => r.contractId),
    );
  }
  throw new Error(
    `no active contract matching '${input}'. Run 'cnwla query' to list visible contracts.`,
  );
}

function matchInCache(
  contracts: Record<string, { templateId: string; ref: string }>,
  input: string,
): string[] {
  const hits: string[] = [];
  for (const [cid, meta] of Object.entries(contracts)) {
    if (matchesRef(meta.templateId, cid, input)) hits.push(cid);
  }
  return hits;
}

// Accepted forms (split on the LAST colon):
//   Coin:d4bc7e                   → template = "Coin"         (simple suffix of templateId)
//   Delegation:Coin:d4bc7e        → template = "Delegation:Coin" (`:Module:Template` suffix)
//   #example:Delegation:Coin:d4bc7e  → template = full id       (exact match)
//   :d4bc7e  or  d4bc7e           → no template filter; cid-suffix match only
function matchesRef(templateId: string, contractId: string, input: string): boolean {
  const lastColon = input.lastIndexOf(":");
  const cid = contractId.toLowerCase();
  if (lastColon <= 0) {
    const suffix = (input.startsWith(":") ? input.slice(1) : input).toLowerCase();
    return cid.endsWith(suffix);
  }
  const wantTemplate = input.slice(0, lastColon).toLowerCase();
  const wantSuffix = input.slice(lastColon + 1).toLowerCase();
  if (!cid.endsWith(wantSuffix)) return false;
  const tid = templateId.toLowerCase();
  if (tid === wantTemplate) return true;
  return tid.endsWith(":" + wantTemplate);
}

function ambiguous(input: string, cids: string[]): Error {
  const lines = cids.map((c) => `  - ${c}`).join("\n");
  return new Error(
    `'${input}' is ambiguous — ${cids.length} contracts match:\n${lines}\nType more of the cid to disambiguate.`,
  );
}

// Re-exported for callers that want the display form without pulling the
// whole module graph.
export { computeRef };
