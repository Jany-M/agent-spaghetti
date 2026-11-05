// Every event is redacted before it is delivered (PLAN §9). An event emitted with `{ ephemeral: true }`
// is fanned out to subscribers (the SSE stream, the tray) but never appended to SQLite, so its `text`
// payload is never persisted (ADR 0007); the latest ones stay in memory only, for a live pane opened later. Ephemeral events carry
// a negative id (unique across restarts: it starts from the clock) so live-state reductions and store reads skip them.
import { redact, type HubEvent, type StoredEvent, type TraceData } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';

const TRACE_MAX = 8000, RECENT = 300;

export class Bus {
  readonly store: Store;
  private subs = new Set<(e: StoredEvent) => void>();
  private nextEphemeralId = -Date.now();                   // ephemeral events are never stored: negative ids
  private recent: StoredEvent[] = [];
  constructor(store: Store) { this.store = store; }
  /** `opts.ephemeral`: delivered live to subscribers, redacted, never written to the events table. */
  emit(e: HubEvent, opts?: { ephemeral?: boolean }): void {
    const clean = redact(e);
    const id = opts?.ephemeral ? this.nextEphemeralId-- : this.store.appendEvent(clean), out = { ...clean, id } as StoredEvent;
    if (opts?.ephemeral) this.recent = [...this.recent, out].slice(-RECENT);
    for (const fn of this.subs) { try { fn(out); } catch { /* one bad subscriber must not break the bus */ } }
  }
  /** The latest ephemeral events (memory only, gone with the daemon). */
  recentTraces(): StoredEvent[] { return this.recent; }
  /** One step of a run for the live window (routing prompt and answer, the task as sent, output, delivery); long text is cut. */
  trace(source: string, data: TraceData): void {
    this.emit({ ts: Date.now(), type: 'trace.detail', envId: 'hub', source,
      data: { ...data, text: data.text.length > TRACE_MAX ? `${data.text.slice(0, TRACE_MAX)}\n… (${data.text.length - TRACE_MAX} more characters)` : data.text } }, { ephemeral: true });
  }
  subscribe(fn: (e: StoredEvent) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
}
