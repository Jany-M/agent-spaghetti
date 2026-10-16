// Tray decisions (pure): menu, tooltip, placement, notifications, daemon start.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { HubClient } from '@agent-spaghetti/sdk';
import { BRIDGE_OPS, isBridgeOp } from '@agent-spaghetti/ui/bridge';
import { ensureDaemon, newQuestions, placeNear, tooltip, trayMenu } from '../../../packages/app/src/logic.ts';

test('menu: Rescan when up, Start daemon when down; stop-daemon only when up', () => {
  const ids = (up: boolean) => trayMenu(up, false).filter(i => i.id).map(i => `${i.id}${i.enabled === false ? '(off)' : ''}`);
  assert.deepEqual(ids(true), ['open', 'scan', 'autostart', 'quit', 'quit-all']);
  assert.deepEqual(ids(false), ['open', 'start', 'autostart', 'quit', 'quit-all(off)']);
  assert.equal(trayMenu(true, true).find(i => i.id === 'autostart')!.checked, true);
});
test('tooltip fits the Windows 127-character limit', () => {
  assert.equal(tooltip(['a', 'b']), 'a\nb');
  const t = tooltip(['x'.repeat(200)]);
  assert.equal(t.length, 127); assert.ok(t.endsWith('…'));
});
test('popover sits above a bottom taskbar, below a top one, beside a side one, always inside the work area', () => {
  const size = { width: 380, height: 520 }, work = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(placeNear({ x: 1800, y: 1045, width: 24, height: 24 }, work, size), { x: 1534, y: 514, ...size });
  assert.deepEqual(placeNear({ x: 900, y: 5, width: 24, height: 24 }, { ...work, y: 40 }, size).y, 46);
  assert.equal(placeNear({ x: 1930, y: 900, width: 24, height: 24 }, { ...work, width: 1880 }, size).x, 1494);
});
test('notify each question once', () => {
  const seen = new Set(['a']);
  assert.deepEqual(newQuestions(seen, ['a', 'b']), ['b']);
});
test('bridge allowlist: only the ops the popover needs', () => {
  assert.deepEqual([...BRIDGE_OPS], ['status', 'scan', 'consent', 'switches', 'switch']);
  assert.equal(isBridgeOp('shutdown'), false); assert.equal(isBridgeOp('grant'), false); assert.equal(isBridgeOp('status'), true);
});
test('ensureDaemon: reuses a running daemon; starts one once and waits; gives up with a clear error', async () => {
  const fake = {} as HubClient;
  let starts = 0;
  assert.equal(await ensureDaemon({ connect: async () => fake, start: () => starts++ }), fake);
  assert.equal(starts, 0);
  let tries = 0;
  assert.equal(await ensureDaemon({ connect: async () => { if (++tries < 3) throw new Error('down'); return fake; }, start: () => starts++, pollMs: 1 }), fake);
  assert.equal(starts, 1);
  await assert.rejects(ensureDaemon({ connect: async () => { throw new Error('down'); }, start: () => starts++, pollMs: 1, timeoutMs: 20 }), /did not start/);
});
