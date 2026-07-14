import { createWriteStream, createReadStream } from "node:fs";
import { mkdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { BackendAdapter } from "./types.js";
import type { Db, JobRow } from "./db.js";

export type JobStatus = "Queued" | "Downloading" | "Completed" | "Failed";

export interface Job {
  nzoId: string;
  name: string;
  filename: string;
  category: string;
  status: JobStatus;
  priority: number;
  bytesTotal: number;
  bytesDone: number;
  storage: string;
  addedAt: number;
  completedAt?: number;
  error?: string;
}

function rowToJob(r: JobRow): Job {
  return {
    nzoId: r.nzo_id,
    name: r.name,
    filename: r.filename ?? r.name,
    category: r.category,
    status: r.status as JobStatus,
    priority: r.priority,
    bytesTotal: r.bytes_total,
    bytesDone: r.bytes_done,
    storage: r.storage,
    addedAt: r.added_at,
    completedAt: r.completed_at ?? undefined,
    error: r.error ?? undefined,
  };
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 180) || "release";
}

export class DownloadManager {
  private running = new Set<string>();
  private aborters = new Map<string, AbortController>();

  constructor(
    private downloadDir: string,
    private adapters: Map<string, BackendAdapter>,
    private db: Db,
    private maxConcurrent = 2,
  ) {}

  /** Resume anything left mid-flight by a restart, then start the scheduler. */
  init(): void {
    for (const r of this.db.listJobs()) {
      if (r.status === "Downloading") {
        this.db.setStatus(r.nzo_id, "Queued");
        this.db.updateProgress(r.nzo_id, 0, r.bytes_total);
      }
    }
    this.schedule();
  }

  list(): Job[] {
    return this.db.listJobs().map(rowToJob);
  }
  get(id: string): Job | undefined {
    const r = this.db.getJob(id);
    return r ? rowToJob(r) : undefined;
  }

  add(opts: {
    backend: string;
    fetchRef: unknown;
    name: string;
    filename?: string;
    category: string;
    sizeBytes: number;
    priority?: number;
  }): Job {
    const nzoId = `SABnzbd_nzo_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const folderName = sanitize(opts.name);
    const row: JobRow = {
      nzo_id: nzoId,
      backend: opts.backend,
      fetch_ref: JSON.stringify(opts.fetchRef),
      name: folderName,
      filename: sanitize(opts.filename ?? opts.name),
      category: opts.category,
      status: "Queued",
      priority: opts.priority ?? 0,
      bytes_total: opts.sizeBytes || 0,
      bytes_done: 0,
      storage: resolve(join(this.downloadDir, folderName)),
      error: null,
      added_at: Date.now(),
      completed_at: null,
    };
    this.db.insertJob(row);
    this.schedule();
    return rowToJob(row);
  }

  setPriority(id: string, priority: number): boolean {
    if (!this.db.getJob(id)) return false;
    this.db.setPriority(id, priority);
    this.schedule();
    return true;
  }

  retry(id: string): boolean {
    const r = this.db.getJob(id);
    if (!r) return false;
    this.db.setStatus(id, "Queued", { error: null, completedAt: null });
    this.db.updateProgress(id, 0, r.bytes_total);
    this.schedule();
    return true;
  }

  /** Stop a running/queued job but keep it in history as Failed(cancelled). */
  cancel(id: string): boolean {
    const r = this.db.getJob(id);
    if (!r) return false;
    this.aborters.get(id)?.abort();
    this.db.setStatus(id, "Failed", { error: "cancelled", completedAt: Date.now() });
    return true;
  }

  /** Remove a job entirely, optionally deleting downloaded files. */
  async remove(id: string, deleteFiles = false): Promise<boolean> {
    const r = this.db.getJob(id);
    if (!r) return false;
    this.aborters.get(id)?.abort();
    if (deleteFiles) await rm(r.storage, { recursive: true, force: true }).catch(() => {});
    this.db.deleteJob(id);
    return true;
  }

  private schedule(): void {
    while (this.running.size < this.maxConcurrent) {
      const next = this.db.nextQueued(this.running);
      if (!next) break;
      void this.run(next.nzo_id);
    }
  }

  private async run(id: string): Promise<void> {
    this.running.add(id);
    const aborter = new AbortController();
    this.aborters.set(id, aborter);
    try {
      const r = this.db.getJob(id);
      if (!r || r.status !== "Queued") return;
      const adapter = this.adapters.get(r.backend);
      if (!adapter) throw new Error(`no such backend: ${r.backend}`);

      this.db.setStatus(id, "Downloading");
      const target = await adapter.fetch(JSON.parse(r.fetch_ref));
      if (aborter.signal.aborted) return;

      const filename = sanitize(target.filename ?? r.filename ?? r.name);
      if (filename !== r.filename) this.db.setFilename(id, filename);
      await mkdir(r.storage, { recursive: true });
      const outPath = join(r.storage, filename);
      let total = r.bytes_total || target.sizeBytes || 0;
      let done = 0;
      let lastPersist = 0;
      const onChunk = (len: number) => {
        done += len;
        if (done > total) total = done;
        const now = Date.now();
        if (now - lastPersist > 750) {
          lastPersist = now;
          this.db.updateProgress(id, done, total);
        }
      };

      if (target.filePath) {
        try {
          total ||= (await stat(target.filePath)).size;
        } catch {
          /* ignore */
        }
        await this.stream(createReadStream(target.filePath), outPath, onChunk, aborter.signal);
        if (target.deleteAfterCopy) {
          await rm(target.filePath, { force: true }).catch((e) =>
            console.warn(`[download] ${id} couldn't delete source file ${target.filePath}:`, e),
          );
        }
      } else if (target.url) {
        const res = await fetch(target.url, { headers: target.headers, signal: aborter.signal });
        if (!res.ok || !res.body) throw new Error(`fetch ${target.url} -> HTTP ${res.status}`);
        const len = Number(res.headers.get("content-length"));
        if (len && !total) total = len;
        await this.stream(Readable.fromWeb(res.body as any), outPath, onChunk, aborter.signal);
      } else {
        throw new Error("fetch target had neither filePath nor url");
      }

      this.db.updateProgress(id, done || total, total || done);
      this.db.setStatus(id, "Completed", { completedAt: Date.now() });
    } catch (e) {
      if (!aborter.signal.aborted) {
        const msg = e instanceof Error ? e.message : String(e);
        this.db.setStatus(id, "Failed", { error: msg, completedAt: Date.now() });
        console.error(`[download] ${id} failed:`, msg);
      }
    } finally {
      this.running.delete(id);
      this.aborters.delete(id);
      this.schedule();
    }
  }

  private async stream(
    src: NodeJS.ReadableStream,
    outPath: string,
    onChunk: (len: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    src.on("data", (c: Buffer) => onChunk(c.length));
    await pipeline(src, createWriteStream(outPath), { signal });
  }
}
