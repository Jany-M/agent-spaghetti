// Runs panel: the run record, one run's hand-off chain + result (verdict, cancel), and "New task" (= delegate).
import { createElement as h, useState } from 'react';
import { HANDOFF_KINDS, runLine, type OpIO, type RunRow, type Target } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useAct, useOp } from './hooks.ts';

type DelegateIn = OpIO['delegate']['in'];
/** The New task form → the delegate op's input (the same fields MCP clients send). Empty optionals are left out. */
export function delegateInput(f: Record<string, string>): DelegateIn {
  const opt = (k: 'kind' | 'reason' | 'model') => (f[k]?.trim() ? { [k]: f[k].trim() } : {});
  return { target: f.target ?? '', task: (f.task ?? '').trim(), ...opt('kind'), ...opt('reason'), ...opt('model'), source: 'tray', waitMs: 0 } as DelegateIn;
}
export interface RunsProps {
  runs: RunRow[]; chain: RunRow[] | null; result?: string; selected: number | null; targets: Target[]; target: string;
  busy: string | null; error: string | null;
  onSelect(id: number | null): void; onVerdict(id: number, v: 'up' | 'down' | 'redo'): void; onCancel(id: number): void;
  onTarget(id: string): void; onSend(f: Record<string, string>): void;
}

export function RunsView(p: RunsProps) {
  const t = p.targets.find(x => x.id === p.target) ?? p.targets[0];
  const sel = p.chain?.find(r => r.id === p.selected);
  const form = h('form', { className: 'card form', onSubmit: (e: { preventDefault(): void; currentTarget: unknown }) => {
      e.preventDefault(); p.onSend(Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement) as unknown as Iterable<[string, string]>));
    } },
    h('h2', null, 'New task'),
    p.targets.length ? null : h('div', { className: 'empty' }, 'Nothing to hand tasks to yet: start a model server or install an agent, then rescan.'),
    h('div', { className: 'grid' },
      h('label', null, 'To', h('select', { name: 'target', value: t?.id ?? '', onChange: (e: { target: { value: string } }) => p.onTarget(e.target.value) },
        ...p.targets.map(x => h('option', { key: x.id, value: x.id }, `${x.name} (${x.cost})`)))),
      t?.models.length ? h('label', null, t.kind === 'model' ? 'Model' : 'Agent', h('select', { name: 'model', key: t.id }, ...t.models.map(m => h('option', { key: m, value: m }, m)))) : null,
      h('label', null, 'Kind', h('select', { name: 'kind', defaultValue: 'other' }, ...HANDOFF_KINDS.map(k => h('option', { key: k, value: k }, k)))),
      h('label', null, 'Why', h('input', { name: 'reason', placeholder: 'one line, kept in the record' }))),
    h('textarea', { name: 'task', rows: 4, required: true, placeholder: 'The whole task: the target sees nothing else.' }),
    h('div', { className: 'row' }, h('button', { className: 'allow', type: 'submit', disabled: !!p.busy || !t }, p.busy === 'send' ? 'Sending…' : 'Send')));
  return h('div', { className: 'panel' },
    p.error ? h('div', { className: 'card error', role: 'alert' }, p.error) : null,
    sel ? h('div', { className: 'card' },
      h('div', { className: 'row' }, h('button', { onClick: () => p.onSelect(null) }, '← All runs')),
      h('h2', null, 'Hand-off chain'), h('div', { className: 'list' }, ...p.chain!.map(r => h('div', { key: r.id, className: r.id === sel.id ? 'me' : '' }, runLine(r)))),
      p.result !== undefined ? h('pre', null, p.result) : null,
      h('div', { className: 'row' },
        sel.outcome === 'running' ? h('button', { disabled: !!p.busy, onClick: () => p.onCancel(sel.id) }, 'Cancel') : null,
        ...(['up', 'down', 'redo'] as const).map(v => h('button', { key: v, disabled: !!p.busy || sel.verdict === v, onClick: () => p.onVerdict(sel.id, v) },
          v === 'up' ? 'Good' : v === 'down' ? 'Bad' : 'Redo'))))
      : form,
    h('section', null, h('h2', null, 'Runs'), p.runs.length
      ? h('div', { className: 'card list runs' }, ...p.runs.map(r => h('button', { key: r.id, className: 'line', onClick: () => p.onSelect(r.id) }, runLine(r))))
      : h('div', { className: 'empty' }, 'No runs yet.')));
}

export function RunsPanel({ bridge }: { bridge: Bridge }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [target, setTarget] = useState('');
  const list = useOp(bridge, 'runs', { limit: 50 });
  const one = useOp(bridge, 'runs', selected === null ? { limit: 0 } : { id: selected });
  const targets = useOp(bridge, 'targets');
  const { busy, error, act } = useAct(list.reload);
  return h(RunsView, {
    runs: list.data?.runs ?? [], chain: selected === null ? null : one.data?.runs ?? null, result: selected === null ? undefined : one.data?.result,
    selected, targets: targets.data ?? [], target, busy, error: error ?? list.error,
    onSelect: setSelected, onTarget: setTarget,
    onVerdict: (id, v) => act('verdict', () => bridge.call('verdict', { id, value: v }).then(one.reload)),
    onCancel: id => act('cancel', () => bridge.call('cancel', { id })),
    onSend: f => act('send', async () => { const v = await bridge.call('delegate', delegateInput(f)); setSelected(v.id); }),
  });
}
