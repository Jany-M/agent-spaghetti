// The flow diagram (Home, and bigger in its own window: ?window=flow): Agent Spaghetti in the middle, the tools around it grouped
// by what they are (the Tools panel's groups), each block in its live-pane color (story.ts toolColor). A block lights up while it
// works and says what it does, for whom and what comes next; lights travel along the lines the way the work goes (caller → Agent
// Spaghetti → worker, and back with the result) for as long as the work or its answer is still on the way. One pure model
// (flowModel) from data the popover already has (status.live, the integrations rows) and one pure layout for whatever space there
// is (flowLayout); the view only draws them. Animation is SVG/CSS only, drawn only while the page can be seen.
import { createElement as h, useEffect, useRef, useState } from 'react';
import { TOOL_GROUPS, type LiveResult, type LiveRun, type ToolGroup, type ToolRow } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useOp } from './hooks.ts';
import { setToolColors, toolColor } from './story.ts';

export const HUB = 'agent-spaghetti';
const ROUTING_MS = 4000;                                         // how long the middle block says it is routing after a run starts
const RETURN_MS = 6000;                                          // how long a delivered result is shown going back
const VERB: Record<string, string> = { research: 'researching', summarize: 'summarizing', 'code-edit': 'coding', tests: 'testing', review: 'reviewing',
  refactor: 'refactoring', docs: 'documenting', plan: 'planning', report: 'reporting' };
export type FlowGroup = ToolGroup | 'callers';                   // callers: whoever asks without being a listed tool (the tray, a terminal)
export interface FlowNode { id: string; name: string; group: FlowGroup | 'hub'; label: string; sub?: string; on: boolean }
/** `back`: a result on its way to the caller (`waiting`: not collected yet). */
export interface FlowLink { from: string; to: string; back?: true; waiting?: true }
export interface Flow { nodes: FlowNode[]; links: FlowLink[] }
type Row = Pick<ToolRow, 'id' | 'name' | 'state' | 'group' | 'connection' | 'receives'>;
/** The blocks and moving lines for what happens now. Blocks: tools that are connected, can take tasks or serve other tools, plus
 *  whoever takes part in a run. A line stays for as long as its run is not finished, and a result's line until it was delivered
 *  (a few seconds after) or, when nobody collected it yet, until somebody does. */
export function flowModel(rows: Row[], runs: LiveRun[], results: LiveResult[], now: number): Flow {
  const shown = rows.filter(r => r.state !== 'not found' && r.state !== 'skipped' && (r.connection === 'connected' || r.receives || r.group === 'tools'));
  const back = results.filter(r => r.how === 'unread' || (r.how !== 'pending' && now - r.ts < RETURN_MS));
  const ids = [...new Set([...shown.map(r => r.id), ...runs.flatMap(r => [r.source, r.target]), ...back.flatMap(r => [r.from, r.to])])].filter(id => id !== HUB);
  const name = (id: string) => rows.find(r => r.id === id)?.name ?? id;
  const nodes = ids.map((id): FlowNode => {
    const doing = runs.find(r => r.target === id), asked = runs.find(r => r.source === id), sent = back.find(r => r.from === id), got = back.find(r => r.to === id);
    return { id, name: name(id), group: rows.find(r => r.id === id)?.group ?? 'callers', on: !!(doing || asked || sent || got),
      label: doing ? `${VERB[doing.kind ?? ''] ?? 'working'} for ${name(doing.source)}` : asked ? `waiting on ${name(asked.target)}`
        : got ? (got.how === 'unread' ? 'result waiting' : `result from ${name(got.from)}`) : sent ? `answered ${name(sent.to)}` : '',
      ...(doing?.next ? { sub: `then ${name(doing.next.split(':')[0])}` } : {}) };
  });
  const hub: FlowNode = { id: HUB, name: 'Agent Spaghetti', group: 'hub', on: runs.length > 0 || back.length > 0,
    label: runs.some(r => now - r.ts < ROUTING_MS) ? 'routing task' : runs.length ? `${runs.length} ${runs.length === 1 ? 'task' : 'tasks'} running` : back.length ? 'returning result' : 'idle' };
  return { nodes: [hub, ...nodes], links: [...runs.map(r => ({ from: r.source, to: r.target })),
    ...back.map(r => ({ from: r.from, to: r.to, back: true as const, ...(r.how === 'unread' ? { waiting: true as const } : {}) }))] };
}

/** Where a group sits around the hub, and its caption. */
const SIDES: Array<{ side: 'left' | 'right' | 'top' | 'bottom'; groups: FlowGroup[] }> = [
  { side: 'left', groups: ['apps', 'callers'] }, { side: 'right', groups: ['agents'] }, { side: 'top', groups: ['models'] }, { side: 'bottom', groups: ['tools'] }];
const CAPTION: Record<string, string> = { ...Object.fromEntries(TOOL_GROUPS.map(g => [g.id, g.label])), callers: 'You' };
export interface FlowBox { x: number; y: number; w: number; h: number }
export interface FlowPlan { width: number; height: number; k: number; boxes: Record<string, FlowBox & { side: string }>; captions: Array<{ text: string; x: number; y: number }> }
/** Every block's place for a space `width` wide (and `height` tall when given: the blocks then spread over all of it; without,
 *  the drawing is as tall as it needs). Model servers along the top, other tools along the bottom, editors and callers on the left,
 *  agents on the right, the hub in the middle with clear space around it; blocks grow with the space (factor `k`) and never overlap. */
export function flowLayout(nodes: FlowNode[], width: number, height?: number): FlowPlan {
  const of = (side: string) => nodes.filter(n => SIDES.find(s => s.side === side)!.groups.includes(n.group as FlowGroup));
  const [left, right, top, bottom] = ['left', 'right', 'top', 'bottom'].map(of);
  /** Sizes at factor k; a side whose column would be taller than the window gets more columns (`cols`, from a first pass). */
  const sizes = (k: number, cols = [1, 1]) => {
    const [pad, gap, cap, room, hubW, hubH, bh] = [8, 8, 13, 30, 120, 60, 54].map(n => Math.round(n * k));
    const n = cols[0] + cols[1], bw = Math.max(84, Math.min(Math.round(118 * k), Math.floor((width - hubW - 2 * room - 2 * pad - (n - 2) * gap) / n)));
    const perRow = Math.max(1, Math.floor((width - 2 * pad + gap) / (bw + gap)));
    const band = (m: number) => (m ? cap + Math.ceil(m / perRow) * (bh + gap) : 0);
    const col = (m: number, c: number) => (m ? cap + Math.ceil(m / c) * (bh + gap) : 0);
    const middle = height ? height - 2 * pad - band(top.length) - band(bottom.length) : 0, fits = Math.max(1, Math.floor((middle - cap) / (bh + gap)));
    return { pad, gap, cap, room, hubW, hubH, bh, bw, perRow, band, fits: [left, right].map(s => (height ? Math.ceil(s.length / fits) || 1 : 1)),
      need: 2 * pad + band(top.length) + band(bottom.length) + Math.max(col(left.length, cols[0]), col(right.length, cols[1]), hubH + 2 * room) };
  };
  let k = Math.max(1, Math.min(1.7, width / 400));
  while (height && k > 1 && sizes(k).need > height) k = Math.max(1, k - 0.02);   // smaller blocks before a second column
  const s = sizes(k), cols = s.fits, most = Math.max(2, Math.floor((width - s.hubW - 2 * s.room - 2 * s.pad + s.gap) / (84 + s.gap)));   // columns that fit beside the hub
  while (cols[0] + cols[1] > most) cols[cols[0] > cols[1] ? 0 : 1]--;                                      // else: taller, the window scrolls
  const { pad, gap, cap, hubW, hubH, bh, bw, perRow, band, need } = sizes(k, cols);
  const H = Math.max(need, height ?? 0), y0 = pad + band(top.length), y1 = H - pad - band(bottom.length);
  const boxes: FlowPlan['boxes'] = {}, captions: FlowPlan['captions'] = [];
  const caption = (list: FlowNode[], x: number, y: number) => captions.push({ text: [...new Set(list.map(n => CAPTION[n.group]))].join(' · '), x, y: y + cap - 4 });
  const column = (list: FlowNode[], x: number, c: number, side: string) => {   // x: the side's outer edge; columns go inward
    if (!list.length) return;
    const w = c * bw + (c - 1) * gap, x0 = side === 'left' ? x : x - w, rows = Math.ceil(list.length / c), step = (y1 - y0 - cap) / rows;
    caption(list, x0 + w / 2, y0);
    list.forEach((n, i) => { const cx = side === 'left' ? Math.floor(i / rows) : c - 1 - Math.floor(i / rows);
      boxes[n.id] = { x: x0 + cx * (bw + gap), y: Math.round(y0 + cap + step * (i % rows) + (step - bh) / 2), w: bw, h: bh, side }; });
  };
  const strip = (list: FlowNode[], y: number, side: string) => {
    if (!list.length) return;
    caption(list, width / 2, y);
    list.forEach((n, i) => { const r = Math.floor(i / perRow), inRow = Math.min(perRow, list.length - r * perRow), w = inRow * bw + (inRow - 1) * gap;
      boxes[n.id] = { x: Math.round(width / 2 - w / 2 + (i % perRow) * (bw + gap)), y: y + cap + r * (bh + gap), w: bw, h: bh, side }; });
  };
  column(left, pad, cols[0], 'left'); column(right, width - pad, cols[1], 'right'); strip(top, pad, 'top'); strip(bottom, y1, 'bottom');
  // the hub: centered between the sides, however many columns each has
  const span = (c: number) => c * bw + (c - 1) * gap, from = left.length ? pad + span(cols[0]) : 0, to = right.length ? width - pad - span(cols[1]) : width;
  boxes[HUB] = { x: Math.round((from + to) / 2 - hubW / 2), y: Math.round((y0 + y1) / 2 - hubH / 2), w: hubW, h: hubH, side: 'hub' };
  return { width, height: H, k, boxes, captions };
}

const center = (b: FlowBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
/** A smooth line from one block's edge to another's (leaving sideways from a column, up or down from a strip). */
function curve(a: FlowBox & { side: string }, b: FlowBox & { side: string }): string {
  const other = a.side === 'hub' ? b : a, across = other.side === 'left' || other.side === 'right', ca = center(a), cb = center(b);
  const edge = (box: FlowBox, c: { x: number; y: number }, to: { x: number; y: number }) => (across ? { x: c.x + Math.sign(to.x - c.x) * box.w / 2, y: c.y } : { x: c.x, y: c.y + Math.sign(to.y - c.y) * box.h / 2 });
  const p = edge(a, ca, cb), q = edge(b, cb, ca), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  return across ? `M${p.x},${p.y} C${mx},${p.y} ${mx},${q.y} ${q.x},${q.y}` : `M${p.x},${p.y} C${p.x},${my} ${q.x},${my} ${q.x},${q.y}`;
}
/** Text in at most `max` lines of `w` pixels at font size `f`, broken between words (after "for", "on", "from" or "answered" first, so a tool's
 *  name stays together); the last line cut with … if needed (the block's tooltip has it whole). */
function wrap(text: string, w: number, f: number, max: number): string[] {
  const n = Math.floor(w / (f * 0.56));
  const fill = (s: string) => s.split(' ').reduce<string[]>((ls, word) => (ls.length && ls[ls.length - 1].length + 1 + word.length <= n
    ? [...ls.slice(0, -1), `${ls[ls.length - 1]} ${word}`] : [...ls, word]), []);
  const m = text.length > n ? /^(.*? (?:for|on|from)|answered) (.+)$/.exec(text) : null, lines = m ? [...fill(m[1]), ...fill(m[2])] : fill(text);
  if (lines.length <= max && lines.every(l => l.length <= n)) return lines;
  return [...lines.slice(0, max - 1), `${lines.slice(max - 1).join(' ').slice(0, n - 1)}…`];
}
const LIGHTS = 3;                                                // lights travelling along one line at a time
/** `still`: nothing moves (the page is hidden). `size`: the space to fill (the window); without a height the drawing is as tall as it needs. */
export function FlowView({ flow, still = false, size }: { flow: Flow; still?: boolean; size?: { width: number; height?: number } }) {
  const plan = flowLayout(flow.nodes, size?.width ?? 400, size?.height), { boxes, k } = plan, px = (n: number) => Math.round(n * k * 10) / 10;
  const part = (from: string, to: string, l: FlowLink, key: string) => {
    const c = toolColor(l.back ? l.from : l.to), d = curve(boxes[from], boxes[to]);   // the work's color: the tool doing it
    return h('g', { key, className: ['link', c.className, l.waiting ? 'waiting' : ''].filter(Boolean).join(' '), style: c.style },
      h('path', { className: 'trail', d }),
      ...(still ? [] : Array.from({ length: LIGHTS }, (_, i) => h('circle', { key: i, className: 'light', r: px(2.4) },
        h('animateMotion', { dur: l.waiting ? '3.6s' : '1.5s', begin: `${(-i * (l.waiting ? 3.6 : 1.5)) / LIGHTS}s`, repeatCount: 'indefinite', path: d })))));
  };
  return h('svg', { className: `flow${still ? ' still' : ''}`, viewBox: `0 0 ${plan.width} ${plan.height}`, width: plan.width, height: plan.height, role: 'img',
    'aria-label': flow.nodes.filter(n => n.on && n.label).map(n => `${n.name}: ${n.label}`).join('; ') || 'Nothing running' },
  h('defs', null,
    h('pattern', { id: 'flow-dots', width: 18, height: 18, patternUnits: 'userSpaceOnUse' }, h('circle', { cx: 1.5, cy: 1.5, r: 0.8 })),
    h('linearGradient', { id: 'flow-glass', x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, className: 'g0' }), h('stop', { offset: 1, className: 'g1' }))),
  h('rect', { className: 'backdrop', width: plan.width, height: plan.height }),
  ...plan.captions.map(c => h('text', { key: c.text, className: 'caption', x: c.x, y: c.y, style: { fontSize: px(7) } }, c.text)),
  ...flow.nodes.filter(n => n.id !== HUB).map(n => h('path', { key: `s-${n.id}`, className: 'spoke', d: curve(boxes[HUB], boxes[n.id]) })),
  ...flow.links.flatMap((l, i) => [part(l.from, HUB, l, `a-${i}`), part(HUB, l.to, l, `b-${i}`)]),
  ...flow.nodes.map(n => {
    const b = boxes[n.id], hub = n.id === HUB, c = hub ? {} : toolColor(n.id), room = b.w - px(hub ? 12 : 20);
    const what = n.label ? wrap(n.label, room, px(8), n.sub || hub ? 2 : 3) : [], next = n.sub && !hub ? wrap(n.sub, room, px(7), 1) : [];   // name, then up to three lines
    const x = hub ? b.w / 2 : px(12), top = hub ? 40 : 26;
    return h('g', { key: n.id, style: c.style, className: ['node', hub ? 'hub' : c.className, n.on ? 'on' : ''].filter(Boolean).join(' '), transform: `translate(${b.x},${b.y})` },
      h('title', null, [n.name, n.label, n.sub].filter(Boolean).join(': ')),
      hub ? h('rect', { className: 'ring', x: -px(5), y: -px(5), width: b.w + px(10), height: b.h + px(10), rx: px(16) }) : null,
      h('rect', { className: 'box', width: b.w, height: b.h, rx: px(9) }),
      hub ? null : h('rect', { className: 'bar', width: px(3), height: b.h - px(12), x: px(4), y: px(6), rx: px(1.5) }),
      h('circle', { className: 'dot', cx: b.w - px(8), cy: px(8), r: px(2.2) }),
      h('text', { className: 'name', x, y: px(hub ? 17 : 14), style: { fontSize: px(hub ? 10 : 8) } }, wrap(n.name, room - px(hub ? 0 : 8), px(hub ? 10 : 8), 1)[0]),
      hub ? h('text', { className: 'tag', x, y: px(28), style: { fontSize: px(6.5) } }, 'JEV · ROUTING') : null,
      ...[...what.map(t => ['what', t]), ...next.map(t => ['what next', t])].map(([cls, t], i) =>
        h('text', { key: i, className: cls, x, y: px(top + i * 10), style: { fontSize: px(cls === 'what' ? 8 : 7) } }, t)));
  }));
}

/** True while the page can be seen (a hidden popover or window animates nothing). */
export function useVisible(): boolean {
  const [v, set] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => { const on = () => set(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, []);
  return v;
}
/** The diagram with its data: the tools (integrations rows, also their own colors), what runs now and what is on its way back.
 *  `fill`: use all of its container (the flow window: blocks spread out as it is resized); else its width, as tall as needed. */
export function FlowPanel({ bridge, runs, results, now, fill = false }: { bridge: Bridge; runs: LiveRun[]; results: LiveResult[]; now: number; fill?: boolean }) {
  const tools = useOp(bridge, 'integrations');
  const visible = useVisible();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height?: number }>();
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setSize({ width: Math.floor(el.clientWidth), ...(fill ? { height: Math.floor(el.clientHeight) } : {}) });
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  const rows = tools.data?.rows ?? [];
  setToolColors(rows);
  return h('div', { ref: box, className: `flow-box${fill ? ' fill' : ''}` }, size ? h(FlowView, { flow: flowModel(rows, runs, results, now), still: !visible, size }) : null);
}
