// The one SQLite store (schema owner): events, latest snapshots, settings + grants (kv), the run record (runs, core/ledger.ts).
import { DatabaseSync } from 'node:sqlite';
import type { HubEvent, StoredEvent } from '@agent-spaghetti/sdk';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    try {
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, env_id TEXT, source TEXT, data TEXT);
        CREATE TABLE IF NOT EXISTS snapshots(key TEXT PRIMARY KEY, ts INTEGER, json TEXT);
        CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, json TEXT);
        CREATE TABLE IF NOT EXISTS runs(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, source TEXT, target TEXT, model TEXT,
          parent_run_id INTEGER, job_id TEXT, kind TEXT, reason TEXT, task_hash TEXT, duration_ms INTEGER, input_tokens INTEGER,
          output_tokens INTEGER, cost_usd REAL, outcome TEXT, error TEXT, result_path TEXT, result_sha256 TEXT, verdict TEXT);`);
      this.addColumns('runs', { chain_id: 'INTEGER', session: 'TEXT', return_to: 'TEXT', delivered: 'TEXT' });
    } catch (err) { throw new Error(`agent-spaghetti store cannot open "${path}": ${(err as Error).message}`); }
  }
  /** Columns added after a table was first created (older stores keep their data). */
  private addColumns(table: string, cols: Record<string, string>) {
    const have = new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name));
    for (const [c, t] of Object.entries(cols)) if (!have.has(c)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${t}`);
  }
  appendEvent(e: HubEvent): number {
    return Number(this.db.prepare('INSERT INTO events(ts,type,env_id,source,data) VALUES(?,?,?,?,?)')
      .run(e.ts, e.type, e.envId, e.source, JSON.stringify(e.data)).lastInsertRowid);
  }
  eventsSince(id: number, limit = 500): StoredEvent[] {
    return (this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(id, limit) as any[])
      .map(r => ({ id: r.id, ts: r.ts, type: r.type, envId: r.env_id, source: r.source, data: JSON.parse(r.data) }));
  }
  lastEventId(): number { return Number((this.db.prepare('SELECT MAX(id) AS m FROM events').get() as { m: number | null }).m ?? 0); }
  pruneEvents(olderThanTs: number): number {
    return Number(this.db.prepare('DELETE FROM events WHERE ts < ?').run(olderThanTs).changes);
  }
  saveSnapshot(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO snapshots(key,ts,json) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET ts=excluded.ts,json=excluded.json')
      .run(key, Date.now(), JSON.stringify(value));
  }
  loadSnapshot<T>(key: string): T | null {
    const r = this.db.prepare('SELECT json FROM snapshots WHERE key=?').get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : null;
  }
  getKv<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT json FROM kv WHERE key=?').get(key) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as T) : undefined;
  }
  setKv(key: string, value: unknown): void {
    if (value === undefined) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); return; }
    this.db.prepare('INSERT INTO kv(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, JSON.stringify(value));
  }
  close(): void { this.db.close(); }
}
