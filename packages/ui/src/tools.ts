// Tools panel (ADR 0009): every found tool, grouped by type in collapsible blocks; connect/disconnect, preference,
// test, skip in scans; "More" shows its switches and, for third-party tools, what it may do.
import { createElement as h, useState, type ReactNode } from 'react';
import { ACTION_LABEL, TOOL_GROUPS, testLines, type DeclaredAction, type Grant, type Mode, type Switch, type ToolRow } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useAct, useOp } from './hooks.ts';

export type Preference = NonNullable<ToolRow['preference']>;
const PREF_LABEL: Record<Preference, string> = { ask: 'Ask at start', always: 'Always connect', never: "Don't connect" };
export interface ToolDetails { switches?: Switch[]; declared?: DeclaredAction[]; grants?: Grant[] }
export interface ToolsProps {
  rows: ToolRow[]; busy: string | null; error: string | null; closed: Set<string>;
  tests: Record<string, string[]>; details: Record<string, ToolDetails>;
  onToggleGroup(group: string, open: boolean): void; onExpand(id: string): void;
  onConnect(id: string, on: boolean): void; onPreference(id: string, p: Preference): void; onTest(id: string): void; onSkip(id: string, skip: boolean): void;
  onSwitch(s: Switch, on: boolean): void; onGrant(id: string, a: DeclaredAction, mode: Mode | null): void;
}

function Row({ r, p }: { r: ToolRow; p: ToolsProps }) {
  const d = p.details[r.id], busy = !!p.busy;
  const more: ReactNode[] = [
    ...(d?.switches?.length ? [h('div', { key: 'sw', className: 'sub' }, h('h3', null, 'Switches'), ...d.switches.map(s =>
      h('label', { key: s.id + s.envId, className: 'check' }, h('input', { type: 'checkbox', checked: s.on, disabled: busy, onChange: () => p.onSwitch(s, !s.on) }), ` ${s.label} (${s.envId})`)))] : []),
    ...(d?.declared?.length ? [h('div', { key: 'pm', className: 'sub' }, h('h3', null, 'May it…'), ...d.declared.map(a => {
      const mode = d.grants?.find(g => g.action === a.action && g.resource === a.resource)?.mode;
      return h('div', { key: a.action + a.resource, className: 'perm' }, h('div', null, `${ACTION_LABEL[a.action]} `, h('code', null, a.resource), h('span', { className: 'why' }, ` ${a.why}`)),
        h('div', { className: 'row' }, ...(['allow', 'deny'] as const).map(m => h('button', { key: m, disabled: busy || mode === m, className: m === 'allow' ? 'allow' : '', onClick: () => p.onGrant(r.id, a, m) }, m === 'allow' ? 'Allow' : 'Deny')),
          mode ? h('button', { disabled: busy, onClick: () => p.onGrant(r.id, a, null) }, 'Ask again') : null));
    }))] : []),
    ...(p.tests[r.id] ? [h('pre', { key: 'test' }, p.tests[r.id].join('\n'))] : []),
  ];
  return h('div', { className: `card tool${r.asks ? ' asking' : ''}` },
    h('div', { className: 'top' }, h('span', { className: 'name' }, r.name), r.version ? h('span', { className: 'meta' }, ` ${r.version}`) : null,
      h('span', { className: `state ${r.state.replace(' ', '-')}` }, r.state),
      r.connection ? h('span', { className: `state ${r.connection === 'connected' ? 'ready' : 'installed'}` }, r.connection) : null),
    h('div', { className: 'why' }, [r.why, r.envs.join(', ')].filter(Boolean).join(' · ')),
    h('div', { className: 'row' },
      r.connection ? h('button', { className: r.connection === 'connected' ? '' : 'allow', disabled: busy, onClick: () => p.onConnect(r.id, r.connection !== 'connected') },
        r.connection === 'connected' ? 'Disconnect' : 'Connect') : null,
      r.preference ? h('select', { 'aria-label': `When ${r.name} is found`, value: r.preference, disabled: busy, onChange: (e: { target: { value: string } }) => p.onPreference(r.id, e.target.value as Preference) },
        ...(Object.keys(PREF_LABEL) as Preference[]).map(k => h('option', { key: k, value: k }, PREF_LABEL[k]))) : null,
      h('button', { disabled: busy, onClick: () => p.onTest(r.id) }, p.busy === `test ${r.id}` ? 'Testing…' : 'Test'),
      h('button', { disabled: busy, onClick: () => p.onSkip(r.id, r.state !== 'skipped') }, r.state === 'skipped' ? 'Scan again' : 'Skip in scans')),
    h('details', { onToggle: (e: { currentTarget: { open: boolean } }) => { if (e.currentTarget.open) p.onExpand(r.id); } }, h('summary', null, 'More'),
      ...(more.length ? more : [h('div', { key: 'none', className: 'empty' }, d ? 'No switches or permissions.' : 'Loading…')])));
}

export function ToolsView(p: ToolsProps) {
  const found = p.rows.filter(r => r.state !== 'not found');
  const missing = p.rows.filter(r => r.state === 'not found');
  return h('div', { className: 'panel' },
    p.error ? h('div', { className: 'card error', role: 'alert' }, p.error) : null,
    ...TOOL_GROUPS.map(g => {
      const rows = found.filter(r => r.group === g.id);
      if (!rows.length) return null;
      const used = rows.filter(r => r.connection === 'connected' || r.state === 'ready').length;
      return h('details', { key: g.id, className: 'group', open: !p.closed.has(g.id) || rows.some(r => r.asks),
        onToggle: (e: { currentTarget: { open: boolean } }) => p.onToggleGroup(g.id, e.currentTarget.open) },
        h('summary', null, h('h2', null, `${g.label} · ${rows.length}`), used ? h('span', { className: 'meta' }, ` ${used} in use`) : null),
        ...rows.map(r => h(Row, { key: r.id, r, p })));
    }),
    missing.length ? h('details', { className: 'group' }, h('summary', null, h('h2', null, `Not found on this machine · ${missing.length}`)),
      h('div', { className: 'card list' }, ...missing.map(r => h('div', { key: r.id }, r.name)))) : null);
}

const CLOSED = 'agent-spaghetti.tools.closed';
const loadClosed = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(CLOSED) ?? '[]')); } catch { return new Set<string>(); } };
/** Preference lists after choosing `p` for `id` (one tool is in at most one list). */
export function preferenceLists(auto: string[], never: string[], id: string, p: Preference) {
  const strip = (l: string[]) => l.filter(x => x !== id);
  return { 'connect.auto': [...strip(auto), ...(p === 'always' ? [id] : [])], 'connect.never': [...strip(never), ...(p === 'never' ? [id] : [])] };
}

export function ToolsPanel({ bridge }: { bridge: Bridge }) {
  const tools = useOp(bridge, 'integrations');
  const settings = useOp(bridge, 'settings');
  const { busy, error, act } = useAct(tools.reload);
  const [closed, setClosed] = useState(loadClosed);
  const [tests, setTests] = useState<Record<string, string[]>>({});
  const [details, setDetails] = useState<Record<string, ToolDetails>>({});
  const rows = tools.data?.rows ?? [];
  const expand = (id: string) => void Promise.all([
    bridge.call('switches').then(r => r.switches.filter(s => s.integration === id)).catch(() => []),
    rows.find(r => r.id === id)?.source === 'user' ? bridge.call('permissions') : Promise.resolve(null),
  ]).then(([switches, perm]) => setDetails(d => ({ ...d, [id]: { switches, declared: perm?.subjects.find(s => s.subject === id)?.declared, grants: perm?.grants.filter(g => g.subject === id) } })));
  return h(ToolsView, {
    rows, busy, error: error ?? tools.error, closed, tests, details,
    onToggleGroup: (g, open) => setClosed(c => { const n = new Set(c); if (open) n.delete(g); else n.add(g); try { localStorage.setItem(CLOSED, JSON.stringify([...n])); } catch { /* convenience only */ } return n; }),
    onExpand: expand,
    onConnect: (id, on) => act(`connect ${id}`, () => bridge.call('connect', { integration: id, on })),
    onPreference: (id, p) => act(`pref ${id}`, async () => {
      const lists = preferenceLists((settings.data?.['connect.auto']?.value as string[]) ?? [], (settings.data?.['connect.never']?.value as string[]) ?? [], id, p);
      for (const [key, v] of Object.entries(lists)) await bridge.call('setting', { key, value: v.join(',') });
      const row = rows.find(r => r.id === id);
      const on = row?.connection === 'connected';
      if ((p === 'always' && !on) || (p === 'never' && on)) await bridge.call('connect', { integration: id, on: !on });   // the choice applies now
      await settings.reload();
    }),
    onTest: id => act(`test ${id}`, async () => {
      const r = await bridge.call('test', { integration: id });
      setTests(t => ({ ...t, [id]: r.flatMap(x => [`${id} in ${x.envId}`, ...(x.result ? testLines(x.result) : [`FAIL  ${x.error}`])]) }));
    }),
    onSkip: (id, skip) => act(`skip ${id}`, () => bridge.call(skip ? 'disable' : 'enable', { id })),
    onSwitch: (s, on) => act(`switch ${s.id}`, () => bridge.call('switch', { id: s.id, on, envId: s.envId }).then(() => expand(s.integration))),
    onGrant: (id, a, mode) => act(`grant ${id}`, () => (mode ? bridge.call('grant', { subject: id, mode, action: a.action, resource: a.resource })
      : bridge.call('revoke', { subject: id, action: a.action, resource: a.resource })).then(() => expand(id))),
  });
}
