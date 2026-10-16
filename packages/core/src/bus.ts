// Every event is redacted before it is stored or delivered (PLAN §9).
import { redact, type HubEvent, type StoredEvent } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';

export class Bus {
  readonly store: Store;
  private subs = new Set<(e: StoredEvent) => void>();
  constructor(store: Store) { this.store = store; }
  emit(e: HubEvent): void {
    const clean = redact(e);
    const id = this.store.appendEvent(clean);
    for (const fn of this.subs) { try { fn({ ...clean, id }); } catch { /* one bad subscriber must not break the bus */ } }
  }
  subscribe(fn: (e: StoredEvent) => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
}
