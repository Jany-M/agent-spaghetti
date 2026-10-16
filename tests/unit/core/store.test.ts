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
test('a corrupt db file fails loudly with a clear message', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'as-')), 'bad.db'); writeFileSync(p, 'not a database at all, really not');
  assert.throws(() => { const s = new Store(p); s.eventsSince(0); }, /agent-spaghetti store cannot open/);
});
