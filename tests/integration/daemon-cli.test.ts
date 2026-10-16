// Daemon + typed client + CLI, in-process, against a fake scan (no machine access).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubClient, DaemonDown, type Snapshot } from '@agent-spaghetti/sdk';
import { Store } from '../../packages/core/src/store.ts';
import { Bus } from '../../packages/core/src/bus.ts';
import { startDaemon } from '../../packages/core/src/daemon.ts';
import { loadOrCreateToken, writeDiscovery } from '../../packages/core/src/config.ts';
import type { Services } from '../../packages/core/src/ops.ts';
import { run } from '../../packages/cli/src/index.ts';

const SNAP: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }], agents: [], rejected: [{ id: 'junk', why: 'not valid JSON' }],
  detections: [{ integration: 'lmstudio', name: 'LM Studio', envId: 'windows', installs: [], levels: ['detect', 'observe'], cost: 'free', connectable: 'yes', why: '1 model(s) loaded' }],
  backends: [{ id: 'lmstudio:m', integration: 'lmstudio', model: 'm', envId: 'windows', endpoint: 'http://127.0.0.1:1234', contextLength: 200192, reachableFrom: ['windows'] }] };

async function boot(scan: () => Promise<Snapshot> = async () => SNAP) {
  const store = new Store(':memory:'); const bus = new Bus(store);
  const services: Services = { store, bus, loaded: () => ({ integrations: [], rejected: [] }), scan };
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  const token = loadOrCreateToken(dir);
  const d = await startDaemon({ services, token, port: 0 });
  const removeDiscovery = writeDiscovery(dir, d.port);
  const env = { AGENT_SPAGHETTI_DATA_DIR: dir } as NodeJS.ProcessEnv;
  return { d, bus, dir, env, token, client: HubClient.fromDiscovery(env), close: async () => { removeDiscovery(); await d.close(); } };
}
const io = () => { const o: string[] = [], e: string[] = []; return { o, e, io: { out: (s: string) => o.push(s), err: (s: string) => e.push(s) } }; };

test('401 without or with a wrong token; 404 for unknown routes', async () => {
  const b = await boot();
  const base = `http://127.0.0.1:${b.d.port}`;
  assert.equal((await fetch(`${base}/v1/status`)).status, 401);
  assert.equal((await fetch(`${base}/v1/status`, { headers: { authorization: 'Bearer nope' } })).status, 401);
  assert.equal((await fetch(`${base}/v1/nope`, { headers: { authorization: `Bearer ${b.token}` } })).status, 404);
  await b.close();
});
test('status is null before a scan; scan saves the snapshot; errors are redacted', async () => {
  const b = await boot();
  assert.equal((await b.client.call('status')).snapshot, null);
  await b.client.call('scan');
  assert.equal((await b.client.call('status')).snapshot!.ts, 1);
  await b.close();
  const bad = await boot(async () => { throw new Error('failed at https://u:secretpw@h/x'); });
  await assert.rejects(bad.client.call('scan'), (e: Error) => e.message === '[redacted]');
  await bad.close();
});
test('events since an id, and the SSE stream delivers new events through the client', async () => {
  const b = await boot();
  b.bus.emit({ ts: 1, type: 'scan.completed', envId: 'hub', source: 't', data: {} });
  assert.equal((await b.client.call('events', { since: 0 })).length, 1);
  const ac = new AbortController();
  setTimeout(() => b.bus.emit({ ts: 2, type: 'env.status', envId: 'windows', source: 'live', data: {} }), 50);
  for await (const e of b.client.stream(ac.signal)) { assert.equal(e.source, 'live'); ac.abort(); break; }
  await b.close();
});
test('token file is created once, reused, user-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  const a = loadOrCreateToken(dir); assert.equal(a, loadOrCreateToken(dir)); assert.equal(a.length, 64);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'token')).mode & 0o077, 0);
});
test('client: no discovery file or a stale one → DaemonDown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  assert.throws(() => HubClient.fromDiscovery({ AGENT_SPAGHETTI_DATA_DIR: dir }), DaemonDown);
  writeFileSync(join(dir, 'daemon.json'), '{"port":1}'); writeFileSync(join(dir, 'token'), 'x');
  await assert.rejects(HubClient.fromDiscovery({ AGENT_SPAGHETTI_DATA_DIR: dir }).call('status'), DaemonDown);
});
test('CLI: status before scan, scan prints tree + table + rejected, --json parses, daemon down → 2, unknown → 1', async () => {
  const b = await boot();
  let t = io(); assert.equal(await run(['status'], t.io, b.env), 0); assert.match(t.o.join('\n'), /No scan yet\. Run: agent-spaghetti scan/);
  t = io(); assert.equal(await run(['scan'], t.io, b.env), 0);
  const out = t.o.join('\n');
  assert.match(out, /LM Studio · m · ctx 200k \(no agent attached\)/);
  assert.match(out, /LM Studio\s+windows\s+-\s+detect,observe\s+yes\s+1 model\(s\) loaded/);
  assert.match(out, /rejected junk: not valid JSON/);
  t = io(); assert.equal(await run(['status', '--json'], t.io, b.env), 0); assert.equal(JSON.parse(t.o[0]).snapshot.ts, 1);
  await b.close();
  t = io(); assert.equal(await run(['status'], t.io, { AGENT_SPAGHETTI_DATA_DIR: b.dir }), 2); assert.match(t.e[0], /daemon is not running/);
  t = io(); assert.equal(await run(['wat'], t.io, b.env), 1); assert.match(t.e[0], /Usage: agent-spaghetti/);
});
