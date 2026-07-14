# mcpnab

A backend-agnostic **Newznab + SABnzbd** API shim. It presents the two surfaces
the __r stack (R_____r/P______r/etc.) expects — a Newznab indexer and a
SABnzbd download client — and puts **any MCP server** behind them via config.
Point it at sources that are clear to redistribute (Project Gutenberg, Standard
Ebooks, Internet Archive open collections, arXiv/DOAJ/PMC for papers) and it
slots into your existing automation like a normal indexer + download client.

> Intended for public-domain and openly-licensed catalogs. The adapter layer is
> deliberately generic, but the point is to wire the __r workflow to sources you
> have the right to fetch and redistribute.

## How it works

```
 R_____r ──search──▶  /api?t=search        (Newznab)  ──▶ backend.search()  ──▶ MCP tool
    │                                                                            │
    │  ◀── RSS with enclosure link  /dl/<backend>/<token> ◀── signed token ◀─────┘
    │
    └──grab──▶ /api?mode=addurl&name=<that link>  (SABnzbd)
                     │ decode token → backend.fetch() → stream to downloadDir
                     ▼
              /api?mode=queue  ▶ progress     /api?mode=history ▶ storage path
                                                      │
                                              R_____r imports from storage
```

The download link handed to the __r stack is a self-contained, optionally
HMAC-signed token carrying the backend name and the adapter's opaque
`fetchRef`. Search and download share no server-side state — a link is valid on
its own. The same `/api` path serves both APIs; requests are routed by
`t=` (Newznab) vs `mode=` (SABnzbd), so you can point both the indexer and the
download client at the same base URL.

## Run it

```bash
npm install
npm run build
node dist/src/index.js ./config.json      # or: npm run dev -- ./config.json
```

There's a working demo config (`config.test.json`) plus a real stdio MCP server
(`examples/mock-gutenberg-mcp.ts`) so you can exercise the whole chain offline:

```bash
npm run dev -- config.test.json
# then, in another shell:
curl "http://127.0.0.1:8088/api?t=book&q=moby"
```

Open the **web UI** at `http://<host>:<port>/` to watch and control the queue.

### Testing end-to-end with curl

Both the Newznab and SABnzbd surfaces take the API key as an `apikey` **query
param** (not a header) — that's what the __r stack sends, so it's what mcpnab
expects too. The UI's JSON API is the exception: it reads an `x-api-key`
**header** (or `apikey` query param as a fallback). If `apiKey` isn't set in
your config, drop `&apikey=...` from every call below.

```bash
MCPNAB_API=change-me-or-remove-to-disable
MCPNAB_BASE=http://127.0.0.1:8080

# Newznab: capabilities (no key required)
curl "$MCPNAB_BASE/api?t=caps"

# Newznab: search
curl "$MCPNAB_BASE/api?t=search&q=moby+dick&apikey=$MCPNAB_API"

# SABnzbd: version / config sanity checks
curl "$MCPNAB_BASE/api?mode=version&apikey=$MCPNAB_API"
curl "$MCPNAB_BASE/api?mode=get_config&apikey=$MCPNAB_API&output=json"

# SABnzbd: grab a result — take the <enclosure url="..."> from a search
# response and hand it to addurl as `name`
curl "$MCPNAB_BASE/api?mode=addurl&name=$MCPNAB_BASE/dl/gutenberg/<token>&apikey=$MCPNAB_API&output=json"

# SABnzbd: watch it move through the queue, then land in history
curl "$MCPNAB_BASE/api?mode=queue&apikey=$MCPNAB_API&output=json"
curl "$MCPNAB_BASE/api?mode=history&apikey=$MCPNAB_API&output=json"

# UI JSON MCPNAB_API: header form
curl -H "x-api-key: $MCPNAB_API" "$MCPNAB_BASE/api/ui/config"
```



## State &amp; persistence

All state lives in a single SQLite file (`mcpnab.db`, via Node's built-in
`node:sqlite` — no extra dependency) in the **data directory**, which defaults to
the folder containing your config file (override with `dataDir`). That covers the
download queue, history, per-backend MCP usage stats, and a cycled token secret,
so everything survives a restart. Downloads interrupted by a restart are
re-queued and re-fetched from scratch on boot.

## Point R_____r at it

- **Indexer** (Settings ▸ Indexers ▸ + ▸ Newznab, custom):
  URL `http://<host>:<port>/api`, API Path `/api`, API Key = your `apiKey` (or blank).
- **Download client** (Settings ▸ Download Clients ▸ + ▸ SABnzbd):
  Host `<host>`, Port `<port>`, API Key = your `apiKey`, URL Base blank.
  Category e.g. `R_____r`.

`get_config` reports categories and disables SAB's sorting/pre-check flags so
the connection test comes back clean.

## Web UI

A SABnzbd-style web UI is served at `/` (no build step, no frontend deps — a
single static file). Tabs:

- **Queue** — live progress bars; raise/lower **priority**, **cancel** in-flight
  downloads. Honors `maxConcurrentDownloads`.
- **History** — completed/failed with the `storage` path R_____r imports from;
  **retry** failed jobs, **delete** (optionally with files).
- **MCP** — per-backend, per-tool usage: call counts, error counts, average
  latency, last-used, last error.
- **Config** — server/paths at a glance; **cycle** or clear the download-token
  secret; set/clear the API key; view the backends config.

If `apiKey` is set it also gates the UI (the page prompts for it and sends it as
`x-api-key`). Otherwise put the UI behind your reverse proxy.

## Adding a backend — no code required

Every backend implements one small contract (`src/types.ts`):

```ts
interface BackendAdapter {
  search(query): Promise<SearchItem[]>;   // -> id, title, author, size, ext, fetchRef
  fetch(fetchRef): Promise<FetchTarget>;  // -> { url } or { filePath }
}
```

The **generic MCP adapter** (`type: "mcp"`) implements that contract for you and
is driven entirely by config: you name the search tool and fetch tool, and map
their JSON responses onto the schema with dot-paths.

```jsonc
{
  "name": "gutenberg",
  "type": "mcp",
  "mcp": {
    "transport": "stdio",                 // or "http" with { "url": ... }
    "command": "npx",
    "args": ["-y", "your-gutenberg-mcp"]
  },
  "search": {
    "tool": "search_books",
    "args": { "query": "{q}", "limit": "{limit}" },   // {q}{author}{title}{limit}{offset}
    "resultPath": "results",              // dot-path to the array of rows
    "map": {                              // dot-paths within each row
      "id": "id",
      "title": "title",
      "author": "authors.0",
      "sizeBytes": "size",
      "extension": "format",
      "published": "year"
    },
    "categories": [7020]                  // newznab cats to stamp (7020 ebook, 3030 audiobook)
  },
  "fetch": {
    "tool": "get_download_link",
    "args": { "id": "{id}" },             // {id} + any field from the matched row
    "urlPath": "download.url",            // OR filePathPath for local files
    "filePathPath": "download.path",
    "filenamePath": "download.filename"
  }
}
```

Argument templating: a value that is exactly `"{key}"` is substituted with the
raw typed value (numbers stay numbers); embedded placeholders like
`"prefix {q}"` do string interpolation. Result parsing prefers a tool's
`structuredContent`, then falls back to JSON-parsing its text blocks.

#### Tools that return plain text instead of JSON

Some MCP servers return formatted text (log lines, "Key: value" blocks) rather
than structured JSON. `textFormat` parses that with per-field regexes instead
of `resultPath`/dot-paths — still no code required:

```jsonc
"search": {
  "tool": "book_search",
  "args": { "query": "{q}" },
  "textFormat": {
    "recordSeparator": "\\n\\s*\\n",   // splits multi-result text into records; default is blank-line-separated
    "fields": {                       // field name -> regex (capture group 1, or whole match if none)
      "title": "Title: (.*)",
      "author": "Authors: (.*)",
      "sizeBytes": "Size: (.*)",      // "1.5MB" etc. is coerced to bytes automatically
      "extension": "Format: (.*)",
      "id": "Hash: (.*)",
      "url": "URL: (.*)"
    }
  },
  "map": { "id": "id", "title": "title", "author": "author", "sizeBytes": "sizeBytes", "extension": "extension" }
}
```

`map` (or `urlPath`/`filePathPath`/`filenamePath` on `fetch`) then refers
directly to `textFormat.fields` keys — the parsed rows are flat, so
`"id": "id"` means "the field named `id`", same as it would for a dot-path.
For `fetch`, the whole response is parsed as a single record (no
`recordSeparator`). Use `npm run probe -- <backend> --raw` to see a tool's raw
text output and iterate on the regexes before committing them to config.

A runnable copy of the example above is wired up end-to-end: `config.example.json`
has a `text-based-source` backend, and `config.test.json` points a `mock-mcp-text`
backend at `examples/mock-textformat-mcp.ts` (a real stdio MCP server that
returns the catalog as plain text). `npm run dev -- config.test.json` and
searching (see below) exercises it the same way as the JSON mock backend.

#### Building a fetch field out of several pieces (`fetch.map`)

Sometimes no single field in a fetch response is the download path — you have
to assemble one from a base path the server gave you plus fields you already
know from the search step. `fetch.map` builds `url`/`filePath`/`filename` by
interpolating `{placeholders}` into one string instead of reading a single
dot-path. Placeholders resolve against the same vars available to `fetch.args`
(`{id}` plus every field on the matched search row) *and* whatever this fetch
call's own result parses to (its `textFormat.fields`, or its top-level JSON
keys):

```jsonc
"fetch": {
  "tool": "get_download_link",
  "args": { "id": "{id}", "format": "{extension}" },
  "textFormat": {
    "fields": { "basePath": "successful: (.*)" }   // this call's response is just "successful: /srv/downloads"
  },
  "map": {
    "filePath": "{basePath}/{id}.{extension}",      // -> "/srv/downloads/abc123.epub"
    "filename": "{id}.{extension}"                  // -> "abc123.epub"
  },
  "deleteSourceAfterCopy": true
}
```

A key set in `map` takes precedence over the matching `urlPath`/`filePathPath`/
`filenamePath` when both are present.

When `filePath` points at a file the MCP server already wrote to local disk
(as above), also set `map.filename` — otherwise `FetchTarget.filename` is left
unset and the downloader falls back to the job's release name, which has no
extension. That produces a working, correctly-named file on the server's own
disk (from the tool's own write) but a second, extension-less copy in
mcpnab's own per-job download folder.

`deleteSourceAfterCopy` closes that duplication: once mcpnab finishes copying
`filePath` into the job's own storage folder, it deletes the server's original
file, so a completed download leaves exactly one copy on disk instead of two.
It only ever touches `filePath` (never anything reached via `url`), and only
after the copy has fully succeeded — a failed/aborted copy leaves the source
alone. Deletion is best-effort: if it fails, the job still completes
successfully and a warning is logged.

##### Compensating for the MCP server's own filename sanitization (`normalize`)

Some MCP servers sanitize characters (`:`, `/`, ...) out of filenames before
writing them to disk, but hand you back the original, unsanitized value in
search results. If you then reconstruct a path yourself via `fetch.map` using
that value, it won't match what's actually on disk. A backend-level
`normalize` option fixes that by applying literal (non-regex) substring
replacements to every value before it's interpolated into a `map` template:

```jsonc
{
  "name": "anna",
  "type": "mcp",
  "mcp": { /* ... */ },
  "normalize": { ":": "_" },   // matches what the server does when it saves the file
  "fetch": {
    "tool": "book_download",
    "args": { "hash": "{id}", "title": "{title}" },
    "textFormat": { "fields": { "basePath": "Book downloaded successfully to path: (.*)" } },
    "map": { "filePath": "{basePath}/{title}.{extension}" }   // {title} is normalized first
  }
}
```

`normalize` only affects `fetch.map` interpolation — it doesn't touch the
`title`/etc. shown to Newznab/SAB clients, and doesn't affect what's sent as
tool `args` (the MCP server sees the original value and does its own
sanitization when it writes the file).

If a source doesn't fit the generic mapping, write a ~40-line adapter instead —
`src/adapters/static.ts` is the reference implementation (implement `search` and
`fetch`, register it in `src/adapters/base.ts`).

### Probing a backend before you map it

`npm run probe` connects to a backend's MCP server using the exact
command/args/env/transport from your config, calls a tool, and prints what
comes back — so you can write `resultPath`/`map`/`urlPath` against a real
response instead of guessing.

```bash
npm run probe -- gutenberg --list-tools           # see every tool + inputSchema
npm run probe -- gutenberg --q "moby dick"        # calls search.tool with {q} filled in
npm run probe -- gutenberg --which fetch --id pg-2701
npm run probe -- gutenberg --tool custom_tool --args '{"foo":"bar"}'
```

`--which fetch` calls the real fetch tool with no real search behind it, so only
`{id}`/`{title}` (and the other named flags) are filled in — any other row field
your `fetch.args`/`fetch.map` references (e.g. `{extension}`) is otherwise
empty. Use repeatable `--var key=value` to fill those in, e.g.
`--which fetch --id abc123 --var extension=epub`. Skipping this for a
download-type tool sends the request with that field genuinely blank, which
for some servers means a real (broken) download — `--which fetch` always
makes a real call, not a dry run.

Output builds up in layers: the raw MCP SDK response (`--raw`), the
extracted/unwrapped result (after `structuredContent`/text-block parsing),
the rows found at your configured `resultPath` (or parsed via `textFormat` if
the tool returns plain text — see below), and — for `search` — a preview of
each row run through your current `map`. Point it at another config with
`--config <path>` (defaults to `./config.json`).

Every run — whether the call above succeeded, failed, or the server refused to
even start — ends by printing an equivalent [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
command, built from the same resolved command/args/env:

```
npx @modelcontextprotocol/inspector --cli -e KEY=value node your-server.js --method tools/call --tool-name book_search --tool-arg query=moby
```

Run it as-is for a non-interactive rerun of the exact same call outside mcpnab
entirely (useful when a server's own stderr logging, like Go's structured
logs, gets interleaved with probe's output), or drop `--cli` for the
interactive web UI to browse tools/schemas and try other calls by hand.

## Docker

A multi-stage `Dockerfile` and a `docker-compose.yml` are included. The runtime
image is `node:22-bookworm-slim` plus the `uv`/`uvx` binaries. It runs as the
non-root `node` user (an entrypoint fixes volume ownership, then drops
privileges, so both bind and named mounts work).

```bash
docker compose up --build      # boots the self-contained static-backend demo
curl "http://localhost:8080/api?t=book&q=moby"   # UI at http://localhost:8080/
```

Everything persistent lives in **one mounted directory**, `/app/data`:
`config.json`, the `mcpnab.db` SQLite state, and the npm/uv caches. On first run
the image seeds `data/config.json` from a built-in default; edit that file (see
`config.example.json` for MCP backends) and restart.

### Matching host file ownership (PUID/PGID)

The container starts as `root`, then drops to the `node` user (uid/gid `1000`)
before running the app. If your bind-mounted `./data` or `./downloads` are
owned by a different uid/gid on the host, set `PUID`/`PGID` to match — the
entrypoint remaps the `node` user to that uid/gid before chowning the mounted
directories, so writes from inside the container land with the right owner on
the host:

```yaml
environment:
  - PUID=1000   # id -u on the host
  - PGID=1000   # id -g on the host
```

### Timezone (TZ)

The base image ships `tzdata`, so `TZ` (e.g. `America/New_York`) works out of
the box — no rebuild needed. It affects log timestamps and anything in the app
or MCP backends that reads local time:

```yaml
environment:
  - TZ=America/New_York
```

### MCP transports inside the container

All three transport styles work in the image:

- **`npx` (Node MCP servers)** — `npx` ships with the node base image. Verified:
  the mcpnab spawns `npx -y @modelcontextprotocol/server-everything` over stdio and
  completes the tool handshake.
- **`uvx` (Python MCP servers)** — the `uv`/`uvx` binaries are copied in from
  `ghcr.io/astral-sh/uv`. Verified: the mcpnab spawns `uvx mcp-server-time` over
  stdio and completes the handshake.
- **Remote (`transport: "http"`)** — needs only outbound network from the
  container; nothing extra in the image. For an MCP server running as a sibling
  compose service, use its service name as the host (`http://my-mcp:port/mcp`).

`npx`/`uvx` fetch their packages at **runtime** on first use, so the container
needs outbound access to your npm/PyPI registry. The caches live under
`/app/data` (`NPM_CONFIG_CACHE=/app/data/npm`, `UV_CACHE_DIR=/app/data/uv`), so
once that volume is mounted an MCP server is downloaded **once** and reused
across cold restarts — no repeated re-downloads. Delete the cache subdirs to
force a refresh.

### Bring your own binary

You can also point `mcp.command` at a **custom binary** you drop into the
mounted data directory instead of an `npx`/`uvx`/registry package. Since
`./data` on the host is mounted to `/app/data` in the container, anything you
put there is reachable at that in-container path:

```json
"mcp": {
  "transport": "stdio",
  "command": "/app/data/my-mcp-server",
  "args": []
}
```

A few things to get right:

- **Build for the container, not your host.** The runtime image is
  `node:22-bookworm-slim` (Debian, glibc). A binary built for macOS or a
  different CPU arch than the image won't exec — cross-compile for Linux and
  the image's target arch.
- **Make it executable** (`chmod +x`) — the bit persists through the bind
  mount.
- **Use the in-container path** (`/app/data/...`), not the host path.
- No extra permission setup is needed: the entrypoint chowns `/app/data` to
  the non-root `node` user before the process starts, so a readable/executable
  file under there just works.

### Proxies, private registries, custom CAs

The MCP SDK launches stdio children with a **stripped environment**, which
otherwise breaks `npx`/`uvx` behind a proxy or corporate CA. The mcpnab passes a
safe allowlist through to children automatically — `HTTP(S)_PROXY`, `NO_PROXY`,
`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `NPM_CONFIG_REGISTRY`, `UV_INDEX_URL`,
`PIP_INDEX_URL`, and a few more. Set them on the `mcpnab` service and they reach
the spawned servers; per-backend `mcp.env` in config overrides them.

### Consumer compose (mcpnab + R_____r + P______r)

```yaml
services:
  mcpnab:
    image: ghcr.io/therebelrobot/mcpnab:latest    # or build: .
    ports:
      - "8080:8080"                     # Newznab + SABnzbd + web UI
    environment:
      - PUID=1000                       # match host uid, avoids write errors
      - PGID=1000                       # match host gid
      - TZ=America/New_York             # log timestamps, local-time scheduling
    volumes:
      - ./mcpnab-data:/app/data           # config.json, mcpnab.db, npx/uvx caches
      - downloads:/downloads            # MUST be shared with R_____r, same path
    restart: unless-stopped

  R_____r:
    image: lscr.io/linuxserver/R_____r:develop
    ports: ["8787:8787"]
    volumes:
      - ./R_____r-config:/config
      - downloads:/downloads            # same volume, same mount path
    restart: unless-stopped

  P______r:
    image: lscr.io/linuxserver/P______r:latest
    ports: ["9696:9696"]
    volumes:
      - ./P______r-config:/config
    restart: unless-stopped

volumes:
  downloads:
```

Two things that trip up every __r + download-client setup — get them right and
imports work, get them wrong and R_____r can't find completed files:

1. **Shared download path must be identical in both containers.** The mcpnab
   reports a `storage` path in SAB history (e.g. `/downloads/<release>`), and
   R_____r reads files from that exact path. Mount the same volume at the same
   location (`/downloads`) in both, or configure R_____r Remote Path Mapping.
2. **`server.baseUrl` must be reachable by R_____r**, since R_____r fetches the
   download link. On a compose network that's the service name:
   `"baseUrl": "http://mcpnab:8080"`. Add the mcpnab in R_____r as a **Newznab
   indexer** (`http://mcpnab:8080/api`) and a **SABnzbd** download client
   (host `mcpnab`, port `8080`), or register the indexer in P______r and let it
   sync to R_____r.



| key | meaning |
|-----|---------|
| `server.host` / `port` / `baseUrl` | bind address; `baseUrl` is used to build download links |
| `downloadDir` | where completed downloads land (one folder per release) |
| `dataDir` | persistent state dir (sqlite db, caches); defaults to the config file's dir |
| `maxConcurrentDownloads` | simultaneous downloads (default 2) |
| `apiKey` | optional; required on Newznab + SAB + UI requests when set |
| `tokenSecret` | optional; HMAC-signs download tokens (cycle it from the UI) |
| `backends[]` | `type: "static"` (JSON catalog) or `type: "mcp"` (config above) |

## Notes / not-yet

- State persists in SQLite (`node:sqlite`); interrupted downloads restart from
  scratch on boot (no partial-file resume yet).
- `addurl` is the primary grab path; `addfile` is supported by scanning the
  uploaded NZB for the embedded mcpnab token, so both R_____r code paths work.
- Auth is a single shared `apiKey` covering Newznab, SAB, and the UI. Front it
  with your reverse proxy for anything more.

Public domain (Unlicense).
