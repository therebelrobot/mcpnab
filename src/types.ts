// Core contracts. Everything the mcpnab knows about a backend goes through
// these interfaces — the Newznab/SAB layers never touch a backend directly.

export interface SearchQuery {
  q?: string;
  author?: string;
  title?: string;
  /** Newznab category ids the client asked for (e.g. 7020 ebook, 3030 audiobook). */
  categories: number[];
  limit: number;
  offset: number;
}

/** One result row, normalized. `fetchRef` is opaque to the mcpnab and is the
 *  only thing handed back to the adapter's fetch() later. */
export interface SearchItem {
  /** Stable within a backend for the lifetime of a link. */
  id: string;
  title: string;
  author?: string;
  /** Best estimate in bytes; 0 if the backend doesn't say. */
  sizeBytes: number;
  /** epub | pdf | mobi | m4b ... used to build the release filename. */
  extension?: string;
  categories: number[];
  /** ISO-8601 if known. */
  published?: string;
  /** Opaque payload the adapter needs to resolve a download later. */
  fetchRef: unknown;
}

/** Tells the downloader where to actually pull bytes from. Exactly one of
 *  `url` or `filePath` must be set. */
export interface FetchTarget {
  url?: string;
  filePath?: string;
  /** Suggested output filename (without directory). */
  filename?: string;
  /** Extra headers for a `url` fetch (auth tokens, etc.). */
  headers?: Record<string, string>;
  sizeBytes?: number;
  /** If true and `filePath` is set, the downloader deletes that file once
   *  it's done copying it into the job's own storage folder — for adapters
   *  whose `filePath` points at a file the MCP server already wrote to local
   *  disk, so a completed download doesn't leave two full copies on disk. */
  deleteAfterCopy?: boolean;
}

export interface BackendAdapter {
  readonly name: string;
  /** Called once at startup. Establish connections here. */
  init?(): Promise<void>;
  search(query: SearchQuery): Promise<SearchItem[]>;
  /** Resolve a previously-returned `fetchRef` into something downloadable. */
  fetch(fetchRef: unknown): Promise<FetchTarget>;
  close?(): Promise<void>;
}

export interface ServerConfig {
  host: string;
  port: number;
  /** Public base URL used to build download links handed to the __r stack. */
  baseUrl: string;
}

export interface AppConfig {
  server: ServerConfig;
  downloadDir: string;
  /** Directory for persistent state (sqlite db). Defaults to the config file's dir. */
  dataDir?: string;
  /** Max simultaneous downloads (default 2). */
  maxConcurrentDownloads?: number;
  /** If set, Newznab + SAB requests must present this apikey. */
  apiKey?: string;
  /** If set, download tokens are HMAC-signed with it. */
  tokenSecret?: string;
  backends: BackendConfig[];
}

export type BackendConfig =
  | ({ name: string; type: "static" } & StaticBackendConfig)
  | ({ name: string; type: "mcp" } & McpBackendConfig);

export interface StaticBackendConfig {
  /** Path to a JSON catalog file (see examples/sample-catalog.json). */
  catalog: string;
}

export interface McpBackendConfig {
  mcp: McpTransportConfig;
  search: McpToolMapping;
  fetch: McpFetchMapping;
  /** Literal substring replacements (matched literally, not as regex; applied
   *  in key order) run over every value before it's interpolated into a
   *  `fetch.map` template. Use this when the MCP server itself sanitizes
   *  characters in the filenames/paths it writes to disk (e.g. `":": "_"`) —
   *  a value we already hold (like a search row's `title`) won't match what's
   *  actually on disk once we reconstruct a path from it, unless we apply the
   *  same substitution first. */
  normalize?: Record<string, string>;
}

export interface McpTransportConfig {
  transport: "stdio" | "http";
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http (streamable HTTP) */
  url?: string;
  headers?: Record<string, string>;
}

export interface McpToolMapping {
  tool: string;
  /** Argument template. Values may contain {q},{author},{title},{limit},{offset}. */
  args: Record<string, unknown>;
  /** Dot-path to the array of rows inside the tool result ("" = the result itself).
   *  Ignored when `textFormat` is set — rows come from parsing instead. */
  resultPath?: string;
  /** If the tool returns plain text instead of JSON, parse it into rows with
   *  regexes instead of walking `resultPath`. `map` then refers directly to
   *  `textFormat.fields` keys (the parsed rows are flat). */
  textFormat?: TextFormatConfig;
  /** Maps our SearchItem fields to dot-paths within each row (or, with
   *  `textFormat`, to its field names). */
  map: {
    id: string;
    title: string;
    author?: string;
    sizeBytes?: string;
    extension?: string;
    published?: string;
  };
  /** Newznab categories to stamp on every row from this backend. */
  categories?: number[];
}

export interface McpFetchMapping {
  tool: string;
  /** Argument template. Placeholders: {id} plus any mapped field, e.g. {title}. */
  args: Record<string, unknown>;
  /** If the tool returns plain text instead of JSON, parse it with regexes
   *  first. `urlPath`/`filePathPath`/`filenamePath` then refer directly to
   *  `textFormat.fields` keys. */
  textFormat?: TextFormatConfig;
  /** Dot-path to a direct download URL in the tool result. */
  urlPath?: string;
  /** Dot-path to a local file path in the tool result (alternative to urlPath). */
  filePathPath?: string;
  filenamePath?: string;
  /** Build url/filePath/filename by interpolating {placeholders} into a single
   *  string instead of reading one dot-path. Placeholders resolve against the
   *  same vars used to render `args` (id + the search row's fields) plus
   *  whatever this fetch call's result parses to (its `textFormat.fields`, or
   *  its top-level JSON keys) — e.g. `"filePath": "{basePath}/{id}.{format}"`.
   *  A key set here takes precedence over the matching *Path option. */
  map?: {
    url?: string;
    filePath?: string;
    filename?: string;
  };
  /** When `filePath` (via `filePathPath` or `map.filePath`) points at a file
   *  the MCP server already wrote to local disk, set this to have the
   *  downloader delete that file once it's done copying it into the job's
   *  own storage folder — otherwise a completed download leaves two full
   *  copies on disk (the server's own write, plus mcpnab's copy). */
  deleteSourceAfterCopy?: boolean;
}

/** Declarative parser for MCP tools that return formatted plain text instead
 *  of JSON (e.g. log-style or "Key: value" block output). No code required —
 *  each field is a regex (capture group 1, or the whole match if there isn't
 *  one) run against a record's text. */
export interface TextFormatConfig {
  /** Regex (source, no flags) separating one record from the next in a
   *  multi-result response. Only used for `search`; `fetch` always parses the
   *  whole response as a single record. Default: one or more blank lines. */
  recordSeparator?: string;
  /** Field name -> regex (source, no flags) applied to each record. */
  fields: Record<string, string>;
}
