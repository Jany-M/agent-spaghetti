// Handlers for the operations declared once in sdk/ops.ts. Per-environment work goes through Services.onEnvs (core/dispatch).
import type { EnvResult, Grant, LiveState, OpId, OpIO, RunView, SettingsOut, Snapshot, Target } from '@agent-spaghetti/sdk';
import { OPS, declaredActions, rankTargets, levelsOf, renderConfigReport, toolRows, withGrants, withoutGrants } from '@agent-spaghetti/sdk';
import type { Store } from './store.ts';
import type { Bus } from './bus.ts';
import type { Loaded } from './registry.ts';
import type { Route } from './serve.ts';
import type { Settings } from './settings.ts';
import type { Consent } from './consent.ts';
import type { EnvCommand, EnvResults } from './actions.ts';
import type { Ledger } from './ledger.ts';
import type { Runner } from './runner.ts';
import { ENGINES } from './engine/inspect.ts';

export interface Services {
  store: Store; bus: Bus; settings: Settings; consent: Consent; ledger: Ledger; runner: Runner;
  shutdown(): void;
  host(): import('@agent-spaghetti/sdk').Environment | null;
  /** How to run agent-spaghetti in an environment (clients start its MCP bridge with it). */
  cli(envId: string): import('@agent-spaghetti/sdk').Cli | null;
  /** scan(): one full scan at a time (shared by concurrent callers); saves the snapshot. */
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
  scan: async (_i, s) => ({ snapshot: await s.scan() }),
  events: (i, s) => s.store.eventsSince(num(i.since, 0), num(i.limit, 500)),
  integrations: (_i, s) => {
    const l = s.loaded(), off = s.settings.get('disabled');
    return { rows: toolRows({ snapshot: snapshot(s), live: s.live(), targets: handlers.targets({}, s) as Target[], consents: s.consent.pending(),
      prefs: { auto: s.settings.get('connect.auto'), never: s.settings.get('connect.never') },
      loaded: l.integrations.map(i => ({ id: i.manifest.id, name: i.manifest.name, source: i.source, roles: i.manifest.roles, levels: levelsOf(i, ENGINES), disabled: off.includes(i.manifest.id), setup: !!i.module?.setup })) }),
      rejected: l.rejected };
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
  settings: (_i, s) => settingsView(s),
  setting: (i, s) => { s.settings.setText(need(i.key, 'key'), String(i.value ?? '')); return settingsView(s); },
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
  delegate: async (i, s) => {
    const { source, waitMs, ...req } = i;
    need(req.target, 'target'); need(req.task, 'task');
    const { id, done } = await s.runner.begin(source || 'cli', { ...req, parentRunId: req.parentRunId ? Number(req.parentRunId) : undefined, chainId: undefined });
    s.runner.watch(id);                                       // the caller waits or polls next: a quick result is returned to it
    if (Number(waitMs) > 0) { await Promise.race([done, new Promise(r => setTimeout(r, Number(waitMs)))]); s.runner.watch(id); }
    return chainView(s, id);
  },
  targets: (_i, s) => s.runner.targets(),
  runs: (i, s) => {
    if (i.unread) {                                           // results waiting for their caller: given once, then read
      const rows = s.ledger.unread(need(i.source, 'source'));
      for (const r of rows) s.ledger.update(r.id, { delivered: 'read' });
      return { runs: [], unread: rows.map(r => chainView(s, r.id)) };
    }
    if (i.id === undefined || i.id === null || String(i.id) === '') return { runs: s.ledger.list({ since: num(i.since, 0), limit: num(i.limit, 50) }) };
    const run = s.ledger.get(num(i.id, 0));
    if (!run) throw new Error(`no run ${i.id}`);
    const caller = i.watch && i.source === s.ledger.get(run.chainId)?.source;   // the chain's caller is polling: it gets the result inline
    if (caller) s.runner.watch(run.chainId);
    const final = chainView(s, run.chainId);
    if (caller && final.run.outcome !== 'running' && final.run.delivered === 'unread') s.ledger.update(run.chainId, { delivered: 'read' });   // collected by id
    return { runs: s.ledger.chain(run.id), result: s.ledger.result(run), final };
  },
  handback: (i, s) => { s.runner.report(num(i.run_id, 0), need(i.source, 'source'), String(i.result ?? ''), i.status === 'failed'); return { ok: true }; },
  cancel: (i, s) => ({ cancelled: s.runner.cancel(num(i.id, 0)) }),
  verdict: (i, s) => {
    if (!['up', 'down', 'redo'].includes(i.value)) throw new Error('verdict must be up, down or redo');
    if (!s.ledger.get(num(i.id, 0))) throw new Error(`no run ${i.id}`);
    s.ledger.update(num(i.id, 0), { verdict: i.value }); return { ok: true };
  },
  connect: async (i, s) => {   // where the last scan found it as a client (else every env it was found in), until one works
    const id = need(i.integration, 'integration'), on = i.on !== false;
    const found = snapshot(s)?.detections.filter(d => d.integration === id && (!i.envId || d.envId === i.envId)) ?? [];
    const envIds = [...new Set([...found.filter(d => d.connected !== undefined), ...found].map(d => d.envId))];
    if (!envIds.length) throw new Error(`${id} was not found by the last scan`);
    const errors: string[] = [];
    for (const envId of envIds) {
      const cli = s.cli(envId);
      const [r] = cli ? await s.onEnvs('connect', [id, JSON.stringify(cli), on ? 'on' : 'off', i.dryRun ? 'dry-run' : ''], [envId]) : [{ envId, error: 'agent-spaghetti cannot run there (see: status)' }];
      if (r?.result) {
        if (r.result.applied) {   // the panel updates at once: patch the saved scan, tell everyone
          const snap = snapshot(s);
          if (snap) s.store.saveSnapshot('scan', { ...snap, detections: snap.detections.map(d => d.integration === id && d.envId === envId ? { ...d, connected: on } : d) });
          s.bus.emit({ ts: Date.now(), type: 'client.connected', envId, source: id, data: { integration: id, on } });
        }
        return r.result;
      }
      errors.push(`${envId}: ${r?.error ?? 'not running'}`);
    }
    throw new Error(errors.join('; '));
  },
  setup: async (i, s) => {   // where the tool's own program was found (not, say, a companion app without it)
    const id = need(i.integration, 'integration');
    if (!s.loaded().integrations.find(x => x.manifest.id === id)?.module?.setup) throw new Error(`${id} has nothing to set up`);
    const envIds = [...new Set(snapshot(s)?.detections.filter(d => d.integration === id && (!i.envId || d.envId === i.envId)
      && d.installs.some(x => x.via === 'bin' || x.via === 'path')).map(d => d.envId))];
    if (!envIds.length) throw new Error(`${id} was not found by the last scan`);
    return Promise.all(envIds.map(async envId => {
      const cli = s.cli(envId);
      if (!cli) return { envId, error: 'agent-spaghetti cannot run there (see: status)' };
      const [r] = await s.onEnvs('setup', [id, JSON.stringify(cli), i.check ? 'check' : 'apply', i.dryRun ? 'dry-run' : '', JSON.stringify(s.settings.optionsOf(id))], [envId]);
      return r ?? { envId, error: 'not running' };
    }));
  },
  hook: (i, s) => {   // metadata only: the hook command already dropped prompts, responses and file contents
    const d = i.data ?? {};
    const keep = Object.fromEntries(['conversation_id', 'session_id', 'generation_id', 'tool_name', 'mcp_server_name', 'status', 'model'].filter(k => typeof d[k] === 'string').map(k => [k, d[k]]));
    s.bus.emit({ ts: Date.now(), type: 'client.hook', envId: s.host()?.id ?? 'hub', source: need(i.client, 'client'), data: { event: need(i.event, 'event'), ...keep } });
    return { ok: true };
  },
};
/** Settings plus the choices the GUI offers: the dispatcher thinks with a loaded model (free first). */
function settingsView(s: Services): SettingsOut {
  const all: SettingsOut = s.settings.all();
  all['dispatcher.model'].choices = rankTargets(s.runner.targets().filter(t => t.kind === 'model')).flatMap(t => t.models.map(m => `${t.id}:${m}`));
  return all;
}
/** A hand-off chain as its caller sees it: the last hop's record and result, still `running` until the chain has ended. */
function chainView(s: Services, chainId: number): RunView {
  const hops = s.ledger.hops(chainId), first = hops[0];
  if (!first) throw new Error(`no run ${chainId}`);
  const last = hops[hops.length - 1];
  const run = { ...last, delivered: first.delivered, ...(s.runner.wait(chainId) ? { outcome: 'running' as const } : {}) };
  return { id: chainId, run, result: run.outcome === 'running' ? undefined : s.ledger.result(last) };
}
export const routesFor = (s: Services): Route[] => (Object.keys(OPS) as OpId[]).map(id => ({
  method: OPS[id].method, path: OPS[id].path, handle: (input: Record<string, unknown>) => (handlers[id] as (i: unknown, s: Services) => unknown)(input, s) }));
