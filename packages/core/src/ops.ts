// Handlers for the operations declared once in sdk/ops.ts.
import type { OpId, OpIO, Snapshot } from '@agent-spaghetti/sdk';
import { OPS, levelsOf } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';
import type { Bus } from './bus.ts';
import type { Loaded } from './registry.ts';
import type { Route } from './serve.ts';
import { ENGINES } from './engine/inspect.ts';

export interface Services { store: Store; bus: Bus; loaded: () => Loaded; scan(): Promise<Snapshot> }
type Handlers = { [K in OpId]: (input: OpIO[K]['in'], s: Services) => Promise<OpIO[K]['out']> | OpIO[K]['out'] };
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);

export const handlers: Handlers = {
  status: (_i, s) => ({ snapshot: s.store.loadSnapshot<Snapshot>('scan') }),
  scan: async (_i, s) => { const snapshot = await s.scan(); s.store.saveSnapshot('scan', snapshot); return { snapshot }; },
  events: (i, s) => s.store.eventsSince(num(i.since, 0), num(i.limit, 500)),
  integrations: (_i, s) => {
    const l = s.loaded();
    return { loaded: l.integrations.map(i => ({ id: i.manifest.id, name: i.manifest.name, source: i.source, levels: levelsOf(i, ENGINES) })), rejected: l.rejected };
  },
};
export const routesFor = (s: Services): Route[] => (Object.keys(OPS) as OpId[]).map(id => ({
  method: OPS[id].method, path: OPS[id].path, handle: (input: Record<string, unknown>) => (handlers[id] as (i: unknown, s: Services) => unknown)(input, s) }));
