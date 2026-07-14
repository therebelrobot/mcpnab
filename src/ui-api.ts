import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { AppContext } from "./config.js";

export interface JsonReply {
  status: number;
  json: unknown;
}

function ok(json: unknown): JsonReply {
  return { status: 200, json };
}
function err(status: number, message: string): JsonReply {
  return { status, json: { ok: false, error: message } };
}

function mask(secret?: string): string | null {
  if (!secret) return null;
  return secret.length <= 6 ? "••••" : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}

/** UI auth: if an apiKey is configured, the UI must present it too. */
export function uiAuthorized(ctx: AppContext, params: URLSearchParams, header?: string): boolean {
  if (!ctx.config.apiKey) return true;
  return header === ctx.config.apiKey || params.get("apikey") === ctx.config.apiKey;
}

function overview(ctx: AppContext): JsonReply {
  const jobs = ctx.downloads.list();
  const pct = (j: (typeof jobs)[number]) =>
    j.status === "Completed" ? 100 : j.bytesTotal ? Math.min(100, Math.floor((j.bytesDone / j.bytesTotal) * 100)) : 0;

  const queue = jobs
    .filter((j) => j.status === "Queued" || j.status === "Downloading")
    .sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt)
    .map((j) => ({
      nzoId: j.nzoId,
      name: j.name,
      category: j.category,
      status: j.status,
      priority: j.priority,
      percentage: pct(j),
      bytesDone: j.bytesDone,
      bytesTotal: j.bytesTotal,
    }));

  const history = jobs
    .filter((j) => j.status === "Completed" || j.status === "Failed")
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, 200)
    .map((j) => ({
      nzoId: j.nzoId,
      name: j.name,
      category: j.category,
      status: j.status,
      bytes: j.bytesDone || j.bytesTotal,
      storage: j.storage,
      completedAt: j.completedAt,
      error: j.error,
    }));

  const stats = ctx.db.listStats().map((s) => ({
    backend: s.backend,
    tool: s.tool,
    calls: s.calls,
    errors: s.errors,
    avgMs: s.calls ? Math.round(s.total_ms / s.calls) : 0,
    lastTs: s.last_ts,
    lastError: s.last_error,
  }));

  return ok({
    downloadDir: ctx.config.downloadDir,
    dataDir: ctx.dataDir,
    maxConcurrent: ctx.config.maxConcurrentDownloads ?? 2,
    backends: ctx.config.backends.map((b) => ({ name: b.name, type: b.type })),
    queue,
    history,
    stats,
  });
}

function configView(ctx: AppContext): JsonReply {
  return ok({
    server: ctx.config.server,
    downloadDir: ctx.config.downloadDir,
    dataDir: ctx.dataDir,
    apiKeySet: !!ctx.config.apiKey,
    tokenSecretSet: !!ctx.config.tokenSecret,
    tokenSecretPreview: mask(ctx.config.tokenSecret),
    backends: ctx.config.backends,
  });
}

/**
 * @param method HTTP method
 * @param path   full pathname, e.g. /api/ui/job/SABnzbd_nzo_x/cancel
 * @param body   parsed JSON body (or {})
 */
export async function handleUi(
  ctx: AppContext,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<JsonReply> {
  const rest = path.replace(/^\/api\/ui\/?/, "");
  const parts = rest.split("/").filter(Boolean);

  if (method === "GET" && parts[0] === "overview") return overview(ctx);
  if (method === "GET" && parts[0] === "config") return configView(ctx);

  if (method === "POST" && parts[0] === "job" && parts[1]) {
    const id = decodeURIComponent(parts[1]);
    const action = parts[2];
    switch (action) {
      case "priority": {
        const cur = ctx.downloads.get(id);
        if (!cur) return err(404, "no such job");
        const priority =
          typeof body.priority === "number"
            ? body.priority
            : cur.priority + (typeof body.delta === "number" ? body.delta : 0);
        return ctx.downloads.setPriority(id, priority) ? ok({ ok: true, priority }) : err(404, "no such job");
      }
      case "cancel":
        return ctx.downloads.cancel(id) ? ok({ ok: true }) : err(404, "no such job");
      case "retry":
        return ctx.downloads.retry(id) ? ok({ ok: true }) : err(404, "no such job");
      case "remove":
        return (await ctx.downloads.remove(id, body.deleteFiles === true))
          ? ok({ ok: true })
          : err(404, "no such job");
      default:
        return err(400, "unknown job action");
    }
  }

  if (method === "POST" && parts[0] === "token" && parts[1] === "cycle") {
    const secret = randomBytes(24).toString("hex");
    ctx.db.setMeta("token_secret", secret);
    ctx.config.tokenSecret = secret;
    return ok({ ok: true, tokenSecretPreview: mask(secret), note: "existing download links are now invalid" });
  }
  if (method === "POST" && parts[0] === "token" && parts[1] === "clear") {
    ctx.db.setMeta("token_secret", "");
    ctx.config.tokenSecret = undefined;
    return ok({ ok: true, note: "tokens are now unsigned" });
  }

  if (method === "POST" && parts[0] === "apikey") {
    const key = typeof body.apiKey === "string" ? body.apiKey : "";
    ctx.db.setMeta("api_key", key);
    ctx.config.apiKey = key || undefined;
    return ok({ ok: true, apiKeySet: !!key });
  }

  if (method === "POST" && parts[0] === "config" && parts[1] === "raw") {
    const text = typeof body.json === "string" ? body.json : "";
    try {
      JSON.parse(text);
    } catch (e) {
      return err(400, `invalid JSON: ${String(e)}`);
    }
    await writeFile(ctx.configPath, text, "utf8");
    return ok({ ok: true, needsRestart: true });
  }

  return err(404, "unknown ui endpoint");
}
