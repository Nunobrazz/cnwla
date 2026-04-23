export interface ParsedField {
  path: string[];
  value: unknown;
}

export function parseField(spec: string): ParsedField {
  const eq = spec.indexOf("=");
  if (eq < 0) {
    throw new Error(`field must be 'key=value', got: '${spec}'`);
  }
  const keyStr = spec.slice(0, eq).trim();
  const valStr = spec.slice(eq + 1);
  if (keyStr === "") {
    throw new Error(`empty key in field spec: '${spec}'`);
  }
  return { path: keyStr.split("."), value: parseValue(valStr) };
}

export function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;

  // Arrays require brackets. Commas alone stay in the string so `memo=hi,there`
  // doesn't silently become an array.
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((p) => parseValue(p));
  }

  // `{...}` and `"..."` go through JSON.parse; anything that fails to parse
  // falls through as a plain string (user probably meant it literally).
  const first = s[0];
  if (first === "{" || first === '"') {
    try {
      return JSON.parse(s);
    } catch {
      /* plain string */
    }
  }

  // Numbers stay as strings: Canton Decimals are string-encoded.
  return s;
}

export function assembleArgs(fields: ParsedField[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const { path, value } of fields) {
    if (path.length === 0) continue;
    let cur: Record<string, unknown> = root;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]!;
      const next = cur[key];
      if (next && typeof next === "object" && !Array.isArray(next)) {
        cur = next as Record<string, unknown>;
      } else {
        const fresh: Record<string, unknown> = {};
        cur[key] = fresh;
        cur = fresh;
      }
    }
    cur[path[path.length - 1]!] = value;
  }
  return root;
}
