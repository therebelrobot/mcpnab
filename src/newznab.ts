import type { AppConfig, BackendAdapter, SearchItem, SearchQuery } from "./types.js";
import { encodeToken } from "./token.js";

export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
}

export interface Ctx {
  config: AppConfig;
  adapters: Map<string, BackendAdapter>;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server version="0.1.0" title="mcpnab"/>
  <limits max="100" default="50"/>
  <retention days="9999"/>
  <registration available="no" open="no"/>
  <searching>
    <search available="yes" supportedParams="q"/>
    <book-search available="yes" supportedParams="q,author,title"/>
    <audio-search available="yes" supportedParams="q,author,title"/>
    <tv-search available="no" supportedParams="q"/>
    <movie-search available="no" supportedParams="q"/>
  </searching>
  <categories>
    <category id="7000" name="Books">
      <subcat id="7020" name="Ebook"/>
    </category>
    <category id="3000" name="Audio">
      <subcat id="3030" name="Audiobook"/>
    </category>
  </categories>
</caps>`;

function rfc822(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return (isNaN(d.getTime()) ? new Date() : d).toUTCString();
}

function itemXml(item: SearchItem, backend: string, cfg: AppConfig): string {
  const token = encodeToken(
    {
      backend,
      fetchRef: item.fetchRef,
      title: item.title,
      sizeBytes: item.sizeBytes,
      extension: item.extension,
    },
    cfg.tokenSecret,
  );
  const dl = `${cfg.server.baseUrl.replace(/\/$/, "")}/dl/${encodeURIComponent(backend)}/${token}`;
  const size = item.sizeBytes || 0;
  const fmt = item.extension ? ` [${item.extension.toUpperCase()}]` : "";
  const displayTitle = `${item.title}${item.author ? ` - ${item.author}` : ""}${fmt}`;
  const cats = item.categories.length ? item.categories : [7020];

  const attrs = [
    ...cats.map((c) => `    <newznab:attr name="category" value="${c}"/>`),
    `    <newznab:attr name="size" value="${size}"/>`,
    item.author ? `    <newznab:attr name="author" value="${xmlEscape(item.author)}"/>` : "",
    `    <newznab:attr name="booktitle" value="${xmlEscape(item.title)}"/>`,
  ]
    .filter(Boolean)
    .join("\n");

  return `  <item>
    <title>${xmlEscape(displayTitle)}</title>
    <guid isPermaLink="true">${xmlEscape(dl)}</guid>
    <link>${xmlEscape(dl)}</link>
    <comments></comments>
    <pubDate>${rfc822(item.published)}</pubDate>
    <size>${size}</size>
    <description>${xmlEscape(displayTitle)}</description>
    <enclosure url="${xmlEscape(dl)}" length="${size}" type="application/x-nzb"/>
${attrs}
  </item>`;
}

async function searchAll(ctx: Ctx, q: SearchQuery): Promise<Array<[SearchItem, string]>> {
  const results = await Promise.allSettled(
    [...ctx.adapters.entries()].map(async ([name, a]) => {
      const items = await a.search(q);
      return items.map((it) => [it, name] as [SearchItem, string]);
    }),
  );
  const out: Array<[SearchItem, string]> = [];
  for (const r of results) {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.warn("[newznab] a backend search failed:", r.reason);
  }
  return out.slice(0, q.limit);
}

export async function handleNewznab(ctx: Ctx, params: URLSearchParams): Promise<HttpReply> {
  const t = params.get("t") ?? "search";

  if (t === "caps") {
    return { status: 200, contentType: "application/xml; charset=utf-8", body: CAPS };
  }

  if (ctx.config.apiKey && params.get("apikey") !== ctx.config.apiKey) {
    return {
      status: 200,
      contentType: "application/xml; charset=utf-8",
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<error code="100" description="Incorrect user credentials"/>`,
    };
  }

  if (["search", "book", "audio", "tvsearch", "movie"].includes(t)) {
    const q: SearchQuery = {
      q: params.get("q") ?? undefined,
      author: params.get("author") ?? undefined,
      title: params.get("title") ?? undefined,
      categories: (params.get("cat") ?? "")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
      limit: Math.min(Number(params.get("limit")) || 50, 100),
      offset: Number(params.get("offset")) || 0,
    };
    const found = await searchAll(ctx, q);
    const items = found.map(([it, name]) => itemXml(it, name, ctx.config)).join("\n");
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <atom:link href="${xmlEscape(ctx.config.server.baseUrl)}" rel="self" type="application/rss+xml"/>
  <title>mcpnab</title>
  <description>MCP-backed Newznab shim</description>
  <link>${xmlEscape(ctx.config.server.baseUrl)}</link>
  <newznab:response offset="${q.offset}" total="${found.length}"/>
${items}
</channel>
</rss>`;
    return { status: 200, contentType: "application/rss+xml; charset=utf-8", body };
  }

  return {
    status: 200,
    contentType: "application/xml; charset=utf-8",
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<error code="203" description="Function not available"/>`,
  };
}
