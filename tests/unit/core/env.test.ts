import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDefaultGateway } from '../../../packages/core/src/env/hosts.ts';
import { expandPath, globFirst, whichBin, localEnvironment } from '../../../packages/core/src/env/local.ts';
import { parseWindowsInventory, windowsScript } from '../../../packages/core/src/env/inventory/windows.ts';
import { parseProcNetTcp, parseDesktopEntry, linuxCollector } from '../../../packages/core/src/env/inventory/linux.ts';
import { parseWslListVerbose, runInDistro, listDistros, type Spawn } from '../../../packages/core/src/env/wsl.ts';
import { discoverEnvironments } from '../../../packages/core/src/env/discover.ts';

const fx = (f: string) => readFileSync(new URL(`../../fixtures/inventory/${f}`, import.meta.url), 'utf8');
const u16 = (s: string) => Buffer.from(s, 'utf16le');
const out = (stdout = '', code = 0) => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) });

test('default gateway from /proc/net/route (little-endian hex)', () => {
  const route = 'Iface\tDestination\tGateway\tFlags\neth0\t00000000\t0100A8C0\t0003\neth0\t0000A8C0\t00000000\t0001\n';
  assert.equal(parseDefaultGateway(route), '192.168.0.1');
  assert.equal(parseDefaultGateway('Iface\n'), null);
});
test('expandPath: ~, %VAR%, $VAR, ${VAR}; unknown vars stay', () => {
  const env = { LOCALAPPDATA: 'C:/Users/u/AppData/Local', HOME: '/home/u' };
  assert.equal(expandPath('~/x', env, '/home/u'), '/home/u/x');
  assert.equal(expandPath('%LOCALAPPDATA%/Programs', env), 'C:/Users/u/AppData/Local/Programs');
  assert.equal(expandPath('$HOME/a/${HOME}', env), '/home/u/a//home/u');
  assert.equal(expandPath('%NOPE%/x', env), '%NOPE%/x');
});
test('globFirst handles one * per segment, spaces and non-ASCII; whichBin finds node', async () => {
  const d = mkdtempSync(join(tmpdir(), 'as-'));
  mkdirSync(join(d, 'Prog Fïles', 'v1.2'), { recursive: true });
  writeFileSync(join(d, 'Prog Fïles', 'v1.2', 'package.json'), '{}');
  assert.equal(await globFirst(join(d, 'Prog F*', 'v*', 'package.json')), join(d, 'Prog Fïles', 'v1.2', 'package.json'));
  assert.equal(await globFirst(join(d, 'nope*', 'x')), null);
  assert.ok(await whichBin('node'));
  assert.equal(await whichBin('definitely-not-a-binary-xyz'), null);
});
test('windows inventory: location from InstallLocation or DisplayIcon folder, MSIX, empty names dropped, partial kept', () => {
  const inv = parseWindowsInventory(fx('windows.json'));
  assert.deepEqual(inv.installed.map(i => [i.name, i.location, i.source]), [
    ['Cursor (User)', 'C:\\Users\\u\\AppData\\Local\\Programs\\cursor\\', 'uninstall'],
    ['LM Studio 0.4.26', 'D:\\Apps\\LM Studio', 'uninstall'],
    ['Claude', 'C:\\Program Files\\WindowsApps\\Claude_2.1.0.0_x64__abc', 'msix']]);
  assert.equal(inv.processes.find(p => p.name === 'svchost')?.path, undefined);
  assert.deepEqual(inv.listening[0], { address: '127.0.0.1', port: 4321, pid: 42 });
  assert.deepEqual(inv.env, { OLLAMA_HOST: '0.0.0.0:5555' });
  assert.deepEqual(inv.partial, ['msix']);
  assert.deepEqual(parseWindowsInventory('not json').partial, ['inventory output was not JSON']);
});
test('windows script asks only for the named, valid env vars', () => {
  const s = windowsScript(['OLLAMA_HOST', 'bad name; rm']);
  assert.match(s, /@\('OLLAMA_HOST'\)/);
  assert.doesNotMatch(s, /bad name/);
  assert.doesNotMatch(s, /\bnetstat\b|\btasklist\b|reg query/);   // never parse localized text
});
test('linux /proc/net/tcp parsing (listen only) and .desktop entries', () => {
  const tcp = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
    + '   0: 0100007F:2EE0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1\n'
    + '   1: 0100007F:0016 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 99 1\n';
  assert.deepEqual(parseProcNetTcp(tcp, false), [{ address: '127.0.0.1', port: 12000, inode: '12345' }]);
  assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nName=LM Stüdio\nExec="/opt/LM Studio/lm" %U\n[Desktop Action x]\nName=Other\n'),
    { name: 'LM Stüdio', location: undefined });
  assert.deepEqual(parseDesktopEntry('[Desktop Entry]\nName=Tool\nExec=/opt/tool/bin/tool %U\n'), { name: 'Tool', location: '/opt/tool/bin' });
});
test('linux collector runs on this machine without commands and reads only requested env vars', { skip: process.platform !== 'linux' }, async () => {
  process.env.AS_TEST_VAR = 'x';
  const inv = await linuxCollector({ exec: async () => { throw new Error('no exec expected'); } }, ['AS_TEST_VAR']);
  assert.ok(inv.processes.some(p => p.pid === process.pid));
  assert.deepEqual(inv.env, { AS_TEST_VAR: 'x' });
});
test('wsl -l -v parsing: UTF-16LE, default marker, states', () => {
  const rows = parseWslListVerbose(u16('  NAME            STATE           VERSION\r\n* Ubuntu          Running         2\r\n  TestDistro      Stopped         2\r\n  docker-desktop  Running         2\r\n'));
  assert.deepEqual(rows, [{ name: 'Ubuntu', state: 'running', isDefault: true }, { name: 'TestDistro', state: 'stopped', isDefault: false },
    { name: 'docker-desktop', state: 'running', isDefault: false }]);
  assert.equal(parseWslListVerbose(Buffer.from('NAME STATE VERSION\nA Running 2\n'))[0].name, 'A');
});
test('discover: no WSL → local only; stopped distro listed but never touched; docker-desktop ignored', async () => {
  const calls: string[][] = [];
  const spawn: Spawn = async (_c, a) => { calls.push(a); return { code: 0, stdout: u16('  NAME STATE VERSION\r\n* TestDistro Running 2\r\n  Other Stopped 2\r\n  docker-desktop Running 2\r\n'), stderr: Buffer.alloc(0) }; };
  const envs = await discoverEnvironments({ spawn });
  assert.deepEqual(envs.slice(1).map(e => [e.status.id, e.status.state, e.distro]), [['wsl:TestDistro', 'running', 'TestDistro'], ['wsl:Other', 'stopped', undefined]]);
  assert.deepEqual(calls, [['-l', '-v']]);
  assert.equal(await listDistros(async () => out('', 127)), null);
});
test('runInDistro: no node → reason; stale bundle copied once; fresh bundle not copied; args passed as array', async () => {
  const bundle = { text: Buffer.from('console.log(1)'), sha256: 'abc' };
  const calls: Array<{ a: string[]; input?: unknown }> = [];
  const mk = (probe: string, run = '{"ok":1}'): Spawn => async (_c, a, o) => {
    calls.push({ a, input: o?.input });
    if (a.includes('-c') && String(a[a.indexOf('-c') + 1]).includes('echo "dir=')) return out(probe);
    if (a.includes('-c')) return out('');
    return out(run);
  };
  assert.deepEqual(await runInDistro('T', bundle, ['inspect'], '{}', mk('dir=/home/u/.local/share/agent-spaghetti\nfresh=0\n')),
    { ok: false, why: 'no Node.js >= 20 in this distro (needed to scan inside it)' });
  calls.length = 0;
  const r = await runInDistro('T', bundle, ['inspect', '--x'], '{"p":1}', mk('dir=/d\nnode=/usr/bin/node\nfresh=0\n'));
  assert.deepEqual(r, { ok: true, stdout: '{"ok":1}' });
  assert.equal(calls.length, 3);
  assert.ok(Buffer.isBuffer(calls[1].input));
  assert.deepEqual(calls[2].a, ['-d', 'T', '--', '/usr/bin/node', '/d/agent-spaghetti-env.mjs', 'inspect', '--x']);
  calls.length = 0;
  await runInDistro('T', bundle, ['inspect'], '{}', mk('dir=/d\nnode=/usr/bin/node\nfresh=1\n'));
  assert.equal(calls.length, 2);
  assert.deepEqual(await runInDistro('T', null, [], ''), { ok: false, why: 'env bundle not built (run: npm run build)' });
});
test('local environment: http to a closed port is null; missing binary is 127', async () => {
  const env = localEnvironment();
  assert.equal(await env.http({ url: 'http://127.0.0.1:1/', timeoutMs: 300 }), null);
  assert.equal((await env.exec('definitely-not-a-binary-xyz', [])).code, 127);
});
