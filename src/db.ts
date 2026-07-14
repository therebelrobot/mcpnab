import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface JobRow {
  nzo_id: string;
  backend: string;
  fetch_ref: string; // JSON
  name: string;
  /** Canonical output filename (with extension) — what's advertised in the
   *  indexer listing and the SAB queue/history, and what's actually written
   *  to disk. Falls back to `name` for rows written before this column existed. */
  filename: string | null;
  category: string;
  status: string;
  priority: number;
  bytes_total: number;
  bytes_done: number;
  storage: string;
  error: string | null;
  added_at: number;
  completed_at: number | null;
}

export interface StatRow {
  backend: string;
  tool: string;
  calls: number;
  errors: number;
  total_ms: number;
  last_ts: number | null;
  last_error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  nzo_id TEXT PRIMARY KEY,
  backend TEXT NOT NULL,
  fetch_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  filename TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  storage TEXT NOT NULL,
  error TEXT,
  added_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS mcp_stats (
  backend TEXT NOT NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  total_ms INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER,
  last_error TEXT,
  PRIMARY KEY (backend, tool)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** A recorder for MCP tool calls; the adapter depends only on this. */
export interface StatsSink {
  recordToolCall(backend: string, tool: string, ok: boolean, ms: number, error?: string): void;
}

export class Db implements StatsSink {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Add columns introduced after a db was first created. `CREATE TABLE IF NOT
   *  EXISTS` above only covers fresh installs. */
  private migrate(): void {
    const cols = (this.db.prepare(`PRAGMA table_info(jobs)`).all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes("filename")) this.db.exec(`ALTER TABLE jobs ADD COLUMN filename TEXT`);
  }

  // --- jobs ---
  insertJob(r: JobRow): void {
    this.db
      .prepare(
        `INSERT INTO jobs (nzo_id,backend,fetch_ref,name,filename,category,status,priority,bytes_total,bytes_done,storage,error,added_at,completed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        r.nzo_id, r.backend, r.fetch_ref, r.name, r.filename, r.category, r.status, r.priority,
        r.bytes_total, r.bytes_done, r.storage, r.error, r.added_at, r.completed_at,
      );
  }
  updateProgress(id: string, done: number, total: number): void {
    this.db.prepare(`UPDATE jobs SET bytes_done=?, bytes_total=? WHERE nzo_id=?`).run(done, total, id);
  }
  setFilename(id: string, filename: string): void {
    this.db.prepare(`UPDATE jobs SET filename=? WHERE nzo_id=?`).run(filename, id);
  }
  setStatus(id: string, status: string, opts: { error?: string | null; completedAt?: number | null; storage?: string } = {}): void {
    this.db
      .prepare(`UPDATE jobs SET status=?, error=COALESCE(?,error), completed_at=COALESCE(?,completed_at), storage=COALESCE(?,storage) WHERE nzo_id=?`)
      .run(status, opts.error ?? null, opts.completedAt ?? null, opts.storage ?? null, id);
  }
  setPriority(id: string, priority: number): void {
    this.db.prepare(`UPDATE jobs SET priority=? WHERE nzo_id=?`).run(priority, id);
  }
  getJob(id: string): JobRow | undefined {
    return this.db.prepare(`SELECT * FROM jobs WHERE nzo_id=?`).get(id) as unknown as JobRow | undefined;
  }
  listJobs(): JobRow[] {
    return this.db.prepare(`SELECT * FROM jobs ORDER BY added_at ASC`).all() as unknown as JobRow[];
  }
  /** Queued/Downloading, highest priority first, for the scheduler. */
  nextQueued(excluding: Set<string>): JobRow | undefined {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status='Queued' ORDER BY priority DESC, added_at ASC`)
      .all() as unknown as JobRow[];
    return rows.find((r) => !excluding.has(r.nzo_id));
  }
  deleteJob(id: string): void {
    this.db.prepare(`DELETE FROM jobs WHERE nzo_id=?`).run(id);
  }

  // --- mcp stats ---
  recordToolCall(backend: string, tool: string, ok: boolean, ms: number, error?: string): void {
    this.db
      .prepare(
        `INSERT INTO mcp_stats (backend,tool,calls,errors,total_ms,last_ts,last_error)
         VALUES (?,?,1,?,?,?,?)
         ON CONFLICT(backend,tool) DO UPDATE SET
           calls=calls+1,
           errors=errors+?,
           total_ms=total_ms+?,
           last_ts=?,
           last_error=COALESCE(?,last_error)`,
      )
      .run(
        backend, tool, ok ? 0 : 1, ms, Date.now(), error ?? null,
        ok ? 0 : 1, ms, Date.now(), error ?? null,
      );
  }
  listStats(): StatRow[] {
    return this.db.prepare(`SELECT * FROM mcp_stats ORDER BY last_ts DESC`).all() as unknown as StatRow[];
  }

  // --- meta ---
  getMeta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as unknown as { value: string } | undefined;
    return row?.value;
  }
  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?`)
      .run(key, value, value);
  }

  close(): void {
    this.db.close();
  }
}
