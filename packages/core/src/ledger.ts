// The run record (ADR 0007): who handed what to whom, why, with what result. The task text is stored as a hash only;
// results live in files referenced by path + sha256.
import type { Grant, RunRow } from '@agent-spaghetti/sdk';
import { wildcard } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';

const COLS: Array<[Exclude<keyof RunRow, 'id'>, string]> = [['ts', 'ts'], ['source', 'source'], ['target', 'target'], ['model', 'model'], ['parentRunId', 'parent_run_id'],
  ['jobId', 'job_id'], ['kind', 'kind'], ['reason', 'reason'], ['taskHash', 'task_hash'], ['durationMs', 'duration_ms'], ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'], ['costUsd', 'cost_usd'], ['outcome', 'outcome'], ['error', 'error'], ['resultPath', 'result_path'],
  ['resultSha256', 'result_sha256'], ['verdict', 'verdict']];
const toRow = (r: Record<string, unknown>): RunRow => Object.fromEntries([['id', r.id], ...COLS.filter(([, c]) => r[c] !== null && r[c] !== undefined).map(([k, c]) => [k, r[c]])]) as unknown as RunRow;
const SELECT = 'SELECT * FROM runs';

export class Ledger {
  private store: Store;
  constructor(store: Store) { this.store = store; }
  /** A new row; returns its id. */
  record(row: Omit<RunRow, 'id'>): number {
    const cols = COLS.filter(([k]) => row[k] !== undefined);
    return Number(this.store.db.prepare(`INSERT INTO runs(${cols.map(c => c[1]).join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
      .run(...cols.map(([k]) => row[k] as string | number)).lastInsertRowid);
  }
  update(id: number, patch: Partial<Omit<RunRow, 'id'>>): void {
    const cols = COLS.filter(([k]) => patch[k] !== undefined);
    if (cols.length) this.store.db.prepare(`UPDATE runs SET ${cols.map(c => `${c[1]}=?`).join(',')} WHERE id=?`).run(...cols.map(([k]) => patch[k] as string | number), id);
  }
  get(id: number): RunRow | null { const r = this.store.db.prepare(`${SELECT} WHERE id=?`).get(id); return r ? toRow(r as Record<string, unknown>) : null; }
  list(o: { since?: number; limit?: number; target?: string } = {}): RunRow[] {
    return (this.store.db.prepare(`${SELECT} WHERE id > ? AND (? IS NULL OR target = ?) ORDER BY id DESC LIMIT ?`)
      .all(o.since ?? 0, o.target ?? null, o.target ?? null, o.limit ?? 50) as Array<Record<string, unknown>>).map(toRow);
  }
  /** The hand-off chain through `id`: every ancestor, the run, and every descendant, oldest first. */
  chain(id: number): RunRow[] {
    const up: RunRow[] = [];
    for (let r = this.get(id); r; r = r.parentRunId ? this.get(r.parentRunId) : null) up.unshift(r);
    const down: RunRow[] = [];
    for (let level = [id]; level.length;) {
      const kids = (this.store.db.prepare(`${SELECT} WHERE parent_run_id IN (${level.map(() => '?').join(',')}) ORDER BY id`).all(...level) as Array<Record<string, unknown>>).map(toRow);
      down.push(...kids); level = kids.map(k => k.id);
    }
    return [...up, ...down];
  }
  /** Money spent under a grant since it was given (budgets). */
  spentUsd(g: Grant): number {
    return (this.store.db.prepare(`${SELECT} WHERE source = ? AND ts >= ? AND cost_usd IS NOT NULL`).all(g.subject, g.ts) as Array<Record<string, unknown>>)
      .map(toRow).filter(r => wildcard(g.resource, r.target) && (g.jobId === undefined || r.jobId === g.jobId)).reduce((n, r) => n + (r.costUsd ?? 0), 0);
  }
}
