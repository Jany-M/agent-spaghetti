// The ONLY module that starts processes (PLAN §3.5). Argument arrays only, never a shell string.
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { closeSync, openSync } from 'node:fs';

const CMD_SHIM = /\.(cmd|bat)$/i;
const UNSAFE_FOR_CMD = /["%^&|<>!\r\n]/;
export interface Spawned { code: number; stdout: Buffer; stderr: Buffer }   // code 127 = not found, 124 = timeout
export interface SpawnOpts { timeoutMs?: number; signal?: AbortSignal; input?: string | Buffer; env?: NodeJS.ProcessEnv }

/** Windows .cmd/.bat shims need cmd.exe; only inert arguments are allowed through it. */
function resolveCmd(cmd: string, args: string[]): { file: string; argv: string[]; verbatim: boolean } {
  if (process.platform !== 'win32' || !CMD_SHIM.test(cmd)) return { file: cmd, argv: args, verbatim: false };
  for (const a of [cmd, ...args]) if (UNSAFE_FOR_CMD.test(a)) throw new Error(`unsafe argument for .cmd: ${a}`);
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

/** Long-running process: one callback per stdout line. Returns a stop function and the exit promise. */
export function spawnLines(cmd: string, args: string[], onLine: (line: string) => void, opts: { env?: NodeJS.ProcessEnv } = {}):
  { stop(): void; exited: Promise<number> } {
  const { file, argv, verbatim } = resolveCmd(cmd, args);
  const child = spawn(file, argv, { windowsHide: true, windowsVerbatimArguments: verbatim, stdio: ['ignore', 'pipe', 'ignore'], env: opts.env });
  createInterface({ input: child.stdout! }).on('line', onLine);
  const exited = new Promise<number>(r => { child.on('error', () => r(127)); child.on('close', c => r(c ?? 1)); });
  return { stop: () => { child.kill(); }, exited };
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
