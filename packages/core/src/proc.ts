// The ONLY module that starts processes (PLAN §3.5). Argument arrays only, never a shell string.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CMD_SHIM = /\.(cmd|bat)$/i;
const UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/;
/** Whether an argument can pass through a Windows .cmd shim (cmd.exe) unchanged. */
export const cmdSafe = (a: string) => !UNSAFE_FOR_CMD.test(a);
export interface Spawned { code: number; stdout: Buffer; stderr: Buffer }   // code 127 = not found, 124 = timeout
export interface SpawnOpts { timeoutMs?: number; signal?: AbortSignal; input?: string | Buffer; env?: NodeJS.ProcessEnv }

/** What an npm .cmd shim (cmd-shim) runs: an .exe, or node with a script; null for any other batch file. */
export function npmShimTarget(text: string, dir: string, nodeExe = 'node'): { file: string; pre: string[] } | null {
  const js = /"%_prog%"\s+"%~?dp0%\\([^"]+)"\s+%\*/.exec(text), exe = /^\s*"%~?dp0%\\([^"]+\.exe)"\s+%\*/m.exec(text);
  if (js) return { file: existsSync(join(dir, 'node.exe')) ? join(dir, 'node.exe') : nodeExe, pre: [join(dir, js[1])] };
  return exe ? { file: join(dir, exe[1]), pre: [] } : null;
}
/** Windows .cmd/.bat shims need cmd.exe; only inert arguments are allowed through it. An npm shim is run without cmd.exe (what it
 *  starts, directly), so a task may be an argument (live 2026-11-04: Cline's CLI takes its prompt only as an argument). */
function resolveCmd(cmd: string, args: string[]): { file: string; argv: string[]; verbatim: boolean } {
  if (process.platform !== 'win32' || !CMD_SHIM.test(cmd)) return { file: cmd, argv: args, verbatim: false };
  const npm = (() => { try { return npmShimTarget(readFileSync(cmd, 'utf8'), dirname(cmd)); } catch { return null; } })();
  if (npm) return { file: npm.file, argv: [...npm.pre, ...args], verbatim: false };
  for (const a of [cmd, ...args]) if (!cmdSafe(a)) throw new Error(`unsafe argument for .cmd: ${a}`);
  return { file: process.env.ComSpec ?? 'cmd.exe', argv: ['/d', '/s', '/c', `"${[cmd, ...args].map(a => `"${a}"`).join(' ')}"`], verbatim: true };
}

export function spawnFile(cmd: string, args: string[], opts: SpawnOpts = {}): Promise<Spawned> {
  const { file, argv, verbatim } = resolveCmd(cmd, args);
  return new Promise(resolve => {
    const child = execFile(file, argv, { timeout: opts.timeoutMs ?? 15000, signal: opts.signal, windowsHide: true, encoding: 'buffer',
      maxBuffer: 32_000_000, windowsVerbatimArguments: verbatim, env: opts.env }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
      const code = !e ? 0 : e.code === 'ENOENT' ? 127 : e.killed ? 124 : typeof e.code === 'number' ? e.code : 1;
      resolve({ code, stdout: stdout ?? Buffer.alloc(0), stderr: stderr?.length ? stderr : Buffer.from(e?.message ?? '') });
    });
    child.stdin?.on('error', () => { /* child exited before reading input */ });
    if (opts.input !== undefined) child.stdin?.end(opts.input); else child.stdin?.end();
  });
}

const EXIT_GRACE_MS = 1000;
export interface LinesOpts { env?: NodeJS.ProcessEnv; input?: string | AsyncIterable<string>; cwd?: string }
/** Long-running process: one callback per stdout line. Returns a stop function, the exit promise and the stderr tail. */
export function spawnLines(cmd: string, args: string[], onLine: (line: string) => void, opts: LinesOpts = {}):
  { stop(): void; exited: Promise<number>; stderr(): string } {
  const { file, argv, verbatim } = resolveCmd(cmd, args);
  const group = process.platform !== 'win32';   // own process group: stop() also ends what the child started (e.g. `sh -c 'a | b'`)
  const child = spawn(file, argv, { windowsHide: true, windowsVerbatimArguments: verbatim, cwd: opts.cwd, env: opts.env, detached: group,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-2000); });
  child.stdin?.on('error', () => { /* exited before reading */ });
  const input = opts.input;
  if (typeof input === 'string') child.stdin!.end(input);
  else if (input) void (async () => { try { for await (const l of input) child.stdin!.write(l + '\n'); } finally { child.stdin!.end(); } })().catch(() => { /* exited */ });
  createInterface({ input: child.stdout! }).on('line', onLine);
  // Exit, not only close: a grandchild that inherited stdout can keep the pipe open long after the child is gone. Once stopped
  // the exit settles at once; an exit of its own gets EXIT_GRACE_MS for the last lines to arrive.
  let stopped = false, code: number | null = null, settle!: (c: number) => void;
  const exited = new Promise<number>(r => { settle = r; child.on('error', () => r(127)); child.on('close', c => r(c ?? code ?? 1));
    child.on('exit', c => { code = c ?? 1; if (stopped) r(code); else setTimeout(() => r(code!), EXIT_GRACE_MS).unref(); }); });
  const stop = () => { stopped = true; if (code !== null) settle(code); try { if (group && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { child.kill(); } };
  return { stop, exited, stderr: () => err };
}
/** Lines as an async iterable (runs); throws after the last line when the process failed. */
export async function* execLines(cmd: string, args: string[], o: LinesOpts & { signal?: AbortSignal } = {}): AsyncIterable<string> {
  const queue: string[] = []; let wake: (() => void) | null = null;
  const p = spawnLines(cmd, args, l => { queue.push(l); wake?.(); }, o);
  let code: number | null = null;
  void p.exited.then(c => { code = c; wake?.(); });
  const abort = () => p.stop();
  o.signal?.addEventListener('abort', abort);
  try {
    while (true) {
      if (queue.length) { yield queue.shift()!; continue; }
      if (code !== null) break;
      await new Promise<void>(r => { wake = r; }); wake = null;
    }
    if (o.signal?.aborted) throw new Error('cancelled');
    if (code !== 0) throw new Error(`${cmd} exited with ${code}${p.stderr() ? `: ${p.stderr().trim().slice(-400)}` : ''}`);
  } finally { o.signal?.removeEventListener('abort', abort); if (code === null) p.stop(); }
}

/** Starts a process that outlives its parent (the tray starting the daemon). Output is appended to `logFile`. */
export function spawnDetached(cmd: string, args: string[], o: { logFile: string; env?: NodeJS.ProcessEnv }): number | undefined {
  const { file, argv, verbatim } = resolveCmd(cmd, args);
  const fd = openSync(o.logFile, 'a');
  try {
    const child = spawn(file, argv, { detached: true, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', fd, fd], env: o.env });
    child.on('error', () => { /* reported by the caller's connect timeout */ });
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}
