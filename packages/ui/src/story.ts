// One event line with its tools and actions colored (Activity, the live pane). Actions use their own few colors (sdk Act); a tool
// uses its manifest's color, else one of TOOL_COLORS, assigned on first sight and remembered (all windows share it, restarts too).
import { createElement as h, useEffect, useState } from 'react';
import { eventLine, storyParts, toolLabel, type Part, type StoredEvent } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';

export const TOOL_COLORS = 7;                                     // .tc0 … .tc6 in styles.ts (hues kept apart from the action colors)
const KEY = 'agent-spaghetti.toolColors';
let memory: Record<string, number> = {};
let own: Record<string, string> = {};                             // manifest colors, by tool id
/** The color slot of a tool: the next free one the first time it shows up, then always the same. */
export function toolSlot(id: string): number {
  let map = memory;
  try { map = JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { /* no storage: this window only */ }
  if (map[id] === undefined) {
    map[id] = Object.keys(map).length % TOOL_COLORS;
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* convenience only */ }
    memory = map;
  }
  return map[id] % TOOL_COLORS;                                  // a slot saved when there were more colors still maps to one
}
/** The tools' own colors (manifest `color`, from the integrations op), set once per window. */
export const setToolColors = (rows: Array<{ id: string; color?: string }>) => { own = Object.fromEntries(rows.flatMap(t => (t.color ? [[t.id, t.color]] : []))); };
/** Loads the tools' own colors once; the lines re-render when they arrive. */
export function useToolColors(bridge: Bridge) {
  const [, set] = useState(0);
  useEffect(() => { void bridge.call('integrations').then(r => { setToolColors(r.rows); set(n => n + 1); }).catch(() => {}); }, [bridge]);
}
const base = (id: string) => id.split(':')[0];                    // lmstudio:gemma → the tool's color
function Tool({ id }: { id: string }) {
  const b = base(id), label = toolLabel(id);
  return b === 'agent-spaghetti' ? h('b', { className: 'tool hub' }, label)
    : own[b] ? h('b', { className: 'tool', style: { color: own[b] } }, label) : h('b', { className: `tool tc${toolSlot(b)}` }, label);
}
export function PartsView({ parts }: { parts: Part[] }) {
  return h('span', { className: 'story' }, ...parts.map((p, i) => typeof p === 'string' ? p
    : 'tool' in p ? h(Tool, { key: i, id: p.tool }) : h('span', { key: i, className: `act ${p.act}` }, p.text)));
}
/** An event: its time, then its sentence colored; events without one as their plain line. */
export function Story({ e }: { e: StoredEvent }) {
  const p = storyParts(e);
  return p ? h('span', null, `${new Date(e.ts).toTimeString().slice(0, 8)}  `, h(PartsView, { parts: p })) : h('span', null, eventLine(e));
}
