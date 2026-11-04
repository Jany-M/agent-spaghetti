// Routing panel (finish-line plan I2): for each kind of task, the targets Agent Spaghetti would hand it to, best first, and why
// (sdk route); your pick or "never" per kind; the routing switches; and the words that tell a task's kind (JEV defaults).
import { createElement as h, useState } from 'react';
import { DIFFICULTIES, JEV_DEFAULTS, type Difficulty, type OpIO } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useAct, useOp } from './hooks.ts';
import { Field } from './settings.ts';

type Out = OpIO['routing']['out'];
type All = OpIO['settings']['out'];
export type Pick = 'prefer' | 'never';
/** The routing settings this panel shows as fields (`routing.prefer` and `routing.never` are the First / Never buttons). */
export const ROUTING_FIELDS = ['routing.learn', 'routing.stretch', 'routing.escalate', 'routing.tiers'] as const;
const list = (s: All | null, p: Pick) => (s?.[`routing.${p}`]?.value as string[] | undefined) ?? [];
/** Both lists after toggling `p` for a target on a kind: one pick per kind, and a target is never both first and never. */
export function routePicks(prefer: string[], never: string[], kind: string, id: string, p: Pick): Record<`routing.${Pick}`, string[]> {
  const entry = `${kind}=${id}`, on = !(p === 'prefer' ? prefer : never).includes(entry);
  return { 'routing.prefer': [...prefer.filter(x => x !== entry && !(p === 'prefer' && on && x.startsWith(`${kind}=`))), ...(on && p === 'prefer' ? [entry] : [])],
    'routing.never': [...never.filter(x => x !== entry), ...(on && p === 'never' ? [entry] : [])] };
}

export interface RoutingProps { routing: Out | null; settings: All | null; difficulty: Difficulty; busy: string | null; error: string | null;
  onDifficulty(d: Difficulty): void; onPick(kind: string, id: string, p: Pick): void; onSave(key: string, text: string): void }
export function RoutingView(p: RoutingProps) {
  const never = list(p.settings, 'never');
  return h('div', { className: 'panel routing' },
    p.error ? h('div', { className: 'card error', role: 'alert' }, p.error) : null,
    h('div', { className: 'card' }, h('div', { className: 'row' }, 'Where a ',
      h('select', { 'aria-label': 'Difficulty', value: p.difficulty, onChange: (e: { target: { value: string } }) => p.onDifficulty(e.target.value as Difficulty) },
        ...DIFFICULTIES.map(d => h('option', { key: d, value: d }, d))), ' task of each kind goes, best first'),
      h('div', { className: 'why' }, 'Free before paid, a target big enough for the task, then how its past runs of that kind went (finished, failed, your grades). First: always try it first for that kind. Never: not for that kind.')),
    ...(p.routing?.kinds ?? []).map(k => h('section', { key: k.kind }, h('h2', null, k.kind),
      h('div', { className: 'card list' }, ...(k.ranked.length ? k.ranked.map((r, i) => h('div', { key: r.target.id, className: r.skip ? 'route skip' : 'route' },
        h('div', null, h('b', null, r.skip ? '– ' : `${i + 1}. `), r.target.name, h('span', { className: 'why' }, `  ${r.why}`)),
        h('div', { className: 'row' },
          h('button', { 'aria-pressed': !!r.preferred, disabled: !!p.busy, title: `Always try ${r.target.name} first for ${k.kind}`, onClick: () => p.onPick(k.kind, r.target.id, 'prefer') }, 'First'),
          h('button', { 'aria-pressed': never.includes(`${k.kind}=${r.target.id}`), disabled: !!p.busy, title: `Never hand ${k.kind} to ${r.target.name}`, onClick: () => p.onPick(k.kind, r.target.id, 'never') }, 'Never'))))
        : [h('div', { key: 'none', className: 'empty' }, 'Nothing to hand it to now.')])))),
    h('section', null, h('h2', null, 'How it ranks'),
      h('div', { className: 'card form' }, ...ROUTING_FIELDS.flatMap(key => { const s = p.settings?.[key]; return s ? [h('div', { key, className: 'setting' },
        h('div', { className: 'name' }, key), h('div', { className: 'why' }, s.help), h(Field, { k: key, s, busy: p.busy === key, onSave: p.onSave }))] : []; }))),
    h('details', { className: 'card' }, h('summary', null, 'How the kind of a task is told'),
      h('div', { className: 'why' }, 'From the words of the task (the first words count more); a tool that hands work over may also name the kind itself.'),
      ...Object.entries(JEV_DEFAULTS.kinds).map(([kind, words]) => h('div', { key: kind, className: 'meta' }, h('b', null, kind), `: ${words.join(', ')}`))));
}

export function RoutingPanel({ bridge }: { bridge: Bridge }) {
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const routing = useOp(bridge, 'routing', { difficulty });
  const settings = useOp(bridge, 'settings');
  const { busy, error, act } = useAct(async () => { await settings.reload(); await routing.reload(); });
  const save = (key: string, value: string) => bridge.call('setting', { key, value });
  return h(RoutingView, { routing: routing.data, settings: settings.data, difficulty, busy, error: error ?? routing.error ?? settings.error, onDifficulty: setDifficulty,
    onPick: (kind, id, p) => act(`${p} ${kind}`, async () => {
      for (const [key, v] of Object.entries(routePicks(list(settings.data, 'prefer'), list(settings.data, 'never'), kind, id, p))) await save(key, v.join(','));
    }),
    onSave: (key, text) => act(key, () => save(key, text)) });
}
