// The build: the env bundle (runs inside WSL distros) and the tray app bundles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnFile } from '../../packages/core/src/proc.ts';
import { encodePayload } from '../../packages/core/src/env/wsl.ts';
import { VERSION } from '@agent-spaghetti/sdk';

const dir = mkdtempSync(join(tmpdir(), 'as-bundle-')), out = join(dir, 'agent-spaghetti-env.mjs');
const node = (args: string[]) => spawnFile(process.execPath, [out, ...args], { timeoutMs: 60000 });

test('bundle builds and is self-contained (no node:sqlite, no TypeScript)', async () => {
  const b = await spawnFile(process.execPath, ['scripts/build.mjs', dir], { timeoutMs: 60000 });
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
test('tray bundles: preload needs only electron, the renderer no Node at all, the page has a strict CSP', () => {
  const app = (f: string) => readFileSync(join(dir, 'app', f), 'utf8');
  assert.deepEqual([...new Set([...app('preload.cjs').matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]))], ['electron']);
  assert.ok(!/require\(|["']node:/.test(app('renderer.js')));
  assert.match(app('popover.html'), /default-src 'none'; script-src 'self'; style-src 'self'/);
  for (const f of ['main.cjs', 'popover.css', 'icon.png', 'tray-idle.png', 'tray-problem@2x.png']) assert.ok(app(f).length > 0, f);
});
