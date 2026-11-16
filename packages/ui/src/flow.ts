// The flow diagram (Home, and bigger in its own window: ?window=flow): Agent Spaghetti in the middle, the tools around it as
// blocks in their live-pane colors (story.ts toolColor). A block lights up while it works, with at most three words on what it
// does and for whom, and lines move in the direction the work goes (caller → Agent Spaghetti → target). One pure model
// (flowModel) from data the popover already has (status.live.runs, the integrations rows); the view only draws it. Animation is
// CSS only and stops when the page is hidden; the diagram exists only while it is shown.
import { createElement as h, useEffect, useState } from 'react';
import { type LiveRun, type ToolRow } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useOp } from './hooks.ts';
import { setToolColors, toolColor } from './story.ts';

export const HUB = 'agent-spaghetti';
const ROUTING_MS = 4000;                                         // how long the middle block says it is routing after a run starts
const VERB: Record<string, string> = { research: 'researching', summarize: 'summarizing', 'code-edit': 'coding', tests: 'testing', review: 'reviewing',
  refactor: 'refactoring', docs: 'documenting', plan: 'planning', report: 'reporting' };
/** A name short enough for a block and one word in a label: its first word ("Claude Code CLI" → "Claude"), with the second
 *  joined on when the first is only an abbreviation ("LM Studio" → "LMStudio"). */
export const shortName = (name: string) => { const [a, b] = name.split(/\s+/); return a.length <= 2 && b ? a + b : a; };
export interface FlowNode { id: string; name: string; label: string; sub?: string; on: boolean }
export interface FlowLink { from: string; to: string }
export interface Flow { nodes: FlowNode[]; links: FlowLink[] }
type Row = Pick<ToolRow, 'id' | 'name' | 'state' | 'group' | 'connection' | 'receives'>;
/** The blocks and moving lines for what runs now. Blocks: tools that are connected, can take tasks or serve other tools, plus
 *  whoever takes part in a run (a caller such as the tray). Labels have at most three words. */
export function flowModel(rows: Row[], runs: LiveRun[], now: number): Flow {
  const shown = rows.filter(r => r.state !== 'not found' && r.state !== 'skipped' && (r.connection === 'connected' || r.receives || r.group === 'tools'));
  const name = (id: string) => shortName(rows.find(r => r.id === id)?.name ?? id);
  const ids = [...new Set([...shown.map(r => r.id), ...runs.flatMap(r => [r.source, r.target])])].filter(id => id !== HUB);
  const nodes = ids.map((id): FlowNode => {
    const doing = runs.find(r => r.target === id), asked = runs.find(r => r.source === id);
    return { id, name: name(id), on: !!(doing || asked),
      label: doing ? `${VERB[doing.kind ?? ''] ?? 'working'} for ${name(doing.source)}` : asked ? `waiting on ${name(asked.target)}` : '',
      ...(doing?.next ? { sub: `then ${name(doing.next.split(':')[0])}` } : {}) };
  });
  const hub: FlowNode = { id: HUB, name: 'Agent Spaghetti', on: runs.length > 0,
    label: runs.some(r => now - r.ts < ROUTING_MS) ? 'routing task' : runs.length ? `${runs.length} ${runs.length === 1 ? 'task' : 'tasks'} running` : 'idle' };
  return { nodes: [hub, ...nodes], links: runs.map(r => ({ from: r.source, to: r.target })) };
}

const W = 360, BW = 96, BH = 36, ROW = 44, PAD = 8;
/** Where each block sits: the hub in the middle, the others in two columns beside it, top to bottom in the same order every time
 *  (no two ever overlap, however many tools there are; the drawing grows downward). */
export function flowLayout(nodes: FlowNode[]): { height: number; at: Record<string, { x: number; y: number }> } {
  const around = nodes.filter(n => n.id !== HUB), left = Math.ceil(around.length / 2), rows = Math.max(left, 3), height = rows * ROW + PAD * 2;
  const y = (i: number, of: number) => Math.round(PAD + (height - PAD * 2) * (i + 0.5) / of);
  return { height, at: Object.fromEntries([[HUB, { x: W / 2, y: Math.round(height / 2) }],
    ...around.map((n, i) => [n.id, i < left ? { x: PAD + BW / 2, y: y(i, left) } : { x: W - PAD - BW / 2, y: y(i - left, around.length - left) }])]) };
}
/** `still`: nothing moves (the page is hidden). */
export function FlowView({ flow, still = false }: { flow: Flow; still?: boolean }) {
  const { height, at } = flowLayout(flow.nodes), hubW = BW + 14, hubH = BH + 10;
  /** A line between two blocks' facing edges (the hub in the middle, the others beside it), so an arrowhead at its end shows. */
  const line = (a: string, b: string) => { const edge = (id: string, other: string) => ({ x: at[id].x + Math.sign(at[other].x - at[id].x) * ((id === HUB ? hubW : BW) / 2 + 2), y: at[id].y });
    const p = edge(a, b), q = edge(b, a); return `M${p.x},${p.y} L${q.x},${q.y}`; };
  const busy = new Set(flow.links.flatMap(l => [l.from, l.to]));
  return h('svg', { className: `flow${still ? ' still' : ''}`, viewBox: `0 0 ${W} ${height}`, role: 'img',
    'aria-label': flow.nodes.filter(n => n.on && n.label).map(n => `${n.name}: ${n.label}`).join('; ') || 'Nothing running' },
  h('defs', null, h('marker', { id: 'flow-head', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 4.5, markerHeight: 4.5, orient: 'auto' }, h('path', { d: 'M0,0 L8,4 L0,8 Z', fill: 'context-stroke' }))),
  ...flow.nodes.filter(n => n.id !== HUB).map(n => h('path', { key: `s-${n.id}`, className: 'spoke', d: line(HUB, n.id) })),
  ...flow.links.flatMap((l, i) => { const c = toolColor(l.to), cls = ['link', c.className].filter(Boolean).join(' ');   // the work's color: the tool doing it
    return [h('path', { key: `a-${i}`, className: cls, style: c.style, d: line(l.from, HUB), markerEnd: 'url(#flow-head)' }),
      h('path', { key: `b-${i}`, className: cls, style: c.style, d: line(HUB, l.to), markerEnd: 'url(#flow-head)' })]; }),
  ...flow.nodes.map(n => {
    const p = at[n.id], hub = n.id === HUB, c = hub ? {} : toolColor(n.id), w = hub ? hubW : BW, hh = hub ? hubH : BH, lines = [n.label, n.sub].filter(Boolean) as string[];
    return h('g', { key: n.id, ...c, className: ['node', hub ? 'hub' : c.className, n.on || busy.has(n.id) ? 'on' : ''].filter(Boolean).join(' '), transform: `translate(${p.x - w / 2},${p.y - hh / 2})` },
      h('rect', { width: w, height: hh, rx: 9 }),
      h('text', { className: 'name', x: w / 2, y: lines.length === 2 ? 12 : lines.length ? 15 : hh / 2 + 4 }, n.name),
      ...lines.map((t, i) => h('text', { key: i, className: i ? 'what next' : 'what', x: w / 2, y: lines.length === 2 ? 22 + i * 9 : 27 }, t)),
      hub ? h('text', { className: 'what tag', x: w / 2, y: hh - 5 }, 'JEV') : null);
  }));
}

/** True while the page can be seen (a hidden popover or window animates nothing). */
export function useVisible(): boolean {
  const [v, set] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => { const on = () => set(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, []);
  return v;
}
/** The diagram with its data: the tools (integrations rows, also their own colors) and what runs now. */
export function FlowPanel({ bridge, runs, now }: { bridge: Bridge; runs: LiveRun[]; now: number }) {
  const tools = useOp(bridge, 'integrations');
  const visible = useVisible();
  const rows = tools.data?.rows ?? [];
  setToolColors(rows);
  return h(FlowView, { flow: flowModel(rows, runs, now), still: !visible });
}
