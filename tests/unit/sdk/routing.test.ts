// I2 routing (finish-line plan, Part I): tiers from model names and the owner's overrides, run stats from the record, and the
// ranking for one task (fit, cost, stretch, history, queue; skips with why).
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelSize, offloadText, route, savings, summarizeRuns, tierOf, withCosts, type Ranked, type RunRow, type Target } from '@agent-spaghetti/sdk';

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
test('route: a free agent busy with another task goes after the idle ones (before paid); a busy paid agent takes more; a busy pick is no pick', () => {
  const A = (id: string, o: Partial<Target> = {}) => T(id, { kind: 'agent', engine: 'module', ...o });
  const ts = [A('kilo'), A('cline'), A('paid', { cost: 'metered' })];
  const ids = (r: Ranked[]) => r.map(x => x.target.id);
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'light' }, ts)), ['kilo', 'cline', 'paid']);
  const busy = route({ kind: 'summarize', difficulty: 'light' }, ts, { busy: id => id === 'kilo' });
  assert.deepEqual(ids(busy), ['cline', 'kilo', 'paid'], 'the next one in line takes it');
  assert.match(busy[1].why, /busy with another task/);
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'light' }, ts, { busy: id => id !== 'paid' })), ['kilo', 'cline', 'paid'], 'all free ones busy: still before paying');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'light' }, [A('paid', { cost: 'metered' }), A('paid2', { cost: 'metered' })], { busy: () => true })), ['paid', 'paid2'], 'paid agents are not held back');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'light' }, ts, { busy: id => id === 'kilo', prefer: ['summarize=kilo'] })), ['cline', 'kilo', 'paid'], 'even your pick: no waiting');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'light' }, [T('lms'), A('kilo')], { busy: () => true }))[0], 'lms', 'models queue instead (their server takes requests side by side)');
});
test('route: research needs the web (unpaid with web, then unpaid without, then paid); plan never stretches; a second local model is never loaded', () => {
  const ts = [T('lms', { models: ['m-4b'] }), T('browser', { kind: 'agent', engine: 'module', cost: 'unknown', web: true }), T('paid', { kind: 'agent', engine: 'module', cost: 'metered', web: true })];
  const ids = (r: ReturnType<typeof route>) => r.map(x => x.target.id);
  assert.deepEqual(ids(route({ kind: 'research', difficulty: 'light' }, ts, { web: true })), ['browser', 'lms', 'paid']);
  assert.match(route({ kind: 'research', difficulty: 'light' }, ts, { web: true })[1].why, /no web access/);
  assert.deepEqual(ids(route({ kind: 'research', difficulty: 'light' }, ts)), ['lms', 'browser', 'paid'], 'it brings its sources: cheapest first as usual');
  const mid = [T('mid', { models: ['m-14b'] }), T('paid', { cost: 'metered' })];
  assert.deepEqual(ids(route({ kind: 'plan', difficulty: 'light' }, mid, { stretch: true })), ['paid', 'mid'], 'a frontier kind: the strongest first whatever its size, no free try below it');
  assert.deepEqual(ids(route({ kind: 'summarize', difficulty: 'heavy' }, mid, { stretch: true })), ['mid', 'paid']);
  const own = [T('lms', { name: 'LMS', models: ['m-4b'] }), T('self', { kind: 'agent', engine: 'module', loads: 'its own local model' })];
  assert.equal(route({ kind: 'summarize', difficulty: 'light' }, own)[1].skip, 'would load its own local model while LMS has a model loaded (name it as the target to do that)');
  assert.equal(route({ kind: 'summarize', difficulty: 'light' }, [own[1]])[0].skip, undefined, 'nothing else loaded: it may load its own');
  assert.equal(route({ kind: 'summarize', difficulty: 'light' }, own, { prefer: ['summarize=self'] })[0].skip, undefined, 'your pick for the kind is your say-so');
});
test('offloadText and savings: the kinds a tool hands off unasked; what free targets did', () => {
  assert.match(offloadText(['summarize', 'research']), /^Without being asked, hand these kinds of task to `delegate` with target `auto` instead of doing them yourself: summarize, research\./);
  assert.equal(offloadText([]), '');
  const r = (o: Partial<RunRow>): RunRow => ({ id: 1, chainId: 1, ts: 100, source: 'ide', target: 'lms', kind: 'summarize', taskHash: 'h', outcome: 'done', ...o });
  const rows = [r({ inputTokens: 50, outputTokens: 20 }), r({ ts: 5 }), r({ outcome: 'error' }), r({ target: 'paid' }), r({ source: 'agent-spaghetti' })];
  assert.deepEqual(savings(rows, t => t === 'lms'), { tasks: 2, tokens: 70 });
  assert.deepEqual(savings(rows, t => t === 'lms', 50), { tasks: 1, tokens: 70 });
});
test('withCosts: the owner\'s word on a tool\'s cost replaces the scan\'s; unknown values are ignored', () => {
  const d = (integration: string, cost: 'free' | 'metered' | 'unknown') => ({ integration, name: integration, envId: 'w', installs: [], levels: [], cost, connectable: 'yes' as const, why: '' });
  const snap = { detections: [d('a', 'metered'), d('b', 'unknown')] };
  assert.deepEqual(withCosts(snap, ['a=free', 'b=cheap'])!.detections.map(x => x.cost), ['free', 'unknown']);
  assert.equal(withCosts(snap, []), snap); assert.equal(withCosts(null, ['a=free']), null);
});
