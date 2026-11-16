// The flow diagram (plan 2026-11-16-flow-diagram): the pure model (who works for whom, in at most three words) and what is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { liveState, type LiveRun } from '@agent-spaghetti/sdk';
import { FlowView, HUB, flowLayout, flowModel, shortName } from '@agent-spaghetti/ui';

const row = (id: string, name: string, o: object = {}) => ({ id, name, state: 'installed' as const, group: 'agents' as const, ...o });
const rows = [row('ide', 'Acme IDE', { connection: 'connected' }), row('helper', 'Helper Agent CLI', { receives: 'module' }), row('lms', 'Local Models', { group: 'models', receives: 'openai' }),
  row('mem', 'MemStore', { group: 'tools' }), row('gone', 'Gone', { state: 'not found', group: 'tools' }), row('idle', 'Unconnected', { connection: 'not connected' })];
const run = (o: Partial<LiveRun>): LiveRun => ({ id: 1, source: 'ide', target: 'helper', ts: 1000, ...o });
const words = (s: string) => s.split(' ').length;

test('flowModel idle: the hub and every tool that is connected, takes tasks or serves others; nothing lit', () => {
  const f = flowModel(rows, [], 5000);
  assert.deepEqual(f.nodes.map(n => n.id), [HUB, 'ide', 'helper', 'lms', 'mem']);
  assert.deepEqual([f.nodes[0].label, f.nodes.some(n => n.on), f.links], ['idle', false, []]);
  assert.deepEqual([shortName('Helper Agent CLI'), shortName('LM Studio'), shortName('X')], ['Helper', 'LMStudio', 'X']);
});
test('flowModel with a run: who works for whom, who waits, the hub routing then counting; a chain names its next step', () => {
  const f = flowModel(rows, [run({ kind: 'research', next: 'lms:m1' })], 2000);
  const by = Object.fromEntries(f.nodes.map(n => [n.id, n]));
  assert.deepEqual([by.helper.label, by.helper.sub, by.ide.label, by[HUB].label], ['researching for Acme', 'then Local', 'waiting on Helper', 'routing task']);
  assert.deepEqual([by.helper.on, by.ide.on, by.lms.on, by[HUB].on], [true, true, false, true]);
  assert.deepEqual(f.links, [{ from: 'ide', to: 'helper' }]);
  assert.equal(flowModel(rows, [run({ kind: 'research' })], 9000).nodes[0].label, '1 task running', 'after the first seconds');
  assert.equal(flowModel(rows, [run({}), run({ id: 2, target: 'lms' })], 9000).nodes[0].label, '2 tasks running');
  assert.equal(flowModel(rows, [run({ kind: 'unheard-of' })], 9000).nodes.find(n => n.id === 'helper')!.label, 'working for Acme', 'a kind without a verb');
});
test('flowModel: a caller that is not a listed tool (the tray, a terminal) gets a block; labels never exceed three words', () => {
  const f = flowModel(rows, [run({ source: 'tray', target: 'lms', kind: 'code-edit' }), run({ id: 2, source: 'ide', target: 'helper', kind: 'plan', next: 'lms' })], 9000);
  assert.ok(f.nodes.some(n => n.id === 'tray' && n.label === 'waiting on Local'));
  assert.equal(f.nodes.find(n => n.id === 'lms')!.label, 'coding for tray');
  assert.ok(f.nodes.every(n => words(n.label || 'x') <= 3 && words(n.sub ?? 'x') <= 3));
});
test('the reducer feeds it: run.started carries kind and the next hop; run.finished clears the run', () => {
  const ev = (id: number, type: string, data: object) => ({ id, ts: id, type, envId: 'hub', source: 'runner', data }) as never;
  const live = liveState([ev(1, 'run.started', { id: 7, source: 'ide', target: 'helper', kind: 'summarize', next: 'lms' })]);
  assert.deepEqual(live.runs[7], { id: 7, source: 'ide', target: 'helper', ts: 1, kind: 'summarize', next: 'lms' });
  assert.deepEqual(liveState([ev(2, 'run.finished', { id: 7 })], live).runs, {});
});
test('FlowView: blocks in their tool color, the working ones and the moving lines marked, an arrow toward the worker; nothing animated when still', () => {
  const f = flowModel(rows, [run({ kind: 'review' })], 9000);
  const { at, height } = flowLayout(f.nodes);
  assert.deepEqual([at[HUB], height], [{ x: 180, y: 74 }, 148]);
  const many = flowLayout(flowModel(Array.from({ length: 15 }, (_, i) => row(`t${i}`, `Tool${i}`, { receives: 'module' })), [], 0).nodes), spots = Object.values(many.at);
  assert.ok(spots.every((p, i) => spots.every((q, j) => i === j || Math.abs(p.x - q.x) >= 96 || Math.abs(p.y - q.y) >= 36)), 'no two blocks overlap, however many tools');
  const page = html(h(FlowView, { flow: f }));
  assert.match(page, /<svg class="flow" viewBox="0 0 360 148" role="img" aria-label="Agent Spaghetti: 1 task running; Acme: waiting on Helper; Helper: reviewing for Acme">/);
  assert.equal((page.match(/class="link tc\d"/g) ?? []).length, 2, 'caller → hub → worker, in the worker\'s color');
  assert.match(page, /marker-end="url\(#flow-head\)"/);
  assert.match(page, /<g class="node tc\d on"[^>]*><rect[^>]*><\/rect><text class="name"[^>]*>Helper<\/text><text class="what"[^>]*>reviewing for Acme<\/text>/);
  assert.match(page, /<g class="node hub on"/); assert.match(page, /<g class="node tc\d"[^>]*><rect[^>]*><\/rect><text class="name"[^>]*>MemStore<\/text><\/g>/, 'an idle block: its name only');
  assert.match(html(h(FlowView, { flow: f, still: true })), /<svg class="flow still"/);
  assert.match(html(h(FlowView, { flow: flowModel(rows, [], 0) })), /aria-label="Nothing running"/);
});
