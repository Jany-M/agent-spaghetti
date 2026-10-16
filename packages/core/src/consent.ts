// The one consent queue (ADR 0005): every `ask` becomes a request the user answers in the tray or the CLI.
// In memory on purpose: a run request dies with its caller, and permission asks are raised again from the last scan.
import { randomUUID } from 'node:crypto';
import type { ConsentAnswer, ConsentRequest, ConsentScope } from '@agent-spaghetti/sdk';
import type { Bus } from './bus.ts';

type Open = { req: ConsentRequest; resolve(a: ConsentAnswer): void; timer?: NodeJS.Timeout };
export type ConsentInput = Omit<ConsentRequest, 'id' | 'ts' | 'expiresAt'> & { timeoutMs?: number };
const keyOf = (r: Pick<ConsentRequest, 'subject' | 'action' | 'resource'>) => `${r.subject}\u0000${r.action}\u0000${r.resource}`;

export class Consent {
  private open = new Map<string, Open>();
  private waiting = new Map<string, Promise<ConsentAnswer>>();   // key → answer: the same question is asked once
  private bus: Bus;
  constructor(bus: Bus) { this.bus = bus; }

  /** Resolves when answered or expired. A `run` request (task text) is never deduplicated: each run is its own question. */
  request(r: ConsentInput): Promise<ConsentAnswer> {
    const key = r.task === undefined ? keyOf(r) : randomUUID();
    const existing = this.waiting.get(key);
    if (existing) return existing;
    const { timeoutMs, ...rest } = r;
    const req: ConsentRequest = { ...rest, id: randomUUID(), ts: Date.now(), ...(timeoutMs ? { expiresAt: Date.now() + timeoutMs } : {}) };
    const p = new Promise<ConsentAnswer>(resolve => {
      const o: Open = { req, resolve: a => { clearTimeout(o.timer); this.open.delete(req.id); this.waiting.delete(key); resolve(a); } };
      if (timeoutMs) o.timer = setTimeout(() => { this.emit('consent.expired', req, {}); o.resolve({ answer: 'expired' }); }, timeoutMs);
      this.open.set(req.id, o);
    });
    this.waiting.set(key, p);
    // the task text is shown to the user from memory (consents op) and never goes into the event store
    this.emit('consent.requested', req, { action: req.action, resource: req.resource, why: req.why, cost: req.cost ?? null, expiresAt: req.expiresAt ?? null });
    return p;
  }
  /** false when the id is unknown (already answered or expired) or the scope was not offered. */
  respond(id: string, allow: boolean, scope?: ConsentScope): boolean {
    const o = this.open.get(id);
    if (!o || (allow && !o.req.scopes.includes(scope ?? o.req.scopes[0]))) return false;
    const a: ConsentAnswer = allow ? { answer: 'granted', scope: scope ?? o.req.scopes[0] } : { answer: 'denied' };
    this.emit('consent.answered', o.req, { ...a });
    o.resolve(a);
    return true;
  }
  pending(): ConsentRequest[] { return [...this.open.values()].map(o => o.req); }
  private emit(type: 'consent.requested' | 'consent.answered' | 'consent.expired', req: ConsentRequest, data: Record<string, unknown>) {
    this.bus.emit({ ts: Date.now(), type, envId: 'hub', source: req.subject, data: { id: req.id, ...data } });
  }
}
