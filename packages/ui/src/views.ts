// Tray popover views. Plain React.createElement (no JSX): the same files run in tests under node and in the bundle.
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { ACTION_LABEL, SCOPE_LABEL, emptyLive, renderStats, trayState, type ConsentRequest, type ConsentScope, type OpIO } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';

export type Status = OpIO['status']['out'];
export interface HubView { up: boolean; status: Status | null }
export type Answer = (id: string, allow: boolean, scope?: ConsentScope) => void;

export function ApprovalCard({ req, names, now, onAnswer }: { req: ConsentRequest; names: Map<string, string>; now: number; onAnswer: Answer }) {
  const name = names.get(req.subject) ?? req.subject, what = req.action === 'run' ? names.get(req.resource) ?? req.resource : req.resource;
  const left = req.expiresAt ? Math.max(0, Math.round((req.expiresAt - now) / 1000)) : null;
  return h('div', { className: 'card ask', role: 'group', 'aria-label': `Question from ${name}` },
    h('div', { className: 'what' }, `${name} wants to ${ACTION_LABEL[req.action]} `, h('code', null, what),
      req.cost && req.cost !== 'free' ? h('span', { className: 'badge' }, req.cost === 'metered' ? 'paid' : req.cost) : null),
    h('div', { className: 'why' }, req.why),
    req.task !== undefined ? h('pre', null, req.task) : null,
    req.billing ? h('div', { className: 'meta' }, req.billing) : null,
    left !== null ? h('div', { className: 'meta' }, `expires in ${left} s (then denied)`) : null,
    h('div', { className: 'row' },
      h('button', { onClick: () => onAnswer(req.id, false) }, 'Deny'),
      ...req.scopes.map(s => h('button', { key: s, className: 'allow', onClick: () => onAnswer(req.id, true, s) }, SCOPE_LABEL[s]))));
}

function sessions(s: Status) {
  const agents = new Map(s.snapshot?.agents.map(a => [`${a.envId}|${a.id.slice(a.integration.length + 1)}`, a.name]) ?? []);
  const names = new Map(s.snapshot?.detections.map(d => [d.integration, d.name]) ?? []);
  const runs = Object.values(s.live.runs).map(r => `${names.get(r.source) ?? r.source} → ${names.get(r.target) ?? r.target} (run ${r.id})`);
  return [...runs, ...Object.values(s.live.sessions).map(x =>
    `${agents.get(`${x.envId}|${x.agentId}`) ?? x.agentId ?? 'agent'} · ${[x.kind ?? 'session', x.status].filter(Boolean).join(' ')}${x.model ? ` · ${x.model}` : ''}`)];
}
const section = (title: string, ...children: ReactNode[]) => h('section', null, h('h2', null, title), ...children);

export function PopoverView({ view, now, onAnswer, onScan, scanning }: { view: HubView; now: number; onAnswer: Answer; onScan(): void; scanning: boolean }) {
  const s = view.status;
  const consents = s?.consents ?? [];
  const live = s?.live ?? emptyLive(), snap = s?.snapshot ?? null;
  const state = trayState(view.up, snap, live, consents), lines = renderStats(view.up, snap, live, consents);
  const names = new Map(s?.snapshot?.detections.map(d => [d.integration, d.name]) ?? []);
  const running = s ? sessions(s) : [];
  return h('div', { className: 'pop' },
    h('header', { className: 'head' }, h('img', { src: 'icon.png', alt: '' }),
      h('div', { className: 'lines' }, h('div', null, h('span', { className: `dot ${state}`, 'aria-label': state }), lines[0]),
        ...lines.slice(1).map(l => h('div', { key: l }, l)))),
    h('main', { className: 'body' },
      consents.length ? section('Waiting for you', ...consents.map(c => h(ApprovalCard, { key: c.id, req: c, names, now, onAnswer }))) : null,
      section('Running', running.length ? h('div', { className: 'card list' }, ...running.map((r, i) => h('div', { key: i }, r))) : h('div', { className: 'empty' }, view.up ? 'Nothing running.' : 'Start the daemon from the tray menu.'))),
    h('footer', { className: 'foot' },
      h('span', null, s?.snapshot ? `last scan ${new Date(s.snapshot.ts).toLocaleTimeString()}` : ''),
      h('button', { onClick: onScan, disabled: !view.up || scanning }, scanning ? 'Scanning…' : 'Rescan')));
}

/** Live data for the popover: refreshed on every hub event (coalesced), cleared when the hub goes away. */
export function useHub(bridge: Bridge): HubView & { refresh(): Promise<void> } {
  const [view, setView] = useState<HubView>({ up: false, status: null });
  const refresh = async () => { try { setView({ up: true, status: await bridge.call('status') }); } catch { setView({ up: false, status: null }); } };
  useEffect(() => {
    void refresh();
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = bridge.onEvent(e => { clearTimeout(t); if (e.type === 'hub.down') setView({ up: false, status: null }); else t = setTimeout(refresh, 150); });
    return () => { off(); clearTimeout(t); };
  }, [bridge]);
  return { ...view, refresh };
}

export function Popover({ bridge }: { bridge: Bridge }) {
  const hub = useHub(bridge);
  const [now, setNow] = useState(Date.now());
  const [scanning, setScanning] = useState(false);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  const onAnswer: Answer = (id, allow, scope) => void bridge.call('consent', { id, allow, scope }).catch(() => {}).finally(hub.refresh);
  const onScan = () => { setScanning(true); void bridge.call('scan').catch(() => {}).finally(() => { setScanning(false); void hub.refresh(); }); };
  return h(PopoverView, { view: hub, now, onAnswer, onScan, scanning });
}
