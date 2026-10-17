// Settings panel: every setting from the `settings` op, grouped by its prefix. Pick lists where the daemon offers choices
// (tools, clients, loaded models): a select for one value, checkboxes for a list; numbers and free text save when the field is
// left. Each save is confirmed next to its name. The machine report shows inline and downloads as a file.
import { createElement as h, useState } from 'react';
import type { OpIO } from '@agent-spaghetti/sdk/web';
import type { Bridge } from './bridge.ts';
import { useAct, useOp } from './hooks.ts';

type All = OpIO['settings']['out'];
export const settingText = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const groupOf = (k: string) => (k.includes('.') ? k.slice(0, k.indexOf('.')) : 'general');

export interface SettingsProps { settings: All | null; busy: string | null; error: string | null; saved: string | null; report: string | null;
  onSave(key: string, text: string): void; onReport(): void }

function Field({ k, s, busy, onSave }: { k: string; s: All[string]; busy: boolean; onSave(key: string, text: string): void }) {
  const value = settingText(s.value);
  if (s.choices && Array.isArray(s.value)) {                // a list of known things: tick them
    const on = new Set(s.value as string[]);
    return h('div', { className: 'checks' }, ...s.choices.map(c => h('label', { key: c.value, className: 'check' },
      h('input', { type: 'checkbox', checked: on.has(c.value), disabled: busy, onChange: () => onSave(k, (on.has(c.value) ? [...on].filter(x => x !== c.value) : [...on, c.value]).join(',')) }),
      ` ${c.label}`)));
  }
  if (s.choices) {                                           // one of: current value kept even when it is not available now
    const choices = s.choices.some(c => c.value === value) ? s.choices : [...s.choices, { value, label: `${value} (not available now)` }];
    return h('select', { name: k, value, disabled: busy, onChange: (e: { target: { value: string } }) => onSave(k, e.target.value) },
      ...choices.map(c => h('option', { key: c.value, value: c.value }, c.label)));
  }
  return h('input', { name: k, defaultValue: value, key: value, type: typeof s.value === 'number' ? 'number' : 'text', disabled: busy,
    placeholder: Array.isArray(s.value) ? 'comma separated' : undefined,
    onBlur: (e: { target: { value: string } }) => { if (e.target.value !== value) onSave(k, e.target.value); },
    onKeyDown: (e: { key: string; currentTarget: { blur(): void } }) => { if (e.key === 'Enter') e.currentTarget.blur(); } });
}

export function SettingsView(p: SettingsProps) {
  const entries = Object.entries(p.settings ?? {});
  const groups = [...new Set(entries.map(([k]) => groupOf(k)))];
  return h('div', { className: 'panel' },
    p.error ? h('div', { className: 'card error', role: 'alert' }, p.error) : null,
    ...groups.map(g => h('section', { key: g }, h('h2', null, g),
      h('div', { className: 'card form' }, ...entries.filter(([k]) => groupOf(k) === g).map(([k, s]) => h('div', { key: k, className: 'setting' },
        h('div', { className: 'name' }, k, p.saved === k ? h('span', { className: 'ok' }, ' ✓ saved') : null),
        h('div', { className: 'why' }, s.help),
        h(Field, { k, s, busy: p.busy === k, onSave: p.onSave })))))),
    h('div', { className: 'card' }, h('h2', null, 'Machine report'),
      h('div', { className: 'why' }, 'What was found on this machine, as Markdown, also saved to your Downloads folder. Review it before sharing.'),
      h('div', { className: 'row' }, h('button', { disabled: !!p.busy, onClick: p.onReport }, p.busy === 'report' ? 'Building…' : 'Show and save report')),
      p.report ? h('pre', null, p.report) : null));
}

export function SettingsPanel({ bridge }: { bridge: Bridge }) {
  const all = useOp(bridge, 'settings');
  const [saved, setSaved] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const { busy, error, act } = useAct(all.reload);
  return h(SettingsView, { settings: all.data, busy, error: error ?? all.error, saved, report,
    onSave: (key, text) => act(key, async () => {
      setSaved(null);
      await bridge.call('setting', { key, value: text.split(',').map(x => x.trim()).join(',') });
      setSaved(key);
    }),
    onReport: () => act('report', async () => {
      const { markdown } = await bridge.call('report');
      setReport(markdown);
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' })), download: `agent-spaghetti-report-${new Date().toISOString().slice(0, 10)}.md` });
      a.click(); URL.revokeObjectURL(a.href);
    }) });
}
