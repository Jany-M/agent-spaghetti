import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { loadIntegrations } from '../../../packages/core/src/registry.ts';

const m = (id: string, extra = {}) => JSON.stringify({ manifest: 1, id, name: id, roles: ['tool'], detect: { bin: [id] }, ...extra });
test('user drop-ins: valid one loads with a hash; bad JSON, schema errors, secrets, id mismatch and code are rejected', async () => {
  const d = mkdtempSync(join(tmpdir(), 'as-'));
  writeFileSync(join(d, 'good-tool.json'), m('good-tool'));
  writeFileSync(join(d, 'broken.json'), '{nope');
  writeFileSync(join(d, 'bad-schema.json'), m('bad-schema', { roles: [] }));
  writeFileSync(join(d, 'leaky.json'), m('leaky', { detect: { bin: ['ghp_' + 'a'.repeat(36)] } }));
  writeFileSync(join(d, 'other-name.json'), m('mismatch'));
  writeFileSync(join(d, 'with-code.json'), m('with-code', { module: './index.ts' }));
  writeFileSync(join(d, 'cursor.json'), m('cursor'));
  const { integrations, rejected } = await loadIntegrations(BUILTINS, d);
  const good = integrations.find(i => i.manifest.id === 'good-tool')!;
  assert.equal(good.source, 'user'); assert.equal(good.hash!.length, 64);
  assert.deepEqual(rejected.map(r => r.id).sort(), ['bad-schema', 'broken', 'leaky', 'other-name', 'with-code']);
  assert.match(rejected.find(r => r.id === 'with-code')!.why, /unknown field/);
  const cursor = integrations.find(i => i.manifest.id === 'cursor')!;
  assert.equal(cursor.source, 'user');
  assert.equal(integrations.length, BUILTINS.length + 1);
});
test('missing user folder is fine', async () => {
  assert.equal((await loadIntegrations(BUILTINS, '/definitely/not/here')).rejected.length, 0);
});
