// Live observation of ONE environment (runs in the daemon for the host and inside distros via the env bundle).
// Generic: tools running (process or server) and backend models, for every manifest (no code per tool) + each module's own observe().
import type { Disposable, Environment, Grant, HubEvent, Integration, Inventory } from '@agent-spaghetti/sdk';
import { inspect, probeLive } from './inspect.ts';
import { asSubject } from '../permissions.ts';

export type Emit = (e: Pick<HubEvent, 'type' | 'data' | 'source'>) => void;
export interface ObserveOpts { toolPollMs: number; sessionPollMs: number; grants?: Grant[]; inventoryRefreshMs?: number }
const EMPTY: Inventory = { installed: [], processes: [], listening: [], env: {}, partial: [] };

/** Inspect with the same guard rules as the scan (third parties never run unguarded). */
export function inspectAs(i: Integration, env: Environment, inventory: Inventory, grants: Grant[] = []) {
  const v = asSubject(i, env, { signal: AbortSignal.timeout(20000), inventory }, grants);
  return inspect(i, v.env, v.ctx);
}

/** Every poll: which tools run (process or server) and which models each server has. The first poll reports only what runs
 *  (the scan just cleared the live state); later polls report every change, marked `changed` (the daemon rescans on those). */
export function observeEnv(env: Environment, integrations: Integration[], emit: Emit, o: ObserveOpts): Disposable {
  let inventory = EMPTY, stopped = false, first = true;
  const names = [...new Set(integrations.flatMap(i => i.manifest.detect?.env ?? []))];
  const refresh = async () => { inventory = await env.inventory(names).catch(() => EMPTY); };
  const timers: NodeJS.Timeout[] = [], disposers: Disposable[] = [];
  const last = new Map<string, string>();
  const report = (type: 'tool.changed' | 'backend.changed', i: Integration, state: Record<string, unknown>, on: boolean) => {
    const key = `${type}|${i.manifest.id}`, sig = JSON.stringify(state);
    if (last.get(key) !== sig && (!first || on)) emit({ type, source: i.manifest.id, data: { integration: i.manifest.id, ...state, ...(first ? {} : { changed: true }) } });
    last.set(key, sig);
  };
  let busy = false;
  const poll = async () => {
    if (busy) return; busy = true;
    try {
      for (const i of integrations) {
        const v = asSubject(i, env, { signal: AbortSignal.timeout(20000), inventory }, o.grants);
        const r = await probeLive(v.env, i.manifest, v.ctx.inventory).catch(() => null);
        if (!r || stopped) continue;
        report('tool.changed', i, { running: r.running, ...(r.endpoint ? { endpoint: r.endpoint } : {}) }, r.running);
        if (i.manifest.models) {
          const up = r.endpoint ? { up: true, endpoint: r.endpoint, models: r.backends.map(b => ({ model: b.model, contextLength: b.contextLength ?? null })) } : { up: false };
          report('backend.changed', i, up, up.up);
        }
      }
      first = false;
    } finally { busy = false; }
  };
  void (async () => {
    await refresh(); if (stopped) return;
    await poll(); if (stopped) return;
    timers.push(setInterval(refresh, o.inventoryRefreshMs ?? 30000), setInterval(poll, o.toolPollMs));
    for (const i of integrations.filter(i => i.module?.observe)) {
      const r = await inspectAs(i, env, inventory, o.grants).catch(() => null);
      if (r && !stopped) disposers.push(i.module!.observe!(env, r.detection, e => emit({ type: e.type, data: e.data, source: i.manifest.id }),
        { signal: new AbortController().signal, inventory, pollMs: o.sessionPollMs }));
    }
  })();
  return { dispose() { stopped = true; timers.forEach(clearInterval); disposers.forEach(d => d.dispose()); } };
}
