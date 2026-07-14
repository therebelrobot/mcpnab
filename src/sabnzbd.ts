import type { AppConfig } from "./types.js";
import type { DownloadManager, Job } from "./downloader.js";
import { decodeToken, encodeToken, type TokenPayload } from "./token.js";

export interface JsonReply {
  status: number;
  json: unknown;
}

export interface SabCtx {
  config: AppConfig;
  downloads: DownloadManager;
}

const SAB_VERSION = "4.3.3";

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(2);
}
function human(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(2)} KB`;
  return `${bytes} B`;
}
function pct(job: Job): number {
  if (!job.bytesTotal) return job.status === "Completed" ? 100 : 0;
  return Math.min(100, Math.floor((job.bytesDone / job.bytesTotal) * 100));
}

function categories(cfg: AppConfig): string[] {
  const fromBackends = cfg.backends.map((b) => b.name);
  return [...new Set(["*", "books", "audio", "R_____r", ...fromBackends])];
}

/** Build the marker embedded in generated NZBs so addfile can recover the job. */
export function mcpnabMarker(backend: string, token: string): string {
  return `MCPNABTOKEN:${backend}|${token}`;
}

/** Minimal NZB served at /dl/... so clients that download-then-addfile still work. */
export function nzbFor(backend: string, token: string, payload: TokenPayload): string {
  const subject = `${payload.title} ${mcpnabMarker(backend, token)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${mcpnabMarker(backend, token)} -->
<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">
  <file poster="mcpnab" date="0" subject="${subject.replace(/"/g, "&quot;")}">
    <groups><group>alt.binaries.mcp-mcpnab</group></groups>
    <segments><segment bytes="${payload.sizeBytes || 0}" number="1">mcpnab@1</segment></segments>
  </file>
</nzb>`;
}

function queueReply(ctx: SabCtx, params: URLSearchParams): JsonReply {
  const cat = params.get("category");
  const active = ctx.downloads
    .list()
    .filter((j) => j.status === "Queued" || j.status === "Downloading")
    .filter((j) => !cat || cat === "*" || j.category === cat);

  const slots = active.map((j, i) => {
    const left = Math.max(0, j.bytesTotal - j.bytesDone);
    return {
      nzo_id: j.nzoId,
      filename: j.name,
      name: j.name,
      cat: j.category,
      status: j.status,
      index: i,
      priority: "Normal",
      size: human(j.bytesTotal),
      sizeleft: human(left),
      mb: mb(j.bytesTotal),
      mbleft: mb(left),
      percentage: String(pct(j)),
      timeleft: "0:00:10",
      eta: "unknown",
    };
  });

  return {
    status: 200,
    json: {
      queue: {
        status: slots.some((s) => s.status === "Downloading") ? "Downloading" : "Idle",
        paused: false,
        speedlimit: "0",
        speed: "1.0 M",
        kbpersec: "1024.0",
        noofslots: slots.length,
        noofslots_total: slots.length,
        start: 0,
        limit: slots.length,
        finish: 0,
        slots,
      },
    },
  };
}

function historyReply(ctx: SabCtx, params: URLSearchParams): JsonReply {
  const cat = params.get("category");
  const done = ctx.downloads
    .list()
    .filter((j) => j.status === "Completed" || j.status === "Failed")
    .filter((j) => !cat || cat === "*" || j.category === cat);

  const slots = done.map((j) => ({
    nzo_id: j.nzoId,
    name: j.name,
    nzb_name: `${j.name}.nzb`,
    category: j.category,
    cat: j.category,
    status: j.status,
    storage: j.storage,
    path: j.storage,
    bytes: j.bytesDone || j.bytesTotal,
    size: human(j.bytesDone || j.bytesTotal),
    download_time: j.completedAt ? Math.round((j.completedAt - j.addedAt) / 1000) : 0,
    postproc_time: 0,
    completed: Math.floor((j.completedAt ?? Date.now()) / 1000),
    fail_message: j.error ?? "",
  }));

  return {
    status: 200,
    json: { history: { noofslots: slots.length, slots } },
  };
}

function getConfigReply(ctx: SabCtx): JsonReply {
  const cats = categories(ctx.config);
  return {
    status: 200,
    json: {
      config: {
        misc: {
          complete_dir: ctx.config.downloadDir,
          download_dir: ctx.config.downloadDir,
          pre_check: 0,
          enable_tv_sorting: 0,
          enable_movie_sorting: 0,
          enable_date_sorting: 0,
          direct_unpack: 0,
          history_retention: "0",
        },
        categories: cats.map((name) => ({ name, dir: "", priority: 0 })),
        servers: [{ host: "mcpnab", displayname: "MCPnab", enable: 1 }],
      },
    },
  };
}

/** addurl gets our own dl URL in `name`; parse backend + token out of it. */
function parseDlUrl(url: string): { backend: string; token: string } | undefined {
  const m = url.match(/\/dl\/([^/]+)\/([^/?#]+)/);
  if (!m) return undefined;
  return { backend: decodeURIComponent(m[1]), token: m[2] };
}

function startJob(
  ctx: SabCtx,
  backend: string,
  token: string,
  category: string,
): JsonReply {
  let payload: TokenPayload;
  try {
    payload = decodeToken(token, ctx.config.tokenSecret);
  } catch (e) {
    return { status: 200, json: { status: false, error: `bad token: ${String(e)}` } };
  }
  const job = ctx.downloads.add({
    backend,
    fetchRef: payload.fetchRef,
    name: payload.title,
    category: category || "R_____r",
    sizeBytes: payload.sizeBytes,
  });
  return { status: 200, json: { status: true, nzo_ids: [job.nzoId] } };
}

export function handleSabGet(ctx: SabCtx, params: URLSearchParams): JsonReply {
  const mode = params.get("mode") ?? "";

  if (ctx.config.apiKey && params.get("apikey") !== ctx.config.apiKey) {
    return { status: 200, json: { status: false, error: "API Key Incorrect" } };
  }

  switch (mode) {
    case "version":
      return { status: 200, json: { version: SAB_VERSION } };
    case "get_config":
      return getConfigReply(ctx);
    case "get_cats":
      return { status: 200, json: { categories: categories(ctx.config) } };
    case "fullstatus":
      return { status: 200, json: { status: { version: SAB_VERSION } } };
    case "addurl": {
      const name = params.get("name") ?? "";
      const parsed = parseDlUrl(name);
      if (!parsed) return { status: 200, json: { status: false, error: "unrecognized url" } };
      return startJob(ctx, parsed.backend, parsed.token, params.get("cat") ?? params.get("category") ?? "");
    }
    case "queue":
      if (params.get("name") === "delete") {
        const v = params.get("value");
        if (v) void ctx.downloads.remove(v, params.get("del_files") === "1");
        return { status: 200, json: { status: true } };
      }
      return queueReply(ctx, params);
    case "history":
      if (params.get("name") === "delete") {
        const v = params.get("value");
        if (v) void ctx.downloads.remove(v, params.get("del_files") === "1");
        return { status: 200, json: { status: true } };
      }
      return historyReply(ctx, params);
    default:
      return { status: 200, json: { status: false, error: `unsupported mode: ${mode}` } };
  }
}

/** addfile: recover the job by scanning the raw multipart body for our marker. */
export function handleSabAddfile(ctx: SabCtx, rawBody: string, params: URLSearchParams): JsonReply {
  if (ctx.config.apiKey && params.get("apikey") !== ctx.config.apiKey) {
    return { status: 200, json: { status: false, error: "API Key Incorrect" } };
  }
  const m = rawBody.match(/MCPNABTOKEN:([^\s|]+)\|([A-Za-z0-9._-]+)/);
  if (!m) return { status: 200, json: { status: false, error: "no mcpnab token in upload" } };
  return startJob(ctx, decodeURIComponent(m[1]), m[2], params.get("cat") ?? params.get("category") ?? "");
}

// re-export for the dl endpoint
export { decodeToken, encodeToken };
