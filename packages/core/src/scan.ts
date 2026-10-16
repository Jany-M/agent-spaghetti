// scanEnv runs the engine over one environment; it is the same code on the host and inside a WSL distro (env bundle).
// runScan merges all environments into one Snapshot and emits events.
import type { BackendInfo, Environment, EnvStatus, Grant, Inspection, Integration, Snapshot } from '@agent-spaghetti/sdk';
import { mapLimit, withDeadline } from './async.ts';
import { inspect } from './engine/inspect.ts';
import type { Bus } from './bus.ts';
import type { EnvEntry } from './env/discover.ts';
import type { Bundle, Spawn } from './env/wsl.ts';
import { onEnv } from './dispatch.ts';
import { asSubject, type Pending } from './permissions.ts';

export interface EnvScan { status: EnvStatus; inspections: Inspection[]; errors: Array<{ integration: string; message: string }>; pending: Pending[] }
export interface ScanOpts { perEnvLimit?: number; deadlineMs?: number; grants?: Grant[] }

export async function scanEnv(env: Environment, integrations: Integration[], o: ScanOpts = {}): Promise<EnvScan> {
  const names = [...new Set(integrations.flatMap(i => i.manifest.detect?.env ?? []))];
  const inventory = await env.inventory(names).catch((e: Error) =>
    ({ installed: [], processes: [], listening: [], env: {}, partial: [`inventory failed: ${e.message}`] }));
  const pending: Pending[] = [];
  const results = await mapLimit(integrations, o.perEnvLimit ?? 4, i => withDeadline(signal => {
    const v = asSubject(i, env, { signal, inventory }, o.grants, pending);   // third parties run guarded (ADR 0005)
    return inspect(i, v.env, v.ctx);
  }, o.deadlineMs ?? 20000));
  const inspections: Inspection[] = [], errors: EnvScan['errors'] = [];
  results.forEach((r, n) => r.status === 'fulfilled' ? r.value && inspections.push(r.value)
    : errors.push({ integration: integrations[n].manifest.id, message: (r.reason as Error)?.message ?? String(r.reason) }));
  const allFailed = integrations.length > 0 && errors.length === integrations.length;
  return { status: { id: env.id, state: allFailed ? 'error' : 'running', partial: inventory.partial.length ? inventory.partial : undefined }, inspections, errors, pending };
}


export interface RunScanOpts extends ScanOpts {
  now?: () => number; rejected?: Snapshot['rejected']; bundle?: Bundle | null; spawn?: Spawn; extraHosts?: string[];
}
export async function runScan(entries: EnvEntry[], integrations: Integration[], bus: Bus, o: RunScanOpts = {}): Promise<Snapshot> {
  const now = o.now ?? Date.now;
  const scans = await Promise.all(entries.map(async (e): Promise<EnvScan> => {
    if (e.env) return scanEnv(e.env, integrations, o);
    if (!e.distro) return { status: e.status, inspections: [], errors: [], pending: [] };
    try { const s = await onEnv(e, { ...o, integrations }, 'inspect'); return { ...s, pending: s.pending ?? [] }; }
    catch (err) { return { status: { ...e.status, partial: [(err as Error).message.replace(`${e.distro}: `, '')] }, inspections: [], errors: [], pending: [] }; }
  }));
  const snap: Snapshot = { ts: now(), envs: [], detections: [], agents: [], backends: [], rejected: o.rejected ?? [], pending: [] };
  const merged = new Map<string, BackendInfo>();
  for (const s of scans) {
    snap.envs.push(s.status);
    if (s.status.state !== 'running' || s.status.partial) bus.emit({ ts: now(), type: 'env.status', envId: s.status.id, source: 'scan', data: { ...s.status } });
    for (const p of s.pending) if (!snap.pending!.some(x => x.subject === p.subject && x.action === p.action && x.resource === p.resource)) snap.pending!.push(p);
    for (const err of s.errors) bus.emit({ ts: now(), type: 'scan.integration_error', envId: s.status.id, source: err.integration, data: { message: err.message } });
    for (const i of s.inspections) {
      snap.detections.push(i.detection); snap.agents.push(...i.agents);
      for (const b of i.backends) {                      // the same server seen from several envs is one backend
        const key = `${b.integration}|${b.model}|${new URL(b.endpoint).port}`;
        const prev = merged.get(key);
        if (prev) prev.reachableFrom = [...new Set([...prev.reachableFrom, ...b.reachableFrom])]; else merged.set(key, { ...b });
      }
    }
  }
  snap.backends = [...merged.values()];
  for (const b of snap.backends) bus.emit({ ts: now(), type: 'backend.detected', envId: b.envId, source: b.integration, data: { id: b.id, model: b.model, contextLength: b.contextLength ?? null, reachableFrom: b.reachableFrom } });
  for (const a of snap.agents) bus.emit({ ts: now(), type: 'agent.detected', envId: a.envId, source: a.integration, data: { id: a.id, name: a.name, provider: a.provider ?? null, model: a.model ?? null } });
  for (const p of snap.pending!) bus.emit({ ts: now(), type: 'permission.pending', envId: 'hub', source: p.subject, data: { ...p } });
  bus.emit({ ts: now(), type: 'scan.completed', envId: 'hub', source: 'scan', data: { detections: snap.detections.length, agents: snap.agents.length, backends: snap.backends.length } });
  return snap;
}
