// Live trace: the detachable always-on-top window (?window=live) — one grouped list,
// thin lines for normal events (sdk eventLine), expandable monospace blocks for trace.detail.
import { createElement as h, useEffect, useRef, useState } from 'react';
import { eventLine, type StoredEvent } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';

const MAX = 500;
const runOf = (e: StoredEvent): string => {
  const d = e.data as Record<string, unknown>;
  if (e.type === 'trace.detail') return String(d.runId ?? d.chainId ?? '-');
  if (d && typeof d.id === 'number') return String(d.id);
  return '-';
};
const isDetail = (e: StoredEvent) => e.type === 'trace.detail';

export function LiveView({ bridge }: { bridge: Bridge }) {
  const [items, setItems] = useState<StoredEvent[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const list = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const off = bridge.onEvent(e => {
      if ('id' in e) {
        if (!paused) setItems(old => { const n = [...old, e]; return n.length > MAX ? n.slice(-MAX) : n; });
      }
    });
    return () => off();
  }, [bridge, paused]);

  const runs = new Map<string, StoredEvent[]>();
  for (const e of items) { const r = String(runOf(e) ?? '-'); (runs.get(r) ?? runs.set(r, []).get(r)!).push(e); }
  const groups = [...runs.entries()].sort((a, b) => {
    const ta = a[1][a[1].length - 1].ts, tb = b[1][b[1].length - 1].ts; return tb - ta;
  });
  const firstRun = groups[0]?.[0] ?? null;
  const showLatestOnly = filter === 'latest';
  const showById = filter !== 'all' && filter !== 'latest';

  const scroll = () => { if (!paused && atBottom.current && list.current) { list.current.scrollTop = list.current.scrollHeight; } };
  useEffect(() => scroll(), [items, paused]);

  return h('div', { className: 'live' },
    h('div', { className: 'bar' },
      h('span', { className: 'label' }, 'Live'),
      h('select', { value: filter, onChange: (e: Event) => setFilter((e.target as HTMLSelectElement).value),
        title: 'Filter by run' },
        h('option', { value: 'all' }, 'All runs'), h('option', { value: 'latest' }, 'Latest'),
        ...groups.map(([k]) => h('option', { value: k, key: k }, `Run ${k}`))
      ),
      h('button', { onClick: () => setPaused(p => !p) }, paused ? 'Resume' : 'Pause'),
      h('button', { onClick: () => { setItems([]); setExpanded(new Set()); setFilter('all'); } }, 'Clear')
    ),
    h('div', { className: 'list', ref: list, onScroll: () => {
      const el = list.current; if (!el) return;
      atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    } },
      groups.map(([runId, entries]) => {
        if (showLatestOnly && runId !== firstRun) return null;
        if (showById && String(runId) !== filter) return null;
        const header = `Run ${runId}`;
        return h('div', { className: 'group', key: runId },
          h('div', { className: 'group-tag' }, header, ' · ', entries.length, ' event(s)'),
          ...entries.map(e => {
            const detail = isDetail(e);
            const text = detail ? String((e.data as Record<string, unknown>).text ?? '') : '';
            return detail
              ? h('div', { className: 'entry detail', key: e.id, onClick: () => setExpanded(s => new Set(s.has(e.id) ? [...s].filter(x => x !== e.id) : [...s, e.id])) },
                  h('div', { className: 'line' }, '▶ ', String((e.data as Record<string, unknown>).stage ?? 'detail'), ' ', String(runId), ' · ', text.slice(0, 90) + (text.length > 90 ? '...' : '')),
                  expanded.has(e.id) ? h('pre', { className: 'mono' }, text) : null
                )
              : h('div', { className: 'entry', key: e.id }, eventLine(e));
          })
        );
      })
    )
  );
}
