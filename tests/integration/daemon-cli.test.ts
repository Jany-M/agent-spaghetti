// Daemon + typed client + CLI, in-process, against a fake scan (no machine access).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubClient, DaemonDown, emptyLive, liveState, type Integration, type Snapshot, type Switch } from '@agent-spaghetti/sdk';
import { Settings } from '../../packages/core/src/settings.ts';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { Consent } from '../../packages/core/src/consent.ts';
import { Ledger } from '../../packages/core/src/ledger.ts';
import { Runner } from '../../packages/core/src/runner.ts';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { Store } from '../../packages/core/src/store.ts';
import { Bus } from '../../packages/core/src/bus.ts';
import { startDaemon } from '../../packages/core/src/daemon.ts';
import { loadOrCreateToken, writeDiscovery } from '../../packages/core/src/config.ts';
import type { Services } from '../../packages/core/src/ops.ts';
import { run } from '../../packages/cli/src/index.ts';

const SNAP: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }], agents: [], rejected: [{ id: 'junk', why: 'not valid JSON' }],
  detections: [{ integration: 'lmstudio', name: 'LM Studio', envId: 'windows', installs: [], levels: ['detect', 'observe'], cost: 'free', connectable: 'yes', why: '1 model(s) loaded' }],
  backends: [{ id: 'lmstudio:m', integration: 'lmstudio', model: 'm', envId: 'windows', endpoint: 'http://127.0.0.1:1234', contextLength: 200192, reachableFrom: ['windows'] }] };

/** The daemon tests never touch the real machine: one fake local environment. */
const fakeMachine = async () => [{ status: { id: 'windows', state: 'running' as const }, env: fakeEnv() }];
const THIRD: Integration = { source: 'user', hash: 'h', manifest: { manifest: 1, id: 'acme', name: 'Acme', roles: ['backend'], detect: { bin: ['acme'], http: { port: 9, path: '/v' } } } };
async function boot(scan: () => Promise<Snapshot> = async () => SNAP) {
  const store = new Store(':memory:'); const bus = new Bus(store);
  let live = emptyLive(); bus.subscribe(e => { live = liveState([e], live); });
  const sw: Switch[] = [{ id: 'openclaw-mcp:a', label: 'a', on: false, envId: 'wsl:TestDistro', integration: 'openclaw' }];
  const calls: string[] = [];
  let stopped = 0;
  const settings = new Settings(store), consent = new Consent(bus), ledger = new Ledger(store);
  const host = fakeEnv({ lines: { 'POST http://127.0.0.1:1234/v1/chat/completions': ['data: {"choices":[{"delta":{"content":"Hi"}}]}', 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}', 'data: [DONE]'] } });
  const integrations = [THIRD, BUILTINS.find(b => b.manifest.id === 'lmstudio')!];
  const resultsDir = mkdtempSync(join(tmpdir(), 'as-results-'));
  const runner = new Runner({ bus, consent, ledger, settings, resultsDir, host: () => host, snapshot: () => store.loadSnapshot('scan'), integrations: () => integrations,
    runOn: () => { throw new Error('no agents in this test'); } });
  const services: Services = { store, bus, settings, consent, ledger, runner, host: () => host, cli: () => ({ command: 'node', args: ['/x/cli.ts'] }),
    shutdown: () => { stopped++; }, live: () => live, scan: async () => { const snap = await scan(); store.saveSnapshot('scan', snap); return snap; },
    loaded: () => ({ integrations, rejected: [] }),
    onEnvs: async (cmd, args, envIds) => {
      calls.push([cmd, ...args, ...(envIds ?? ['*'])].join(' '));
      const r: Record<string, unknown> = { switches: sw, switch: { ...sw[0], on: args[1] === 'on' }, test: { ok: true, steps: [{ name: 'detect', ok: true, detail: 'found', ms: 1 }] },
        connect: { integration: args[0], envId: envIds?.[0], description: 'add it', changes: ['x'], applied: args[2] !== 'dry-run' } };
      return (envIds ?? ['windows', 'wsl:TestDistro']).map(envId => envId === 'windows' && (cmd === 'switches' || cmd === 'connect') ? { envId, error: 'boom' } : { envId, result: r[cmd] as never });
    } };
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  const token = loadOrCreateToken(dir);
  const d = await startDaemon({ services, token, port: 0 });
  const removeDiscovery = writeDiscovery(dir, d.port);
  const env = { AGENT_SPAGHETTI_DATA_DIR: dir } as NodeJS.ProcessEnv;
  return { d, bus, dir, env, token, calls, services, stopped: () => stopped, client: HubClient.fromDiscovery(env), close: async () => { removeDiscovery(); await d.close(); } };
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

test('CLI 1b: switches, on (env resolved, switch.changed → live), test, permissions, allow/revoke, settings, disable, report', async () => {
  const b = await boot();
  const cli = async (...a: string[]) => { const t = io(); const code = await run(a, t.io, b.env); return { code, out: t.o.join('\n'), err: t.e.join('\n') }; };
  let r = await cli('switches'); assert.equal(r.code, 0); assert.match(r.out, /openclaw-mcp:a\s+wsl:TestDistro\s+off/); assert.match(r.out, /windows: boom/);
  r = await cli('on', 'openclaw-mcp:a'); assert.equal(r.code, 0); assert.match(r.out, /is on/);
  assert.ok(b.calls.includes('switch openclaw-mcp:a on wsl:TestDistro'));
  assert.equal((await b.client.call('status')).live.switches['openclaw-mcp:a'].on, true);
  r = await cli('on', 'nope'); assert.equal(r.code, 1); assert.match(r.err, /unknown switch nope/);
  r = await cli('test', 'acme', '--env', 'windows'); assert.equal(r.code, 0); assert.match(r.out, /acme in windows\nOK\s+detect/);
  r = await cli('test', 'ghost'); assert.equal(r.code, 1); assert.match(r.err, /unknown integration ghost/);
  r = await cli('permissions'); assert.match(r.out, /read\s+PATH:acme\s+not asked yet/);
  r = await cli('allow', 'acme'); assert.match(r.out, /acme: 2 grant\(s\)/);
  r = await cli('deny', 'acme', 'net', 'GET /v'); assert.match(r.out, /net\s+GET \/v\s+deny/);
  r = await cli('permissions'); assert.match(r.out, /read\s+PATH:acme\s+allow/); assert.match(r.out, /net\s+GET \/v\s+deny/);
  r = await cli('revoke', 'acme', 'read', 'PATH:acme'); assert.match(r.out, /acme: 1 grant/);
  r = await cli('allow', 'lmstudio'); assert.equal(r.code, 1); assert.match(r.err, /not a third-party integration/);
  r = await cli('set', 'llmHosts', '192.0.2.5, 192.0.2.6'); assert.match(r.out, /llmHosts\s+192\.0\.2\.5,192\.0\.2\.6/);
  r = await cli('set', 'nope', '1'); assert.equal(r.code, 1); assert.match(r.err, /unknown setting nope/);
  r = await cli('disable', 'acme'); assert.match(r.out, /disabled: acme/);
  r = await cli('integrations'); assert.match(r.out, /acme\s+Acme\s+user\s+\S+\s+disabled/);
  r = await cli('enable', 'acme'); assert.match(r.out, /disabled: none/);
  r = await cli('report'); assert.equal(r.code, 1); assert.match(r.err, /no scan yet/);
  await cli('scan');
  const out = join(b.dir, 'report.md');
  r = await cli('report', '--out', out); assert.equal(r.code, 0);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(out, 'utf8'), /^# Agent Spaghetti: machine configuration/);
  await b.close();
});

test('runDaemon wiring: real settings, grants and host-env commands; no scan or observers unless asked', async () => {
  const { runDaemon } = await import('../../packages/core/src/main.ts');
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  const d = await runDaemon({ AGENT_SPAGHETTI_DATA_DIR: dir }, { scanOnStart: false, observe: false, discover: fakeMachine });
  const c = HubClient.fromDiscovery({ AGENT_SPAGHETTI_DATA_DIR: dir });
  try {
  assert.equal((await c.call('status')).snapshot, null);
  assert.equal((await c.call('settings'))['events.retentionDays'].value, 14);
  await c.call('setting', { key: 'disabled', value: 'cursor' });
  assert.equal((await c.call('integrations')).loaded.find(i => i.id === 'cursor')!.disabled, true);
  const sw = await c.call('switches');
  assert.ok(Array.isArray(sw.switches));
  assert.deepEqual((await c.call('permissions')).subjects, []);
  } finally { await d.close(); }
});

test('CLI 2: questions show in status with their id; answer allow resolves the asker; status --short; shutdown', async () => {
  const b = await boot();
  const cli = async (...a: string[]) => { const t = io(); const code = await run(a, t.io, b.env); return { code, out: t.o.join('\n'), err: t.e.join('\n') }; };
  await cli('scan');
  const answer = b.services.consent.request({ subject: 'acme', action: 'read', resource: 'PATH:acme', why: 'look for acme', scopes: ['always'] });
  const id = b.services.consent.pending()[0].id;
  let r = await cli('status'); assert.match(r.out, new RegExp(`\\? ${id}  acme wants read PATH:acme \\(look for acme\\) → answer ${id} allow\\|deny$`, 'm'));
  r = await cli('status', '--short'); assert.equal(r.out, 'agent-spaghetti running · 1 tool\nLM Studio · m · ctx 200k\n1 approval waiting');
  r = await cli('answer', id, 'maybe'); assert.equal(r.code, 1);
  r = await cli('answer', id, 'allow', 'once'); assert.equal(r.code, 1); assert.match(r.err, /no open question/);
  r = await cli('answer', id, 'allow'); assert.equal(r.code, 0);
  assert.deepEqual(await answer, { answer: 'granted', scope: 'always' });
  r = await cli('shutdown'); assert.equal(r.code, 0);
  await new Promise(res => setImmediate(res));
  assert.equal(b.stopped(), 1);
  await b.close();
});
test('runDaemon: a third-party drop-in asks once per action; allowing stores a grant and rescans', async () => {
  const { runDaemon } = await import('../../packages/core/src/main.ts');
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  mkdirSync(join(dir, 'integrations'));
  writeFileSync(join(dir, 'integrations', 'acme-tool.json'), JSON.stringify({ manifest: 1, id: 'acme-tool', name: 'Acme', roles: ['tool'], detect: { bin: ['acme-tool-xyz'] } }));
  const d = await runDaemon({ AGENT_SPAGHETTI_DATA_DIR: dir }, { scanOnStart: false, observe: false, discover: fakeMachine });
  const c = HubClient.fromDiscovery({ AGENT_SPAGHETTI_DATA_DIR: dir });
  try {
  await c.call('scan');
  const [q] = (await c.call('status')).consents;
  assert.deepEqual([q.subject, q.action, q.resource, q.why], ['acme-tool', 'read', 'PATH:acme-tool-xyz', 'look for the "acme-tool-xyz" program on PATH']);
  await c.call('scan');
  assert.equal((await c.call('status')).consents.length, 1, 'asked once');
  const before = (await c.call('events', { since: 0 })).filter(e => e.type === 'scan.completed').length;
  await c.call('consent', { id: q.id, allow: true });
  assert.deepEqual((await c.call('permissions')).grants.map(g => [g.subject, g.action, g.resource, g.mode]), [['acme-tool', 'read', 'PATH:acme-tool-xyz', 'allow']]);
  await new Promise(res => setTimeout(res, 3500));
  assert.ok((await c.call('events', { since: 0 })).filter(e => e.type === 'scan.completed').length > before, 'rescanned');
  assert.equal((await c.call('status')).consents.length, 0);
  } finally { await d.close(); }
});

test('runDaemon: concurrent scans share one; a tool starting or stopping triggers one rescan', async () => {
  const { runDaemon } = await import('../../packages/core/src/main.ts');
  const dir = mkdtempSync(join(tmpdir(), 'as-'));
  const d = await runDaemon({ AGENT_SPAGHETTI_DATA_DIR: dir }, { scanOnStart: false, observe: false, discover: fakeMachine });
  const scans = () => d.services.store.eventsSince(0, 1000).filter(e => e.type === 'scan.completed').length;
  try {
    const [a, b] = [d.services.scan(), d.services.scan()];
    assert.equal(a, b);
    await a;
    assert.ok(d.services.store.loadSnapshot('scan'), 'the scan saves its snapshot');
    const emit = (changed: boolean) => d.services.bus.emit({ ts: Date.now(), type: 'tool.changed', envId: 'windows', source: 'lmstudio', data: { integration: 'lmstudio', running: false, ...(changed ? { changed } : {}) } });
    emit(false); emit(true); emit(true);
    await new Promise(res => setTimeout(res, 3500));
    assert.equal(scans(), 2, 'first reports do not rescan; several changes → one rescan');
  } finally { await d.close(); }
});
test('CLI 3: targets, delegate to a free local model (result printed), runs, runs <id>, verdict, cancel', async () => {
  const b = await boot();
  const cli = async (...a: string[]) => { const t = io(); const code = await run(a, t.io, b.env); return { code, out: t.o.join('\n'), err: t.e.join('\n') }; };
  try {
    await cli('scan');
    let r = await cli('targets'); assert.match(r.out, /lmstudio\s+LM Studio\s+model\s+free\s+m/);
    r = await cli('delegate', 'lmstudio', 'say', 'hi', '--kind', 'summarize', '--reason', 'test'); assert.equal(r.code, 0, r.err); assert.equal(r.out, 'Hi');
    r = await cli('runs'); assert.match(r.out, /^\s+1 .+ cli → lmstudio \(m\)\s+summarize\s+done/m); assert.match(r.out, /· test$/m);
    r = await cli('runs', '1'); assert.match(r.out, /\n\nHi$/);
    r = await cli('verdict', '1', 'redo'); assert.equal(r.code, 0); assert.match((await cli('runs')).out, /\[redo\]/);
    r = await cli('verdict', '1', 'meh'); assert.equal(r.code, 1);
    r = await cli('cancel', '1'); assert.match(r.out, /run 1 is not running/);
    r = await cli('delegate', 'nope', 'x'); assert.equal(r.code, 1); assert.match(r.err, /unknown or unavailable target nope/);
    b.services.store.saveSnapshot('scan', { ...SNAP, detections: [...SNAP.detections, ...['windows', 'wsl:TestDistro'].map(envId => ({ ...SNAP.detections[0], integration: 'openclaw', name: 'OpenClaw', envId }))] });
    r = await cli('connect', 'openclaw', '--dry-run'); assert.equal(r.code, 0, r.err); assert.match(r.out, /^Would: add it \(wsl:TestDistro\)\n  x$/);
    assert.ok(b.calls.includes('connect openclaw {"command":"node","args":["/x/cli.ts"]} dry-run windows'), 'tried the Windows install first');
    r = await cli('connect', 'ghost'); assert.equal(r.code, 1); assert.match(r.err, /ghost was not found by the last scan/);
    const types = (await b.client.call('events', { since: 0 })).map(e => e.type);
    for (const t of ['run.started', 'run.finished', 'backend.queue']) assert.ok(types.includes(t as never), t);
  } finally { await b.close(); }
});
