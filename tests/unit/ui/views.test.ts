// Popover views rendered to HTML under node (no DOM needed): what the user sees for each state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLive, liveState, type ConsentRequest, type Snapshot } from '@agent-spaghetti/sdk';
import { ApprovalCard, PopoverView } from '@agent-spaghetti/ui';

const ask: ConsentRequest = { id: 'q1', ts: 1, subject: 'acme', action: 'read', resource: 'PATH:acme', why: 'look for acme', scopes: ['always'] };
const run: ConsentRequest = { ...ask, id: 'q2', action: 'run', resource: 'claude-cli', task: 'write <tests>', cost: 'metered', billing: 'your Claude plan', scopes: ['once', 'job', 'always'], expiresAt: 61_000 };
const html = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);
const noop = () => {};

test('approval card: what, where, why; Deny first, one button per offered scope; never pre-focused', () => {
  const a = html(h(ApprovalCard, { req: ask, names: new Map([['acme', 'Acme']]), now: 0, onAnswer: noop }));
  assert.match(a, /Acme wants to read <code>PATH:acme<\/code>/);
  assert.match(a, /look for acme/);
  assert.deepEqual([...a.matchAll(/<button[^>]*>([^<]+)</g)].map(m => m[1]), ['Deny', 'Always allow']);
  assert.ok(!/autofocus/i.test(a));
  const r = html(h(ApprovalCard, { req: run, names: new Map([['acme', 'Cursor'], ['claude-cli', 'Claude Code CLI']]), now: 1_000, onAnswer: noop }));
  assert.match(r, /hand a task to <code>Claude Code CLI<\/code><span class="badge">paid<\/span>/);
  assert.match(r, /<pre>write &lt;tests&gt;<\/pre>/);
  assert.match(r, /your Claude plan/);
  assert.match(r, /expires in 60 s/);
  assert.deepEqual([...r.matchAll(/<button[^>]*>([^<]+)</g)].map(m => m[1]), ['Deny', 'Allow once', 'Allow for this job', 'Always allow']);
});
test('popover: daemon down; running sessions with agent names; questions first; rescan disabled while scanning', () => {
  const down = html(h(PopoverView, { view: { up: false, status: null }, now: 0, onAnswer: noop, onScan: noop, scanning: false }));
  assert.match(down, /dot problem/); assert.match(down, /agent-spaghetti is not running/); assert.match(down, /Start the daemon from the tray menu/);
  const snapshot: Snapshot = { ts: 1, envs: [], backends: [], rejected: [], detections: [{ integration: 'acme', name: 'Acme', envId: 'windows', installs: [], levels: [], cost: 'free', connectable: 'yes', why: '' }],
    agents: [{ id: 'openclaw:main', integration: 'openclaw', name: 'Main', envId: 'wsl:T' }] };
  const live = liveState([{ id: 1, ts: 1, type: 'session.started', envId: 'wsl:T', source: 'openclaw', data: { key: 'k', agentId: 'main', kind: 'chat', status: 'running' } }]);
  const busy = html(h(PopoverView, { view: { up: true, status: { snapshot, live, consents: [ask] } }, now: 0, onAnswer: noop, onScan: noop, scanning: true }));
  assert.match(busy, /dot approval/);
  assert.ok(busy.indexOf('Waiting for you') < busy.indexOf('Running'));
  assert.match(busy, /Acme wants to read/);
  assert.match(busy, /Main · chat running/);
  assert.match(busy, /<button disabled="">Scanning…<\/button>/);
  const idle = html(h(PopoverView, { view: { up: true, status: { snapshot, live: emptyLive(), consents: [] } }, now: 0, onAnswer: noop, onScan: noop, scanning: false }));
  assert.match(idle, /dot idle/); assert.match(idle, /Nothing running\./); assert.ok(!idle.includes('Waiting for you'));
});

test('popover frame: one tab per panel (current marked, others off while the daemon is down); a panel replaces Home', async () => {
  const { PANELS } = await import('@agent-spaghetti/sdk');
  const up = { up: true, status: { snapshot: null, live: emptyLive(), consents: [ask] } };
  const a = html(h(PopoverView, { view: up, now: 0, onAnswer: noop, onScan: noop, scanning: false, panel: 'runs' }, h('p', null, 'RUNS-PANEL')));
  assert.deepEqual([...a.matchAll(/<nav[^]*?<\/nav>/g)][0][0].match(/<button[^>]*>([A-Za-z]+)/g)!.map(b => b.replace(/<button[^>]*>/, '')), ['Home', 'Tools', 'Runs', 'Settings', 'Activity']);
  assert.equal(PANELS.length, 5);
  assert.match(a, /aria-current="page"[^>]*>Runs/);
  assert.match(a, /RUNS-PANEL/); assert.ok(!a.includes('Waiting for you'));
  assert.match(a, />Home<span class="count">1<\/span>/, 'questions counted on the Home tab');
  const down = html(h(PopoverView, { view: { up: false, status: null }, now: 0, onAnswer: noop, onScan: noop, scanning: false, panel: 'tools' }));
  assert.match(down, /<button disabled="">Tools<\/button>/); assert.match(down, /Start the daemon/);
});
test('tools panel: blocks by type with counts, found first, missing folded; client row: connection, connect button, preference; asking opens its block; takes-tasks badge', async () => {
  const { ToolsView, preferenceLists } = await import('@agent-spaghetti/ui');
  const row = (id: string, o: Record<string, unknown>) => ({ id, name: id.toUpperCase(), group: 'apps', source: 'builtin', levels: [], envs: ['windows'], state: 'installed', why: 'w', asks: 0, ...o }) as never;
  const props = { busy: null, error: null, closed: new Set(['apps', 'models']), tests: { ed: ['OK    detect'] }, details: {},
    onToggleGroup: noop, onExpand: noop, onConnect: noop, onPreference: noop, onTest: noop, onSkip: noop, onSwitch: noop, onGrant: noop, onSetup: noop,
    rows: [row('oc', { group: 'agents', setup: true }), row('ed', { connection: 'not connected', preference: 'ask', asks: 1 }), row('cur', { connection: 'connected', preference: 'always' }),
      row('lms', { group: 'models', state: 'ready', receives: 'acp' }), row('gone', { state: 'not found' })] };
  const a = html(h(ToolsView, props));
  assert.match(a, /<details class="group" open="">.*?Editors &amp; apps · 2.*?1 in use/s, 'a waiting question opens a closed block');
  assert.match(a, /<details class="group"><summary><h2>Model servers · 1/, 'closed stays closed');
  assert.match(a, /<details class="group"><summary><h2>Not found on this machine · 1/);
  assert.match(a, /ED<\/span>.*?installed.*?not connected.*?<button class="allow">Connect<\/button>/s);
  assert.match(a, /CUR<\/span>.*?<button class="">Disconnect<\/button>.*?<option value="always" selected="">Always connect/s);
  assert.match(a, /<pre>OK {4}detect<\/pre>/);
  assert.match(a, /LMS<\/span>.*?<span class="state ready" title="Tasks can be handed to it now">takes tasks \(ACP\)<\/span>/s);
  assert.match(a, /OC<\/span>.*?>Set up<\/button>.*?>Dry run<\/button>.*?>Check<\/button>/s, 'tools with setup offer it');
  assert.ok(!/ED<\/span>.*?>Set up</s.test(a.slice(a.indexOf('ED</span>'), a.indexOf('CUR</span>'))));
  assert.deepEqual(preferenceLists(['a', 'x'], ['x'], 'x', 'never'), { 'connect.auto': ['a'], 'connect.never': ['x'] });
  assert.deepEqual(preferenceLists(['a'], ['x'], 'x', 'always'), { 'connect.auto': ['a', 'x'], 'connect.never': [] });
  assert.deepEqual(preferenceLists(['x'], [], 'x', 'ask'), { 'connect.auto': [], 'connect.never': [] });
});
test('runs panel: form fields → delegate input (auto, then, return); list lines with where results went, unread count; selected run shows chain, result, verdict and cancel', async () => {
  const { RunsView, delegateInput } = await import('@agent-spaghetti/ui');
  assert.deepEqual(delegateInput({ target: 'oc', task: ' do it ', kind: 'docs', reason: '', model: 'worker', then: '', returnTo: 'caller' }), { target: 'oc', task: 'do it', kind: 'docs', model: 'worker', source: 'tray', waitMs: 0 });
  assert.deepEqual(delegateInput({ target: 'auto', task: 't', then: 'cc, lms:m1 ,', returnTo: 'none' }), { target: 'auto', task: 't', then: ['cc', 'lms:m1'], returnTo: 'none', source: 'tray', waitMs: 0 });
  const r = (id: number, o: Record<string, unknown> = {}) => ({ id, ts: 0, source: 'tray', target: 'oc', kind: 'other', taskHash: 'h', outcome: 'done', ...o }) as never;
  const base = { busy: null, error: null, onSelect: noop, onVerdict: noop, onCancel: noop, onTarget: noop, onSend: noop, runs: [r(2), r(1, { delivered: 'unread' })],
    targets: [{ id: 'oc', name: 'OpenClaw', kind: 'agent', cost: 'unknown', envId: 'wsl:T', models: ['main', 'worker'] }] as never, target: 'oc' };
  const form = html(h(RunsView, { ...base, chain: null, selected: null }));
  assert.match(form, /<option value="oc"[^>]*>OpenClaw \(unknown\)<\/option>/); assert.match(form, /Agent<select name="model">/);
  assert.match(form, /<textarea name="task"[^>]*required=""/);
  assert.equal([...form.matchAll(/class="line"/g)].length, 2);
  assert.match(form, /<option value="auto">Let Agent Spaghetti choose<\/option>/); assert.match(form, /name="then"/); assert.match(form, /<select name="returnTo">/);
  assert.match(form, /Runs<span class="badge"[^>]*> 1 waiting<\/span>/); assert.match(form, /↩ waiting to be read/);
  const one = html(h(RunsView, { ...base, chain: [r(1, { delivered: 'resumed' }), r(2, { parentRunId: 1, source: 'oc', target: 'cc' }), r(3, { parentRunId: 2, source: 'cc', outcome: 'running' })], selected: 3, result: 'partial <b>' }));
  assert.match(one, /tray → oc .*↩ resumed in its session/); assert.match(one, /oc → cc/); assert.match(one, /cc → oc/);
  assert.match(one, /← All runs/); assert.match(one, /<div class="me">/); assert.match(one, /<pre>partial &lt;b&gt;<\/pre>/);
  assert.match(one, />Cancel<\/button>/); assert.ok(!one.includes('New task'));
});
test('settings and activity panels: typed fields from the settings op; newest event first', async () => {
  const { SettingsView, ActivityView, settingText } = await import('@agent-spaghetti/ui');
  const s = html(h(SettingsView, { settings: { llmHosts: { value: ['192.0.2.1', '192.0.2.2'], help: 'hosts' }, 'scan.everyMin': { value: 10, help: 'minutes' } }, busy: null, error: null, onSave: noop, onReport: noop }));
  assert.match(s, /type="text" name="llmHosts" value="192.0.2.1, 192.0.2.2"/); assert.match(s, /type="number" name="scan.everyMin" value="10"/);
  assert.equal(settingText([]), ''); assert.match(s, /Save report…/);
  const d = html(h(SettingsView, { settings: { 'dispatcher.model': { value: '', help: 'h', choices: ['lms:a', 'lms:b'] } }, busy: null, error: null, onSave: noop, onReport: noop }));
  assert.match(d, /<select name="dispatcher.model"><option value="" selected="">off<\/option><option value="lms:a">lms:a<\/option><option value="lms:b">lms:b<\/option><\/select>/);
  const ev = (id: number, type: string) => ({ id, ts: 0, type, envId: 'hub', source: 's', data: {} }) as never;
  const a = html(h(ActivityView, { events: [ev(1, 'scan.completed'), ev(2, 'tool.changed')] }));
  assert.ok(a.indexOf('tool.changed') < a.indexOf('scan.completed'));
});
