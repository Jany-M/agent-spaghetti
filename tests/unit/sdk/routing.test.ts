// I2 routing (finish-line plan, Part I): tiers from model names and the owner's overrides, run stats from the record, and the
// ranking for one task (fit, cost, stretch, history, queue; skips with why).
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSize, route, summarizeRuns, tierOf, type RunRow, type Target } from '@agent-spaghetti/sdk';

const T = (id: string, o: Partial<Target> = {}): Target => ({ id, name: id, kind: 'model', cost: 'free', envId: 'w', models: [], engine: 'openai', resumable: false, ...o });
test('tiers: model size from its name (active size when stated), paid → heavy, agents → medium, the owner\'s entry wins', () => {
  assert.deepEqual(['qwen2.5-7b-instruct', 'google/gemma-4-e4b', 'Qwen3-30B-A3B', 'llama-3.3-70b', 'mistral-small', 'phi-3.5-mini'].map(modelSize), [7, 4, 3, 70, null, null]);
  assert.deepEqual([T('a', { models: ['x-7b'] }), T('b', { models: ['x-14b'] }), T('c', { models: ['x-70b'] }), T('d', { models: ['x'] }), T('e', { cost: 'metered' }), T('f', { kind: 'agent' })]
    .map(t => tierOf(t)), ['light', 'medium', 'heavy', 'medium', 'heavy', 'medium']);
  assert.equal(tierOf(T('a', { models: ['x-7b'] }), ['a=heavy']), 'heavy');
  assert.equal(tierOf(T('a', { models: ['x-7b', 'y'] }), ['a:y=light', 'a=heavy'], 'y'), 'light', 'target:model before target');
});
test('stats: per kind and target, recency-weighted; Bad/Redo and errors count against; cancelled and denied runs say nothing', () => {
  const day = 864e5, now = 100 * day;
  const r = (target: string, outcome: RunRow['outcome'], o: Partial<RunRow> = {}): RunRow => ({ id: 1, chainId: 1, ts: now, source: 'cli', target, kind: 'summarize', taskHash: 'h', outcome, ...o });
  const s = summarizeRuns([r('a', 'done', { durationMs: 10 }), r('a', 'done', { verdict: 'down', durationMs: 30 }), r('a', 'error'), r('a', 'cancelled'), r('a', 'denied'),
    r('b', 'error', { ts: now - 60 * day }), r('b', 'done')], now);
  assert.deepEqual(s['summarize a'], { runs: 3, rate: 1 / 3, bad: 1, medianMs: 30 });
  assert.equal(s['summarize b'].runs, 2); assert.equal(Math.round(s['summarize b'].rate * 100), 80, 'an old failure weighs a quarter (two half-lives)');
});
test('route: fit before cost, stretch lets a free smaller target try first, history (with learn) after cost, queue last; skips last', () => {
  const ts = [T('paid', { cost: 'metered' }), T('small', { models: ['m-4b'] }), T('mid', { models: ['m-14b'] }), T('mid2', { models: ['n-14b'] }), T('agent', { kind: 'agent', engine: 'acp' })];
  const ids = (r: ReturnType<typeof route>) => r.map(x => x.target.id);
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'medium' }, ts)), ['mid', 'mid2', 'agent', 'paid', 'small'], 'small is below medium: last');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'medium' }, ts, { stretch: true })), ['mid', 'mid2', 'agent', 'small', 'paid'], 'stretch: free and one tier below, before paid');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'heavy' }, ts, { stretch: true })), ['mid', 'mid2', 'agent', 'paid', 'small'], 'free medium ones try a heavy task before paying');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'heavy' }, ts)), ['paid', 'mid', 'mid2', 'agent', 'small']);
  const good = { runs: 6, rate: 1, bad: 0 }, bad = { runs: 6, rate: 0.2, bad: 3 };
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'medium' }, ts, { learn: true, stats: { 'summarize mid': bad, 'summarize mid2': good } })).slice(0, 3), ['mid2', 'agent', 'mid']);
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'medium' }, ts, { stats: { 'summarize mid': bad, 'summarize mid2': good } })).slice(0, 2), ['mid', 'mid2'], 'learn off: history shown, not used');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'medium' }, ts, { queued: id => (id === 'mid' ? 2 : 0) })).slice(0, 3), ['mid2', 'agent', 'mid'], 'a busy one goes after its equals');
  const edit = route({ kind: 'code-edit', difficulty: 'light', edits: true }, ts, { source: 'agent' });
  assert.ok(edit.every(x => x.skip), 'models cannot edit files; the only agent is the caller');
  assert.equal(route({ kind: 'code-edit', difficulty: 'light' }, ts)[0].target.id, 'small', 'no folder: a model can write the change as text');
  assert.equal(edit.find(x => x.target.id === 'agent')!.skip, 'the caller itself');
  assert.match(route({ kind: 'summarize', difficulty: 'medium' }, ts, { stretch: true, stats: { 'summarize small': { runs: 2, rate: 1, bad: 0 } } }).find(x => x.target.id === 'small')!.why,
    /^free, light tier \(stretch: tries a medium task, escalates if it fails\), summarize: 2 runs, 100% ok \(too few to count yet\)$/);
});
