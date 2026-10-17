// The model gateway end to end: a fake upstream server, real HTTP on both sides, the runner's permission check and record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Integration, Manifest, Snapshot, Target } from '@agent-spaghetti/sdk';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { Store } from '../../packages/core/src/store.ts';
import { Bus } from '../../packages/core/src/bus.ts';
import { Consent } from '../../packages/core/src/consent.ts';
import { Settings } from '../../packages/core/src/settings.ts';
import { Ledger } from '../../packages/core/src/ledger.ts';
import { Runner } from '../../packages/core/src/runner.ts';
import { Gateway, KEY_PREFIX, resolveRoute } from '../../packages/core/src/gateway.ts';

const T = (id: string, cost: Target['cost'], models: string[]): Target => ({ id, name: id, kind: 'model', cost, envId: 'w', models, engine: 'openai', resumable: false });
test('resolveRoute: target:model, a loaded model id, the tool\'s route, auto = best-ranked; clear errors', () => {
  const ts = [T('paid', 'metered', ['big']), T('lms', 'free', ['g:4b', 'q']), { ...T('agent', 'free', ['x']), kind: 'agent' as const }];
  assert.deepEqual(resolveRoute([], 'vscode', 'paid:big', ts), { target: 'paid', model: 'big' });
  assert.deepEqual(resolveRoute([], 'vscode', 'q', ts), { target: 'lms', model: 'q' });
  assert.deepEqual(resolveRoute([], 'vscode', 'auto', ts), { target: 'lms', model: 'g:4b' }, 'free first, no tool preferred by name');
  assert.deepEqual(resolveRoute(['vscode=paid:big'], 'vscode', 'gpt-whatever', ts), { target: 'paid', model: 'big' });
  assert.deepEqual(resolveRoute(['cline=paid'], 'vscode', 'x', ts), { target: 'lms', model: 'g:4b' }, 'another tool\'s route does not apply; agents are no models');
  assert.match((resolveRoute(['vscode=paid:gone'], 'vscode', 'auto', ts) as { error: string }).error, /vscode's model paid:gone is not available now/);
  assert.match((resolveRoute([], 'vscode', 'auto', []) as { error: string }).error, /no model is loaded/);
});

/** An upstream that streams two words, then usage only because it was asked; or answers JSON. */
async function upstream() {
  const seen: Array<{ url: string; body: any; auth?: string }> = [];
  const s = createServer(async (req: IncomingMessage, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); seen.push({ url: req.url!, body, auth: req.headers.authorization });
    if (body.fail) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad model"}}'); return; }
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const w of ['He', 'llo']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
    if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen, close: () => new Promise<void>(r => s.close(() => r())) };
}
const integ = (id: string, cost: 'free' | 'metered', headers?: Record<string, string>): Integration => ({ source: 'builtin',
  manifest: { manifest: 1, id, name: id, roles: ['backend'], cost, detect: { env: ['K'] }, models: { list: 'data', id: 'id' }, speaks: { openai: { base: '/v1', ...(headers ? { headers } : {}) } } } as Manifest });

test('gateway: keys name the tool; models listed; streams pass through with only model rewritten; usage recorded; denial is a readable 403', async () => {
  const up = await upstream();
  process.env.K = 'test-key';
  const store = new Store(':memory:'), bus = new Bus(store), consent = new Consent(bus), settings = new Settings(store), ledger = new Ledger(store);
  const ints = [integ('lms', 'free'), integ('paid', 'metered', { Authorization: 'Bearer {env:K}' })];
  const snap: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }], agents: [], rejected: [],
    detections: ints.map(i => ({ integration: i.manifest.id, name: i.manifest.id, envId: 'windows', installs: [], levels: [], cost: i.manifest.cost!, connectable: 'yes' as const, why: '' })),
    backends: [{ id: 'lms:m1', integration: 'lms', model: 'm1', envId: 'windows', endpoint: up.url, reachableFrom: ['windows'] },
      { id: 'paid:big', integration: 'paid', model: 'big', envId: 'windows', endpoint: up.url, reachableFrom: ['windows'] }] };
  const runner = new Runner({ bus, consent, ledger, settings, resultsDir: mkdtempSync(join(tmpdir(), 'as-gw-')), host: () => fakeEnv({}), snapshot: () => snap, integrations: () => ints,
    runOn: () => { throw new Error('no agents'); } });
  const gw = new Gateway({ settings, store, runner });
  settings.set('gateway.port', 0); await gw.sync();
  assert.equal(gw.status().port, 0, 'off by default');
  const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
  settings.set('gateway.port', port); await gw.sync();
  const key = gw.key('vscode', true)!;
  assert.ok(key.startsWith(KEY_PREFIX)); assert.ok(!JSON.stringify(store.getKv('gateway.keys')).includes(key), 'only the hash is kept');
  const call = (path: string, body?: object, k = key) => fetch(`http://127.0.0.1:${port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    const bad = await call('/v1/models', undefined, 'nope');
    assert.deepEqual([bad.status, (await bad.json()).error.type], [401, 'invalid_api_key']);
    assert.deepEqual((await (await call('/v1/models')).json()).data.map((m: any) => m.id), ['auto', 'lms:m1', 'paid:big']);

    const s = await call('/v1/chat/completions', { model: 'auto', stream: true, messages: [{ role: 'user', content: 'SECRET-PROMPT' }], tools: [{ type: 'function' }] });
    const text = await s.text();
    assert.equal(s.headers.get('content-type'), 'text/event-stream');
    assert.ok(text.includes('"He"') && text.includes('"llo"') && text.includes('[DONE]'));
    assert.ok(!text.includes('usage'), 'the usage chunk we asked for stays with us');
    assert.deepEqual([up.seen[0].url, up.seen[0].body.model, up.seen[0].body.tools, up.seen[0].body.stream_options], ['/v1/chat/completions', 'm1', [{ type: 'function' }], { include_usage: true }]);
    const row = ledger.list({})[0];
    assert.deepEqual([row.source, row.target, row.model, row.outcome, row.inputTokens, row.outputTokens, row.returnTo], ['vscode', 'lms', 'm1', 'done', 5, 2, 'none']);
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM runs').all()).includes('SECRET-PROMPT'));

    const j = await call('/v1/chat/completions', { model: 'lms:m1', messages: [] });
    assert.deepEqual((await j.json()).choices[0].message.content, 'ok');
    const upErr = await call('/v1/chat/completions', { model: 'lms:m1', messages: [], fail: true });
    assert.deepEqual([upErr.status, await upErr.text()], [400, '{"error":{"message":"bad model"}}'], 'the server\'s own error passes through');
    assert.match(ledger.list({})[0].error!, /HTTP 400/);

    const paid = call('/v1/chat/completions', { model: 'paid:big', messages: [] });
    for (let i = 0; i < 100 && !consent.pending().length; i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual([consent.pending()[0].subject, consent.pending()[0].resource], ['vscode', 'paid'], 'a paid model asks first');
    consent.respond(consent.pending()[0].id, false);
    const denied = await paid;
    assert.deepEqual([denied.status, (await denied.json()).error], [403, { message: 'Agent Spaghetti: denied by the user', type: 'permission_denied' }]);

    const allowed = call('/v1/chat/completions', { model: 'paid:big', messages: [] });
    for (let i = 0; i < 100 && !consent.pending().length; i++) await new Promise(r => setTimeout(r, 5));
    consent.respond(consent.pending()[0].id, true, 'once');
    assert.equal((await allowed).status, 200);
    assert.equal(up.seen.at(-1)!.auth, 'Bearer test-key', 'the key variable is read at request time');

    const missing = await call('/v1/chat/completions', { model: 'nope:x', messages: [] });
    assert.equal(missing.status, 200, 'an unknown name follows the tool\'s route (auto)');
    gw.key('vscode', false);
    assert.equal((await call('/v1/models')).status, 401, 'revoked');
  } finally { await gw.close(); await up.close(); delete process.env.K; }
});
test('gatewayClient op: a tool\'s model (route) and a key shown once with its setup steps filled in', async () => {
  const { routesFor } = await import('../../packages/core/src/ops.ts');
  const { BUILTINS } = await import('@agent-spaghetti/integrations');
  const store = new Store(':memory:'), settings = new Settings(store);
  const gateway = new Gateway({ settings, store, runner: { targets: () => [] } as unknown as Runner });
  const s = { settings, store, gateway, loaded: () => ({ integrations: BUILTINS, rejected: [] }) } as never;
  const op = routesFor(s).find(r => r.path === '/v1/gateway/client')!;
  assert.deepEqual(await op.handle({ integration: 'vscode', model: 'lms:m1' }, null as never), { model: 'lms:m1' });
  assert.deepEqual(settings.get('gateway.routes'), ['vscode=lms:m1']);
  const k = await op.handle({ integration: 'vscode', key: 'create' }, null as never) as { key: string; setup: string };
  assert.ok(k.setup.includes(`API key: ${k.key}`) && k.setup.includes('"url": "http://127.0.0.1:<gateway.port>/v1/chat/completions"'));
  assert.deepEqual(await op.handle({ integration: 'vscode', model: 'auto' }, null as never), { model: 'auto' });
  assert.deepEqual(settings.get('gateway.routes'), []);
  await assert.rejects(async () => op.handle({ integration: 'lmstudio', key: 'create' }, null as never), /cannot use a custom model endpoint/);
});
