// The consent queue (ADR 0005) and the tray's pure state/stats functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyLive, liveState, renderStats, trayState, type ConsentRequest, type Snapshot } from '@agent-spaghetti/sdk';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';
import { Consent } from '../../../packages/core/src/consent.ts';

const q = { subject: 'acme', action: 'read' as const, resource: 'PATH:acme', why: 'look for acme', scopes: ['always' as const] };
const setup = () => { const bus = new Bus(new Store(':memory:')); return { bus, c: new Consent(bus), types: () => bus.store.eventsSince(0).map(e => e.type) }; };

test('consent: the same question is asked once; answers resolve every waiter and emit events', async () => {
  const { c, types } = setup();
  const a = c.request(q), b = c.request(q);
  assert.equal(c.pending().length, 1);
  const id = c.pending()[0].id;
  assert.equal(c.respond(id, true, 'once'), false, 'scope not offered');
  assert.equal(c.respond(id, true), true);
  assert.deepEqual(await a, { answer: 'granted', scope: 'always' });
  assert.deepEqual(await b, { answer: 'granted', scope: 'always' });
  assert.equal(c.respond(id, false), false, 'answering twice is a no-op');
  assert.deepEqual(types(), ['consent.requested', 'consent.answered']);
  assert.equal(c.pending().length, 0);
});
test('consent: deny; run requests are never merged; expiry; task text never reaches the event store', async () => {
  const { bus, c, types } = setup();
  const run = { ...q, action: 'run' as const, resource: 'claude-cli', task: 'SECRET-MARKER refactor', scopes: ['once' as const, 'job' as const, 'always' as const], cost: 'metered' as const };
  const r1 = c.request(run), r2 = c.request({ ...run, timeoutMs: 30 });
  assert.equal(c.pending().length, 2);
  assert.equal(c.pending()[0].task, 'SECRET-MARKER refactor', 'the prompt shows the full task');
  c.respond(c.pending()[0].id, false);
  assert.deepEqual(await r1, { answer: 'denied' });
  assert.deepEqual(await r2, { answer: 'expired' });
  assert.deepEqual(types(), ['consent.requested', 'consent.requested', 'consent.answered', 'consent.expired']);
  assert.ok(!JSON.stringify(bus.store.eventsSince(0)).includes('SECRET-MARKER'));
});

const snap = (o: Partial<Snapshot> = {}): Snapshot => ({ ts: 1, envs: [{ id: 'windows', state: 'running' }], detections: [], agents: [], backends: [], rejected: [], ...o });
const pending = [{ id: 'x' } as ConsentRequest];
test('trayState: problem > approval > working > idle', () => {
  const busy = liveState([{ id: 1, ts: 1, type: 'session.started', envId: 'wsl:T', source: 'openclaw', data: { key: 'k' } }]);
  assert.equal(trayState(false, null, emptyLive(), []), 'problem');
  assert.equal(trayState(true, snap({ envs: [{ id: 'wsl:T', state: 'error' }] }), busy, pending), 'problem');
  assert.equal(trayState(true, snap(), busy, pending), 'approval');
  assert.equal(trayState(true, snap(), busy, []), 'working');
  assert.equal(trayState(true, snap({ envs: [{ id: 'wsl:T', state: 'stopped' }] }), emptyLive(), []), 'idle');
});
test('renderStats: tools, live backends once per server, sessions, approvals; daemon down', () => {
  const s = snap({ detections: [
    { integration: 'lmstudio', name: 'LM Studio', envId: 'windows', installs: [], levels: [], cost: 'free', connectable: 'yes', why: '' },
    { integration: 'lmstudio', name: 'LM Studio', envId: 'wsl:T', installs: [], levels: [], cost: 'free', connectable: 'yes', why: '' }] });
  const live = liveState([
    { id: 1, ts: 1, type: 'backend.changed', envId: 'windows', source: 'lmstudio', data: { integration: 'lmstudio', up: true, models: [{ model: 'm', contextLength: 8192 }] } },
    { id: 2, ts: 1, type: 'backend.changed', envId: 'wsl:T', source: 'lmstudio', data: { integration: 'lmstudio', up: true, models: [{ model: 'm', contextLength: 8192 }] } },
    { id: 3, ts: 1, type: 'session.started', envId: 'wsl:T', source: 'openclaw', data: { key: 'k' } }]);
  assert.deepEqual(renderStats(true, s, live, pending), ['agent-spaghetti running · 1 tool', 'LM Studio · m · ctx 8k', '1 session running', '1 approval waiting']);
  assert.deepEqual(renderStats(true, null, emptyLive(), []), ['agent-spaghetti running · no scan yet']);
  assert.deepEqual(renderStats(false, null, emptyLive(), []), ['agent-spaghetti is not running']);
});
