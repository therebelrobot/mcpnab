import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppContext } from "./config.js";
import { handleNewznab } from "./newznab.js";
import { handleSabGet, handleSabAddfile, nzbFor, decodeToken } from "./sabnzbd.js";
import { handleUi, uiAuthorized } from "./ui-api.js";

const UI_HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ui.html"), "utf8");

function sendJson(res: ServerResponse, status: number, json: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(json));
}
function sendText(res: ServerResponse, status: number, ctype: string, body: string): void {
  res.writeHead(status, { "content-type": ctype });
  res.end(body);
}
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startServer(ctx: AppContext): void {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", ctx.config.server.baseUrl);
      const params = url.searchParams;
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path === "/health") return sendText(res, 200, "text/plain; charset=utf-8", "ok\n");

      // Web UI
      if ((path === "/" || path === "/ui") && method === "GET") {
        return sendText(res, 200, "text/html; charset=utf-8", UI_HTML);
      }

      // UI JSON API (separate auth: shares apiKey when one is configured)
      if (path.startsWith("/api/ui")) {
        if (!uiAuthorized(ctx, params, req.headers["x-api-key"] as string | undefined)) {
          return sendJson(res, 401, { ok: false, error: "unauthorized" });
        }
        let body: Record<string, unknown> = {};
        if (method === "POST") {
          const raw = await readBody(req);
          if (raw) try { body = JSON.parse(raw); } catch { /* ignore */ }
        }
        const reply = await handleUi(ctx, method, path, body);
        return sendJson(res, reply.status, reply.json);
      }

      // Download-link endpoint (serves an NZB carrying the mcpnab token)
      const dl = path.match(/^\/dl\/([^/]+)\/([^/]+)$/);
      if (dl) {
        const backend = decodeURIComponent(dl[1]);
        const token = dl[2];
        try {
          const payload = decodeToken(token, ctx.config.tokenSecret);
          return sendText(res, 200, "application/x-nzb; charset=utf-8", nzbFor(backend, token, payload));
        } catch (e) {
          return sendText(res, 400, "text/plain", `bad token: ${String(e)}`);
        }
      }

      // SAB addfile (multipart) needs the raw body
      if (params.get("mode") === "addfile" && method === "POST") {
        const raw = await readBody(req);
        return sendJson(res, 200, handleSabAddfile(ctx, raw, params).json);
      }

      // Shared /api surface: SAB (mode=) vs Newznab (t=)
      if (params.has("mode")) return sendJson(res, 200, handleSabGet(ctx, params).json);
      if (params.has("t")) {
        const reply = await handleNewznab(ctx, params);
        return sendText(res, reply.status, reply.contentType, reply.body);
      }

      sendText(res, 404, "text/plain", "not found\n");
    } catch (e) {
      console.error("[server] error:", e);
      if (!res.headersSent) sendText(res, 500, "text/plain", "internal error\n");
      else res.end();
    }
  });

  server.listen(ctx.config.server.port, ctx.config.server.host, () => {
    const { host, port, baseUrl } = ctx.config.server;
    console.log(`[server] listening on http://${host}:${port}  (public: ${baseUrl})`);
    console.log(`[server] Web UI:   ${baseUrl}/`);
    console.log(`[server] Newznab:  ${baseUrl}/api   SABnzbd: ${baseUrl}/api`);
  });
}
