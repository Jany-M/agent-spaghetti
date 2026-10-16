import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { renderTree, renderTable, detectionRows, type Integration, type Manifest } from '@agent-spaghetti/sdk';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';
import { runScan, scanEnv } from '../../../packages/core/src/scan.ts';
import type { Spawn } from '../../../packages/core/src/env/wsl.ts';

const be: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'lmstudio', name: 'LM Studio', roles: ['backend'],
  detect: { http: { port: 1234, path: '/m' } }, models: { list: 'data', id: 'id', context: ['ctx'] } } as Manifest };
const ag: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'openclaw', name: 'OpenClaw', roles: ['agent'], detect: { bin: ['openclaw'] } } as Manifest,
  module: { async inspect(env, base) { return { ...base, agents: [
    { id: 'openclaw:main', integration: 'openclaw', name: 'Main', envId: env.id, provider: 'lmstudio', model: 'g', endpoint: 'http://192.0.2.10:1234' },
    { id: 'openclaw:c', integration: 'openclaw', name: 'cloudy', envId: env.id, provider: 'anthropic', model: 'claude-x' }] }; } } };
const boom: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'boom', name: 'Boom', roles: ['tool'], detect: { bin: ['x'] } } as Manifest,
  module: { async inspect() { throw new Error('kaput'); } } };
const hang: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'hang', name: 'Hang', roles: ['tool'], detect: { bin: ['h'] } } as Manifest,
  module: { inspect: () => new Promise(() => {}) } };
const models = { status: 200, body: '{"data":[{"id":"g","ctx":200192}]}' };

test('scanEnv: one inventory per env, errors and timeouts isolated, partial reported', async () => {
  const env = fakeEnv({ bins: { x: '/x', h: '/h' }, http: { 'http://127.0.0.1:1234/m': models }, inventory: { partial: ['msix'] } });
  const s = await scanEnv(env, [be, boom, hang], { deadlineMs: 100 });
  assert.equal(s.inspections.length, 1);
  assert.deepEqual(s.errors.map(e => [e.integration, e.message]), [['boom', 'kaput'], ['hang', 'timeout after 100ms']]);
  assert.deepEqual(s.status, { id: 'windows', state: 'running', partial: ['msix'] });
});
test('runScan: same server from host + distro is one backend; agent links by model+port; stopped env listed; events emitted', async () => {
  const bus = new Bus(new Store(':memory:'));
  const host = fakeEnv({ http: { 'http://127.0.0.1:1234/m': models } });
  const distroScan = await scanEnv(fakeEnv({ id: 'wsl:T', kind: 'wsl', hosts: ['127.0.0.1', '192.0.2.10'], bins: { openclaw: '/o' },
    http: { 'http://192.0.2.10:1234/m': models } }), [be, ag]);
  const calls: string[][] = [];
  const spawn: Spawn = async (_c, a) => {
    calls.push(a);
    const out = a.includes('-c') && String(a[a.indexOf('-c') + 1]).includes('echo "dir=') ? 'dir=/d\nnode=/n\nfresh=1\n' : JSON.stringify(distroScan);
    return { code: 0, stdout: Buffer.from(out), stderr: Buffer.alloc(0) };
  };
  const snap = await runScan([
    { status: { id: 'windows', state: 'running' }, env: host },
    { status: { id: 'wsl:T', state: 'running' }, distro: 'T' },
    { status: { id: 'wsl:Off', state: 'stopped', why: 'not started by scan' } }], [be, ag], bus,
    { now: () => 42, bundle: { text: Buffer.from('x'), sha256: 'h' }, spawn });
  assert.equal(snap.backends.length, 1);
  assert.deepEqual(snap.backends[0].reachableFrom, ['windows', 'wsl:T']);
  assert.ok(calls.every(a => a[1] !== 'Off'));
  const tree = renderTree(snap);
  assert.match(tree, /^OpenClaw · Main → LM Studio · g · ctx 200k$/m);
  assert.match(tree, /^OpenClaw · cloudy → anthropic · claude-x \(not observed\)$/m);
  assert.match(tree, /^! wsl:Off stopped \(not started by scan\)$/m);
  const types = new Set(bus.store.eventsSince(0).map(e => e.type));
  for (const t of ['backend.detected', 'agent.detected', 'scan.completed', 'env.status']) assert.ok(types.has(t as never), t);
});
test('runScan: distro without node or bundle → partial with the reason, scan continues', async () => {
  const bus = new Bus(new Store(':memory:'));
  const snap = await runScan([{ status: { id: 'wsl:T', state: 'running' }, distro: 'T' }], [be], bus, { bundle: null });
  assert.deepEqual(snap.envs[0].partial, ['env bundle not built (run: npm run build)']);
  assert.match(renderTree(snap), /! wsl:T partial: env bundle not built/);
});
test('table formatting pads columns', () => {
  const snap = { ts: 1, envs: [], agents: [], backends: [], rejected: [], detections: [
    { integration: 'lmstudio', name: 'LM Studio', envId: 'windows', installs: [], levels: ['detect', 'observe'], cost: 'free', connectable: 'yes', why: 'ok' }] } as never;
  assert.equal(renderTable(detectionRows(snap)), 'Tool       Env      Version  Levels          Connectable  Why\nLM Studio  windows  -        detect,observe  yes          ok');
});
