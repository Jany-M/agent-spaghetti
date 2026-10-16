// 1b core: guard, settings, live observation, per-env commands (host and distro), test steps, OpenClaw module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import type { Grant, HubEvent, Integration, Manifest } from '@agent-spaghetti/sdk';
import { asSubject, guardEnvironment, type Pending } from '../../../packages/core/src/permissions.ts';
import { Settings } from '../../../packages/core/src/settings.ts';
import { Store } from '../../../packages/core/src/store.ts';
import { observeEnv } from '../../../packages/core/src/engine/observe.ts';
import { testIntegration } from '../../../packages/core/src/engine/test.ts';
import { runEnvCommand } from '../../../packages/core/src/actions.ts';
import { onEnv } from '../../../packages/core/src/dispatch.ts';
import { decodePayload, type Spawn } from '../../../packages/core/src/env/wsl.ts';
import { diffSessions, toAgents } from '../../../integrations/openclaw/index.ts';

const user = (m: Partial<Manifest>): Integration => ({ source: 'user', manifest: { manifest: 1, id: 'acme', name: 'Acme', roles: ['backend'], ...m } as Manifest });
const allow = (action: Grant['action'], resource: string): Grant => ({ subject: 'acme', action, resource, mode: 'allow', by: 'user', ts: 1 });

test('guard: refused calls become pending once; granted ones pass; a granted glob result may be read', async () => {
  const env = fakeEnv({ bins: { acme: '/b/acme' }, files: { '/opt/*/acme.json': '{}', '/etc/passwd': 'x' }, exec: { 'acme --version': { code: 0, stdout: '1', stderr: '' } },
    http: { 'http://127.0.0.1:9/v': { status: 200, body: '' } } });
  const pending: Pending[] = [];
  const g = guardEnvironment(env, 'acme', [allow('read', '/opt/*/acme.json'), allow('net', 'GET /v')], pending);
  assert.equal(await g.which('acme'), null);
  assert.equal(await g.which('acme'), null);
  assert.equal((await g.exec('/b/acme.exe', ['--version'])).code, 126);
  assert.equal(await g.readFile('/etc/passwd'), null);
  assert.equal(await g.glob('/opt/*/acme.json'), '/opt/*/acme.json');
  assert.equal(await g.readFile('/opt/*/acme.json'), '{}');
  assert.equal((await g.http({ url: 'http://127.0.0.1:9/v' }))?.status, 200);
  assert.deepEqual(pending.map(p => `${p.action} ${p.resource}`), ['read PATH:acme', 'exec acme --version', 'read /etc/passwd']);
  assert.ok(!env.calls.some(c => c.includes('--version')), 'refused exec never reached the env');
});
test('asSubject: built-ins untouched; env values reach a third party only when granted', () => {
  const env = fakeEnv(), ctx = { signal: new AbortController().signal, inventory: { installed: [], processes: [], listening: [], env: { ACME_HOST: 'h', OTHER: 'o' }, partial: [] } };
  const b = asSubject({ ...user({}), source: 'builtin' }, env, ctx);
  assert.equal(b.env, env);
  const pending: Pending[] = [];
  assert.deepEqual(asSubject(user({ detect: { env: ['ACME_HOST'] } }), env, ctx, [], pending).ctx.inventory.env, {});
  assert.deepEqual(pending, [{ subject: 'acme', action: 'read', resource: 'env:ACME_HOST' }]);
  assert.deepEqual(asSubject(user({ detect: { env: ['ACME_HOST'] } }), env, ctx, [allow('read', 'env:ACME_HOST')]).ctx.inventory.env, { ACME_HOST: 'h' });
});
test('settings: defaults, typed set, text parsing, unknown keys and bad values refused, grants persist', () => {
  const s = new Settings(new Store(':memory:'));
  assert.equal(s.get('events.retentionDays'), 14);
  s.setText('llmHosts', ' 192.0.2.1 ,,192.0.2.2'); assert.deepEqual(s.get('llmHosts'), ['192.0.2.1', '192.0.2.2']);
  s.setText('llmHosts', ''); assert.deepEqual(s.get('llmHosts'), []);
  s.setText('observe.backendPollMs', '5000'); assert.equal(s.get('observe.backendPollMs'), 5000);
  assert.throws(() => s.setText('observe.backendPollMs', 'soon'), /invalid value/);
  assert.throws(() => s.setText('nope', '1'), /unknown setting nope/);
  s.setGrants([allow('net', 'GET /v')]); assert.equal(s.grants().length, 1);
  assert.equal(s.all()['events.retentionDays'].value, 14);
});

const lms: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'lmstudio', name: 'LM Studio', roles: ['backend'], cost: 'free',
  detect: { http: { port: 1234, path: '/m' } }, models: { list: 'data', id: 'id' }, speaks: { openai: { port: 1234, base: '/v1' } } } as Manifest };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
test('observeEnv: a running backend is reported at start, then only on change; module observers get the detection', async () => {
  const http: Record<string, { status: number; body: string } | null> = { 'http://127.0.0.1:1234/m': { status: 200, body: '{"data":[{"id":"a"}]}' } };
  const env = fakeEnv({ http });
  const seen: Array<Pick<HubEvent, 'type' | 'data' | 'source'>> = [];
  let observedWith = '';
  const mod: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'oc', name: 'OC', roles: ['agent'], detect: { http: { port: 1234, path: '/m' } } } as Manifest,
    module: { observe(_e, det, emit) { observedWith = det.integration; emit({ type: 'session.updated', data: { key: 'k' } }); return { dispose() {} }; } } };
  const d = observeEnv(env, [lms, mod], e => seen.push(e), { backendPollMs: 20, sessionPollMs: 20 });
  await wait(50);
  assert.equal(seen.filter(e => e.type === 'backend.changed').length, 1);
  assert.deepEqual(seen.find(e => e.type === 'backend.changed')!.data, { integration: 'lmstudio', up: true, endpoint: 'http://127.0.0.1:1234', models: [{ model: 'a', contextLength: null }] });
  assert.equal(observedWith, 'oc');
  assert.ok(seen.some(e => e.type === 'session.updated' && e.source === 'oc'));
  http['http://127.0.0.1:1234/m'] = null;
  await wait(60);
  d.dispose();
  const changes = seen.filter(e => e.type === 'backend.changed');
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[1].data, { integration: 'lmstudio', up: false });
});
test('testIntegration: detect, reachable, models, 1-token completion (free only); not found stops early', async () => {
  const env = fakeEnv({ http: { 'http://127.0.0.1:1234/m': { status: 200, body: '{"data":[{"id":"a"}]}' },
    'POST http://127.0.0.1:1234/v1/chat/completions': { status: 200, body: '{"choices":[{}]}' } } });
  const r = await testIntegration(env, lms);
  assert.deepEqual(r.steps.map(s => [s.name, s.ok]), [['detect', true], ['server reachable', true], ['models', true], ['1-token completion', true]]);
  assert.equal(r.ok, true);
  const paid = await testIntegration(env, { ...lms, manifest: { ...lms.manifest, cost: 'metered' } });
  assert.match(paid.steps.at(-1)!.detail, /skipped: paid target/);
  const none = await testIntegration(fakeEnv(), lms);
  assert.deepEqual(none, { ok: false, steps: [{ ...none.steps[0], name: 'detect', ok: false, detail: 'not found in this environment' }] });
  const guarded = await testIntegration(env, user({ detect: { http: { port: 1234, path: '/m' } } }));
  assert.equal(guarded.ok, false, 'a third party without grants cannot even probe');
});

const swMod: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'oc', name: 'OC', roles: ['agent'], detect: { bin: ['oc'] } } as Manifest,
  module: { async switches(env) { return [{ id: 'oc:a', label: 'a', on: false, envId: env.id, integration: 'oc' }]; }, async setSwitch() {} } };
test('runEnvCommand: switches, switch, test and inspect; unknown switch/integration fail', async () => {
  const env = fakeEnv({ bins: { oc: '/b/oc' } });
  assert.deepEqual((await runEnvCommand(env, [swMod], 'switches', [], [])).map(s => s.id), ['oc:a']);
  assert.equal((await runEnvCommand(env, [swMod], 'switch', ['oc:a', 'on'], [])).on, true);
  await assert.rejects(runEnvCommand(env, [swMod], 'switch', ['oc:zz', 'on'], []), /unknown switch oc:zz/);
  await assert.rejects(runEnvCommand(env, [swMod], 'test', ['ghost'], []), /unknown integration ghost/);
  assert.equal((await runEnvCommand(env, [swMod], 'inspect', [], [])).inspections.length, 1);
});
test('onEnv: host in-process; distro through the bundle with user manifests + grants; stopped env refused', async () => {
  const env = fakeEnv({ bins: { oc: '/b/oc' } });
  assert.equal((await onEnv({ status: { id: 'windows', state: 'running' }, env }, { integrations: [swMod] }, 'switches')).length, 1);
  let argv: string[] = [];
  const spawn: Spawn = async (_c, a) => {
    if (a.includes('-c')) return { code: 0, stdout: Buffer.from(String(a[a.indexOf('-c') + 1]).includes('echo "dir=') ? 'dir=/d\nnode=/n\nfresh=1\n' : ''), stderr: Buffer.alloc(0) };
    argv = a; return { code: 0, stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) };
  };
  const g = [allow('net', 'GET /v')];
  assert.deepEqual(await onEnv({ status: { id: 'wsl:T', state: 'running' }, distro: 'T' }, { integrations: [swMod, user({})], grants: g, bundle: { text: Buffer.from(''), sha256: 'h' }, spawn }, 'switch', ['oc:a', 'on']), []);
  assert.deepEqual(argv.slice(0, 6), ['-d', 'T', '--exec', '/n', '/d/agent-spaghetti-env.mjs', 'switch']);
  assert.deepEqual(argv.slice(7), ['oc:a', 'on']);
  const p = decodePayload(argv[6]);
  assert.deepEqual([p.envId, p.user.map(m => m.id), p.grants], ['wsl:T', ['acme'], g]);
  await assert.rejects(onEnv({ status: { id: 'wsl:Off', state: 'stopped' } }, { integrations: [] }, 'switches'), /wsl:Off is stopped/);
});

test('OpenClaw: agents from CLI JSON (endpoint without credentials); sessions diff; first poll reports running ones as updated', () => {
  const agents = toAgents([{ id: 'main', isDefault: true, model: 'lm/studio/m1' }, { id: 'w', name: 'Worker', model: 'cloud/x' }, { nope: 1 }],
    { 'lm/studio': { baseUrl: 'http://u:pw@192.0.2.10:1234/v1?k=1' }, cloud: {} }, 'wsl:T');
  assert.deepEqual(agents.map(a => [a.name, a.provider, a.model, a.endpoint, a.isDefault]),
    [['main', 'lm/studio', 'm1', 'http://192.0.2.10:1234', true], ['Worker', 'cloud', 'x', undefined, false]]);
  const prev = new Map<string, string>();
  const seed = diffSessions(prev, [{ key: 'a', status: 'running', secret: 'S' }, { key: 'b', status: 'done' }], true);
  assert.deepEqual(seed.map(e => [e.type, e.data.key]), [['session.updated', 'a']]);
  assert.ok(!JSON.stringify(seed).includes('"S"'), 'only whitelisted fields');
  assert.deepEqual(diffSessions(prev, [{ key: 'a', status: 'running', secret: 'S' }, { key: 'b', status: 'done' }], false), []);
  const next = diffSessions(prev, [{ key: 'a', status: 'done' }, { key: 'c', status: 'running' }], false);
  assert.deepEqual(next.map(e => [e.type, e.data.key, e.data.status]), [['session.ended', 'a', 'done'], ['session.started', 'c', 'running'], ['session.ended', 'b', 'gone']]);
});
