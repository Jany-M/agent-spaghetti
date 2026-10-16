// Live observation of ONE environment (runs in the daemon for the host and inside distros via the env bundle).
// Generic backend observer for every manifest with `models` (no code per backend) + each module's own observe().
import type { Disposable, Environment, Grant, HubEvent, Integration, Inventory } from '@agent-spaghetti/sdk';
import { inspect } from './inspect.ts';
import { asSubject } from '../permissions.ts';

export type Emit = (e: Pick<HubEvent, 'type' | 'data' | 'source'>) => void;
export interface ObserveOpts { backendPollMs: number; sessionPollMs: number; grants?: Grant[]; inventoryRefreshMs?: number }
const EMPTY: Inventory = { installed: [], processes: [], listening: [], env: {}, partial: [] };

/** Inspect with the same guard rules as the scan (third parties never run unguarded). */
export function inspectAs(i: Integration, env: Environment, inventory: Inventory, grants: Grant[] = []) {
  const v = asSubject(i, env, { signal: AbortSignal.timeout(20000), inventory }, grants);
  return inspect(i, v.env, v.ctx);
}

export function observeEnv(env: Environment, integrations: Integration[], emit: Emit, o: ObserveOpts): Disposable {
  let inventory = EMPTY, stopped = false;
  const names = [...new Set(integrations.flatMap(i => i.manifest.detect?.env ?? []))];
  const refresh = async () => { inventory = await env.inventory(names).catch(() => EMPTY); };
  const timers: NodeJS.Timeout[] = [], disposers: Disposable[] = [];
  const last = new Map<string, string>();
  const backends = integrations.filter(i => i.manifest.models);
  const pollBackends = async () => {
    for (const i of backends) {
      const r = await inspectAs(i, env, inventory, o.grants).catch(() => null);
      const state = r?.detection.endpoint ? { up: true, endpoint: r.detection.endpoint, models: r.backends.map(b => ({ model: b.model, contextLength: b.contextLength ?? null })) } : { up: false };
      const sig = JSON.stringify(state);
      if (last.get(i.manifest.id) !== sig && (last.has(i.manifest.id) || state.up)) emit({ type: 'backend.changed', source: i.manifest.id, data: { integration: i.manifest.id, ...state } });
      last.set(i.manifest.id, sig);
    }
  };
  void (async () => {
    await refresh(); if (stopped) return;
    await pollBackends(); if (stopped) return;
    timers.push(setInterval(refresh, o.inventoryRefreshMs ?? 60000), setInterval(pollBackends, o.backendPollMs));
    for (const i of integrations.filter(i => i.module?.observe)) {
      const r = await inspectAs(i, env, inventory, o.grants).catch(() => null);
      if (r && !stopped) disposers.push(i.module!.observe!(env, r.detection, e => emit({ type: e.type, data: e.data, source: i.manifest.id }),
        { signal: new AbortController().signal, inventory, pollMs: o.sessionPollMs }));
    }
  })();
  return { dispose() { stopped = true; timers.forEach(clearInterval); disposers.forEach(d => d.dispose()); } };
}
