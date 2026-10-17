// Hand-off chains (ADR 0010): hops with context, the hop budget, and where the result goes back (inline, resumed, unread).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Detection, Integration, Manifest, RunRequest, RunRow, Snapshot } from '@agent-spaghetti/sdk';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';
import { Consent } from '../../../packages/core/src/consent.ts';
import { Settings } from '../../../packages/core/src/settings.ts';
import { Ledger } from '../../../packages/core/src/ledger.ts';
import { Runner, parseHop } from '../../../packages/core/src/runner.ts';

/** Agents that answer `<id>(<task>)`; `resumes` ones report a session; the paid one costs money. */
const seen: Array<{ id: string; req: RunRequest }> = [];
const agent = (id: string, cost: 'free' | 'metered', resumes = false): Integration => ({ source: 'builtin', manifest: { manifest: 1, id, name: id, roles: ['agent'], cost } as Manifest,
  module: { resumes, async *run(_e, _d, req) {
    seen.push({ id, req });
    if (resumes) yield { type: 'session', id: req.session ?? `${id}-s1` };
    if (req.task.startsWith('slow')) await new Promise(r => setTimeout(r, 60));
    yield { type: 'done', result: `${id}(${req.task.split('\n')[0]})` };
  } } });
const agents = [agent('editor', 'free', true), agent('coder', 'free'), agent('paid', 'metered'), agent('chatty', 'free')];
const det = (integration: string): Detection => ({ integration, name: integration, envId: 'windows', installs: [{ path: '/b/x', via: 'bin' }], levels: [],
  cost: agents.find(a => a.manifest.id === integration)!.manifest.cost!, connectable: 'yes', why: '' });
const snap: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }], agents: [], rejected: [], backends: [], detections: agents.map(a => det(a.manifest.id)) };
function setup() {
  const store = new Store(':memory:'), bus = new Bus(store), consent = new Consent(bus), settings = new Settings(store), ledger = new Ledger(store), host = fakeEnv({});
  const runner = new Runner({ bus, consent, ledger, settings, resultsDir: mkdtempSync(join(tmpdir(), 'as-chain-')), host: () => host, snapshot: () => snap, integrations: () => agents,
    runOn: (_envId, id, req, o) => agents.find(a => a.manifest.id === id)!.module!.run!(host, det(id), req, { ...o, inventory: { installed: [], processes: [], listening: [], env: {}, partial: [] } }) });
  return { store, consent, settings, ledger, runner };
}
const delivered = async (l: Ledger, id: number) => { for (let i = 0; i < 100 && !l.get(id)!.delivered; i++) await new Promise(r => setTimeout(r, 5)); return l.get(id)!.delivered; };

test('parseHop: target[:model], models may contain colons', () => {
  assert.deepEqual(parseHop('coder'), { target: 'coder' });
  assert.deepEqual(parseHop('lms:qwen/q:7b'), { target: 'lms', model: 'qwen/q:7b' });
});
test('chain: each hop gets the previous result as context; one chain id; nobody waiting → unread, given once', async () => {
  const s = setup(); seen.length = 0;
  const { id, done } = s.runner.start('cli', { target: 'coder', task: 'plan it', then: ['chatty', 'coder:fast'] });
  const last = await done;
  const hops = s.ledger.hops(id);
  assert.deepEqual(hops.map(h => [h.source, h.target, h.chainId, h.parentRunId ?? null]), [['cli', 'coder', id, null], ['coder', 'chatty', id, id], ['chatty', 'coder', id, hops[1].id]]);
  assert.equal(seen[1].req.task, 'plan it\n\n## Context from the previous step\ncoder(plan it)');
  assert.equal(seen[2].req.model, 'fast');
  assert.equal(s.ledger.result(last), 'coder(plan it)');
  assert.equal(await delivered(s.ledger, id), 'unread');
  assert.deepEqual(s.ledger.unread('cli').map(r => r.id), [id]);
  assert.deepEqual(s.ledger.unread('coder'), [], 'only the chain\'s caller gets it');
});
test('chain: a caller still polling gets it inline; returnTo none sends nothing back', async () => {
  const s = setup();
  const a = s.runner.start('cli', { target: 'coder', task: 'slow one' });
  s.runner.watch(a.id); await a.done;
  assert.equal(await delivered(s.ledger, a.id), 'inline');
  const b = s.runner.start('cli', { target: 'coder', task: 'x', returnTo: 'none' }); await b.done;
  await new Promise(r => setTimeout(r, 20));
  assert.equal(s.ledger.get(b.id)!.delivered, undefined);
});
test('chain: a caller whose engine resumes gets a report run in its own session, without a new question', async () => {
  const s = setup(); seen.length = 0;
  const parent = s.runner.start('cli', { target: 'editor', task: 'slow work' });
  await new Promise(r => setTimeout(r, 10));
  const child = s.runner.start('editor', { target: 'coder', task: 'sub', then: ['paid'] });   // editor delegates while it runs
  assert.equal(s.ledger.get(child.id)!.parentRunId, parent.id);
  const q = await (async () => { for (let i = 0; i < 50 && !s.consent.pending().length; i++) await new Promise(r => setTimeout(r, 5)); return s.consent.pending()[0]; })();
  assert.equal(q.resource, 'paid', 'a paid hop in the middle still asks');
  s.consent.respond(q.id, true, 'once');
  await child.done; await parent.done;
  assert.equal(await delivered(s.ledger, child.id), 'resumed');
  const report = await (async () => { for (let i = 0; i < 100; i++) { const r = s.ledger.list({ target: 'editor' }).find(x => x.kind === 'report'); if (r?.outcome === 'done') return r; await new Promise(r => setTimeout(r, 5)); } })() as RunRow;
  assert.deepEqual([report.session, report.returnTo, s.consent.pending().length], ['editor-s1', 'none', 0]);
  assert.match(seen.find(x => x.req.kind === 'report')!.req.task, /^The work you handed off \(run \d+: coder → paid\) is done\. Result:\n\npaid\(sub\)/);
});
test('chain: hop budget stops loops; a next hop that cannot start ends the chain with a note', async () => {
  const s = setup();
  s.settings.set('delegate.maxHops', 2 as never);
  const { id, done } = s.runner.start('cli', { target: 'coder', task: 'loop', then: ['chatty', 'coder'] });
  const last = await done;
  assert.equal(s.ledger.hops(id).length, 2);
  assert.match(last.error!, /next hop not started: hop budget reached: 2/);
  assert.throws(() => s.runner.start('cli', { target: 'coder', task: 'x', then: ['nope'] }), /unknown or unavailable target nope in then/);
});
test('ledger: rows a stopped daemon left running are marked', () => {
  const store = new Store(':memory:'), l = new Ledger(store);
  const id = l.record({ ts: 1, source: 'a', target: 'b', kind: 'other', taskHash: 'h', outcome: 'running' });
  l.abandonRunning();
  assert.deepEqual([l.get(id)!.outcome, l.get(id)!.chainId], ['error', id]);
});
