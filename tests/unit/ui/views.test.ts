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
  const a = html(h(ApprovalCard, { req: ask, name: 'Acme', now: 0, onAnswer: noop }));
  assert.match(a, /Acme wants to read <code>PATH:acme<\/code>/);
  assert.match(a, /look for acme/);
  assert.deepEqual([...a.matchAll(/<button[^>]*>([^<]+)</g)].map(m => m[1]), ['Deny', 'Always allow']);
  assert.ok(!/autofocus/i.test(a));
  const r = html(h(ApprovalCard, { req: run, name: 'Cursor', now: 1_000, onAnswer: noop }));
  assert.match(r, /hand a task to <code>claude-cli<\/code><span class="badge">paid<\/span>/);
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
