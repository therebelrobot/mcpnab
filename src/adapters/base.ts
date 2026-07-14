import type { BackendAdapter, BackendConfig, TextFormatConfig } from "../types.js";
import type { StatsSink } from "../db.js";

/** Resolve a dot-path like "authors.0.name" against an object. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/** Substitute {placeholders} in a plain string template with stringified values
 *  from a value bag; a var that's missing/null becomes "". Shared by args
 *  templating and by the fetch `map` field-construction templates, which
 *  interpolate request vars (e.g. {id}) and parsed result fields (e.g. a
 *  textFormat field like {basePath}) into a single derived string. */
export function interpolateTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const val = vars[key];
    return val == null ? "" : String(val);
  });
}

/** Substitute {placeholders} in an args template using a value bag.
 *  A value that is exactly "{key}" is replaced by the raw typed value
 *  (so numbers stay numbers); otherwise substitution is string interpolation. */
export function renderArgs(
  template: Record<string, unknown>,
  vars: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(template)) {
    if (typeof v === "string") {
      const whole = v.match(/^\{(\w+)\}$/);
      out[k] = whole ? vars[whole[1]] : interpolateTemplate(v, vars);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** True for a non-null, non-array object — the shape a parsed fetch result
 *  needs to be in order to spread its fields into a `map` template's vars. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Apply a backend's `normalize` substring replacements (in key order, matched
 *  literally, not as regex) to every string value in a vars bag before it's
 *  interpolated into a `map` template. Non-string values pass through as-is. */
export function applyNormalize(
  vars: Record<string, unknown>,
  normalize: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!normalize || Object.keys(normalize).length === 0) return vars;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    out[k] = Object.entries(normalize).reduce((s, [from, to]) => s.split(from).join(to), v);
  }
  return out;
}

/** Pull named fields out of a block of text with per-field regexes. Each
 *  pattern's capture group 1 is used, or the whole match if it has none;
 *  fields that don't match are left out of the row. */
export function parseTextFields(text: string, fields: Record<string, string>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(fields)) {
    const m = text.match(new RegExp(pattern));
    if (m) row[key] = (m[1] ?? m[0]).trim();
  }
  return row;
}

/** Split a plain-text tool response into records (default: blank-line
 *  separated) and run `parseTextFields` on each. */
export function parseTextRecords(text: string, cfg: TextFormatConfig): Record<string, string>[] {
  const sep = new RegExp(cfg.recordSeparator ?? "\\n\\s*\\n");
  return text
    .split(sep)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => parseTextFields(block, cfg.fields));
}

/** Coerce a size value that may be a human string ("1.5MB") instead of a raw
 *  byte count — common in text-formatted tool output. */
export function parseHumanSize(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  const m = v.trim().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/i);
  if (!m) return Number(v) || 0;
  const mult: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(parseFloat(m[1]) * mult[(m[2] ?? "b").toLowerCase()]);
}

const KNOWN_MCP_TRANSPORT_KEYS = new Set(["transport", "command", "args", "env", "url", "headers"]);

/** Catches the easy-to-make mistake of nesting `textFormat` (or other mapping
 *  keys) under `mcp` — that block only describes the transport, so anything
 *  else there is silently ignored and search/fetch quietly falls back to the
 *  JSON `resultPath` path. Returns human-readable warnings; doesn't throw. */
export function checkMcpTransportConfig(backendName: string, mcp: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(mcp)) {
    if (KNOWN_MCP_TRANSPORT_KEYS.has(key)) continue;
    if (key === "textFormat") {
      warnings.push(
        `backend "${backendName}": "textFormat" is under "mcp" but belongs under "search" (and/or "fetch") — as configured it's ignored, so search falls back to JSON \`resultPath\` and returns nothing for a plain-text tool.`,
      );
    } else {
      warnings.push(`backend "${backendName}": unknown key "${key}" under "mcp" — ignored.`);
    }
  }
  return warnings;
}

export async function buildAdapter(cfg: BackendConfig, stats?: StatsSink): Promise<BackendAdapter> {
  switch (cfg.type) {
    case "static": {
      const { StaticAdapter } = await import("./static.js");
      return new StaticAdapter(cfg.name, cfg.catalog);
    }
    case "mcp": {
      const { McpAdapter } = await import("./mcp.js");
      return new McpAdapter(cfg.name, cfg, stats);
    }
    default: {
      // exhaustiveness guard
      const _never: never = cfg;
      throw new Error(`unknown backend type: ${JSON.stringify(_never)}`);
    }
  }
}
