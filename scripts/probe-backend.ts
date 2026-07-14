import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AppConfig, McpTransportConfig } from "../src/types.js";
import { createMcpTransport, extractResult, inheritedEnv } from "../src/adapters/mcp.js";
import {
  applyNormalize,
  checkMcpTransportConfig,
  getPath,
  interpolateTemplate,
  isPlainObject,
  parseHumanSize,
  parseTextFields,
  parseTextRecords,
  renderArgs,
} from "../src/adapters/base.js";

interface Flags {
  config: string;
  backend?: string;
  tool?: string;
  args?: string;
  which: "search" | "fetch";
  listTools: boolean;
  raw: boolean;
  q: string;
  author: string;
  title: string;
  id: string;
  limit: number;
  offset: number;
  /** Extra {placeholder} vars from repeated --var key=value, for row-derived
   *  fields (e.g. {extension}) that fetch.args/fetch.map reference but that
   *  --which fetch has no dedicated flag for and can't get from a real search. */
  vars: Record<string, string>;
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {
    config: "./config.json",
    which: "search",
    listTools: false,
    raw: false,
    q: "test",
    author: "",
    title: "",
    id: "",
    limit: 20,
    offset: 0,
    vars: {},
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--config": flags.config = argv[++i]; break;
      case "--tool": flags.tool = argv[++i]; break;
      case "--args": flags.args = argv[++i]; break;
      case "--which": flags.which = argv[++i] === "fetch" ? "fetch" : "search"; break;
      case "--list-tools": case "-l": flags.listTools = true; break;
      case "--raw": flags.raw = true; break;
      case "--q": flags.q = argv[++i]; break;
      case "--author": flags.author = argv[++i]; break;
      case "--title": flags.title = argv[++i]; break;
      case "--id": flags.id = argv[++i]; break;
      case "--limit": flags.limit = Number(argv[++i]); break;
      case "--offset": flags.offset = Number(argv[++i]); break;
      case "--var": {
        const kv = argv[++i] ?? "";
        const eq = kv.indexOf("=");
        if (eq > 0) flags.vars[kv.slice(0, eq)] = kv.slice(eq + 1);
        break;
      }
      case "--help": case "-h": printUsage(); process.exit(0); break;
      default: positional.push(a);
    }
  }
  if (positional[0]) flags.backend = positional[0];
  return flags;
}

function printUsage(): void {
  console.log(`Usage: npm run probe -- <backend> [options]

Connects to a backend's configured MCP server using the exact same
command/args/env/transport mcpnab uses in production, calls a tool, and
prints what comes back — so you can write resultPath/map/urlPath in
config.json against a real response instead of guessing. Every run also
prints an equivalent MCP Inspector command so you can keep digging outside
the probe (interactively, or with its own --cli mode) after success or
failure.

Options:
  --config <path>       path to config.json (default ./config.json)
  --which search|fetch  use that mapping's tool + args template (default search)
  --tool <name>         call this tool instead of the mapping's configured tool
  --args '<json>'       literal arguments object, overrides the rendered template
  --list-tools, -l      list every tool the backend exposes (name, description, inputSchema) and exit
  --raw                 also print the untouched MCP SDK response (content blocks, isError, ...)
  --q, --author, --title, --id, --limit, --offset
                         values substituted into the configured args template
                         ({q}, {author}, {title}, {limit}, {offset}, {id})
  --var key=value        extra {placeholder} vars, repeatable — e.g. for a
                         --which fetch mapping that references a row field
                         (like {extension}/{format}) with no dedicated flag,
                         since standalone fetch probing has no real search row
  --help, -h             show this help

Examples:
  npm run probe -- anna --list-tools
  npm run probe -- anna --q dune
  npm run probe -- anna --which fetch --id abc123 --title "Dune" --var extension=epub
  npm run probe -- anna --tool book_search --args '{"query":"dune","limit":5}'
`);
}

/** Shell-quote a value for safe copy/paste into a terminal. */
function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/** Print the equivalent `npx @modelcontextprotocol/inspector` invocation for
 *  whatever this run just did (or tried to do), so the user can keep
 *  investigating outside the probe — interactively, or non-interactively via
 *  Inspector's own --cli mode — independent of whether the call above
 *  succeeded or failed. */
function printInvestigateCommand(
  mcp: McpTransportConfig,
  call?: { method: "tools/list" | "tools/call"; toolName?: string; args?: Record<string, unknown> },
): void {
  console.log(`\n--- run this outside the probe to investigate further ---`);
  if (mcp.transport !== "stdio") {
    console.log(`transport is "${mcp.transport}" — MCP Inspector doesn't take a remote URL as a CLI arg;`);
    console.log(`run \`npx @modelcontextprotocol/inspector\` and connect manually to:`);
    console.log(`  url: ${mcp.url}`);
    if (mcp.headers) console.log(`  headers: ${JSON.stringify(mcp.headers)}`);
    return;
  }
  if (!mcp.command) return;

  const env = { ...inheritedEnv(), ...(mcp.env ?? {}) };
  const envFlags = Object.entries(env)
    .map(([k, v]) => `-e ${shq(`${k}=${v}`)}`)
    .join(" ");
  const cmd = [mcp.command, ...(mcp.args ?? [])].map(shq).join(" ");

  let line = `npx @modelcontextprotocol/inspector --cli${envFlags ? " " + envFlags : ""} ${cmd}`;
  if (call?.method === "tools/list") {
    line += ` --method tools/list`;
  } else if (call?.method === "tools/call" && call.toolName) {
    line += ` --method tools/call --tool-name ${shq(call.toolName)}`;
    for (const [k, v] of Object.entries(call.args ?? {})) {
      line += ` --tool-arg ${shq(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)}`;
    }
  }
  console.log(line);
  console.log(`(drop --cli for the interactive UI at http://localhost:6274)`);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (!flags.backend) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const config = JSON.parse(await readFile(flags.config, "utf8")) as AppConfig;
  const bcfg = config.backends.find((b) => b.name === flags.backend);
  if (!bcfg) {
    console.error(
      `no backend named "${flags.backend}" in ${flags.config}. Known backends: ${config.backends.map((b) => b.name).join(", ") || "(none)"}`,
    );
    process.exitCode = 1;
    return;
  }
  if (bcfg.type !== "mcp") {
    console.error(`backend "${flags.backend}" is type "${bcfg.type}", not "mcp" — nothing to probe.`);
    process.exitCode = 1;
    return;
  }

  for (const w of checkMcpTransportConfig(bcfg.name, bcfg.mcp as unknown as Record<string, unknown>)) {
    console.warn(`[probe] warning: ${w}`);
  }

  let toolName: string | undefined;
  let toolArgs: Record<string, unknown> | undefined;

  console.log(`[probe] connecting to "${bcfg.name}" via ${bcfg.mcp.transport}...`);
  const client = new Client({ name: "mcpnab-probe", version: "0.1.0" });

  try {
    await client.connect(createMcpTransport(bcfg.name, bcfg.mcp));

    if (flags.listTools) {
      const { tools } = await client.listTools();
      for (const t of tools) {
        console.log(`\n${t.name}`);
        if (t.description) console.log(`  ${t.description}`);
        console.log(`  inputSchema: ${JSON.stringify(t.inputSchema)}`);
      }
      return;
    }

    const mapping = flags.which === "fetch" ? bcfg.fetch : bcfg.search;
    toolName = flags.tool ?? mapping.tool;
    if (!toolName) {
      console.error(`no --tool given and backend has no "${flags.which}.tool" configured`);
      process.exitCode = 1;
      return;
    }

    const vars = {
      q: flags.q, author: flags.author, title: flags.title, id: flags.id, limit: flags.limit, offset: flags.offset,
      ...flags.vars,
    };
    toolArgs = flags.args ? JSON.parse(flags.args) : renderArgs(mapping.args, vars);

    if (flags.which === "fetch") {
      console.log(`[probe] note: this is a REAL call to the fetch tool — for a download-type tool it will actually download/write files, not just preview.`);
    }
    console.log(`[probe] calling ${toolName}(${JSON.stringify(toolArgs)})`);
    const res = await client.callTool({ name: toolName, arguments: toolArgs });

    if (flags.raw) {
      console.log("\n--- raw MCP response ---");
      console.log(JSON.stringify(res, null, 2));
    }

    const extracted = extractResult(res);
    console.log("\n--- extracted result (what resultPath/map/urlPath walk) ---");
    console.log(JSON.stringify(extracted, null, 2));

    if (flags.which === "search") {
      const s = bcfg.search;
      let rows: unknown[];
      if (s.textFormat && typeof extracted === "string") {
        rows = parseTextRecords(extracted, s.textFormat);
        console.log(`\n--- rows parsed via textFormat (${rows.length}) ---`);
      } else {
        const rowsRaw = getPath(extracted, s.resultPath);
        rows = Array.isArray(rowsRaw) ? rowsRaw : rowsRaw != null ? [rowsRaw] : [];
        console.log(`\n--- rows at resultPath "${s.resultPath ?? "(root)"}" (${rows.length}) ---`);
      }
      console.log(JSON.stringify(rows, null, 2));

      console.log(`\n--- mapped preview using current search.map ---`);
      console.log(
        JSON.stringify(
          rows.map((row) => ({
            id: getPath(row, s.map.id),
            title: getPath(row, s.map.title),
            author: s.map.author ? getPath(row, s.map.author) : undefined,
            sizeBytes: s.map.sizeBytes ? parseHumanSize(getPath(row, s.map.sizeBytes)) : undefined,
            extension: s.map.extension ? getPath(row, s.map.extension) : undefined,
            published: s.map.published ? getPath(row, s.map.published) : undefined,
          })),
          null,
          2,
        ),
      );
    } else {
      const f = bcfg.fetch;
      const parsed = f.textFormat && typeof extracted === "string" ? parseTextFields(extracted, f.textFormat.fields) : extracted;
      if (f.textFormat) {
        console.log(`\n--- fields parsed via textFormat ---`);
        console.log(JSON.stringify(parsed, null, 2));
      }

      console.log(
        `\n--- mapped preview using current fetch mapping (row-derived {vars} are unavailable outside a real search — only {id}/{title} plus anything from --var are filled in) ---`,
      );
      const mapVars = applyNormalize({ ...vars, ...(isPlainObject(parsed) ? parsed : {}) }, bcfg.normalize);
      console.log(
        JSON.stringify(
          {
            url: f.map?.url ? interpolateTemplate(f.map.url, mapVars) : f.urlPath ? getPath(parsed, f.urlPath) : undefined,
            filePath: f.map?.filePath
              ? interpolateTemplate(f.map.filePath, mapVars)
              : f.filePathPath
                ? getPath(parsed, f.filePathPath)
                : undefined,
            filename: f.map?.filename
              ? interpolateTemplate(f.map.filename, mapVars)
              : f.filenamePath
                ? getPath(parsed, f.filenamePath)
                : undefined,
          },
          null,
          2,
        ),
      );
    }
  } catch (e) {
    console.error(`[probe] error:`, e);
    process.exitCode = 1;
  } finally {
    printInvestigateCommand(
      bcfg.mcp,
      flags.listTools ? { method: "tools/list" } : toolName ? { method: "tools/call", toolName, args: toolArgs } : undefined,
    );
    try {
      await client.close();
    } catch {
      // connection may never have succeeded; nothing to clean up
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
