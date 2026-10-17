// Pure sdk pieces added in 1b: permission model, live state reducer, report renderer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, declaredActions, emptyLive, liveState, permissionRows, renderConfigReport, withGrants, withoutGrants,
  type Grant, type Manifest, type Snapshot, type StoredEvent } from '@agent-spaghetti/sdk';

const M: Manifest = { manifest: 1, id: 'acme', name: 'Acme', roles: ['backend'],
  detect: { bin: ['acme'], paths: { linux: ['~/acme/bin/acme'] }, env: ['ACME_HOST'], version: { args: ['--version'] }, http: { port: 9, path: '/v' } }, models: { path: '/m', list: 'd', id: 'id' } };
const g = (action: Grant['action'], resource: string, mode: Grant['mode'] = 'allow'): Grant => ({ subject: 'acme', action, resource, mode, by: 'user', ts: 1 });

test('declaredActions lists every resource the guard will check, in its exact format', () => {
  assert.deepEqual(declaredActions(M).map(a => `${a.action} ${a.resource}`),
    ['read PATH:acme', 'read ~/acme/bin/acme', 'exec acme --version', 'read env:ACME_HOST', 'net GET /v', 'net GET /m']);
});
test('check: first match wins, wildcards, other subjects ignored, no grant → ask', () => {
  const grants = [g('net', 'GET /v', 'deny'), g('net', 'GET *'), { ...g('read', '*'), subject: 'other' }];
  assert.equal(check(grants, 'acme', 'net', 'GET /v'), 'deny');
  assert.equal(check(grants, 'acme', 'net', 'GET /m'), 'allow');
  assert.equal(check(grants, 'acme', 'read', 'PATH:acme'), 'ask');
});
test('withGrants replaces the same subject/action/resource; withoutGrants removes all or one', () => {
  const a = withGrants([g('net', 'GET /v')], [g('net', 'GET /v', 'deny'), g('read', 'PATH:acme')]);
  assert.deepEqual(a.map(x => `${x.action} ${x.resource} ${x.mode}`), ['net GET /v deny', 'read PATH:acme allow']);
  assert.equal(withoutGrants(a, 'acme', 'read', 'PATH:acme').length, 1);
  assert.equal(withoutGrants(a, 'acme').length, 0);
  assert.equal(withoutGrants(a, 'other').length, 2);
});
test('permissionRows: granted mode, pending, or not asked yet', () => {
  const rows = permissionRows('acme', declaredActions(M), [g('net', 'GET /v')], [{ action: 'read', resource: 'PATH:acme' }]);
  assert.deepEqual(rows.slice(1, 2)[0].slice(0, 3), ['read', 'PATH:acme', 'pending']);
  assert.ok(rows.some(r => r[1] === 'GET /v' && r[2] === 'allow'));
  assert.ok(rows.some(r => r[1] === 'GET /m' && r[2] === 'not asked yet'));
});

const ev = (id: number, type: StoredEvent['type'], data: Record<string, unknown>, envId = 'wsl:T'): StoredEvent => ({ id, ts: id, type, envId, source: 's', data });
test('liveState: sessions by env+key, ended removes, stopped env clears its sessions, backends and switches, old ids skipped', () => {
  let s = liveState([ev(1, 'session.started', { key: 'k1', agentId: 'main', status: 'running' }), ev(2, 'session.updated', { key: 'k2', status: 'running' }),
    ev(3, 'session.updated', { key: 'k1', agentId: 'main', status: 'waiting' }), ev(4, 'backend.changed', { integration: 'lmstudio', up: true, models: [{ model: 'm', contextLength: 8 }] }, 'windows'),
    ev(5, 'switch.changed', { id: 'sw', on: true })]);
  assert.equal(s.sessions['wsl:T|k1'].status, 'waiting');
  assert.equal(s.backends['windows|lmstudio'].models[0].model, 'm');
  assert.equal(s.switches.sw.on, true);
  s = liveState([ev(5, 'session.ended', { key: 'k1' }), ev(6, 'session.ended', { key: 'k2' })], s);
  assert.ok(s.sessions['wsl:T|k1'], 'id 5 was already applied');
  assert.equal(s.sessions['wsl:T|k2'], undefined);
  s = liveState([ev(7, 'env.status', { state: 'stopped' })], s);
  assert.deepEqual(s.sessions, {});
  assert.equal(s.lastEventId, 7);
  assert.deepEqual(liveState([]), emptyLive());
});
test('report: markdown with environments, tools, backends, agents and running sessions; pipes escaped', () => {
  const snap: Snapshot = { ts: Date.UTC(2026, 0, 2), envs: [{ id: 'windows', state: 'running', partial: ['msix'] }], rejected: [],
    detections: [{ integration: 'x', name: 'X|Y', envId: 'windows', installs: [], levels: ['detect'], cost: 'free', connectable: 'no', why: 'w' }],
    backends: [], agents: [{ id: 'a', integration: 'openclaw', name: 'main', envId: 'wsl:T', model: 'm' }] };
  const live = liveState([ev(1, 'session.started', { key: 'k', agentId: 'main', kind: 'chat', status: 'running' })]);
  const md = renderConfigReport(snap, live);
  assert.match(md, /^# Agent Spaghetti: machine configuration \(2026-01-02\)/);
  assert.match(md, /\| windows \| running \| msix \|/);
  assert.match(md, /X\\\|Y/);
  assert.match(md, /## Backends\nnone running/);
  assert.match(md, /\| openclaw · main \| wsl:T \| m \| not observed \|/);
  assert.match(md, /## Running sessions\n\| Env \| Agent \| Kind \| Status \|\n\|---\|---\|---\|---\|\n\| wsl:T \| main \| chat \| running \|/);
});
test('liveState: delegated runs while running, server queues; tray stats show both', async () => {
  const { renderStats, trayState } = await import('@agent-spaghetti/sdk');
  let s = liveState([ev(1, 'run.started', { id: 4, source: 'cursor', target: 'lmstudio' }, 'hub'),
    { id: 2, ts: 2, type: 'backend.queue', envId: 'windows', source: 'lmstudio', data: { waiting: 2, running: 1 } },
    ev(3, 'backend.changed', { integration: 'lmstudio', up: true, models: [{ model: 'm', contextLength: null }] }, 'windows')]);
  assert.deepEqual(s.runs['4'], { id: 4, source: 'cursor', target: 'lmstudio', ts: 1 });
  assert.equal(trayState(true, null, s, []), 'working');
  assert.deepEqual(renderStats(true, null, s, []).slice(1), ['lmstudio · m · queue 2', '1 delegated task running']);
  s = liveState([ev(4, 'run.finished', { id: 4, outcome: 'done' }, 'hub')], s);
  assert.deepEqual(s.runs, {});
});
test('toolRows: group by first role in TOOL_GROUPS order; state, connection, preference and waiting questions per tool', async () => {
  const { toolRows, renderToolRows, emptyLive, liveState } = await import('@agent-spaghetti/sdk');
  const det = (integration: string, o: Record<string, unknown> = {}) => ({ integration, name: integration, envId: 'windows', installs: [], levels: [], cost: 'free' as const, connectable: 'yes' as const, why: 'w', ...o });
  const L = (id: string, roles: string[], disabled = false) => ({ id, name: id.toUpperCase(), source: 'builtin' as const, roles: roles as never, levels: [], disabled });
  const snapshot = { ts: 1, envs: [], agents: [], backends: [], rejected: [], detections: [
    det('oc', { connected: true, envId: 'wsl:T' }), det('oc', { envId: 'windows' }), det('lms'), det('ed', { connected: false, installs: [{ via: 'process', pid: 1 }] }),
    det('srv', { connectable: 'needs-setup', why: 'installed, server not running' }), det('gone') ] };
  const live = liveState([{ id: 1, ts: 1, type: 'tool.changed', envId: 'windows', source: 'gone', data: { integration: 'gone', running: false } }], emptyLive());
  const rows = toolRows({ snapshot, live, targets: [{ id: 'lms', name: 'LMS', kind: 'model', cost: 'free', envId: 'windows', models: ['m'], engine: 'openai', resumable: false }],
    prefs: { auto: ['oc'], never: [] }, consents: [{ subject: 'ed' }],
    loaded: [L('oc', ['agent', 'client']), L('lms', ['backend']), L('ed', ['client']), L('srv', ['backend']), L('gone', ['tool']), L('nope', ['client']), L('off', ['client'], true)] });
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual([by.oc.group, by.oc.connection, by.oc.preference, by.oc.envs.join()], ['agents', 'connected', 'always', 'wsl:T,windows']);
  assert.deepEqual([by.lms.group, by.lms.state, by.lms.connection, by.lms.receives], ['models', 'ready', undefined, 'openai']);
  assert.deepEqual([by.ed.state, by.ed.connection, by.ed.preference, by.ed.asks], ['running', 'not connected', 'ask', 1]);
  assert.deepEqual([by.srv.state, by.gone.state, by.nope.state, by.off.state, by.off.why], ['stopped', 'stopped', 'not found', 'skipped', 'skipped in scans']);
  const text = renderToolRows(rows);
  assert.ok(text.indexOf('Agents:') < text.indexOf('Model servers:') && text.indexOf('Model servers:') < text.indexOf('Editors & apps:'));
  assert.match(text, /oc\s+OC\s+installed\s+connected \(always\)\s+wsl:T,windows/);
  assert.ok(text.indexOf('ed ') < text.indexOf('nope'), 'found tools first');
});
test('rankTargets: free, then unknown, then metered; up before down; least queued; otherwise the input order (no tool preferred)', async () => {
  const { rankTargets } = await import('@agent-spaghetti/sdk');
  const t = (id: string, cost: 'free' | 'metered' | 'unknown') => ({ id, cost });
  const items = [t('paid', 'metered'), t('b', 'free'), t('maybe', 'unknown'), t('a', 'free'), t('down', 'free')];
  assert.deepEqual(rankTargets(items).map(x => x.id), ['b', 'a', 'down', 'maybe', 'paid']);
  assert.deepEqual(rankTargets(items, { up: id => id !== 'down', queued: id => (id === 'b' ? 2 : 0) }).map(x => x.id), ['a', 'b', 'down', 'maybe', 'paid']);
});
test('parseJsonc: comments and trailing commas go, strings stay untouched; not JSON → undefined', async () => {
  const { parseJsonc } = await import('@agent-spaghetti/sdk');
  assert.deepEqual(parseJsonc('{\n // c\n "a": "x // not a comment, }", /* b */ "l": [1, 2, /* t */ ],\n}'), { a: 'x // not a comment, }', l: [1, 2] });
  assert.deepEqual(parseJsonc('{"q": "say \\"hi\\" /* x */"}'), { q: 'say "hi" /* x */' });
  assert.equal(parseJsonc('{oops'), undefined);
});
