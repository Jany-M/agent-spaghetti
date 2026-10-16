// Handlers for the operations declared once in sdk/ops.ts. Per-environment work goes through Services.onEnvs (core/dispatch).
import type { EnvResult, Grant, LiveState, OpId, OpIO, Snapshot } from '@agent-spaghetti/sdk';
import { OPS, declaredActions, levelsOf, renderConfigReport, withGrants, withoutGrants } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';
import type { Bus } from './bus.ts';
import type { Loaded } from './registry.ts';
import type { Route } from './serve.ts';
import type { Settings } from './settings.ts';
import type { Consent } from './consent.ts';
import type { EnvCommand, EnvResults } from './actions.ts';
import { ENGINES } from './engine/inspect.ts';

export interface Services {
  store: Store; bus: Bus; settings: Settings; consent: Consent;
  shutdown(): void;
  loaded(): Loaded; scan(): Promise<Snapshot>; live(): LiveState;
  /** Run a command in the given (default: every running) environment(s); failures are per env. */
  onEnvs<C extends EnvCommand>(cmd: C, args: string[], envIds?: string[]): Promise<Array<EnvResult<EnvResults[C]>>>;
}
type Handlers = { [K in OpId]: (input: OpIO[K]['in'], s: Services) => Promise<OpIO[K]['out']> | OpIO[K]['out'] };
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined ? Number(v) : d);
const snapshot = (s: Services) => s.store.loadSnapshot<Snapshot>('scan');
const need = (v: unknown, what: string) => { if (typeof v !== 'string' || !v) throw new Error(`missing ${what}`); return v; };
function userSubject(s: Services, id: string) {
  const i = s.loaded().integrations.find(i => i.manifest.id === id && i.source === 'user');
  if (!i) throw new Error(`${id} is not a third-party integration (built-ins need no grants)`);
  return i;
}
const toggle = (s: Services, id: string, off: boolean) => {
  need(id, 'integration id');
  const cur = s.settings.get('disabled').filter(x => x !== id);
  s.settings.set('disabled', off ? [...cur, id] : cur);
  return { disabled: s.settings.get('disabled') };
};

export const handlers: Handlers = {
  status: (_i, s) => ({ snapshot: snapshot(s), live: s.live(), consents: s.consent.pending() }),
  scan: async (_i, s) => { const snap = await s.scan(); s.store.saveSnapshot('scan', snap); return { snapshot: snap }; },
  events: (i, s) => s.store.eventsSince(num(i.since, 0), num(i.limit, 500)),
  integrations: (_i, s) => {
    const l = s.loaded(), off = s.settings.get('disabled');
    return { loaded: l.integrations.map(i => ({ id: i.manifest.id, name: i.manifest.name, source: i.source, levels: levelsOf(i, ENGINES), disabled: off.includes(i.manifest.id) })), rejected: l.rejected };
  },
  switches: async (_i, s) => {
    const r = await s.onEnvs('switches', []);
    return { switches: r.flatMap(x => x.result ?? []), errors: r.filter(x => x.error).map(x => ({ envId: x.envId, error: x.error! })) };
  },
  switch: async (i, s) => {
    const id = need(i.id, 'switch id');
    let envId = i.envId;
    if (!envId) {
      const where = (await handlers.switches({}, s) as OpIO['switches']['out']).switches.filter(x => x.id === id).map(x => x.envId);
      if (where.length !== 1) throw new Error(where.length ? `switch ${id} exists in ${where.join(', ')}; pick one with --env` : `unknown switch ${id}`);
      envId = where[0];
    }
    const [r] = await s.onEnvs('switch', [id, i.on ? 'on' : 'off'], [envId]);
    if (!r?.result) throw new Error(r?.error ?? `environment ${envId} is not running`);
    s.bus.emit({ ts: Date.now(), type: 'switch.changed', envId, source: r.result.integration, data: { id, on: r.result.on } });
    return r.result;
  },
  test: async (i, s) => {
    const id = need(i.integration, 'integration id');
    if (!s.loaded().integrations.some(x => x.manifest.id === id)) throw new Error(`unknown integration ${id}`);
    const found = [...new Set(snapshot(s)?.detections.filter(d => d.integration === id).map(d => d.envId) ?? [])];
    return s.onEnvs('test', [id], i.envId ? [i.envId] : found.length ? found : undefined);
  },
  permissions: (_i, s) => ({
    subjects: s.loaded().integrations.filter(i => i.source === 'user').map(i => ({ subject: i.manifest.id, declared: declaredActions(i.manifest) })),
    grants: s.settings.grants(), pending: snapshot(s)?.pending ?? [],
  }),
  grant: (i, s) => {
    const m = userSubject(s, need(i.subject, 'subject')).manifest;
    if (i.mode !== 'allow' && i.mode !== 'deny') throw new Error('mode must be allow or deny');
    if ((i.action === undefined) !== (i.resource === undefined)) throw new Error('give both action and resource, or neither');
    const targets = i.action ? [{ action: i.action, resource: i.resource! }] : declaredActions(m);
    const add: Grant[] = targets.map(t => ({ subject: m.id, action: t.action, resource: t.resource, mode: i.mode, by: 'user', ts: Date.now() }));
    s.settings.setGrants(withGrants(s.settings.grants(), add));
    return { grants: s.settings.grants().filter(g => g.subject === m.id) };
  },
  revoke: (i, s) => {
    const subject = need(i.subject, 'subject');
    s.settings.setGrants(withoutGrants(s.settings.grants(), subject, i.action, i.resource));
    return { grants: s.settings.grants().filter(g => g.subject === subject) };
  },
  settings: (_i, s) => s.settings.all(),
  setting: (i, s) => { s.settings.setText(need(i.key, 'key'), String(i.value ?? '')); return s.settings.all(); },
  disable: (i, s) => toggle(s, i.id, true),
  enable: (i, s) => toggle(s, i.id, false),
  report: (_i, s) => {
    const snap = snapshot(s);
    if (!snap) throw new Error('no scan yet; run: agent-spaghetti scan');
    return { markdown: renderConfigReport(snap, s.live()) };
  },
  consent: (i, s) => {
    if (!s.consent.respond(need(i.id, 'request id'), i.allow === true, i.scope)) throw new Error(`no open question ${i.id} with that scope (already answered or expired?)`);
    return { ok: true };
  },
  shutdown: (_i, s) => { setImmediate(() => s.shutdown()); return { stopping: true }; },   // answer first, then stop
};
export const routesFor = (s: Services): Route[] => (Object.keys(OPS) as OpId[]).map(id => ({
  method: OPS[id].method, path: OPS[id].path, handle: (input: Record<string, unknown>) => (handlers[id] as (i: unknown, s: Services) => unknown)(input, s) }));
