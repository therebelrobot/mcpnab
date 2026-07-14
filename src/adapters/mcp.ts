import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  BackendAdapter,
  FetchTarget,
  McpBackendConfig,
  McpTransportConfig,
  SearchItem,
  SearchQuery,
} from "../types.js";
import {
  applyNormalize,
  getPath,
  interpolateTemplate,
  isPlainObject,
  parseHumanSize,
  parseTextFields,
  parseTextRecords,
  renderArgs,
} from "./base.js";
import type { StatsSink } from "../db.js";

/** Builds the same transport mcpnab uses in production for a given backend's
 *  `mcp` config — env inheritance, stdio vs http, all of it. Exported so
 *  tooling (e.g. scripts/probe-backend.ts) can connect exactly like the
 *  adapter does without duplicating this logic. */
export function createMcpTransport(name: string, t: McpTransportConfig): Transport {
  if (t.transport === "stdio") {
    if (!t.command) throw new Error(`[${name}] stdio transport needs "command"`);
    return new StdioClientTransport({
      command: t.command,
      args: t.args ?? [],
      env: { ...getDefaultEnvironment(), ...inheritedEnv(), ...(t.env ?? {}) },
    });
  }
  if (t.transport === "http") {
    if (!t.url) throw new Error(`[${name}] http transport needs "url"`);
    return new StreamableHTTPClientTransport(new URL(t.url), {
      requestInit: t.headers ? { headers: t.headers } : undefined,
    });
  }
  throw new Error(`[${name}] unknown transport ${(t as { transport: string }).transport}`);
}

/**
 * Puts ANY MCP server behind the mcpnab. You describe, in config, which tool
 * does search and which does fetch, and how to map their JSON responses onto
 * our SearchItem / FetchTarget shapes. No code changes to add a new server.
 */
export class McpAdapter implements BackendAdapter {
  private client?: Client;
  private connecting?: Promise<void>;

  constructor(readonly name: string, private cfg: McpBackendConfig, private stats?: StatsSink) { }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new Client({ name: "mcpnab", version: "0.1.0" });
        await client.connect(createMcpTransport(this.name, this.cfg.mcp));
        this.client = client;
      })().catch((e) => {
        this.connecting = undefined;
        throw e;
      });
    }
    await this.connecting;
    return this.client!;
  }

  async init(): Promise<void> {
    // Connect eagerly so config errors surface at startup, but don't hard-fail
    // boot if a backend is momentarily down — it'll retry on first search.
    try {
      await this.ensureConnected();
    } catch (e) {
      console.warn(`[${this.name}] initial MCP connect failed, will retry on demand:`, e);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const started = Date.now();
    const attempt = async () => {
      const client = await this.ensureConnected();
      const res = await client.callTool({ name, arguments: args });
      if ((res as { isError?: boolean }).isError) {
        throw new Error(`[${this.name}] tool ${name} reported isError`);
      }
      return extractResult(res);
    };
    try {
      let out: unknown;
      try {
        out = await attempt();
      } catch (e) {
        this.client = undefined;
        this.connecting = undefined;
        console.warn(`[${this.name}] tool ${name} failed, reconnecting once:`, e);
        out = await attempt();
      }
      this.stats?.recordToolCall(this.name, name, true, Date.now() - started);
      return out;
    } catch (e) {
      this.stats?.recordToolCall(
        this.name,
        name,
        false,
        Date.now() - started,
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
  }

  async search(query: SearchQuery): Promise<SearchItem[]> {
    const s = this.cfg.search;
    const vars = {
      q: query.q ?? "",
      author: query.author ?? "",
      title: query.title ?? "",
      limit: query.limit,
      offset: query.offset,
    };
    const result = await this.callTool(s.tool, renderArgs(s.args, vars));
    const rows: unknown[] =
      s.textFormat && typeof result === "string"
        ? parseTextRecords(result, s.textFormat)
        : (() => {
            const rowsRaw = getPath(result, s.resultPath);
            return Array.isArray(rowsRaw) ? rowsRaw : rowsRaw != null ? [rowsRaw] : [];
          })();

    return rows.map((row): SearchItem => {
      const id = String(getPath(row, s.map.id) ?? "");
      return {
        id,
        title: String(getPath(row, s.map.title) ?? "Unknown"),
        author: s.map.author ? asStr(getPath(row, s.map.author)) : undefined,
        sizeBytes: s.map.sizeBytes ? parseHumanSize(getPath(row, s.map.sizeBytes)) : 0,
        extension: s.map.extension ? asStr(getPath(row, s.map.extension)) : undefined,
        published: s.map.published ? asStr(getPath(row, s.map.published)) : undefined,
        categories: s.categories ?? [7020],
        fetchRef: { id, row },
      };
    });
  }

  async fetch(fetchRef: unknown): Promise<FetchTarget> {
    const f = this.cfg.fetch;
    const { id, row } = fetchRef as { id: string; row: Record<string, unknown> };
    const vars = { id, ...(row ?? {}) };
    const result = await this.callTool(f.tool, renderArgs(f.args, vars));
    const parsed = f.textFormat && typeof result === "string" ? parseTextFields(result, f.textFormat.fields) : result;
    const mapVars = applyNormalize({ ...vars, ...(isPlainObject(parsed) ? parsed : {}) }, this.cfg.normalize);
    const url = f.map?.url
      ? interpolateTemplate(f.map.url, mapVars)
      : f.urlPath
        ? asStr(getPath(parsed, f.urlPath))
        : undefined;
    const filePath = f.map?.filePath
      ? interpolateTemplate(f.map.filePath, mapVars)
      : f.filePathPath
        ? asStr(getPath(parsed, f.filePathPath))
        : undefined;
    const filename = f.map?.filename
      ? interpolateTemplate(f.map.filename, mapVars)
      : f.filenamePath
        ? asStr(getPath(parsed, f.filenamePath))
        : undefined;
    if (!url && !filePath) {
      throw new Error(`[${this.name}] fetch tool ${f.tool} returned neither url nor filePath`);
    }
    return { url, filePath, filename, deleteAfterCopy: !!(f.deleteSourceAfterCopy && filePath) };
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}

function asStr(v: unknown): string | undefined {
  return v == null ? undefined : String(v);
}

/** getDefaultEnvironment() strips almost everything, which breaks npx/uvx behind
 *  a proxy, a custom CA, or a private registry. Pass through a safe allowlist so
 *  stdio-launched servers inherit the host's network config without leaking
 *  arbitrary secrets. Per-backend `env` in config still overrides these. */
export function inheritedEnv(): Record<string, string> {
  const allow = [
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
    "NPM_CONFIG_REGISTRY", "NPM_CONFIG_STRICT_SSL",
    "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_NATIVE_TLS", "UV_CACHE_DIR",
    "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL",
  ];
  const out: Record<string, string> = {};
  for (const k of allow) {
    const v = process.env[k];
    if (v != null) out[k] = v;
  }
  return out;
}

/** MCP tool results: prefer structuredContent, else parse concatenated text as
 *  JSON, else return the raw text. */
export function extractResult(res: unknown): unknown {
  const r = res as {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = (r.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
