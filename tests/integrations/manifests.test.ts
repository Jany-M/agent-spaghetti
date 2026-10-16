// Every built-in manifest is valid and every fixtures.json case passes. Adding an integration adds no test code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILTINS, BUILTIN_DIR } from '@agent-spaghetti/integrations';
import { loadIntegrations } from '../../packages/core/src/registry.ts';
import { runFixture, type FixtureCase } from '../../packages/core/src/engine/fixtures.ts';

const { integrations, rejected } = await loadIntegrations(BUILTINS, null);
test('every built-in manifest is valid', () => assert.deepEqual(rejected, []));
for (const i of integrations) {
  const cases: FixtureCase[] = JSON.parse(readFileSync(new URL(`${i.manifest.id}/fixtures.json`, BUILTIN_DIR), 'utf8'));
  test(`${i.manifest.id}: has a found and a not-found case`, () => {
    assert.ok(cases.some(c => c.expect !== null) && cases.some(c => c.expect === null));
  });
  for (const c of cases) test(`${i.manifest.id}: ${c.name}`, async () => assert.deepEqual(await runFixture(i, c), []));
}
