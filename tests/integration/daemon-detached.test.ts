// `daemon --detached` / `daemon stop` against an isolated data dir and a free port (never the developer's daemon).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryPath, logsDir, pidAlive, readDiscovery, tokenPath } from '@agent-spaghetti/sdk';
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

const cliIn = (env: NodeJS.ProcessEnv) => async (...a: string[]) => { const out: string[] = [], err: string[] = []; const code = await run(a, { out: s => out.push(s), err: s => err.push(s) }, env); return { code, out: out.join('\n'), err: err.join('\n') }; };

test('daemon stop: live pid but unreachable daemon → one-line error, exit 1 (no stack trace)', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-stop-'));
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    writeFileSync(tokenPath(dir), 'x'); writeFileSync(discoveryPath(dir), JSON.stringify({ port: 1, pid: sleeper.pid }));
    const r = await cliIn({ ...process.env, AGENT_SPAGHETTI_DATA_DIR: dir, AGENT_SPAGHETTI_PORT: '' })('daemon', 'stop');
    assert.equal(r.code, 1); assert.match(r.err, /did not stop/); assert.ok(!r.err.includes('\n'));
  } finally { sleeper.kill(); rmSync(dir, { recursive: true, force: true }); }
});

test('daemon --detached against a port-holder that never answers: fails within budget, does not hang', { timeout: 40000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'as-hang-'));
  const holder = createServer(() => { /* accepts, never answers */ });
  await new Promise<void>(r => holder.listen(0, '127.0.0.1', r));
  const port = String((holder.address() as { port: number }).port);
  try {
    writeFileSync(tokenPath(dir), 'x');
    const r = await cliIn({ ...process.env, AGENT_SPAGHETTI_DATA_DIR: dir, AGENT_SPAGHETTI_PORT: port })('daemon', '--detached');
    assert.equal(r.code, 1); assert.match(r.err, /did not start/);
  } finally {
    holder.closeAllConnections(); holder.close();
    const d = readDiscovery(dir); if (d?.pid) try { process.kill(d.pid); } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
