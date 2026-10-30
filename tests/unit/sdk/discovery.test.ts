// Discovery record: a daemon.json whose pid is dead is "not running" and removed by whoever reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryPath, pidAlive, readDiscovery } from '@agent-spaghetti/sdk';

const withDir = (fn: (dir: string) => void) => { const d = mkdtempSync(join(tmpdir(), 'as-disc-')); try { fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('readDiscovery: alive pid is returned; dead pid is stale and removed; missing/garbled file is null', () => {
  withDir(dir => {
    assert.equal(readDiscovery(dir), null);
    writeFileSync(discoveryPath(dir), JSON.stringify({ port: 8787, pid: process.pid }));
    assert.equal(readDiscovery(dir)?.port, 8787);
    writeFileSync(discoveryPath(dir), JSON.stringify({ port: 8787, pid: 2 ** 22 + 12345 }));   // above any real pid_max default
    assert.equal(readDiscovery(dir), null);
    assert.equal(existsSync(discoveryPath(dir)), false);
    writeFileSync(discoveryPath(dir), 'not json');
    assert.equal(readDiscovery(dir), null);
  });
  assert.equal(pidAlive(process.pid), true);
});
