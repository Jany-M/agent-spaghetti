// Activity panel: the latest events, then new ones as they happen (same lines as `agent-spaghetti events`).
import { createElement as h, useEffect, useState } from 'react';
import { eventLine, type StoredEvent } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';

export const ActivityView = ({ events }: { events: StoredEvent[] }) => h('div', { className: 'panel' },
  events.length ? h('div', { className: 'card list mono' }, ...[...events].reverse().map(e => h('div', { key: e.id }, eventLine(e)))) : h('div', { className: 'empty' }, 'No events yet.'));

const KEEP = 200;
export function ActivityPanel({ bridge }: { bridge: Bridge }) {
  const [events, setEvents] = useState<StoredEvent[]>([]);
  useEffect(() => {
    let live = true;
    void bridge.call('status').then(s => bridge.call('events', { since: Math.max(0, s.live.lastEventId - KEEP), limit: KEEP }))
      .then(ev => { if (live) setEvents(ev); }).catch(() => {});
    const off = bridge.onEvent(e => { if ('id' in e) setEvents(l => [...l.filter(x => x.id !== e.id), e].slice(-KEEP)); });
    return () => { live = false; off(); };
  }, [bridge]);
  return h(ActivityView, { events });
}
