// The live pane (?window=live): a small window that stays on top and stays open when you click elsewhere. One line per step of the
// work as it happens, newest on top: hand-offs and hops, Agent Spaghetti's choices, questions, the task as sent, answers as they stream, where results
// went. Trace lines (never stored, ADR 0007) open to their full text. Lines from sdk storyParts, tools and actions colored (story.ts).
import { createElement as h, useState } from 'react';
import { eventTone, isTrace, storyLine, type StoredEvent } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { Story, useToolColors } from './story.ts';
import { useEvents } from './hooks.ts';

const KEEP = 400;
/** The run an event belongs to, if any. */
export const runOf = (e: StoredEvent): number | null => {
  const d = e.data as Record<string, unknown>, n = Number(e.type === 'trace.detail' ? d.runId ?? d.chainId : e.type.startsWith('run.') || e.type === 'dispatcher.action' ? d.id : NaN);
  return Number.isFinite(n) ? n : null;
};
const ABOUT_WORK = (e: StoredEvent) => e.type.startsWith('run.') || e.type.startsWith('consent.') || e.type === 'dispatcher.action' || e.type === 'trace.detail';
export interface LiveRow { key: number; tone: string; line: string; event: StoredEvent; run: number | null; text?: string }
/** What the pane shows, oldest first: work events only unless `all`, one run when `run` is set; streamed output of a run is one growing line. */
export function liveRows(events: StoredEvent[], o: { all?: boolean; run?: number | null } = {}): LiveRow[] {
  const rows: LiveRow[] = [];
  let last: { e: StoredEvent; text: string } | null = null;
  for (const e of events) {
    if (!o.all && !ABOUT_WORK(e)) continue;
    const run = runOf(e);
    if (o.run != null && run !== o.run) continue;
    const d = e.data as Record<string, unknown>;
    if (e.type === 'trace.detail' && d.stage === 'output' && last && last.e.type === 'trace.detail' && (last.e.data as Record<string, unknown>).stage === 'output' && runOf(last.e) === run) {
      last.text += String(d.text ?? '');
      const merged = { ...last.e, data: { ...last.e.data, text: last.text } };
      rows[rows.length - 1] = { key: last.e.id, tone: eventTone(merged), line: storyLine(merged), event: merged, run, text: last.text };
      continue;
    }
    last = isTrace(e) ? { e, text: String(d.text ?? '') } : null;
    rows.push({ key: e.id, tone: eventTone(e), line: storyLine(e), event: e, run, ...(isTrace(e) ? { text: String(d.text ?? '') } : {}) });
  }
  return rows;
}

export interface LiveProps { rows: LiveRow[]; all: boolean; run: number | null; paused: boolean; open: Set<number>;
  onAll(all: boolean): void; onRun(run: number | null): void; onPause(): void; onClear(): void; onToggle(key: number): void; onClose(): void }
export function LiveList(p: LiveProps) {
  return h('div', { className: 'live' },
    h('header', { className: 'bar' },
      h('span', { className: 'label' }, 'Live'),
      h('select', { 'aria-label': 'What to show', value: p.all ? 'all' : 'work', onChange: (e: { target: { value: string } }) => p.onAll(e.target.value === 'all') },
        h('option', { value: 'work' }, 'Runs and hand-offs'), h('option', { value: 'all' }, 'Everything')),
      p.run !== null ? h('button', { className: 'chip', title: 'Show every run', onClick: () => p.onRun(null) }, `run ${p.run} ×`) : null,
      h('span', { className: 'grow' }),
      h('button', { onClick: p.onPause, 'aria-pressed': p.paused }, p.paused ? 'Resume' : 'Pause'),
      h('button', { onClick: p.onClear }, 'Clear'),
      h('button', { 'aria-label': 'Close', title: 'Close (tray menu → Live activity opens it again)', onClick: p.onClose }, '×')),
    p.rows.length ? h('div', { className: 'feed mono', role: 'log', 'aria-live': 'polite' }, ...[...p.rows].reverse().map(r => h('div', { key: r.key, className: `entry tone-${r.tone}` },
      h('div', { className: 'line' },
        r.run !== null && p.run === null ? h('button', { className: 'tag', title: `Only run ${r.run}`, onClick: () => p.onRun(r.run) }, `#${r.run}`) : null,
        r.text !== undefined ? h('button', { className: 'text', title: 'Show the full text', 'aria-expanded': p.open.has(r.key), onClick: () => p.onToggle(r.key) }, h(Story, { e: r.event })) : h(Story, { e: r.event })),
      r.text !== undefined && p.open.has(r.key) ? h('pre', null, r.text) : null)))
      : h('div', { className: 'empty' }, p.paused ? 'Paused.' : 'Nothing yet: hand a task to a tool and its steps show here as they happen.'));
}

export function LiveView({ bridge }: { bridge: Bridge }) {
  const [events, setEvents] = useEvents(bridge, KEEP, true);
  const [all, setAll] = useState(false);
  const [run, setRun] = useState<number | null>(null);
  const [frozen, setFrozen] = useState<StoredEvent[] | null>(null);       // paused: the lines as they were
  const [open, setOpen] = useState<Set<number>>(new Set());
  const rows = liveRows(frozen ?? events, { all, run });
  useToolColors(bridge);
  return h(LiveList, { rows, all, run, paused: frozen !== null, open,
    onAll: setAll, onRun: setRun, onPause: () => setFrozen(f => (f ? null : events)), onClear: () => { setEvents([]); setFrozen(null); setOpen(new Set()); },
    onToggle: k => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; }),
    onClose: () => window.close() });
}
