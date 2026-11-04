// One event line with its tools and actions colored (Activity, the live pane). Actions use their own few colors (sdk Act); tools
// get one of TOOL_COLORS, assigned on first sight and remembered (all windows share it, restarts too), so a tool keeps its color.
import { createElement as h } from 'react';
import { eventLine, storyParts, toolLabel, type Part, type StoredEvent } from '@agent-spaghetti/sdk/web';

export const TOOL_COLORS = 7;                                     // .tc0 … .tc6 in styles.ts (hues kept apart from the action colors)
const KEY = 'agent-spaghetti.toolColors';
let memory: Record<string, number> = {};
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
const base = (id: string) => id.split(':')[0];                    // lmstudio:gemma → the tool's color
export function PartsView({ parts }: { parts: Part[] }) {
  return h('span', { className: 'story' }, ...parts.map((p, i) => typeof p === 'string' ? p
    : 'tool' in p ? h('b', { key: i, className: base(p.tool) === 'agent-spaghetti' ? 'tool hub' : `tool tc${toolSlot(base(p.tool))}` }, toolLabel(p.tool))
    : h('span', { key: i, className: `act ${p.act}` }, p.text)));
}
/** An event: its time, then its sentence colored; events without one as their plain line. */
export function Story({ e }: { e: StoredEvent }) {
  const p = storyParts(e);
  return p ? h('span', null, `${new Date(e.ts).toTimeString().slice(0, 8)}  `, h(PartsView, { parts: p })) : h('span', null, eventLine(e));
}
