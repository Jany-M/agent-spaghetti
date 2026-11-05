import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubEvent } from '@agent-spaghetti/sdk';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';

const ev = (type: HubEvent['type'], data: Record<string, unknown> = { a: 1 }, ts = 1): HubEvent => ({ ts, type, envId: 'windows', source: 't', data });
test('events persist in order, can be read since an id, and pruned by age', () => {
  const s = new Store(':memory:');
  const a = s.appendEvent(ev('scan.completed', {}, 1)); s.appendEvent(ev('env.status', {}, 5));
  assert.deepEqual(s.eventsSince(a).map(e => e.type), ['env.status']);
  assert.equal(s.pruneEvents(3), 1);
  assert.equal(s.eventsSince(0).length, 1);
});
test('snapshots and kv round-trip; missing → null/undefined; undefined deletes', () => {
  const s = new Store(':memory:');
  s.saveSnapshot('scan', { x: [1, 2] }); assert.deepEqual(s.loadSnapshot('scan'), { x: [1, 2] });
  assert.equal(s.loadSnapshot('nope'), null);
  s.setKv('k', ['a']); assert.deepEqual(s.getKv('k'), ['a']); s.setKv('k', undefined); assert.equal(s.getKv('k'), undefined);
});
test('bus persists then notifies; unsubscribe stops delivery; secrets are redacted in store and delivery', () => {
  const s = new Store(':memory:'); const b = new Bus(s); const got: unknown[] = [];
  const off = b.subscribe(e => got.push(e.data));
  b.emit(ev('env.status', { url: 'https://u:pw@h', token: 'x', ok: 'fine' })); off(); b.emit(ev('env.status'));
  assert.deepEqual(got, [{ url: '[redacted]', token: '[redacted]', ok: 'fine' }]);
  assert.deepEqual(s.eventsSince(0)[0].data, { url: '[redacted]', token: '[redacted]', ok: 'fine' });
});
test('ephemeral events reach subscribers redacted but are not stored (negative id, out of liveState sequence)', () => {
  const s = new Store(':memory:'); const b = new Bus(s); const got: { id: number; type: string }[] = [];
  const off = b.subscribe(e => got.push({ id: e.id, type: e.type }));
  b.emit({ ts: 1, type: 'trace.detail', envId: 'hub', source: 't', data: { stage: 'relay', text: 'hello' } }, { ephemeral: true });
  b.emit({ ts: 2, type: 'run.started', envId: 'hub', source: 't', data: { id: 42 } });
  assert.equal(got.length, 2);
  assert.ok(got[0].id < 0); // ephemeral negative id
  assert.equal(s.eventsSince(0).length, 1); // only the persisted run.started reaches the DB
  assert.equal(s.eventsSince(0)[0].type, 'run.started');
  assert.deepEqual(b.recentTraces().map(e => e.data.text), ['hello'], 'the latest kept in memory for a pane opened later');
  assert.ok(new Bus(s).recentTraces().length === 0 && got[0].id < -1e12, 'ids start from the clock: a restarted daemon never reuses one');
  off();
});
test('a corrupt db file fails loudly with a clear message', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'as-')), 'bad.db'); writeFileSync(p, 'not a database at all, really not');
  assert.throws(() => { const s = new Store(p); s.eventsSince(0); }, /agent-spaghetti store cannot open/);
});
