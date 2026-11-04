// Activity panel: the latest events, then new ones as they happen, each as a sentence colored by how it went
// (done, failed, in progress, information). The live pane (live.ts) adds the run-by-run detail.
import { createElement as h } from 'react';
import { eventTone, type StoredEvent } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useEvents } from './hooks.ts';
import { Story } from './story.ts';

export const ActivityView = ({ events }: { events: StoredEvent[] }) => h('div', { className: 'panel' },
  events.length ? h('div', { className: 'card list mono' }, ...[...events].reverse().map(e => h('div', { key: e.id, className: `tone-${eventTone(e)}` }, h(Story, { e }))))
    : h('div', { className: 'empty' }, 'No events yet.'));

export function ActivityPanel({ bridge }: { bridge: Bridge }) {
  const [events] = useEvents(bridge, 200);
  return h(ActivityView, { events });
}
