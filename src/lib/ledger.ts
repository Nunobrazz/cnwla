import { randomUUID } from "node:crypto";

export interface LedgerUser {
  id: string;
  primaryParty: string | null;
}

export interface UserRights {
  actAs: string[];
  readAs: string[];
  admin: boolean;
}

export interface PartyDetails {
  party: string;
  isLocal: boolean;
  identityProviderId: string;
}

export interface LedgerUserSummary {
  id: string;
  primaryParty: string | null;
  isDeactivated: boolean;
}

export interface ContractRecord {
  contractId: string;
  templateId: string;
  argument: Record<string, unknown>;
  signatories: string[];
  observers: string[];
  offset: number;
  createdAt: string;
  nodeId: number;
  workflowId: string;
  witnessParties: string[];
  synchronizerId: string;
  reassignmentCounter: number;
  packageName: string;
  representativePackageId: string;
  createdEventBlob: string;
  interfaceViews: unknown[];
  acsDelta: boolean;
}

export interface ActiveContractsFilter {
  party?: string;
  readAs?: string[];
  anyParty?: boolean;
  templateId?: string;
  includeBlob?: boolean;
}

export interface SubmitCreateOpts {
  templateId: string;
  createArguments: Record<string, unknown>;
  userId: string;
  actAs: string[];
  readAs?: string[];
  workflowId?: string;
  commandId?: string;
  submissionId?: string;
}

export interface SubmitExerciseOpts {
  templateId: string;
  contractId: string;
  choice: string;
  choiceArgument: Record<string, unknown>;
  userId: string;
  actAs: string[];
  readAs?: string[];
  workflowId?: string;
  commandId?: string;
  submissionId?: string;
}

export interface ExercisedEvent {
  kind: "Exercised";
  nodeId: number;
  lastDescendantNodeId: number;
  contractId: string;
  templateId: string;
  choice: string;
  choiceArgument: unknown;
  actingParties: string[];
  consuming: boolean;
  exerciseResult: unknown;
  witnessParties: string[];
  packageName: string;
  interfaceId: string | null;
  acsDelta: boolean;
}

export interface CreatedEventFlat {
  kind: "Created";
  nodeId: number;
  contractId: string;
  templateId: string;
  argument: Record<string, unknown>;
  signatories: string[];
  observers: string[];
  createdAt: string;
  offset: number;
  packageName: string;
  witnessParties: string[];
  acsDelta: boolean;
}

export interface ArchivedEventFlat {
  kind: "Archived";
  nodeId: number;
  contractId: string;
  templateId: string;
  witnessParties: string[];
  packageName: string;
}

export type TxEvent = ExercisedEvent | CreatedEventFlat | ArchivedEventFlat;

export interface ExerciseResult {
  updateId: string;
  commandId: string;
  offset: number;
  synchronizerId: string;
  effectiveAt: string;
  events: TxEvent[];
}

type RightEntry =
  | { kind: { CanActAs: { value: { party: string } } } }
  | { kind: { CanReadAs: { value: { party: string } } } }
  | { kind: { ParticipantAdmin: { value: Record<string, never> } } }
  | { kind: Record<string, unknown> };

export class LedgerClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(opts: { url: string; token: string }) {
    this.baseUrl = opts.url.replace(/\/$/, "");
    this.token = opts.token;
  }

  async getUser(userId: string): Promise<LedgerUser> {
    const json = await this.request(`/v2/users/${encodeURIComponent(userId)}`);
    const user = (json as { user?: { id?: unknown; primaryParty?: unknown } }).user;
    if (!user || typeof user.id !== "string") {
      throw new Error(`unexpected /v2/users response: ${JSON.stringify(json)}`);
    }
    const primary = typeof user.primaryParty === "string" && user.primaryParty !== "" ? user.primaryParty : null;
    return { id: user.id, primaryParty: primary };
  }

  async getLedgerEnd(): Promise<number> {
    const json = await this.request("/v2/state/ledger-end");
    const offset = (json as { offset?: unknown }).offset;
    if (typeof offset !== "number") {
      throw new Error(`unexpected /v2/state/ledger-end response: ${JSON.stringify(json)}`);
    }
    return offset;
  }

  // Uses /submit-and-wait-for-transaction (not plain /submit-and-wait) because
  // we need the CreatedEvent back. Body shape is *flat* for this endpoint.
  async submitCreate(opts: SubmitCreateOpts): Promise<ContractRecord> {
    const commandId = opts.commandId ?? randomUuid();
    const submissionId = opts.submissionId ?? commandId;
    const readAs = opts.readAs ?? [];

    const filtersByParty: Record<string, unknown> = {};
    for (const p of opts.actAs) {
      filtersByParty[p] = {
        cumulative: [
          { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
        ],
      };
    }

    const body = {
      commands: {
        commands: [
          {
            CreateCommand: {
              templateId: opts.templateId,
              createArguments: opts.createArguments,
            },
          },
        ],
        commandId,
        userId: opts.userId,
        actAs: opts.actAs,
        readAs,
        workflowId: opts.workflowId ?? "",
        submissionId,
        deduplicationPeriod: { Empty: {} },
        disclosedContracts: [],
        synchronizerId: "",
        packageIdSelectionPreference: [],
      },
      transactionFormat: {
        eventFormat: { filtersByParty, verbose: false },
        transactionShape: "TRANSACTION_SHAPE_ACS_DELTA",
      },
    };

    const json = await this.request("/v2/commands/submit-and-wait-for-transaction", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const tx = (json as { transaction?: { events?: unknown[]; workflowId?: unknown; synchronizerId?: unknown } }).transaction;
    if (!tx || !Array.isArray(tx.events)) {
      throw new Error(`unexpected submit response: ${JSON.stringify(json)}`);
    }
    const createdEvents = tx.events
      .map((ev) => (ev as { CreatedEvent?: Record<string, unknown> }).CreatedEvent)
      .filter((e): e is Record<string, unknown> => Boolean(e));
    if (createdEvents.length === 0) {
      throw new Error(`transaction contained no CreatedEvents: ${JSON.stringify(json)}`);
    }
    return flattenCreated(createdEvents[0]!, {
      workflowId: typeof tx.workflowId === "string" ? tx.workflowId : "",
      synchronizerId: typeof tx.synchronizerId === "string" ? tx.synchronizerId : "",
      reassignmentCounter: 0,
    });
  }

  async resolveTemplateByCid(contractId: string, requestingParties: string[]): Promise<string> {
    const filtersByParty: Record<string, unknown> = {};
    for (const p of requestingParties) {
      filtersByParty[p] = {
        cumulative: [
          { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
        ],
      };
    }
    const body = {
      contractId,
      eventFormat: { filtersByParty, verbose: false },
    };
    const json = await this.request("/v2/events/events-by-contract-id", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const created = (json as { created?: { createdEvent?: { templateId?: unknown } } }).created?.createdEvent;
    if (!created || typeof created.templateId !== "string") {
      throw new Error(
        `could not resolve templateId for contract ${contractId} (not visible to the requesting parties, or already archived)`,
      );
    }
    return created.templateId;
  }

  // /submit-and-wait-for-transaction with LEDGER_EFFECTS shape. ACS_DELTA
  // would hide the ExercisedEvent (and therefore exerciseResult + acting
  // parties). Body shape is *nested* (commands under a commands key) for
  // this endpoint — different from submitCreate above.
  async submitExercise(opts: SubmitExerciseOpts): Promise<ExerciseResult> {
    const commandId = opts.commandId ?? randomUuid();
    const submissionId = opts.submissionId ?? commandId;
    const readAs = opts.readAs ?? [];

    const filtersByParty: Record<string, unknown> = {};
    for (const p of opts.actAs) {
      filtersByParty[p] = {
        cumulative: [
          { identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } },
        ],
      };
    }

    const body = {
      commands: {
        commands: [
          {
            ExerciseCommand: {
              templateId: opts.templateId,
              contractId: opts.contractId,
              choice: opts.choice,
              choiceArgument: opts.choiceArgument,
            },
          },
        ],
        commandId,
        userId: opts.userId,
        actAs: opts.actAs,
        readAs,
        workflowId: opts.workflowId ?? "",
        submissionId,
        deduplicationPeriod: { Empty: {} },
        disclosedContracts: [],
        synchronizerId: "",
        packageIdSelectionPreference: [],
      },
      transactionFormat: {
        eventFormat: { filtersByParty, verbose: false },
        transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
      },
    };

    const json = await this.request("/v2/commands/submit-and-wait-for-transaction", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return parseExerciseResult(json);
  }

  async activeContracts(filter: ActiveContractsFilter): Promise<ContractRecord[]> {
    const offset = await this.getLedgerEnd();
    const body = buildFilterBody(filter, offset);
    const json = await this.request("/v2/state/active-contracts", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!Array.isArray(json)) {
      throw new Error(`unexpected /v2/state/active-contracts response: ${JSON.stringify(json)}`);
    }
    const records: ContractRecord[] = [];
    for (const entry of json) {
      const r = flattenEntry(entry);
      if (r) records.push(r);
    }
    return records;
  }

  async listUsers(): Promise<LedgerUserSummary[]> {
    const results: LedgerUserSummary[] = [];
    let token: string | undefined = undefined;
    do {
      const qs = token ? `?pageToken=${encodeURIComponent(token)}` : "";
      const json = await this.request(`/v2/users${qs}`);
      const entries = (json as { users?: unknown }).users;
      if (!Array.isArray(entries)) {
        throw new Error(`unexpected /v2/users response: ${JSON.stringify(json)}`);
      }
      for (const e of entries as Array<Record<string, unknown>>) {
        if (typeof e["id"] !== "string") continue;
        const primary =
          typeof e["primaryParty"] === "string" && e["primaryParty"] !== "" ? e["primaryParty"] : null;
        results.push({
          id: e["id"],
          primaryParty: primary,
          isDeactivated: e["isDeactivated"] === true,
        });
      }
      const next = (json as { nextPageToken?: unknown }).nextPageToken;
      token = typeof next === "string" && next !== "" ? next : undefined;
    } while (token);
    return results;
  }

  async listParties(): Promise<PartyDetails[]> {
    const results: PartyDetails[] = [];
    let token: string | undefined = undefined;
    do {
      const qs = token ? `?pageToken=${encodeURIComponent(token)}` : "";
      const json = await this.request(`/v2/parties${qs}`);
      const entries = (json as { partyDetails?: unknown }).partyDetails;
      if (!Array.isArray(entries)) {
        throw new Error(`unexpected /v2/parties response: ${JSON.stringify(json)}`);
      }
      for (const e of entries as Array<Record<string, unknown>>) {
        if (typeof e["party"] !== "string") {
          throw new Error(`unexpected partyDetails entry: ${JSON.stringify(e)}`);
        }
        results.push({
          party: e["party"],
          isLocal: e["isLocal"] === true,
          identityProviderId: typeof e["identityProviderId"] === "string" ? e["identityProviderId"] : "",
        });
      }
      const next = (json as { nextPageToken?: unknown }).nextPageToken;
      token = typeof next === "string" && next !== "" ? next : undefined;
    } while (token);
    return results;
  }

  async getUserRights(userId: string): Promise<UserRights> {
    const json = await this.request(`/v2/users/${encodeURIComponent(userId)}/rights`);
    const entries = (json as { rights?: unknown }).rights;
    if (!Array.isArray(entries)) {
      throw new Error(`unexpected /v2/users/{id}/rights response: ${JSON.stringify(json)}`);
    }
    const actAs: string[] = [];
    const readAs: string[] = [];
    let admin = false;
    for (const e of entries as RightEntry[]) {
      const kind = e.kind as Record<string, { value?: { party?: unknown } }>;
      if ("CanActAs" in kind && typeof kind["CanActAs"]?.value?.party === "string") {
        actAs.push(kind["CanActAs"].value.party);
      } else if ("CanReadAs" in kind && typeof kind["CanReadAs"]?.value?.party === "string") {
        readAs.push(kind["CanReadAs"].value.party);
      } else if ("ParticipantAdmin" in kind) {
        admin = true;
      }
    }
    return { actAs, readAs, admin };
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined ?? {}),
    };
    if (this.token !== "") headers["Authorization"] = `Bearer ${this.token}`;
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      throw new Error(formatLedgerError(init.method ?? "GET", path, res.status, await res.text()));
    }
    return res.json();
  }
}

// Preserves every field the server returned (traceId, correlationId, etc.)
// rather than trimming — keeping prod debugging ergonomic. Layout just makes
// the JSON scannable at a glance.
function formatLedgerError(method: string, path: string, status: number, body: string): string {
  let parsed: Record<string, unknown> | null = null;
  try {
    const p = JSON.parse(body) as unknown;
    if (p !== null && typeof p === "object" && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  if (!parsed) {
    return `${method} ${path} → ${status}: ${body}`;
  }

  const lines: string[] = [];
  const code = typeof parsed["code"] === "string" ? (parsed["code"] as string) : undefined;
  lines.push(code ? `${status} ${code}` : `HTTP ${status}`);

  const rest = Object.entries(parsed).filter(([k]) => k !== "code");
  if (rest.length > 0) {
    const keyWidth = Math.max(...rest.map(([k]) => k.length)) + 2;
    for (const [k, v] of rest) {
      const label = `${k}:`.padEnd(keyWidth);
      if (v === null || v === undefined) {
        lines.push(`  ${label}null`);
      } else if (Array.isArray(v)) {
        lines.push(`  ${label}${v.length === 0 ? "[]" : JSON.stringify(v)}`);
      } else if (typeof v === "object") {
        const sub = v as Record<string, unknown>;
        const entries = Object.entries(sub);
        if (entries.length === 0) {
          lines.push(`  ${label}{}`);
        } else {
          lines.push(`  ${label}`);
          const subWidth = Math.max(...entries.map(([sk]) => sk.length)) + 2;
          for (const [sk, sv] of entries) {
            const subLabel = `${sk}:`.padEnd(subWidth);
            lines.push(`    ${subLabel}${primToString(sv)}`);
          }
        }
      } else {
        lines.push(`  ${label}${String(v)}`);
      }
    }
  }
  lines.push(`  endpoint: ${method} ${path}`);
  return lines.join("\n");
}

function primToString(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildFilterBody(filter: ActiveContractsFilter, offset: number): unknown {
  const includeBlob = filter.includeBlob ?? false;
  const identifierFilter = filter.templateId
    ? { TemplateFilter: { value: { templateId: filter.templateId, includeCreatedEventBlob: includeBlob } } }
    : { WildcardFilter: { value: { includeCreatedEventBlob: includeBlob } } };
  const cumulative = [{ identifierFilter }];

  if (filter.anyParty) {
    return {
      filter: { filtersForAnyParty: { cumulative } },
      verbose: false,
      activeAtOffset: offset,
    };
  }

  if (!filter.party) {
    throw new Error("activeContracts: must specify party or anyParty");
  }

  const filtersByParty: Record<string, { cumulative: unknown[] }> = {
    [filter.party]: { cumulative },
  };
  for (const p of filter.readAs ?? []) {
    filtersByParty[p] = { cumulative };
  }

  return {
    filter: { filtersByParty },
    verbose: false,
    activeAtOffset: offset,
  };
}

function flattenEntry(entry: unknown): ContractRecord | null {
  const e = entry as {
    workflowId?: unknown;
    contractEntry?: { JsActiveContract?: {
      createdEvent?: Record<string, unknown>;
      synchronizerId?: unknown;
      reassignmentCounter?: unknown;
    } };
  };
  const active = e?.contractEntry?.JsActiveContract;
  const created = active?.createdEvent;
  if (!created || typeof created["contractId"] !== "string") return null;
  return flattenCreated(created, {
    workflowId: typeof e.workflowId === "string" ? e.workflowId : "",
    synchronizerId: typeof active?.synchronizerId === "string" ? (active.synchronizerId as string) : "",
    reassignmentCounter:
      typeof active?.reassignmentCounter === "number" ? (active.reassignmentCounter as number) : 0,
  });
}

function flattenCreated(
  created: Record<string, unknown>,
  envelope: { workflowId: string; synchronizerId: string; reassignmentCounter: number },
): ContractRecord {
  return {
    contractId: typeof created["contractId"] === "string" ? (created["contractId"] as string) : "",
    templateId: typeof created["templateId"] === "string" ? (created["templateId"] as string) : "",
    argument: (created["createArgument"] as Record<string, unknown>) ?? {},
    signatories: Array.isArray(created["signatories"]) ? (created["signatories"] as string[]) : [],
    observers: Array.isArray(created["observers"]) ? (created["observers"] as string[]) : [],
    offset: typeof created["offset"] === "number" ? (created["offset"] as number) : 0,
    createdAt: typeof created["createdAt"] === "string" ? (created["createdAt"] as string) : "",
    nodeId: typeof created["nodeId"] === "number" ? (created["nodeId"] as number) : 0,
    workflowId: envelope.workflowId,
    witnessParties: Array.isArray(created["witnessParties"]) ? (created["witnessParties"] as string[]) : [],
    synchronizerId: envelope.synchronizerId,
    reassignmentCounter: envelope.reassignmentCounter,
    packageName: typeof created["packageName"] === "string" ? (created["packageName"] as string) : "",
    representativePackageId:
      typeof created["representativePackageId"] === "string"
        ? (created["representativePackageId"] as string)
        : "",
    createdEventBlob:
      typeof created["createdEventBlob"] === "string" ? (created["createdEventBlob"] as string) : "",
    interfaceViews: Array.isArray(created["interfaceViews"]) ? (created["interfaceViews"] as unknown[]) : [],
    acsDelta: created["acsDelta"] === true,
  };
}

function randomUuid(): string {
  return randomUUID();
}

function parseExerciseResult(json: unknown): ExerciseResult {
  const tx = (json as { transaction?: Record<string, unknown> }).transaction;
  if (!tx) throw new Error(`unexpected submit response: ${JSON.stringify(json)}`);
  const rawEvents = tx["events"];
  if (!Array.isArray(rawEvents)) {
    throw new Error(`transaction.events missing or not an array: ${JSON.stringify(json)}`);
  }
  const events: TxEvent[] = [];
  for (const raw of rawEvents) {
    const ev = parseTxEvent(raw);
    if (ev) events.push(ev);
  }
  return {
    updateId: typeof tx["updateId"] === "string" ? (tx["updateId"] as string) : "",
    commandId: typeof tx["commandId"] === "string" ? (tx["commandId"] as string) : "",
    offset: typeof tx["offset"] === "number" ? (tx["offset"] as number) : 0,
    synchronizerId: typeof tx["synchronizerId"] === "string" ? (tx["synchronizerId"] as string) : "",
    effectiveAt: typeof tx["effectiveAt"] === "string" ? (tx["effectiveAt"] as string) : "",
    events,
  };
}

function parseTxEvent(raw: unknown): TxEvent | null {
  const r = raw as {
    ExercisedEvent?: Record<string, unknown>;
    CreatedEvent?: Record<string, unknown>;
    ArchivedEvent?: Record<string, unknown>;
  };
  if (r.ExercisedEvent) {
    const e = r.ExercisedEvent;
    return {
      kind: "Exercised",
      nodeId: typeof e["nodeId"] === "number" ? (e["nodeId"] as number) : 0,
      lastDescendantNodeId:
        typeof e["lastDescendantNodeId"] === "number"
          ? (e["lastDescendantNodeId"] as number)
          : 0,
      contractId: typeof e["contractId"] === "string" ? (e["contractId"] as string) : "",
      templateId: typeof e["templateId"] === "string" ? (e["templateId"] as string) : "",
      choice: typeof e["choice"] === "string" ? (e["choice"] as string) : "",
      choiceArgument: e["choiceArgument"] ?? null,
      actingParties: Array.isArray(e["actingParties"]) ? (e["actingParties"] as string[]) : [],
      consuming: e["consuming"] === true,
      exerciseResult: e["exerciseResult"] ?? null,
      witnessParties: Array.isArray(e["witnessParties"]) ? (e["witnessParties"] as string[]) : [],
      packageName: typeof e["packageName"] === "string" ? (e["packageName"] as string) : "",
      interfaceId:
        typeof e["interfaceId"] === "string" ? (e["interfaceId"] as string) : null,
      acsDelta: e["acsDelta"] === true,
    };
  }
  if (r.CreatedEvent) {
    const e = r.CreatedEvent;
    return {
      kind: "Created",
      nodeId: typeof e["nodeId"] === "number" ? (e["nodeId"] as number) : 0,
      contractId: typeof e["contractId"] === "string" ? (e["contractId"] as string) : "",
      templateId: typeof e["templateId"] === "string" ? (e["templateId"] as string) : "",
      argument: (e["createArgument"] as Record<string, unknown>) ?? {},
      signatories: Array.isArray(e["signatories"]) ? (e["signatories"] as string[]) : [],
      observers: Array.isArray(e["observers"]) ? (e["observers"] as string[]) : [],
      createdAt: typeof e["createdAt"] === "string" ? (e["createdAt"] as string) : "",
      offset: typeof e["offset"] === "number" ? (e["offset"] as number) : 0,
      packageName: typeof e["packageName"] === "string" ? (e["packageName"] as string) : "",
      witnessParties: Array.isArray(e["witnessParties"]) ? (e["witnessParties"] as string[]) : [],
      acsDelta: e["acsDelta"] === true,
    };
  }
  if (r.ArchivedEvent) {
    const e = r.ArchivedEvent;
    return {
      kind: "Archived",
      nodeId: typeof e["nodeId"] === "number" ? (e["nodeId"] as number) : 0,
      contractId: typeof e["contractId"] === "string" ? (e["contractId"] as string) : "",
      templateId: typeof e["templateId"] === "string" ? (e["templateId"] as string) : "",
      witnessParties: Array.isArray(e["witnessParties"]) ? (e["witnessParties"] as string[]) : [],
      packageName: typeof e["packageName"] === "string" ? (e["packageName"] as string) : "",
    };
  }
  return null;
}
