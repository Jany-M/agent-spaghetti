// One fixture runner for the repo's tests and (Phase 5) `agent-spaghetti integration check`.
import type { Integration } from '@agent-spaghetti/sdk';
import { fakeEnv, fakeInventory, type FakeSpec } from '@agent-spaghetti/sdk/testing';
import { inspect } from './inspect.ts';

export interface FixtureCase {
  name: string; env: FakeSpec;
  expect: null | { version?: string; endpoint?: string; why?: string; connectable?: string; connected?: boolean; levels?: string[]; installs?: number;
    backends?: Array<[string, number | null]>; agents?: Array<[string, string | null, string | null]>; endpoints?: Array<string | null>; absent?: string[] };
}
export async function runFixture(i: Integration, c: FixtureCase): Promise<string[]> {
  const env = fakeEnv(c.env);
  const r = await inspect(i, env, { signal: new AbortController().signal, inventory: fakeInventory(c.env.inventory) });
  const e = c.expect, diffs: string[] = [];
  const eq = (what: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
  if (e === null) { if (r !== null) diffs.push(`expected nothing to be found, got ${r.detection.why}`); return diffs; }
  if (!r) return ['expected a detection, found nothing'];
  const d = r.detection;
  if (e.version !== undefined) eq('version', d.version, e.version);
  if (e.endpoint !== undefined) eq('endpoint', d.endpoint, e.endpoint);
  if (e.connectable !== undefined) eq('connectable', d.connectable, e.connectable);
  if (e.connected !== undefined) eq('connected', d.connected, e.connected);
  if (e.levels) eq('levels', d.levels, e.levels);
  if (e.installs !== undefined) eq('installs', d.installs.length, e.installs);
  if (e.why && !new RegExp(e.why, 'i').test(d.why)) diffs.push(`why: "${d.why}" does not match /${e.why}/`);
  if (e.backends) eq('backends', r.backends.map(b => [b.model, b.contextLength ?? null]), e.backends);
  if (e.agents) eq('agents', r.agents.map(a => [a.name, a.provider ?? null, a.model ?? null]), e.agents);
  if (e.endpoints) eq('agent endpoints', r.agents.map(a => a.endpoint ?? null), e.endpoints);
  for (const s of e.absent ?? []) if (JSON.stringify(r).includes(s)) diffs.push(`output contains "${s}"`);
  return diffs;
}
