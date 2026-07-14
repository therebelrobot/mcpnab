// A tiny but real MCP server over stdio, exposing `search_books` and
// `get_download_link`. It exists so you can exercise the McpAdapter without a
// live third-party server — and as a template shape for what a real
// Gutenberg/Internet-Archive MCP might return. Run: npm run mock-mcp
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

const server = new McpServer({ name: "mock-gutenberg", version: "0.1.0" });

server.tool(
  "search_books",
  "Search the (mock) Gutenberg catalog",
  { query: z.string().default(""), limit: z.number().default(50) },
  async ({ query, limit }) => {
    const needle = query.toLowerCase().trim();
    const results = catalog
      .filter((r) => !needle || `${r.title} ${r.author ?? ""}`.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        title: r.title,
        authors: r.author ? [r.author] : [],
        format: r.extension ?? "epub",
        size: r.sizeBytes ?? 0,
        year: r.published?.slice(0, 4) ?? "",
      }));
    return { content: [{ type: "text", text: JSON.stringify({ results }) }] };
  },
);

server.tool(
  "get_download_link",
  "Resolve a catalog id to a fast download link",
  { id: z.string() },
  async ({ id }) => {
    const row = catalog.find((r) => r.id === id);
    if (!row) {
      return { isError: true, content: [{ type: "text", text: `unknown id ${id}` }] };
    }
    const download = {
      path: join(here, row.filePath),
      filename: `${row.title}.${row.extension ?? "epub"}`,
    };
    return { content: [{ type: "text", text: JSON.stringify({ download }) }] };
  },
);

await server.connect(new StdioServerTransport());
console.error("[mock-gutenberg-mcp] up on stdio");
