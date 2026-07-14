import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { BackendAdapter, FetchTarget, SearchItem, SearchQuery } from "../types.js";

interface CatalogRow {
  id: string;
  title: string;
  author?: string;
  extension?: string;
  sizeBytes?: number;
  categories?: number[];
  published?: string;
  /** Either a URL or a path (relative to the catalog file) to the actual file. */
  url?: string;
  filePath?: string;
}

/**
 * A backend backed by a local JSON catalog. Doubles as the reference
 * implementation for writing your own non-MCP adapter: implement search()
 * and fetch(), that's the whole contract.
 */
export class StaticAdapter implements BackendAdapter {
  private rows: CatalogRow[] = [];
  private baseDir = "";

  constructor(readonly name: string, private catalogPath: string) {}

  async init(): Promise<void> {
    const abs = resolve(this.catalogPath);
    this.baseDir = dirname(abs);
    this.rows = JSON.parse(await readFile(abs, "utf8"));
  }

  async search(query: SearchQuery): Promise<SearchItem[]> {
    const needle = [query.q, query.author, query.title]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .trim();

    const matched = this.rows.filter((r) => {
      if (!needle) return true;
      const hay = `${r.title} ${r.author ?? ""}`.toLowerCase();
      return needle.split(/\s+/).every((tok) => hay.includes(tok));
    });

    return matched.slice(query.offset, query.offset + query.limit).map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      sizeBytes: r.sizeBytes ?? 0,
      extension: r.extension,
      categories: r.categories ?? [7020],
      published: r.published,
      fetchRef: { id: r.id },
    }));
  }

  async fetch(fetchRef: unknown): Promise<FetchTarget> {
    const id = (fetchRef as { id: string }).id;
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`static: unknown id ${id}`);
    const filename = `${row.title}${row.extension ? "." + row.extension : ""}`;
    if (row.url) return { url: row.url, filename, sizeBytes: row.sizeBytes };
    if (row.filePath) {
      return { filePath: resolve(this.baseDir, row.filePath), filename, sizeBytes: row.sizeBytes };
    }
    throw new Error(`static: row ${id} has neither url nor filePath`);
  }
}
