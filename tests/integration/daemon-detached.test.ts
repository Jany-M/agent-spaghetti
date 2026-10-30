// `daemon --detached` / `daemon stop` against an isolated data dir and a free port (never the developer's daemon).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryPath, logsDir, pidAlive, readDiscovery } from '@agent-spaghetti/sdk';
import { run } from '../../packages/cli/src/index.ts';

test('detached start → status → log → idempotent restart → stop → gone', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-detached-'));
  const env = { ...process.env, AGENT_SPAGHETTI_DATA_DIR: dir, AGENT_SPAGHETTI_PORT: '' };
  const cli = async (...a: string[]) => { const out: string[] = [], err: string[] = []; const code = await run(a, { out: s => out.push(s), err: s => err.push(s) }, env); return { code, out: out.join('\n'), err: err.join('\n') }; };
  try {
    assert.match((await cli('status')).err, /not running/);
    const first = await cli('daemon', '--detached');
    assert.equal(first.code, 0); assert.match(first.out, /started on 127\.0\.0\.1:\d+/);
    const pid = readDiscovery(dir)!.pid!;
    assert.equal((await cli('status')).code, 0);
    assert.ok(existsSync(join(logsDir(dir), 'daemon.log')));
    const second = await cli('daemon', '--detached');
    assert.equal(second.code, 0); assert.match(second.out, /already running/);
    assert.equal(readDiscovery(dir)!.pid, pid);
    const stop = await cli('daemon', 'stop');
    assert.equal(stop.code, 0); assert.match(stop.out, /stopped/);
    assert.equal(pidAlive(pid), false); assert.equal(existsSync(discoveryPath(dir)), false);
    const after = await cli('status');
    assert.equal(after.code, 2); assert.match(after.err, /not running/);
  } finally {
    const d = readDiscovery(dir); if (d?.pid) try { process.kill(d.pid); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
