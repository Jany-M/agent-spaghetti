// The flow diagram (Home, and bigger in its own window: ?window=flow): Agent Spaghetti in the middle, the tools around it grouped
// by what they are (the Tools panel's groups), each block in its live-pane color (story.ts toolColor). A block lights up while it
// works and says what it does, for whom and what comes next; lights travel along the lines the way the work goes (caller → Agent
// Spaghetti → worker, and back with the result) for as long as the work or its answer is still on the way. One pure model
// (flowModel) from data the popover already has (status.live, the integrations rows) and one pure layout for whatever space there
// is (flowLayout); the view only draws them. Animation is SVG/CSS only, drawn only while the page can be seen.
import { createElement as h, useEffect, useRef, useState } from 'react';
import { type LiveResult, type LiveRun, type ToolGroup, type ToolRow } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useOp } from './hooks.ts';
import { setToolColors, toolColor } from './story.ts';

export const HUB = 'agent-spaghetti';
const ROUTING_MS = 4000;                                         // how long the middle block says it is routing after a run starts
const RETURN_MS = 6000;                                          // how long a delivered result is shown going back
const VERB: Record<string, string> = { research: 'researching', summarize: 'summarizing', 'code-edit': 'coding', tests: 'testing', review: 'reviewing',
  refactor: 'refactoring', docs: 'documenting', plan: 'planning', report: 'reporting' };
export type FlowGroup = ToolGroup | 'callers';                   // callers: whoever asks without being a listed tool (the tray, a terminal)
/** `off`: an app that is not open (it can hand off only while open): drawn dim. */
export interface FlowNode { id: string; name: string; group: FlowGroup | 'hub'; label: string; sub?: string; on: boolean; off?: true }
/** `back`: a result on its way to the caller (`waiting`: not collected yet). */
export interface FlowLink { from: string; to: string; back?: true; waiting?: true }
export interface Flow { nodes: FlowNode[]; links: FlowLink[] }
type Row = Pick<ToolRow, 'id' | 'name' | 'state' | 'group' | 'connection' | 'receives' | 'open'>;
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
    const row = rows.find(r => r.id === id), on = !!(doing || asked || sent || got), off = !on && row?.connection !== undefined && row.open === false;
    return { id, name: name(id), group: row?.group ?? 'callers', on, ...(off ? { off: true as const } : {}),
      label: doing ? `${VERB[doing.kind ?? ''] ?? 'working'} for ${name(doing.source)}` : asked ? `waiting on ${name(asked.target)}`
        : got ? (got.how === 'unread' ? 'result waiting' : `result from ${name(got.from)}`) : sent ? `answered ${name(sent.to)}` : off ? 'not open' : '',
      ...(doing?.next ? { sub: `then ${name(doing.next.split(':')[0])}` } : {}) };
  });
  const hub: FlowNode = { id: HUB, name: 'Agent Spaghetti', group: 'hub', on: runs.length > 0 || back.length > 0,
    label: runs.some(r => now - r.ts < ROUTING_MS) ? 'routing task' : runs.length ? `${runs.length} ${runs.length === 1 ? 'task' : 'tasks'} running` : back.length ? 'returning result' : 'idle' };
  return { nodes: [hub, ...nodes], links: [...runs.map(r => ({ from: r.source, to: r.target })),
    ...back.map(r => ({ from: r.from, to: r.to, back: true as const, ...(r.how === 'unread' ? { waiting: true as const } : {}) }))] };
}

/** The groups clockwise from the top (the Tools panel's groups; callers that are no listed tool come last), and their captions. */
const ORDER: FlowGroup[] = ['models', 'agents', 'tools', 'apps', 'callers'];
const CAPTION: Record<FlowGroup, string> = { models: 'models', agents: 'agents', tools: 'tools', apps: 'apps', callers: 'you' };   // short: they ring the sun
export interface FlowBox { x: number; y: number; w: number; h: number }
export interface FlowPlan {
  width: number; height: number; k: number; cx: number; cy: number; r: number;   // the hub: a sun of radius r at (cx, cy)
  boxes: Record<string, FlowBox>; orbits: Array<{ rx: number; ry: number }>; captions: Array<{ text: string; angle: number }>;
}
const apart = (a: FlowBox, b: FlowBox, gap: number) => a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
/** How far a block is from a point (0 when the point is inside it). */
const reach = (b: FlowBox, x: number, y: number) => Math.hypot(Math.max(b.x - x, 0, x - b.x - b.w), Math.max(b.y - y, 0, y - b.y - b.h));
/** A solar system for a space `width` wide (and `height` tall when given; without, as tall as it needs): Agent Spaghetti is the
 *  sun in the middle, the tools are planets on one or more elliptical orbits shaped like the space, each group in its own arc
 *  (model servers at the top, then clockwise agents, other tools, editors and callers). Planets grow with the space (factor `k`),
 *  never touch each other or the sun; when one orbit is too crowded, neighbours alternate between orbits, then the planets
 *  shrink, then (only when nothing else fits) the drawing gets taller and scrolls. */
export const FLOW_MIN = { width: 360, height: 300 };          // below this the planets stop shrinking and moving: the window scrolls
export function flowLayout(nodes: FlowNode[], space: number, tall?: number): FlowPlan {
  const width = Math.max(FLOW_MIN.width, space), height = tall === undefined ? undefined : Math.max(FLOW_MIN.height, tall);
  const planets = ORDER.flatMap(g => nodes.filter(n => n.group === g)), n = planets.length;
  const run = (g: FlowGroup) => planets.filter(p => p.group === g).length;
  /** Angles that space n planets evenly along an ellipse (by length, not by angle: no crowding at its narrow ends), the first
   *  group centered at the top, then clockwise. */
  const angles = (rx: number, ry: number) => {
    const N = 720, at = (i: number) => -Math.PI / 2 + (i / N) * 2 * Math.PI, len = [0];
    for (let i = 1; i <= N; i++) len.push(len[i - 1] + Math.hypot(rx * (Math.cos(at(i)) - Math.cos(at(i - 1))), ry * (Math.sin(at(i)) - Math.sin(at(i - 1)))));
    const L = len[N], step = L / Math.max(n, 1), first = -((run(planets[0]?.group as FlowGroup) - 1) / 2) * step;
    return planets.map((_, i) => { const want = (((first + i * step) % L) + L) % L; let j = 0; while (len[j + 1] < want) j++; return at(j); });
  };
  const place = (k: number, H: number, rings: number): FlowPlan | null => {
    const [pad, gap, room, r, bw, bh] = [8, 6, 14, 40, 108, 48].map(x => Math.round(x * k)), cx = width / 2, cy = H / 2;
    const out = { rx: cx - pad - bw / 2, ry: cy - pad - bh / 2 }, inner = { rx: r + room + bw / 2, ry: r + room + bh / 2 };
    if (out.rx < inner.rx || out.ry < inner.ry) return null;
    const orbits = Array.from({ length: rings }, (_, j) => ({ rx: Math.max(inner.rx, out.rx * (1 - 0.3 * j)), ry: Math.max(inner.ry, out.ry * (1 - 0.3 * j)) }));
    const boxes: FlowPlan['boxes'] = {}, angle = angles(out.rx, out.ry);
    planets.forEach((p, i) => { const o = orbits[i % rings], a = angle[i];
      boxes[p.id] = { x: Math.round(cx + o.rx * Math.cos(a) - bw / 2), y: Math.round(cy + o.ry * Math.sin(a) - bh / 2), w: bw, h: bh }; });
    const all = Object.values(boxes);
    if (!all.every((b, i) => reach(b, cx, cy) >= r + room && all.every((c, j) => i === j || apart(b, c, gap)))) return null;
    const captions = ORDER.filter(run).map(g => { const ids = planets.flatMap((p, i) => (p.group === g ? [i] : [])), a = ids.map(i => angle[i]);
      return { text: CAPTION[g], angle: Math.atan2(a.reduce((s, x) => s + Math.sin(x), 0), a.reduce((s, x) => s + Math.cos(x), 0)) }; });
    boxes[HUB] = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
    return { width, height: H, k, cx, cy, r, boxes, orbits, captions };
  };
  const most = Math.max(1, Math.min(1.5, width / 420, height ? height / 360 : 9));
  for (let H = height ?? Math.round(width * 0.8), tries = 0; ; H = Math.round(H * 1.1), tries++) {   // taller only when nothing fits
    for (let k = most; k >= 0.9; k = Math.round((k - 0.05) * 100) / 100)   // smaller (0.9: still readable) before taller
      for (let rings = 1; rings <= 3; rings++) { const p = place(k, H, rings); if (p) return p; }
    if (tries > 40) return place(0.9, H, 3) ?? place(0.9, 3 * H, 3)!;   // not reached (tested): from FLOW_MIN.width up a taller orbit fits
  }
}

/** A line from one body's edge to another's, bent a little the same way around the sun (a swirl). */
function curve(plan: FlowPlan, from: string, to: string): string {
  const { cx, cy, r } = plan, edge = (id: string, tx: number, ty: number) => {
    const b = plan.boxes[id], x = b.x + b.w / 2, y = b.y + b.h / 2, dx = tx - x, dy = ty - y, d = Math.hypot(dx, dy) || 1;
    const t = id === HUB ? r : Math.min(b.w / 2 / (Math.abs(dx) / d || 1e-9), b.h / 2 / (Math.abs(dy) / d || 1e-9));
    return { x: x + (dx / d) * t, y: y + (dy / d) * t };
  };
  const planet = plan.boxes[from === HUB ? to : from], px = planet.x + planet.w / 2 - cx, py = planet.y + planet.h / 2 - cy, pl = Math.hypot(px, py) || 1;
  const a = plan.boxes[from], b = plan.boxes[to];
  const p = edge(from, b.x + b.w / 2, b.y + b.h / 2), q = edge(to, a.x + a.w / 2, a.y + a.h / 2), bend = 0.18 * Math.hypot(q.x - p.x, q.y - p.y);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return `M${r1(p.x)},${r1(p.y)} Q${r1((p.x + q.x) / 2 - (py / pl) * bend)},${r1((p.y + q.y) / 2 + (px / pl) * bend)} ${r1(q.x)},${r1(q.y)}`;
}
/** Text in at most `max` lines of `w` pixels at font size `f`, broken between words (after "for", "on", "from" or "answered" first,
 *  so a tool's name stays together); the last line cut with … if needed (the block's tooltip has it whole). */
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
  const plan = flowLayout(flow.nodes, size?.width ?? 400, size?.height), { boxes, k, cx, cy, r } = plan, px = (n: number) => Math.round(n * k * 10) / 10;
  const part = (from: string, to: string, l: FlowLink, key: string) => {
    const c = toolColor(l.back ? l.from : l.to), d = curve(plan, from, to);   // the work's color: the tool doing it
    return h('g', { key, className: ['link', c.className, l.waiting ? 'waiting' : ''].filter(Boolean).join(' '), style: c.style },
      h('path', { className: 'trail', d }),
      ...(still ? [] : Array.from({ length: LIGHTS }, (_, i) => h('circle', { key: i, className: 'light', r: px(2.4) },
        h('animateMotion', { dur: l.waiting ? '3.6s' : '1.5s', begin: `${(-i * (l.waiting ? 3.6 : 1.5)) / LIGHTS}s`, repeatCount: 'indefinite', path: d })))));
  };
  const cr = r + px(9), ring = (sweep: 0 | 1) => `M${cx - cr},${cy} A${cr},${cr} 0 1 ${sweep} ${cx + cr},${cy} A${cr},${cr} 0 1 ${sweep} ${cx - cr},${cy}`;
  const hub = flow.nodes.find(n => n.id === HUB)!;
  return h('svg', { className: `flow${still ? ' still' : ''}`, viewBox: `0 0 ${plan.width} ${plan.height}`, width: plan.width, height: plan.height, role: 'img',
    'aria-label': flow.nodes.filter(n => n.on && n.label).map(n => `${n.name}: ${n.label}`).join('; ') || 'Nothing running' },
  h('defs', null,
    h('pattern', { id: 'flow-dots', width: 18, height: 18, patternUnits: 'userSpaceOnUse' }, h('circle', { cx: 1.5, cy: 1.5, r: 0.8 })),
    h('linearGradient', { id: 'flow-glass', x1: 0, y1: 0, x2: 0, y2: 1 }, h('stop', { offset: 0, className: 'g0' }), h('stop', { offset: 1, className: 'g1' })),
    h('radialGradient', { id: 'flow-sun' }, h('stop', { offset: 0, className: 's0' }), h('stop', { offset: 1, className: 's1' })),
    h('path', { id: 'flow-cap-top', d: ring(1) }), h('path', { id: 'flow-cap-bottom', d: ring(0) })),
  h('rect', { className: 'backdrop', width: plan.width, height: plan.height }),
  ...plan.orbits.map((o, i) => h('ellipse', { key: `o${i}`, className: 'orbit', cx, cy, rx: o.rx, ry: o.ry })),
  ...plan.captions.map(c => {                                    // around the sun, on the side of its group; upright above and below
    const below = Math.sin(c.angle) > 0.2, deg = (c.angle * 180) / Math.PI, at = below ? (180 - deg) / 360 : (((deg + 180) % 360) + 360) % 360 / 360;
    return h('text', { key: c.text, className: 'caption', dy: below ? px(7) : -px(2), style: { fontSize: px(6.5) } },
      h('textPath', { href: `#flow-cap-${below ? 'bottom' : 'top'}`, startOffset: `${Math.round(at * 1000) / 10}%` }, c.text));
  }),
  ...flow.nodes.filter(n => n.id !== HUB).map(n => h('path', { key: `s-${n.id}`, className: 'spoke', d: curve(plan, HUB, n.id) })),
  ...flow.links.flatMap((l, i) => [part(l.from, HUB, l, `a-${i}`), part(HUB, l.to, l, `b-${i}`)]),
  h('g', { key: HUB, className: `node hub${hub.on ? ' on' : ''}` },
    h('title', null, [hub.name, hub.label].join(': ')),
    h('circle', { className: 'corona', cx, cy, r: r + px(6) }),
    h('circle', { className: 'sun', cx, cy, r }),
    h('text', { className: 'name', x: cx, y: cy - px(5), style: { fontSize: px(9) } }, 'Agent'),
    h('text', { className: 'name', x: cx, y: cy + px(5), style: { fontSize: px(9) } }, 'Spaghetti'),
    h('text', { className: 'what', x: cx, y: cy + px(17), style: { fontSize: px(7) } }, wrap(hub.label, 2 * r - px(14), px(7), 1)[0])),
  ...flow.nodes.filter(n => n.id !== HUB).map(n => {
    const b = boxes[n.id], c = toolColor(n.id), room = b.w - px(18);
    const what = n.label ? wrap(n.label, room, px(7.5), n.sub ? 2 : 3) : [], next = n.sub ? wrap(n.sub, room, px(7), 1) : [];   // name, then up to three lines
    return h('g', { key: n.id, style: c.style, className: ['node', c.className, n.on ? 'on' : '', n.off ? 'off' : ''].filter(Boolean).join(' '), transform: `translate(${b.x},${b.y})` },
      h('title', null, [n.name, n.label, n.sub].filter(Boolean).join(': ')),
      h('rect', { className: 'box', width: b.w, height: b.h, rx: px(8) }),
      h('rect', { className: 'bar', width: px(2.5), height: b.h - px(12), x: px(4), y: px(6), rx: px(1.25) }),
      h('circle', { className: 'dot', cx: b.w - px(7), cy: px(8), r: px(2) }),
      h('text', { className: 'name', x: px(11), y: px(13), style: { fontSize: px(8) } }, wrap(n.name, room - px(6), px(8), 1)[0]),
      ...[...what.map(t => ['what', t]), ...next.map(t => ['what next', t])].map(([cls, t], i) =>
        h('text', { key: i, className: cls, x: px(11), y: px(24 + i * 9), style: { fontSize: px(cls === 'what' ? 7.5 : 7) } }, t)));
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
    // sizes that never depend on the drawing: the width inside the scrollbar's reserved gutter, the height of the box itself (a
    // scrollbar coming or going must not change the layout, or the two layouts take turns: blocks seem doubled)
    const measure = () => setSize({ width: el.clientWidth, ...(fill ? { height: el.offsetHeight } : {}) });
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  const rows = tools.data?.rows ?? [];
  setToolColors(rows);
  return h('div', { ref: box, className: `flow-box${fill ? ' fill' : ''}` }, size ? h(FlowView, { flow: flowModel(rows, runs, results, now), still: !visible, size }) : null);
}
