import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import type { AppConfig, BackendAdapter } from "./types.js";
import { buildAdapter, checkMcpTransportConfig } from "./adapters/base.js";
import { DownloadManager } from "./downloader.js";
import { Db } from "./db.js";

export interface AppContext {
  config: AppConfig;
  adapters: Map<string, BackendAdapter>;
  downloads: DownloadManager;
  db: Db;
  configPath: string;
  dataDir: string;
}

export async function loadContext(configPath: string): Promise<AppContext> {
  const absConfig = resolve(configPath);
  const raw = await readFile(absConfig, "utf8");
  const config = JSON.parse(raw) as AppConfig;

  // Persistent data (sqlite db) lives alongside the config by default, so a
  // single mounted volume (e.g. ./data:/app/data) captures config + state.
  const dataDir = resolve(config.dataDir ?? dirname(absConfig));
  await mkdir(dataDir, { recursive: true });

  config.downloadDir = resolve(config.downloadDir ?? "./downloads");
  await mkdir(config.downloadDir, { recursive: true });
  config.server.baseUrl = (config.server.baseUrl ?? `http://localhost:${config.server.port}`).replace(/\/$/, "");

  const db = new Db(join(dataDir, "mcpnab.db"));

  // A cycled token secret (from the UI) is stored in the db and wins over file.
  const metaSecret = db.getMeta("token_secret");
  if (metaSecret) config.tokenSecret = metaSecret;
  const metaApiKey = db.getMeta("api_key");
  if (metaApiKey !== undefined) config.apiKey = metaApiKey || undefined;

  const adapters = new Map<string, BackendAdapter>();
  for (const bcfg of config.backends) {
    if (adapters.has(bcfg.name)) throw new Error(`duplicate backend name: ${bcfg.name}`);
    if (bcfg.type === "mcp") {
      for (const w of checkMcpTransportConfig(bcfg.name, bcfg.mcp as unknown as Record<string, unknown>)) {
        console.warn(`[config] ${w}`);
      }
    }
    const adapter = await buildAdapter(bcfg, db);
    await adapter.init?.();
    adapters.set(bcfg.name, adapter);
    console.log(`[config] backend ready: ${bcfg.name} (${bcfg.type})`);
  }

  const downloads = new DownloadManager(
    config.downloadDir,
    adapters,
    db,
    config.maxConcurrentDownloads ?? 2,
  );
  downloads.init();

  return { config, adapters, downloads, db, configPath: absConfig, dataDir };
}
