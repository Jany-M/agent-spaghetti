// The env bundle (what runs inside WSL distros) builds, has no node:sqlite, and answers its commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnFile } from '../../packages/core/src/proc.ts';
import { encodePayload } from '../../packages/core/src/env/wsl.ts';
import { VERSION } from '../../packages/env/src/main.ts';

const out = join(mkdtempSync(join(tmpdir(), 'as-bundle-')), 'agent-spaghetti-env.mjs');
const node = (args: string[]) => spawnFile(process.execPath, [out, ...args], { timeoutMs: 60000 });

test('bundle builds and is self-contained (no node:sqlite, no TypeScript)', async () => {
  const b = await spawnFile(process.execPath, ['scripts/build-env.mjs', out], { timeoutMs: 60000 });
  assert.equal(b.code, 0, b.stderr.toString());
  const text = readFileSync(out, 'utf8');
  assert.ok(!text.includes('node:sqlite'));
  assert.ok(!/from ['"]@agent-spaghetti\//.test(text), 'workspace imports are inlined');
});
test('bundle: version, inspect JSON, unknown command → usage + exit 1', async () => {
  assert.equal((await node(['version'])).stdout.toString().trim(), VERSION);
  const r = await node(['inspect', encodePayload({ envId: 'linux', extraHosts: [], user: [], grants: [] })]);
  assert.equal(r.code, 0, r.stderr.toString());
  const scan = JSON.parse(r.stdout.toString());
  assert.equal(scan.status.id, 'linux');
  assert.ok(Array.isArray(scan.inspections) && Array.isArray(scan.pending));
  const bad = await node(['nope']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr.toString(), /usage: agent-spaghetti-env\.mjs/);
});
