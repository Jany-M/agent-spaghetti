// Every event is redacted before it is delivered (PLAN §9). An event emitted with `{ ephemeral: true }`
// is fanned out to subscribers (the SSE stream, the tray) but never appended to SQLite, so its `text`
// payload is never persisted (ADR 0007). Ephemeral events carry a negative id so live-state reductions
// and store reads skip them as if they never existed.
import { redact, type HubEvent, type StoredEvent, type TraceData } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';

const TRACE_MAX = 8000;

export class Bus {
  readonly store: Store;
  private subs = new Set<(e: StoredEvent) => void>();
  private nextEphemeralId = -1;                            // ephemeral events are never stored: negative ids
  constructor(store: Store) { this.store = store; }
  /** `opts.ephemeral`: delivered live to subscribers, redacted, never written to the events table. */
  emit(e: HubEvent, opts?: { ephemeral?: boolean }): void {
    const clean = redact(e);
    const id = opts?.ephemeral ? this.nextEphemeralId-- : this.store.appendEvent(clean);
    for (const fn of this.subs) { try { fn({ ...clean, id } as StoredEvent); } catch { /* one bad subscriber must not break the bus */ } }
  }
  /** One step of a run for the live window (routing prompt and answer, the task as sent, output, delivery); long text is cut. */
  trace(source: string, data: TraceData): void {
    this.emit({ ts: Date.now(), type: 'trace.detail', envId: 'hub', source,
      data: { ...data, text: data.text.length > TRACE_MAX ? `${data.text.slice(0, TRACE_MAX)}\n… (${data.text.length - TRACE_MAX} more characters)` : data.text } }, { ephemeral: true });
  }
  subscribe(fn: (e: StoredEvent) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
}
