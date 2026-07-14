// A tiny but real MCP server over stdio, exposing `book_search` and
// `get_download_link` like mock-gutenberg-mcp.ts, but returning **plain
// formatted text** instead of JSON — exercises the `textFormat` regex-parsing
// path (see README "Tools that return plain text instead of JSON") against a
// real MCP round trip. Run: npm run mock-mcp-text
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
interface Row {
  id: string;
  title: string;
  author?: string;
  extension?: string;
  sizeBytes?: number;
  published?: string;
  filePath: string;
}
const catalog: Row[] = JSON.parse(readFileSync(join(here, "sample-catalog.json"), "utf8"));

function humanSize(bytes = 0): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

const server = new McpServer({ name: "mock-textformat", version: "0.1.0" });

server.tool(
  "book_search",
  "Search the (mock) catalog; returns plain 'Key: value' text blocks instead of JSON",
  { query: z.string().default("") },
  async ({ query }) => {
    const needle = query.toLowerCase().trim();
    const matches = catalog.filter(
      (r) => !needle || `${r.title} ${r.author ?? ""}`.toLowerCase().includes(needle),
    );
    const text =
      matches
        .map((r) =>
          [
            `Title: ${r.title}`,
            `Authors: ${r.author ?? "Unknown"}`,
            `Format: ${(r.extension ?? "epub").toUpperCase()}`,
            `Size: ${humanSize(r.sizeBytes)}`,
            `Hash: ${r.id}`,
          ].join("\n"),
        )
        .join("\n\n") + "\n\n";
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "get_download_link",
  "Resolve a catalog id (Hash) to a download link; returns plain 'Key: value' text",
  { id: z.string() },
  async ({ id }) => {
    const row = catalog.find((r) => r.id === id);
    if (!row) {
      return { isError: true, content: [{ type: "text", text: `unknown id ${id}` }] };
    }
    const text = [
      `Path: ${join(here, row.filePath)}`,
      `Filename: ${row.title}.${row.extension ?? "epub"}`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
console.error("[mock-textformat-mcp] up on stdio");
