import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { npmShimTarget, spawnFile, spawnLines } from '../../../packages/core/src/proc.ts';
import { withDeadline, mapLimit } from '../../../packages/core/src/async.ts';
import { http } from '../../../packages/core/src/http.ts';

const node = process.execPath;
test('missing binary → 127, no throw; exit code passes through; stdin input works', async () => {
  assert.equal((await spawnFile('definitely-not-a-binary-xyz', [])).code, 127);
  assert.equal((await spawnFile(node, ['-e', 'process.exit(3)'])).code, 3);
  const r = await spawnFile(node, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hello' });
  assert.equal(r.stdout.toString(), 'hello');
});
test('timeout → 124 quickly', async () => {
  const t0 = Date.now();
  assert.equal((await spawnFile(node, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 200 })).code, 124);
  assert.ok(Date.now() - t0 < 2000);
});
test('spawnLines streams lines and reports exit', async () => {
  const lines: string[] = [];
  const p = spawnLines(node, ['-e', 'console.log("a");console.log("b")'], l => lines.push(l));
  assert.equal(await p.exited, 0);
  assert.deepEqual(lines, ['a', 'b']);
});
test('.cmd shims refuse unsafe arguments (windows only)', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(async () => spawnFile('x.cmd', ['a&b']), /unsafe argument/);
});
test('withDeadline rejects on time and does not keep the process alive', async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 50), /timeout after 50ms/);
  assert.equal(await withDeadline(async () => 7, 1000), 7);
});
test('mapLimit keeps order and never exceeds the limit', async () => {
  let active = 0, peak = 0;
  const r = await mapLimit([1, 2, 3, 4, 5], 2, async n => { active++; peak = Math.max(peak, active); await new Promise(s => setTimeout(s, 5)); active--; if (n === 3) throw new Error('x'); return n * 2; });
  assert.equal(peak, 2);
  assert.deepEqual(r.map(x => x.status === 'fulfilled' ? x.value : 'err'), [2, 4, 'err', 8, 10]);
});
test('http returns null when unreachable', async () => {
  assert.equal(await http({ url: 'http://127.0.0.1:1/', timeoutMs: 500 }), null);
});
test('spawnLines stop() ends what the child started too (POSIX process group)', { skip: process.platform === 'win32' }, async () => {
  let pid = 0;
  const p = spawnLines('sh', ['-c', 'cat | "$0" -e "console.log(process.pid); setTimeout(() => {}, 60000)"', node], l => { pid = Number(l); }, { input: '' });
  for (let i = 0; i < 100 && !pid; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(pid > 0);
  p.stop();
  await p.exited;
  await new Promise(r => setTimeout(r, 200));
  const state = () => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0]; } catch { return 'gone'; } };   // Z: ended, not reaped yet
  assert.ok(['gone', 'Z'].includes(state() ?? 'gone'), `the grandchild is still ${state()}`);
});
test('spawnLines stop() returns even when a detached grandchild keeps the pipe open', async () => {
  const grandchild = 'console.log(process.pid); setTimeout(() => {}, 60000)';
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit', detached: true }); setTimeout(() => {}, 60000)`;
  let pid = 0;
  const p = spawnLines(node, ['-e', parent], l => { pid = Number(l); });
  for (let i = 0; i < 250 && !pid; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(pid > 0);
  try {
    p.stop();
    const exit = await Promise.race([p.exited, new Promise(r => setTimeout(() => r('hung'), 5000))]);
    assert.notEqual(exit, 'hung', 'exited waits for the grandchild to close the pipe');
  } finally { try { process.kill(pid); } catch { /* gone */ } }
});
test('spawnLines exited settles when the child ends on its own while a detached grandchild keeps the pipe open', async () => {
  const grandchild = 'console.log(process.pid); setTimeout(() => {}, 60000)';
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'inherit', detached: true }).unref(); setTimeout(() => process.exit(3), 300)`;
  let pid = 0;
  const p = spawnLines(node, ['-e', parent], l => { pid = Number(l); });
  try {
    const exit = await Promise.race([p.exited, new Promise(r => setTimeout(() => r('hung'), 5000))]);
    assert.equal(exit, 3, 'the child\'s own exit code, without waiting for the grandchild');
    p.stop();                                                   // stopping after the exit is harmless
  } finally { for (let i = 0; i < 50 && !pid; i++) await new Promise(r => setTimeout(r, 20)); try { process.kill(pid); } catch { /* gone */ } }
});
test('npm .cmd shims run what they start (node + script, or an .exe) without cmd.exe, so a task can be an argument', () => {
  const js = '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\cline\\bin\\cline.js" %*\r\n';
  const a = npmShimTarget(js, '/npm', 'node')!;
  assert.equal(a.file, 'node'); assert.match(a.pre[0], /^\/npm[\\/]node_modules\\cline\\bin\\cline\.js$/);
  assert.match(npmShimTarget('@ECHO off\r\n"%~dp0%\\node_modules\\x\\bin\\x.exe"   %*\r\n', '/npm')!.file, /x\.exe$/);
  assert.equal(npmShimTarget('@echo off\r\necho hi\r\n', '/npm'), null, 'any other batch file: cmd.exe as before');
});
