// The dispatcher: auto routing (ranking, or the dispatcher model's pick), the watchdog, never acting on its own runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Detection, Integration, Manifest, Snapshot, Target } from '@agent-spaghetti/sdk';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';
import { Consent } from '../../../packages/core/src/consent.ts';
import { Settings } from '../../../packages/core/src/settings.ts';
import { Ledger } from '../../../packages/core/src/ledger.ts';
import { Runner } from '../../../packages/core/src/runner.ts';
import { Dispatcher, parseRoute, routePrompt } from '../../../packages/core/src/dispatcher.ts';

let answer = 'coder';
const agent = (id: string, cost: 'free' | 'metered'): Integration => ({ source: 'builtin', manifest: { manifest: 1, id, name: id, roles: ['agent'], cost } as Manifest,
  module: { async *run(_e, _d, req, ctx) {
    if (id === 'brain') { yield { type: 'done', result: answer }; return; }
    if (req.task.startsWith('fail')) { yield id === 'coder' ? { type: 'error', message: 'boom' } : { type: 'done', result: '' }; return; }
    if (req.task.startsWith('hang')) await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(ctx.signal.reason)));
    yield { type: 'done', result: `${id} did it` };
  } } });
const agents = [agent('paid', 'metered'), agent('coder', 'free'), agent('brain', 'free'), agent('helper', 'free')];
const det = (i: Integration): Detection => ({ integration: i.manifest.id, name: i.manifest.id, envId: 'windows', installs: [{ path: '/b/x', via: 'bin' }], levels: [], cost: i.manifest.cost!, connectable: 'yes', why: '' });
const snap: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }], agents: [], rejected: [], backends: [], detections: agents.map(det) };
function setup(queues: Record<string, { waiting: number; running: number }> = {}) {
  const store = new Store(':memory:'), bus = new Bus(store), consent = new Consent(bus), settings = new Settings(store), ledger = new Ledger(store), host = fakeEnv({});
  let dispatcher!: Dispatcher;
  const runner = new Runner({ bus, consent, ledger, settings, resultsDir: mkdtempSync(join(tmpdir(), 'as-disp-')), host: () => host, snapshot: () => snap, integrations: () => agents,
    route: (s, r, w) => dispatcher.route(s, r, w),
    runOn: (_e, id, req, o) => agents.find(a => a.manifest.id === id)!.module!.run!(host, det(agents.find(a => a.manifest.id === id)!), req, { ...o, inventory: { installed: [], processes: [], listening: [], env: {}, partial: [] } }) });
  dispatcher = new Dispatcher({ runner, settings, bus, ledger, live: () => ({ queues }) as never });
  const actions = () => store.eventsSince(0).filter(e => e.type === 'dispatcher.action').map(e => e.data);
  return { store, settings, ledger, runner, dispatcher, actions };
}
const T = (id: string, models: string[] = []): Target => ({ id, name: id, kind: 'agent', cost: 'free', envId: 'w', models, engine: 'module', resumable: false });

test('routePrompt and parseRoute: one id from the list (optionally :model); anything else is no pick', () => {
  assert.match(routePrompt('do x', [T('a', ['m1'])]), /- a: a, agent, free, models: m1\n\nTask:\ndo x$/);
  assert.deepEqual(parseRoute(' `a:m1`.\nbecause', [T('a', ['m1'])]), { target: 'a', model: 'm1' });
  assert.deepEqual(parseRoute('a:zz', [T('a', ['m1'])]), { target: 'a' });
  assert.equal(parseRoute('I would pick b', [T('a')]), null);
});
test('auto without a dispatcher model: the best-ranked target other than the caller; unknown targets stay errors', async () => {
  const s = setup();
  const r = await s.runner.begin('coder', { target: 'auto', task: 't' });
  assert.equal(s.ledger.get(r.id)!.target, 'brain', 'free first, scan order, never the caller');
  await assert.rejects(s.runner.begin('cli', { target: 'nope', task: 't' }), /unknown or unavailable target nope/);
  assert.equal(s.actions()[0].why, 'free, medium tier', 'why: from the ranking');
});
test('with a dispatcher model: its pick (recorded as its own run), unknown targets routed too; a bad answer falls back to the ranking', async () => {
  const s = setup(); s.settings.set('dispatcher.model', 'brain');
  answer = 'helper';
  const r = await s.runner.begin('cli', { target: 'nope', task: 'fix the tests' });
  assert.equal(s.ledger.get(r.id)!.target, 'helper');
  assert.ok(s.ledger.list({}).some(x => x.source === 'agent-spaghetti' && x.target === 'brain' && x.returnTo === 'none'));
  answer = 'no idea';
  assert.equal(s.ledger.get((await s.runner.begin('cli', { target: 'auto', task: 'x' })).id)!.target, 'coder');
  assert.match(String(s.actions().at(-1)!.why), /not a target/);
});
test('auto hops in then are routed when they start', async () => {
  const s = setup();
  const { id, done } = await s.runner.begin('cli', { target: 'coder', task: 't', then: ['auto'] });
  await done;
  assert.deepEqual(s.ledger.hops(id).map(h => h.target), ['coder', 'brain']);
});
test('watchdog: off without a model; a stuck run goes to the next target once per chain, then is reported once; its own runs are left alone', async () => {
  const s = setup();
  s.settings.setGrants([{ subject: 'cli', action: 'run', resource: '*', mode: 'allow', by: 'user', ts: 0 }]);
  const later = () => Date.now() + 3600_000, tick = () => new Promise(res => setTimeout(res, 20));
  const r = s.runner.start('cli', { target: 'paid', task: 'hang on' });
  const own = s.runner.start('agent-spaghetti', { target: 'helper', task: 'hang mine' });
  await tick();
  s.dispatcher.check(later());
  assert.equal(s.actions().length, 0, 'off');
  s.settings.set('dispatcher.model', 'brain');
  s.dispatcher.check(later()); await tick();
  const hops = s.ledger.hops(r.id);
  assert.deepEqual(hops.map(h => [h.target, h.outcome]), [['paid', 'error'], ['coder', 'running']]);
  assert.equal(hops[0].error, 'no progress: handed to coder');
  s.dispatcher.check(later()); s.dispatcher.check(later());
  assert.deepEqual(s.actions().map(a => a.what), ['handed-over', 'stuck'], 'second time: reported once, left to its deadline');
  assert.equal(s.ledger.get(own.id)!.outcome, 'running');
  s.runner.active().forEach(a => s.runner.cancel(a.id));
  await r.done; await own.done;
});
test('auto: among equally cheap targets the one with the shortest queue', async () => {
  const { dispatcher } = setup({ coder: { waiting: 2, running: 1 } });
  assert.equal((await dispatcher.route('cli', { target: 'auto', task: 't' })).target, 'brain', 'coder is busy: the next free one');
});
test('escalation: a target Agent Spaghetti chose fails or answers nothing → the next in the ranking, once per chain; a named target never escalates', async () => {
  const s = setup();
  const r = await s.runner.begin('cli', { target: 'auto', task: 'fail: summarize this' });
  const hops = s.ledger.hops((await r.done).chainId);
  assert.deepEqual(hops.map(h => [h.target, h.outcome]), [['coder', 'error'], ['brain', 'done']], 'brain answered nothing: once per chain, so the chain ends there');
  assert.deepEqual(s.actions().filter(a => a.what === 'escalated').map(a => [a.from, a.to]), [['coder', 'brain']]);
  const named = await s.runner.begin('cli', { target: 'coder', task: 'fail again' });
  assert.equal(s.ledger.hops((await named.done).chainId).length, 1);
  s.settings.set('routing.escalate', false);
  assert.equal(s.ledger.hops((await (await s.runner.begin('cli', { target: 'auto', task: 'fail once more' })).done).chainId).length, 1);
});
test('routing settings shape the pick: your pick per kind first, never for a kind skipped, the kind that needs an agent', async () => {
  const s = setup();
  s.settings.setText('routing.prefer', 'summarize=helper'); s.settings.setText('routing.never', 'summarize=coder');
  const r = s.dispatcher.ranking({ kind: 'summarize', difficulty: 'light' }, 'cli');
  assert.deepEqual(r.map(x => [x.target.id, x.skip ?? '']), [['helper', ''], ['brain', ''], ['paid', ''], ['coder', 'never for summarize (your choice)']]);
  assert.equal((await s.runner.begin('cli', { target: 'auto', task: 'summarize the notes' })).id > 0, true);
  assert.equal(s.actions().at(-1)!.to, 'helper');
  assert.match(String(s.actions().at(-1)!.why), /^your pick for summarize, free/);
});
test('delegate.models: an agent target without a model in the task uses the owner\'s default for it', async () => {
  const s = setup(); s.settings.setText('delegate.models', 'coder=fast');
  const r = s.runner.start('cli', { target: 'coder', task: 'summarize x' });
  assert.equal((await r.done).model, 'fast');
  assert.equal((await s.runner.start('cli', { target: 'coder', task: 'summarize y', model: 'other' }).done).model, 'other', 'the task\'s own model wins');
});
