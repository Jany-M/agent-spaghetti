// Popover views rendered to HTML under node (no DOM needed): what the user sees for each state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyLive, liveState, type ConsentRequest, type Snapshot, type Target } from '@agent-spaghetti/sdk';
import { ApprovalCard, PopoverView } from '@agent-spaghetti/ui';

const ask: ConsentRequest = { id: 'q1', ts: 1, subject: 'acme', action: 'read', resource: 'PATH:acme', why: 'look for acme', scopes: ['always'] };
const run: ConsentRequest = { ...ask, id: 'q2', action: 'run', resource: 'claude-cli', task: 'write <tests>', cost: 'metered', billing: 'your Claude plan', scopes: ['once', 'job', 'always'], expiresAt: 61_000 };
const html = (el: ReturnType<typeof h>) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, '');
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
  assert.deepEqual([...a.matchAll(/<nav[^]*?<\/nav>/g)][0][0].match(/<button[^>]*>([A-Za-z]+)/g)!.map(b => b.replace(/<button[^>]*>/, '')), ['Home', 'Tools', 'Runs', 'Routing', 'Settings', 'Activity']);
  assert.equal(PANELS.length, 6);
  assert.match(a, /aria-current="page"[^>]*>Runs/);
  assert.match(a, /RUNS-PANEL/); assert.ok(!a.includes('Waiting for you'));
  assert.match(a, />Home<span class="count">1<\/span>/, 'questions counted on the Home tab');
  const down = html(h(PopoverView, { view: { up: false, status: null }, now: 0, onAnswer: noop, onScan: noop, scanning: false, panel: 'tools' }));
  assert.match(down, /<button disabled="">Tools<\/button>/); assert.match(down, /Start the daemon/);
});
test('tools panel: blocks by type with counts, found first, missing folded; client row: connection, connect button, preference; asking opens its block; takes-tasks badge', async () => {
  const { ToolsView, preferenceLists } = await import('@agent-spaghetti/ui');
  const row = (id: string, o: Record<string, unknown>) => ({ id, name: id.toUpperCase(), group: 'apps', source: 'builtin', levels: [], envs: ['windows'], state: 'installed', why: 'w', asks: 0, ...o }) as never;
  const props = { busy: null, error: null, closed: new Set(['apps', 'models']), output: { ed: { ok: true, lines: ['OK    detect'] }, cur: { ok: false, lines: ['FAIL  x'] } }, details: {},
    onToggleGroup: noop, onExpand: noop, onConnect: noop, onPreference: noop, onTest: noop, onSkip: noop, onSwitch: noop, onGrant: noop, onSetup: noop, onModel: noop, onKey: noop, gatewayUrl: null, models: ['lms:m1'],
    rows: [row('oc', { group: 'agents', setup: true }), row('ed', { connection: 'not connected', preference: 'ask', asks: 1, gateway: { model: 'auto', key: false } }), row('cur', { connection: 'connected', preference: 'always' }),
      row('lms', { group: 'models', state: 'ready', receives: 'acp' }), row('gone', { state: 'not found' })] };
  const a = html(h(ToolsView, props));
  assert.match(a, /<details class="group" open="">.*?Editors &amp; apps · 2.*?1 in use/s, 'a waiting question opens a closed block');
  assert.match(a, /<details class="group"><summary><h2>Model servers · 1/, 'closed stays closed');
  assert.match(a, /<details class="group"><summary><h2>Not found on this machine · 1/);
  assert.match(a, /ED<\/span>.*?installed.*?not connected.*?<button class="allow">Connect<\/button>/s);
  assert.match(a, /CUR<\/span>.*?<button class="">Disconnect<\/button>.*?<option value="always" selected="">Always connect/s);
  assert.match(a, /ED<\/span>.*?<div class="out pass" role="status"><pre>OK {4}detect<\/pre><\/div><details>/s, 'a test result shows under the row, not inside More');
  assert.match(a, /CUR<\/span>.*?<div class="out fail" role="status"><pre>FAIL  x<\/pre>/s);
  assert.match(a, /ED<\/span>.*?<label>Model <select aria-label="ED&#x27;s model through the gateway"><option value="auto" selected="">auto \(best free first\)<\/option><option value="lms:m1">lms:m1<\/option><\/select>.*?Model gateway off/s);
  const on = html(h(ToolsView, { ...props, gatewayUrl: 'http://127.0.0.1:4141/v1', rows: [row('ed', { gateway: { model: 'lms:m1', key: true } })] }));
  assert.match(on, />New gateway key<\/button>.*?>Revoke key<\/button>/s); assert.match(on, /<option value="lms:m1" selected="">/);
  assert.match(a, /LMS<\/span>.*?<span class="state ready" title="Tasks can be handed to it now">takes tasks \(ACP\)<\/span>/s);
  assert.match(a, /OC<\/span>.*?>Set up<\/button>.*?>Dry run<\/button>.*?>Check<\/button>/s, 'tools with setup offer it');
  assert.ok(!/ED<\/span>.*?>Set up</s.test(a.slice(a.indexOf('ED</span>'), a.indexOf('CUR</span>'))));
  assert.deepEqual(preferenceLists(['a', 'x'], ['x'], 'x', 'never'), { 'connect.auto': ['a'], 'connect.never': ['x'] });
  assert.deepEqual(preferenceLists(['a'], ['x'], 'x', 'always'), { 'connect.auto': ['a', 'x'], 'connect.never': [] });
  assert.deepEqual(preferenceLists(['x'], [], 'x', 'ask'), { 'connect.auto': [], 'connect.never': [] });
});
test('tools panel output: per-environment results as one block, failing when any environment fails', async () => {
  const { envOutput } = await import('@agent-spaghetti/ui');
  const ok = { ok: true, steps: [{ name: 'detect', ok: true, detail: 'found', ms: 1 }] };
  assert.deepEqual(envOutput('test', [{ envId: 'windows', result: ok }, { envId: 'wsl:T', error: 'not running' }]),
    { ok: false, lines: ['test in windows', 'OK    detect               found (1 ms)', 'ALL OK', 'test in wsl:T', 'FAIL  not running'] });
  assert.equal(envOutput('test', []).ok, false, 'nothing tested is not a pass');
});
test('runs panel: form fields → delegate input (auto, then, return); list lines with where results went, unread count; selected run shows chain, result, verdict and cancel', async () => {
  const { RunsView, delegateInput } = await import('@agent-spaghetti/ui');
  assert.deepEqual(delegateInput({ target: 'oc', task: ' do it ', kind: 'docs', reason: '', model: 'worker', then: '', returnTo: 'caller' }), { target: 'oc', task: 'do it', kind: 'docs', model: 'worker', source: 'tray', waitMs: 0 });
  assert.deepEqual(delegateInput({ target: 'auto', task: 't', then: 'cc,lms:m1', returnTo: 'none', cwd: ' /w ' }), { target: 'auto', task: 't', cwd: '/w', then: ['cc', 'lms:m1'], returnTo: 'none', source: 'tray', waitMs: 0 });
  const r = (id: number, o: Record<string, unknown> = {}) => ({ id, ts: 0, source: 'tray', target: 'oc', kind: 'other', taskHash: 'h', outcome: 'done', ...o }) as never;
  const base = { busy: null, error: null, onSelect: noop, onVerdict: noop, onCancel: noop, onTarget: noop, onSend: noop, then: [] as string[], onThen: noop, runs: [r(2), r(1, { delivered: 'unread' })],
    targets: [{ id: 'oc', name: 'OpenClaw', kind: 'agent', cost: 'unknown', envId: 'wsl:T', models: ['main', 'worker'] }] as never, target: 'oc' };
  const form = html(h(RunsView, { ...base, chain: null, selected: null }));
  assert.match(form, /<option value="oc"[^>]*>OpenClaw \(unknown\)<\/option>/); assert.match(form, /Agent<select name="model">/);
  assert.match(form, /<textarea name="task"[^>]*required=""/);
  assert.match(form, /Kind<select name="kind"><option value="" selected="">Agent Spaghetti decides<\/option>/); assert.match(form, /Difficulty<select name="difficulty"><option value="" selected="">Agent Spaghetti decides<\/option><option value="light">/);
  assert.deepEqual(delegateInput({ target: 'oc', task: 't', kind: '', difficulty: 'heavy' }), { target: 'oc', task: 't', difficulty: 'heavy', source: 'tray', waitMs: 0 }, 'an empty kind lets JEV decide');
  const r4 = r(4, { kind: 'summarize', difficulty: 'light', classifiedBy: 'rules', confidence: 0.8 });
  const jev = html(h(RunsView, { ...base, runs: [r4], chain: [r4], selected: 4 }));
  assert.match(jev, /<div class="why">summarize · light \(Agent Spaghetti&#x27;s rules, 80% sure\)<\/div>/);
  assert.equal([...form.matchAll(/class="line tone-ok"/g)].length, 2, 'run lines colored by outcome');
  assert.match(form, /<option value="auto">Let Agent Spaghetti choose<\/option>/); assert.match(form, /<select name="returnTo">/); assert.match(form, /name="cwd"/, 'agents get a folder field');
  assert.match(form, /<select aria-label="Add a next step"><option value="" selected="">nobody \(one step\)<\/option><option value="oc">OpenClaw \(unknown\)<\/option><option value="oc:main">OpenClaw: main<\/option>/);
  const two = html(h(RunsView, { ...base, chain: null, selected: null, then: ['oc:worker', 'auto'] }));
  assert.match(two, /then:<\/span><span class="step">OpenClaw: worker<button type="button" aria-label="Remove step 1">×<\/button><\/span><span class="step">Let Agent Spaghetti choose/);
  assert.match(two, /<input type="hidden" name="then" value="oc:worker,auto"\/>/);
  assert.match(form, /Runs<button class="badge" aria-pressed="false"[^>]*>1 waiting<\/button>/); assert.match(form, /↩ waiting to be read/);
  const waiting = html(h(RunsView, { ...base, chain: null, selected: null, waitingOnly: true }));
  assert.equal([...waiting.matchAll(/class="line tone-/g)].length, 1, 'the waiting filter shows only results nobody collected');
  assert.match(waiting, />1 waiting ×<\/button>/);
  const unread = html(h(RunsView, { ...base, chain: [r(1, { delivered: 'unread', outcome: 'error', error: 'next hop not started' })], selected: 1 }));
  assert.match(unread, /<div class="card error">next hop not started<\/div>/); assert.match(unread, /waiting for tray to collect it/); assert.match(unread, />Dismiss<\/button>/);
  const chain = [r(1, { delivered: 'resumed' }), r(2, { parentRunId: 1, source: 'oc', target: 'cc' }), r(3, { parentRunId: 2, source: 'cc', outcome: 'running', verdict: 'up' })];
  const one = html(h(RunsView, { ...base, runs: [chain[2], ...base.runs], chain, selected: 3, result: 'partial <b>' }));
  assert.match(one, /tray → oc .*↩ resumed in its session/); assert.match(one, /oc → cc/); assert.match(one, /cc → oc/);
  assert.match(one, /<div class="open"><button class="line tone-run" aria-expanded="true"[^>]*>[^<]*<\/button><div class="detail">/, 'the open run unfolds under its own row');
  assert.match(one, /<div class="me">/); assert.match(one, /<pre>partial &lt;b&gt;<\/pre>/);
  assert.match(one, /<button aria-pressed="true" class="allow"[^>]*>Good<\/button><button aria-pressed="false" class=""[^>]*>Bad<\/button>/, 'grades right there, the given one marked');
  assert.match(one, />Cancel<\/button>/); assert.ok(one.includes('New task'), 'the form stays at the top');
  assert.equal([...one.matchAll(/class="detail"/g)].length, 1, 'other rows stay closed');
});
test('settings and activity panels: grouped fields, pick lists from the daemon\'s choices, saves confirmed; events with their facts, newest first', async () => {
  const { SettingsView, ActivityView } = await import('@agent-spaghetti/ui');
  const { settingText } = await import('@agent-spaghetti/sdk/web');
  const base = { busy: null, error: null, saved: null, report: null, onSave: noop, onReport: noop };
  const s = html(h(SettingsView, { ...base, settings: { llmHosts: { value: ['192.0.2.1', '192.0.2.2'], help: 'hosts' }, 'scan.everyMin': { value: 10, help: 'minutes' },
    'routing.learn': { value: true, help: 'in the Routing panel' }, 'x.on': { value: false, help: 'a switch' } } }));
  assert.doesNotMatch(s, /routing\.learn/, 'routing settings live in the Routing panel'); assert.match(s, /<input type="checkbox" name="x.on"\/> off/, 'a switch is a checkbox');
  assert.match(s, /<h2>general<\/h2>.*name="llmHosts" value="192.0.2.1,192.0.2.2"/s); assert.match(s, /<h2>scan<\/h2>.*type="number" name="scan.everyMin" value="10"/s);
  assert.equal(settingText([]), ''); assert.equal(settingText(false), 'off'); assert.match(s, /Show and save report/);
  const d = html(h(SettingsView, { ...base, saved: 'dispatcher.model', report: '# Report', settings: {
    'dispatcher.model': { value: 'lms:gone', help: 'h', choices: [{ value: '', label: 'off' }, { value: 'lms:a', label: 'LMS: a' }] },
    'connect.auto': { value: ['cursor'], help: 'h', choices: [{ value: 'cursor', label: 'Cursor' }, { value: 'vscode', label: 'VS Code' }] } } }));
  assert.match(d, /<select name="dispatcher.model"><option value="">off<\/option><option value="lms:a">LMS: a<\/option><option value="lms:gone" selected="">lms:gone \(not available now\)<\/option><\/select>/);
  assert.match(d, /dispatcher.model<span class="ok"> ✓ saved<\/span>/); assert.match(d, /<pre># Report<\/pre>/);
  assert.match(d, /<input type="checkbox" checked=""\/> Cursor<\/label><label class="check"><input type="checkbox"\/> VS Code/);
  const ev = (id: number, type: string, data = {}) => ({ id, ts: 0, type, envId: 'hub', source: 's', data }) as never;
  const a = html(h(ActivityView, { events: [ev(1, 'scan.completed'), ev(2, 'tool.checked', { action: 'test', ok: false, envs: 'windows', deep: { x: 1 } })] }));
  assert.ok(a.indexOf('tool.checked') < a.indexOf('scan.completed'));
  assert.match(a, /<div class="tone-fail"><span>00:00:00  tool.checked  s  hub  action=test ok=false envs=windows</, 'a failed check reads red');
  const story = html(h(ActivityView, { events: [ev(3, 'run.started', { id: 7, source: 'cursor', target: 'lmstudio', kind: 'summarize', reason: 'cheap' }), ev(4, 'run.finished', { id: 7, target: 'lmstudio', outcome: 'done' })] }));
  assert.match(story, /<div class="tone-ok">.*<div class="tone-run">/, 'newest first, each colored by outcome');
  assert.match(text(story), /run 7: lmstudio done.*run 7: cursor → lmstudio \(summarize\) · cheap/);
  assert.match(story, /<b class="tool tc\d">lmstudio<\/b> <span class="act answer">done<\/span>/, 'tools and actions colored in the line');
});

test('live pane: work events only by default, one run on request, streamed output as one growing line; header controls', async () => {
  const { LiveList, liveRows } = await import('@agent-spaghetti/ui/live');
  const ev = (id: number, type: string, data: Record<string, unknown>) => ({ id, ts: 0, type, envId: 'hub', source: 'runner', data }) as never;
  const events = [ev(1, 'scan.completed', { detections: 3 }), ev(2, 'run.started', { id: 5, source: 'claude-desktop', target: 'lmstudio' }),
    ev(-1, 'trace.detail', { stage: 'request', runId: 5, source: 'claude-desktop', target: 'lmstudio', text: 'Research X' }),
    ev(-2, 'trace.detail', { stage: 'output', runId: 5, target: 'lmstudio', text: 'Hello ' }), ev(-3, 'trace.detail', { stage: 'output', runId: 5, target: 'lmstudio', text: 'world' }),
    ev(-4, 'trace.detail', { stage: 'return', runId: 5, target: 'claude-desktop', how: 'inline', text: 'Hello world' }),
    ev(3, 'run.started', { id: 6, source: 'cursor', target: 'codex' }), ev(4, 'dispatcher.action', { what: 'routed', asked: 'auto', to: 'lmstudio', why: 'best-ranked target' })];
  const rows = liveRows(events);
  assert.deepEqual(rows.map(r => r.line.slice(10)), ['run 5: claude-desktop → lmstudio', 'run 5: claude-desktop asks lmstudio: Research X', 'run 5: lmstudio answers: Hello world',
    'run 5: result back to claude-desktop (returned): Hello world',
    'run 6: cursor → codex', 'Agent Spaghetti picks lmstudio for auto (best-ranked target)']);
  assert.equal(rows[2].text, 'Hello world');
  assert.equal(liveRows(events, { all: true }).length, 7, 'everything: the scan too');
  assert.deepEqual(liveRows(events, { run: 6 }).map(r => r.run), [6]);
  (await import('@agent-spaghetti/ui')).setToolColors([{ id: 'claude-desktop', color: '#ea580c' }]);
  const page = html(h(LiveList, { rows, all: false, run: null, paused: false, open: new Set([-2]), onAll: noop, onRun: noop, onPause: noop, onClear: noop, onToggle: noop, onClose: noop }));
  assert.match(page, /<header class="bar">.*<option value="work" selected="">Runs and hand-offs<\/option>.*>Pause<\/button>.*>Clear<\/button><button aria-label="Close"/s);
  assert.match(page, /<button class="tag" title="Only run 5">#5<\/button>/);
  assert.match(page, /<b class="tool" style="color:#ea580c">claude-desktop<\/b> <span class="act send">asks<\/span> <b class="tool tc\d">lmstudio<\/b>: Research X/, 'the request a tool sent: its own color from the manifest, else a palette one');
  assert.match(text(page), /Agent Spaghetti picks.*cursor → codex.*claude-desktop → lmstudio/s, 'newest on top; the arrow is plain text');
  assert.match(page, /<b class="tool hub">Agent Spaghetti<\/b> <span class="act decide">picks<\/span>/); assert.match(page, /<pre>Hello world<\/pre>/, 'an opened trace shows its full text');
  const one = html(h(LiveList, { rows: liveRows(events, { run: 6 }), all: false, run: 6, paused: true, open: new Set<number>(), onAll: noop, onRun: noop, onPause: noop, onClear: noop, onToggle: noop, onClose: noop }));
  assert.match(one, /class="chip"[^>]*>run 6 ×</); assert.match(one, /aria-pressed="true">Resume</);
});
test('routing panel: per kind the targets best first with why, First / Never per kind, the routing switches, the shipped word lists', async () => {
  const { RoutingView, routePicks } = await import('@agent-spaghetti/ui');
  const t = (id: string): Target => ({ id, name: id, kind: 'model', cost: 'free', envId: 'w', models: [], engine: 'openai', resumable: false });
  const routing = { difficulty: 'light' as const, kinds: [{ kind: 'summarize' as const, ranked: [{ target: t('lms'), tier: 'light' as const, why: 'your pick for summarize, free, light tier', preferred: true as const },
    { target: t('oll'), tier: 'light' as const, why: 'never for summarize (your choice)', skip: 'never for summarize (your choice)' }] }, { kind: 'tests' as const, ranked: [] }] };
  const settings = { 'routing.never': { value: ['summarize=oll'], help: 'n' }, 'routing.learn': { value: true, help: 'use past runs' } };
  const page = html(h(RoutingView, { routing, settings, difficulty: 'light', busy: null, error: null, onDifficulty: noop, onPick: noop, onSave: noop }));
  assert.match(page, /<h2>summarize<\/h2>.*1\. <\/b>lms<span class="why">  your pick for summarize, free, light tier<\/span>.*aria-pressed="true"[^>]*>First<\/button>/s);
  assert.match(page, /class="route skip"><div><b>– <\/b>oll.*aria-pressed="true"[^>]*>Never</s);
  assert.match(page, /<h2>tests<\/h2><div class="card list"><div class="empty">Nothing to hand it to now./);
  assert.match(page, /routing\.learn<\/div><div class="why">use past runs<\/div><label class="check"><input type="checkbox" name="routing.learn" checked=""\/> on/);
  assert.match(page, /<summary>How the kind of a task is told<\/summary>.*<b>summarize<\/b>: summarize, summarise/s);
  assert.deepEqual(routePicks(['summarize=a', 'docs=a'], ['summarize=b'], 'summarize', 'b', 'prefer'), { 'routing.prefer': ['docs=a', 'summarize=b'], 'routing.never': [] }, 'one pick per kind; not both');
  assert.deepEqual(routePicks(['summarize=b'], [], 'summarize', 'b', 'prefer'), { 'routing.prefer': [], 'routing.never': [] }, 'pressed again: off');
  assert.deepEqual(routePicks(['summarize=b'], [], 'summarize', 'b', 'never'), { 'routing.prefer': [], 'routing.never': ['summarize=b'] });
});
