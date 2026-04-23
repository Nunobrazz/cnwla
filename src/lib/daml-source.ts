import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

export interface DamlProject {
  rootDir: string;
  damlYamlPath: string;
  packageName: string;
  sourceDir: string;
}

export interface FieldDef {
  name: string;
  /** Raw type text between `:` and end-of-line (trimmed). e.g. `Party`, `[Party]`, `ContractId Coin`. */
  type: string;
}

export interface TemplateEntry {
  packageName: string;
  module: string;
  template: string;
  fullId: string;
  file: string;
  /** Ordered fields from the template's `with` block. */
  fields: FieldDef[];
}

export class DamlTemplateCatalog {
  constructor(
    readonly project: DamlProject,
    readonly entries: TemplateEntry[],
  ) {}

  /** Case-insensitive suffix match against `:Module:Template`. Returns distinct full ids. */
  lookupBySuffix(pattern: string): string[] {
    const suffix = (pattern.startsWith(":") ? pattern : `:${pattern}`).toLowerCase();
    const matches = new Set<string>();
    for (const e of this.entries) {
      const key = `:${e.module}:${e.template}`.toLowerCase();
      if (key.endsWith(suffix)) matches.add(e.fullId);
    }
    return [...matches];
  }

  /** Like `lookupBySuffix` but returns the full entries (fields, module, etc.). */
  lookupEntriesBySuffix(pattern: string): TemplateEntry[] {
    const suffix = (pattern.startsWith(":") ? pattern : `:${pattern}`).toLowerCase();
    const out: TemplateEntry[] = [];
    const seen = new Set<string>();
    for (const e of this.entries) {
      const key = `:${e.module}:${e.template}`.toLowerCase();
      if (key.endsWith(suffix) && !seen.has(e.fullId)) {
        seen.add(e.fullId);
        out.push(e);
      }
    }
    return out;
  }
}

export function findDamlProject(startDir: string): DamlProject | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  while (true) {
    const yamlPath = path.join(dir, "daml.yaml");
    if (fs.existsSync(yamlPath)) {
      try {
        const raw = fs.readFileSync(yamlPath, "utf8");
        const parsed = YAML.parse(raw) as Record<string, unknown> | null;
        if (parsed && typeof parsed === "object") {
          const packageName = typeof parsed["name"] === "string" ? (parsed["name"] as string) : "";
          const sourceRel = typeof parsed["source"] === "string" ? (parsed["source"] as string) : "";
          if (packageName && sourceRel) {
            return {
              rootDir: dir,
              damlYamlPath: yamlPath,
              packageName,
              sourceDir: path.resolve(dir, sourceRel),
            };
          }
        }
      } catch {
        // Malformed daml.yaml — skip and keep walking
      }
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findDamlFiles(rootDir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(rootDir)) return out;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".daml")) out.push(full);
    }
  };
  walk(rootDir);
  return out;
}

// Line-anchored: `^template` (not `\btemplate`) so `-- template Foo` and
// indented inner references don't false-match. Good enough for the actual Daml
// people write; avoids shipping a DALF/Protobuf parser.
const MODULE_RE = /^\s*module\s+([\w.]+)\s+where/m;

function extractTemplates(filePath: string, packageName: string): TemplateEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const moduleMatch = MODULE_RE.exec(content);
  if (!moduleMatch) return [];
  const moduleName = moduleMatch[1]!;
  const entries: TemplateEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = /^template\s+(\w+)\b/.exec(lines[i]!);
    if (!m) continue;
    const name = m[1]!;
    entries.push({
      packageName,
      module: moduleName,
      template: name,
      fullId: `#${packageName}:${moduleName}:${name}`,
      file: filePath,
      fields: extractWithFields(lines, i + 1),
    });
  }
  return entries;
}

// From the line after `template X`, find the `with` block and collect
// `field : Type` entries up to `where`. Handles both multi-line block form
// (`with\n  field : T\n`) and short inline form (`with field : T`) — the
// latter is rare for templates but cheap to cover.
function extractWithFields(lines: string[], startIdx: number): FieldDef[] {
  const fields: FieldDef[] = [];
  let inBlock = false;
  for (let i = startIdx; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/--.*$/, "");
    if (!inBlock) {
      if (/^\s*with\s*$/.test(line)) {
        inBlock = true;
        continue;
      }
      const inline = /^\s*with\s+(\w+)\s*:\s*(.+)$/.exec(line);
      if (inline) {
        fields.push({ name: inline[1]!, type: inline[2]!.trim() });
        inBlock = true;
        continue;
      }
      if (/^template\s/.test(line) || /^\S/.test(line)) return fields;
      continue;
    }
    if (/^\s*where\b/.test(line)) return fields;
    const fm = /^\s+(\w+)\s*:\s*(.+)$/.exec(line);
    if (fm) fields.push({ name: fm[1]!, type: fm[2]!.trim() });
  }
  return fields;
}

// Per-process memo. Same startDir in the same invocation = zero re-parse.
let cachedCatalog: { startDir: string; catalog: DamlTemplateCatalog | null } | null = null;

export function loadDamlTemplates(startDir: string = process.cwd()): DamlTemplateCatalog | null {
  const key = path.resolve(startDir);
  if (cachedCatalog && cachedCatalog.startDir === key) return cachedCatalog.catalog;

  const project = findDamlProject(key);
  if (!project) {
    cachedCatalog = { startDir: key, catalog: null };
    return null;
  }
  const files = findDamlFiles(project.sourceDir);
  const entries: TemplateEntry[] = [];
  for (const f of files) {
    for (const e of extractTemplates(f, project.packageName)) entries.push(e);
  }
  const catalog = new DamlTemplateCatalog(project, entries);
  cachedCatalog = { startDir: key, catalog };
  return catalog;
}
