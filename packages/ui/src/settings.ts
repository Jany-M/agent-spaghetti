// Settings panel: one field per setting from the `settings` op (lists as comma separated text, numbers as numbers),
// saved when the field is left; the machine report as a file download.
import { createElement as h } from 'react';
import type { OpIO } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useAct, useOp } from './hooks.ts';

type All = OpIO['settings']['out'];
export const settingText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

export function SettingsView({ settings, busy, error, onSave, onReport }: { settings: All | null; busy: string | null; error: string | null;
  onSave(key: string, text: string): void; onReport(): void }) {
  return h('div', { className: 'panel' },
    error ? h('div', { className: 'card error', role: 'alert' }, error) : null,
    h('div', { className: 'card form' }, ...Object.entries(settings ?? {}).map(([k, s]) => h('label', { key: k, className: 'setting' },
      h('span', { className: 'name' }, k), h('span', { className: 'why' }, s.help),
      h('input', { name: k, defaultValue: settingText(s.value), key: settingText(s.value), type: typeof s.value === 'number' ? 'number' : 'text', disabled: busy === k,
        onBlur: (e: { target: { value: string } }) => { if (e.target.value !== settingText(s.value)) onSave(k, e.target.value); },
        onKeyDown: (e: { key: string; currentTarget: { blur(): void } }) => { if (e.key === 'Enter') e.currentTarget.blur(); } })))),
    h('div', { className: 'card' }, h('h2', null, 'Machine report'),
      h('div', { className: 'why' }, 'What was found on this machine, as Markdown. Review it before sharing.'),
      h('div', { className: 'row' }, h('button', { disabled: !!busy, onClick: onReport }, busy === 'report' ? 'Saving…' : 'Save report…'))));
}

export function SettingsPanel({ bridge }: { bridge: Bridge }) {
  const all = useOp(bridge, 'settings');
  const { busy, error, act } = useAct(all.reload);
  return h(SettingsView, { settings: all.data, busy, error: error ?? all.error,
    onSave: (key, text) => act(key, () => bridge.call('setting', { key, value: text.split(',').map(x => x.trim()).join(',') })),
    onReport: () => act('report', async () => {
      const { markdown } = await bridge.call('report');
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' })), download: `agent-spaghetti-report-${new Date().toISOString().slice(0, 10)}.md` });
      a.click(); URL.revokeObjectURL(a.href);
    }) });
}
