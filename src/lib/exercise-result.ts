import type { CreatedEventFlat, ExercisedEvent, ExerciseResult, TxEvent } from "./ledger.js";

interface FlatBuckets {
  exercised: ExercisedEvent[];
  archived: { contractId: string; templateId: string }[];
  created: CreatedEventFlat[];
}

// With LEDGER_EFFECTS, consuming choices produce an ExercisedEvent 
// we derive the archived list from `consuming: true`.
export function bucketize(result: ExerciseResult): FlatBuckets {
  const exercised: ExercisedEvent[] = [];
  const archived: { contractId: string; templateId: string }[] = [];
  const created: CreatedEventFlat[] = [];
  for (const e of result.events) {
    if (e.kind === "Exercised") {
      exercised.push(e);
      if (e.consuming) {
        archived.push({ contractId: e.contractId, templateId: e.templateId });
      }
    } else if (e.kind === "Created") {
      created.push(e);
    } else if (e.kind === "Archived") {
      archived.push({ contractId: e.contractId, templateId: e.templateId });
    }
  }
  return { exercised, archived, created };
}

export function renderFlatText(result: ExerciseResult, full: boolean): void {
  const { exercised, archived, created } = bucketize(result);
  console.log(`updateId:       ${result.updateId}`);
  console.log(`offset:         ${result.offset}`);
  if (full) {
    console.log(`commandId:      ${result.commandId}`);
    console.log(`synchronizerId: ${result.synchronizerId}`);
    console.log(`effectiveAt:    ${result.effectiveAt}`);
  }
  console.log("");

  if (exercised.length === 0) {
    console.log("exercised: (none)");
  } else {
    console.log(`exercised:${exercised.length > 1 ? ` (${exercised.length})` : ""}`);
    for (const e of exercised) {
      printExercised(e, "  ", full);
    }
  }
  console.log("");

  if (archived.length === 0) {
    console.log("archived: (none)");
  } else {
    console.log(`archived:${archived.length > 1 ? ` (${archived.length})` : ""}`);
    for (const a of archived) {
      console.log(`  ${a.contractId}   ${shortenTemplateId(a.templateId)}`);
    }
  }
  console.log("");

  if (created.length === 0) {
    console.log("created: (none)");
  } else {
    console.log(`created:${created.length > 1 ? ` (${created.length})` : ""}`);
    for (let i = 0; i < created.length; i++) {
      if (i > 0) console.log("");
      printCreated(created[i]!, "  ", full);
    }
  }
}

function printExercised(e: ExercisedEvent, indent: string, full: boolean): void {
  console.log(`${indent}choice:        ${e.choice}`);
  console.log(`${indent}templateId:    ${shortenTemplateId(e.templateId)}`);
  console.log(`${indent}target:        ${e.contractId}`);
  console.log(`${indent}actingParties: ${e.actingParties.join(", ")}`);
  console.log(`${indent}consuming:     ${e.consuming}`);
  console.log(`${indent}result:        ${formatExerciseResult(e.exerciseResult)}`);
  if (full) {
    console.log(`${indent}nodeId:                ${e.nodeId}`);
    console.log(`${indent}lastDescendantNodeId:  ${e.lastDescendantNodeId}`);
    console.log(`${indent}witnessParties:        ${e.witnessParties.join(", ")}`);
    console.log(`${indent}packageName:           ${e.packageName}`);
    console.log(`${indent}interfaceId:           ${e.interfaceId ?? "null"}`);
    console.log(`${indent}acsDelta:              ${e.acsDelta}`);
    console.log(`${indent}choiceArgument:        ${JSON.stringify(e.choiceArgument)}`);
  }
}

function printCreated(c: CreatedEventFlat, indent: string, full: boolean): void {
  console.log(`${indent}contractId:    ${c.contractId}`);
  console.log(`${indent}templateId:    ${shortenTemplateId(c.templateId)}`);
  console.log(`${indent}signatories:   ${c.signatories.join(", ")}`);
  console.log(`${indent}observers:     ${c.observers.join(", ")}`);
  if (full) {
    console.log(`${indent}nodeId:         ${c.nodeId}`);
    console.log(`${indent}offset:         ${c.offset}`);
    console.log(`${indent}createdAt:      ${c.createdAt}`);
    console.log(`${indent}packageName:    ${c.packageName}`);
    console.log(`${indent}witnessParties: ${c.witnessParties.join(", ")}`);
    console.log(`${indent}acsDelta:       ${c.acsDelta}`);
  }
  console.log(`${indent}argument:`);
  printJsonYamlish(c.argument, `${indent}  `);
}

function formatExerciseResult(v: unknown): string {
  if (v === null || v === undefined) return "()";
  if (typeof v === "object" && Object.keys(v as Record<string, unknown>).length === 0) return "()";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function shortenTemplateId(id: string): string {
  // Leave full hash intact; users can copy-paste. Could add #name alias later.
  return id;
}

function printJsonYamlish(obj: unknown, indent: string): void {
  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      console.log(`${indent}[]`);
      return;
    }
    for (const item of obj) {
      if (typeof item === "object" && item !== null) {
        console.log(`${indent}-`);
        printJsonYamlish(item, `${indent}  `);
      } else {
        console.log(`${indent}- ${item}`);
      }
    }
    return;
  }
  if (obj === null || typeof obj !== "object") {
    console.log(`${indent}${obj}`);
    return;
  }
  const record = obj as Record<string, unknown>;
  const keyWidth = Math.max(...Object.keys(record).map((k) => k.length)) + 2;
  for (const [k, v] of Object.entries(record)) {
    const label = `${k}:`.padEnd(keyWidth);
    if (Array.isArray(v)) {
      if (v.length === 0) {
        console.log(`${indent}${k}: []`);
      } else {
        console.log(`${indent}${k}:`);
        printJsonYamlish(v, `${indent}  `);
      }
    } else if (v !== null && typeof v === "object") {
      console.log(`${indent}${k}:`);
      printJsonYamlish(v, `${indent}  `);
    } else {
      console.log(`${indent}${label}${v === null || v === undefined ? "" : String(v)}`);
    }
  }
}

interface TreeNode {
  event: TxEvent;
  children: TreeNode[];
}

// Events arrive in pre-order DFS. Each Exercised carries `lastDescendantNodeId`
// marking the end of its subtree, so we walk linearly with a stack: pop any
// parent whose subtree we've left, attach the current node to whatever's still
// on top, push the current node if it can have children of its own.
export function buildTree(events: TxEvent[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const stack: { node: TreeNode; endsAt: number }[] = [];
  for (const ev of events) {
    const node: TreeNode = { event: ev, children: [] };
    while (stack.length > 0 && stack[stack.length - 1]!.endsAt < ev.nodeId) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1]!.node.children.push(node);
    }
    if (ev.kind === "Exercised") {
      stack.push({ node, endsAt: ev.lastDescendantNodeId });
    }
  }
  return roots;
}

export function renderTreeText(result: ExerciseResult, full: boolean): void {
  console.log(`updateId:       ${result.updateId}`);
  console.log(`offset:         ${result.offset}`);
  if (full) {
    console.log(`commandId:      ${result.commandId}`);
    console.log(`synchronizerId: ${result.synchronizerId}`);
    console.log(`effectiveAt:    ${result.effectiveAt}`);
  }
  console.log("");
  const tree = buildTree(result.events);
  for (const root of tree) renderTreeNode(root, "", true, full);
}

function renderTreeNode(
  node: TreeNode,
  prefix: string,
  isLast: boolean,
  full: boolean,
): void {
  const connector = prefix === "" ? "" : isLast ? "└── " : "├── ";
  const line = summarizeEvent(node.event);
  console.log(`${prefix}${connector}${line}`);
  const childPrefix = prefix + (isLast ? "    " : "│   ");
  if (full) {
    printEventDetail(node.event, childPrefix + "  ");
  }
  for (let i = 0; i < node.children.length; i++) {
    renderTreeNode(node.children[i]!, childPrefix, i === node.children.length - 1, full);
  }
}

function summarizeEvent(e: TxEvent): string {
  if (e.kind === "Exercised") {
    const kind = e.consuming ? "consuming" : "non-consuming";
    const result = formatExerciseResult(e.exerciseResult);
    return `node ${e.nodeId}  ▸ Exercised   ${e.choice} on ${shortenTemplateId(e.templateId)}   ${kind}   result=${result}`;
  }
  if (e.kind === "Created") {
    return `node ${e.nodeId}  ▸ Created    ${shortenTemplateId(e.templateId)}   ${e.contractId}`;
  }
  return `node ${e.nodeId}  ▸ Archived   ${shortenTemplateId(e.templateId)}   ${e.contractId}`;
}

function printEventDetail(e: TxEvent, indent: string): void {
  if (e.kind === "Exercised") {
    console.log(`${indent}target:         ${e.contractId}`);
    console.log(`${indent}actingParties:  ${e.actingParties.join(", ")}`);
    console.log(`${indent}witnessParties: ${e.witnessParties.join(", ")}`);
    console.log(`${indent}choiceArgument: ${JSON.stringify(e.choiceArgument)}`);
  } else if (e.kind === "Created") {
    console.log(`${indent}signatories:    ${e.signatories.join(", ")}`);
    console.log(`${indent}observers:      ${e.observers.join(", ")}`);
    console.log(`${indent}createdAt:      ${e.createdAt}`);
    console.log(`${indent}argument:`);
    printJsonYamlish(e.argument, `${indent}  `);
  } else {
    console.log(`${indent}witnessParties: ${e.witnessParties.join(", ")}`);
  }
}

export function renderFlatJson(result: ExerciseResult, full: boolean): unknown {
  const { exercised, archived, created } = bucketize(result);
  const base: Record<string, unknown> = {
    updateId: result.updateId,
    offset: result.offset,
    synchronizerId: result.synchronizerId,
    exercised: exercised.map((e) => projectExercised(e, full)),
    archived,
    created: created.map((c) => projectCreated(c, full)),
  };
  if (full) {
    base["commandId"] = result.commandId;
    base["effectiveAt"] = result.effectiveAt;
  }
  return base;
}

export function renderTreeJson(result: ExerciseResult, full: boolean): unknown {
  const toJson = (node: TreeNode): unknown => {
    const ev = node.event;
    if (ev.kind === "Exercised") {
      const body = projectExercised(ev, full) as Record<string, unknown>;
      body["children"] = node.children.map(toJson);
      return body;
    }
    const body = ev.kind === "Created" ? projectCreated(ev, full) : projectArchived(ev, full);
    (body as Record<string, unknown>)["children"] = [];
    return body;
  };
  return {
    updateId: result.updateId,
    offset: result.offset,
    synchronizerId: result.synchronizerId,
    ...(full ? { commandId: result.commandId, effectiveAt: result.effectiveAt } : {}),
    roots: buildTree(result.events).map(toJson),
  };
}

function projectExercised(e: ExercisedEvent, full: boolean): unknown {
  const base: Record<string, unknown> = {
    event: "Exercised",
    nodeId: e.nodeId,
    contractId: e.contractId,
    templateId: e.templateId,
    choice: e.choice,
    consuming: e.consuming,
    actingParties: e.actingParties,
    result: e.exerciseResult,
  };
  if (full) {
    base["lastDescendantNodeId"] = e.lastDescendantNodeId;
    base["choiceArgument"] = e.choiceArgument;
    base["witnessParties"] = e.witnessParties;
    base["packageName"] = e.packageName;
    base["interfaceId"] = e.interfaceId;
    base["acsDelta"] = e.acsDelta;
  }
  return base;
}

function projectCreated(c: CreatedEventFlat, full: boolean): unknown {
  const base: Record<string, unknown> = {
    event: "Created",
    nodeId: c.nodeId,
    contractId: c.contractId,
    templateId: c.templateId,
    argument: c.argument,
    signatories: c.signatories,
    observers: c.observers,
  };
  if (full) {
    base["offset"] = c.offset;
    base["createdAt"] = c.createdAt;
    base["packageName"] = c.packageName;
    base["witnessParties"] = c.witnessParties;
    base["acsDelta"] = c.acsDelta;
  }
  return base;
}

function projectArchived(a: TxEvent, full: boolean): unknown {
  if (a.kind !== "Archived") return {};
  const base: Record<string, unknown> = {
    event: "Archived",
    nodeId: a.nodeId,
    contractId: a.contractId,
    templateId: a.templateId,
  };
  if (full) {
    base["witnessParties"] = a.witnessParties;
    base["packageName"] = a.packageName;
  }
  return base;
}
