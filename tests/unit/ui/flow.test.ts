// The flow diagram (plan 2026-11-16-flow-diagram): the pure model (who works for whom, what comes back), the grouped layout for any
// space, and what is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { liveState, type LiveResult, type LiveRun } from '@agent-spaghetti/sdk';
import { FLOW_MIN, FlowView, HUB, flowLayout, flowModel, type FlowBox } from '@agent-spaghetti/ui';

const row = (id: string, name: string, o: object = {}) => ({ id, name, state: 'installed' as const, group: 'agents' as const, ...o });
const rows = [row('ide', 'Acme IDE', { group: 'apps', connection: 'connected' }), row('helper', 'Helper Agent CLI', { receives: 'module' }),
  row('lms', 'Local Models', { group: 'models', receives: 'openai' }), row('mem', 'MemStore', { group: 'tools' }),
  row('gone', 'Gone', { state: 'not found', group: 'tools' }), row('idle', 'Unconnected', { connection: 'not connected' })];
const run = (o: Partial<LiveRun>): LiveRun => ({ id: 1, source: 'ide', target: 'helper', ts: 1000, ...o });
const result = (o: Partial<LiveResult>): LiveResult => ({ id: 1, from: 'helper', to: 'ide', how: 'unread', ts: 1000, ...o });

test('flowModel idle: the hub and every tool that is connected, takes tasks or serves others, with its group; nothing lit', () => {
  const f = flowModel(rows, [], [], 5000);
  assert.deepEqual(f.nodes.map(n => [n.id, n.group]), [[HUB, 'hub'], ['ide', 'apps'], ['helper', 'agents'], ['lms', 'models'], ['mem', 'tools']]);
  assert.deepEqual([f.nodes[0].label, f.nodes.some(n => n.on), f.links], ['idle', false, []]);
});
test('flowModel: an app that is set up but not open is drawn dim and says so; open, or taking part, it is not', () => {
  const closed = [...rows.filter(r => r.id !== 'ide'), row('ide', 'Acme IDE', { group: 'apps', connection: 'connected', open: false })];
  const ide = (f: ReturnType<typeof flowModel>) => f.nodes.find(n => n.id === 'ide')!;
  assert.deepEqual([ide(flowModel(closed, [], [], 0)).off, ide(flowModel(closed, [], [], 0)).label], [true, 'not open']);
  assert.equal(ide(flowModel(closed.map(r => (r.id === 'ide' ? { ...r, open: true } : r)), [], [], 0)).off, undefined);
  assert.equal(ide(flowModel(closed, [run({})], [], 0)).off, undefined, 'a run from it: it is open after all');
  assert.match(html(h(FlowView, { flow: flowModel(closed, [], [], 0) })), /<g class="node tc\d off"/);
});
test('FlowView: a block says which program Agent Spaghetti works with (its CLI or its app)', () => {
  const page = html(h(FlowView, { flow: flowModel([...rows.filter(r => r.id !== 'helper'), row('helper', 'Helper Agent', { receives: 'module', uses: 'cli' })], [], [], 0) }));
  assert.match(page, /<text class="uses"[^>]*>CLI<\/text><text class="name"[^>]*>Helper Agent<\/text>/);
});
test('flowModel with a run: who works for whom, who waits, the hub routing then counting; a chain names its next step', () => {
  const f = flowModel(rows, [run({ kind: 'research', next: 'lms:m1' })], [], 2000);
  const by = Object.fromEntries(f.nodes.map(n => [n.id, n]));
  assert.deepEqual([by.helper.label, by.helper.sub, by.ide.label, by[HUB].label], ['researching for Acme IDE', 'then Local Models', 'waiting on Helper Agent CLI', 'routing task']);
  assert.deepEqual([by.helper.on, by.ide.on, by.lms.on, by[HUB].on], [true, true, false, true]);
  assert.deepEqual(f.links, [{ from: 'ide', to: 'helper' }]);
  assert.equal(flowModel(rows, [run({ kind: 'research' })], [], 9000).nodes[0].label, '1 task running', 'after the first seconds');
  assert.equal(flowModel(rows, [run({}), run({ id: 2, target: 'lms' })], [], 9000).nodes[0].label, '2 tasks running');
  assert.equal(flowModel(rows, [run({ kind: 'unheard-of' })], [], 9000).nodes.find(n => n.id === 'helper')!.label, 'working for Acme IDE', 'a kind without a verb');
});
test('flowModel results: a result nobody collected keeps its line moving back; a delivered one shows for a few seconds', () => {
  const waiting = flowModel(rows, [], [result({})], 999_999);
  assert.deepEqual(waiting.links, [{ from: 'helper', to: 'ide', back: true, waiting: true }]);
  assert.deepEqual(waiting.nodes.filter(n => n.on).map(n => [n.id, n.label]), [[HUB, 'returning result'], ['ide', 'result waiting'], ['helper', 'answered Acme IDE']]);
  assert.deepEqual(flowModel(rows, [], [result({ how: 'inline', ts: 1000 })], 3000).links, [{ from: 'helper', to: 'ide', back: true }]);
  assert.deepEqual(flowModel(rows, [], [result({ how: 'inline', ts: 1000 })], 9000).links, [], 'gone after a few seconds');
  assert.deepEqual(flowModel(rows, [], [result({ how: 'pending' })], 1000).links, [], 'a finished step of a chain still going: its run shows it');
});
test('flowModel: a caller that is not a listed tool (the tray, a terminal) gets a block with the callers', () => {
  const f = flowModel(rows, [run({ source: 'tray', target: 'lms', kind: 'code-edit' }), run({ id: 2, source: 'ide', target: 'helper', kind: 'plan', next: 'lms' })], [], 9000);
  assert.ok(f.nodes.some(n => n.id === 'tray' && n.group === 'callers' && n.label === 'waiting on Local Models'));
  assert.equal(f.nodes.find(n => n.id === 'lms')!.label, 'coding for tray');
});
test('the reducer feeds it: runs come and go; a chain\'s result is tracked until its caller collects it', () => {
  const ev = (id: number, type: string, data: object) => ({ id, ts: id, type, envId: 'hub', source: 'runner', data }) as never;
  const live = liveState([ev(1, 'run.started', { id: 7, source: 'ide', target: 'helper', kind: 'summarize', next: 'lms' })]);
  assert.deepEqual(live.runs[7], { id: 7, source: 'ide', target: 'helper', ts: 1, kind: 'summarize', next: 'lms' });
  const done = liveState([ev(2, 'run.finished', { id: 7, chainId: 7 })], live);
  assert.deepEqual([done.runs, done.results[7]], [{}, { id: 7, from: 'helper', to: 'ide', how: 'pending', ts: 2 }]);
  const unread = liveState([ev(3, 'run.delivered', { id: 7, how: 'unread', to: 'ide' })], done);
  assert.equal(unread.results[7].how, 'unread');
  assert.equal(liveState([ev(4, 'run.delivered', { id: 7, how: 'read', to: 'ide' })], unread).results[7].how, 'read');
});
test('flowLayout: a solar system: planets never touch each other or the sun, stay inside, fill the window, grouped in arcs', () => {
  const many = flowModel([...rows, ...Array.from({ length: 9 }, (_, i) => row(`t${i}`, `Tool${i}`, { receives: 'module' })),
    row('m2', 'More Models', { group: 'models', receives: 'openai' }), row('ed', 'Editor', { group: 'apps', connection: 'connected' })], [], [], 0).nodes;
  const six = flowModel(Array.from({ length: 6 }, (_, i) => row(`a${i}`, `Agent${i}`, { receives: 'module' })), [], [], 0).nodes;
  for (const nodes of [many, six, flowModel(rows, [], [], 0).nodes])
    for (const [w, ht] of [[380, undefined], [420, undefined], [520, 420], [650, 490], [760, 560], [1200, 760], [1400, 900]] as const) {
      const p = flowLayout(nodes, w, ht), planets = Object.entries(p.boxes).filter(([id]) => id !== HUB).map(([, b]) => b);
      const apart = (a: FlowBox, b: FlowBox) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      const reach = (b: FlowBox) => Math.hypot(Math.max(b.x - p.cx, 0, p.cx - b.x - b.w), Math.max(b.y - p.cy, 0, p.cy - b.y - b.h));
      assert.ok(planets.every((a, i) => planets.every((b, j) => i === j || apart(a, b))), `no overlaps at ${w}×${ht}`);
      assert.ok(planets.every(b => reach(b) >= p.r + 10), `clear of the sun at ${w}×${ht}`);
      assert.ok(planets.every(b => b.x >= 0 && b.x + b.w <= w && b.y >= 0 && b.y + b.h <= p.height), `inside at ${w}×${ht}`);
      if (ht && (w >= 760 || nodes !== many)) assert.equal(p.height, ht, `fills the window at ${w}×${ht}`);   // sixteen tools in a small window: it scrolls
    }
  const p = flowLayout(flowModel(rows, [], [], 0).nodes, 760, 560), at = (id: string) => p.boxes[id], mid = (b: FlowBox) => [b.x + b.w / 2 - p.cx, b.y + b.h / 2 - p.cy];
  assert.ok(mid(at('lms'))[1] < 0 && Math.abs(mid(at('lms'))[0]) < 1, 'model servers at the top');
  assert.ok(mid(at('helper'))[0] > 0 && mid(at('ide'))[0] < 0 && mid(at('mem'))[1] > 0, 'agents right, other tools below, editors left');
  assert.deepEqual(p.captions.map(c => c.text), ['models', 'agents', 'tools', 'apps']);
  assert.equal(p.orbits.length, 1, 'one orbit when there is room');
  assert.ok(flowLayout(many, 760, 560).orbits.length > 1, 'crowded: neighbours alternate between orbits');
  const twenty = flowModel(Array.from({ length: 20 }, (_, i) => row(`z${i}`, `Tool${i}`, { group: ['agents', 'models', 'tools', 'apps'][i % 4], receives: 'module' })), [], [], 0).nodes;
  for (const nodes of [many, six, twenty]) for (const [w, ht] of [[0, 0], [100, 80], [200, undefined], [359, 299], [300, 1000], [2000, 120]] as Array<[number, number | undefined]>) {
    const p = flowLayout(nodes, w, ht);                        // a window made tiny: the drawing keeps its smallest size and scrolls
    assert.ok(p && p.width === Math.max(w, FLOW_MIN.width) && p.height >= (ht === undefined ? 0 : Math.max(ht, FLOW_MIN.height)), `a drawing at ${w}×${ht}`);
  }
  assert.deepEqual(flowLayout(six, 100, 80).boxes, flowLayout(six, 200, 150).boxes, 'below the smallest size nothing moves');
  const big = flowLayout(six, 1400, 900), small = flowLayout(six, 650, 490);
  assert.ok(big.k > small.k && big.boxes.a0.w > small.boxes.a0.w, 'planets grow with the window');
});
test('FlowView: blocks in their tool color, lights moving along the lines while work or a result is on its way; nothing animated when still', () => {
  const f = flowModel(rows, [run({ kind: 'review' })], [result({ id: 2, from: 'lms', to: 'ide' })], 9000);
  const page = html(h(FlowView, { flow: f, size: { width: 400 } }));
  assert.match(page, /<svg class="flow" viewBox="0 0 400 \d+" width="400"[^>]*aria-label="Agent Spaghetti: 1 task running; Acme IDE: waiting on Helper Agent CLI; Helper Agent CLI: reviewing for Acme IDE; Local Models: answered Acme IDE"/);
  assert.equal((page.match(/class="link tc\d"/g) ?? []).length, 2, 'caller → hub → worker, in the worker\'s color');
  assert.equal((page.match(/class="link tc\d waiting"/g) ?? []).length, 2, 'worker → hub → caller while the result waits');
  assert.equal((page.match(/<animateMotion /g) ?? []).length, 12, 'three lights on each of the four lines');
  assert.doesNotMatch(page, /marker-end/, 'no arrowheads');
  assert.match(page, /<g class="node tc\d on"[^>]*><title>Helper Agent CLI: reviewing for Acme IDE<\/title>.*?<text class="name"[^>]*>Helper Agent CLI<\/text><text class="what"[^>]*>reviewing for<\/text><text class="what"[^>]*>Acme IDE<\/text>/, 'a label broken between words');
  const chain = html(h(FlowView, { flow: flowModel(rows, [run({ kind: 'research', next: 'lms' })], [], 9000), size: { width: 400 } }));
  assert.match(chain, /<text class="what next"[^>]*>then Local Models<\/text>/);
  const long = html(h(FlowView, { flow: flowModel([...rows, row('x', 'An Extremely Long Integration Name Indeed', { receives: 'module' })], [run({ target: 'x', kind: 'review' })], [], 9000), size: { width: 400 } }));
  assert.match(long, /<text class="name"[^>]*>An Extremely L[^<]*…<\/text>/, 'a long name is cut, the tooltip has it whole');
  assert.match(page, /<g class="node hub on"><title>Agent Spaghetti: 1 task running<\/title><circle class="corona"/);
  assert.match(page, /<textPath href="#flow-cap-top" startOffset="25%">models<\/textPath>/, 'a caption around the sun on its group\'s side');
  const still = html(h(FlowView, { flow: f, still: true }));
  assert.match(still, /<svg class="flow still"/); assert.doesNotMatch(still, /animateMotion/);
  assert.match(html(h(FlowView, { flow: flowModel(rows, [], [], 0) })), /aria-label="Nothing running"/);
});
