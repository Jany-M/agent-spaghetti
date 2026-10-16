// The one Environment implementation (Node APIs). Runs on the Windows host, on Linux, and inside WSL via the env bundle.
import { access, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { EnvKind, Environment } from '@agent-spaghetti/sdk';
import { spawnFile } from '../proc.ts';
import { http } from '../http.ts';
import { hostCandidates } from './hosts.ts';
import { collectorFor } from './inventory/index.ts';

export function currentKind(): EnvKind {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return process.env.WSL_DISTRO_NAME ? 'wsl' : 'linux';
}
const exists = (p: string) => access(p, constants.F_OK).then(() => true, () => false);

/** ~, %VAR% (windows) and $VAR / ${VAR} expansion from this process's environment. */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return p.replace(/^~(?=$|[\\/])/, home)
    .replace(/%([A-Za-z0-9_]+)%/g, (m, n) => env[n] ?? m)
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n) => env[n] ?? m);
}
/** First existing path matching a pattern; '*' is allowed inside a single segment. */
export async function globFirst(pattern: string): Promise<string | null> {
  const parts = pattern.replaceAll('\\', '/').split('/');
  const walk = async (base: string, i: number): Promise<string | null> => {
    if (i === parts.length) return (await exists(base)) ? base : null;
    const seg = parts[i];
    if (!seg.includes('*')) return walk(i === 0 ? (seg === '' ? '/' : /^[A-Za-z]:$/.test(seg) ? seg + '/' : seg) : join(base, seg), i + 1);
    const re = new RegExp('^' + seg.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    const names = (await readdir(base).catch(() => [] as string[])).filter(n => re.test(n)).sort();
    for (const n of names) { const r = await walk(join(base, n), i + 1); if (r) return r; }
    return null;
  };
  return walk('', 0);
}
export async function whichBin(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';')] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean))
    for (const ext of exts) { const p = join(dir, bin + ext); if (await exists(p)) return p; }
  return null;
}

export function localEnvironment(o: { id?: string; kind?: EnvKind; extraHosts?: string[] } = {}): Environment {
  const kind = o.kind ?? currentKind();
  const env: Environment = {
    id: o.id ?? (kind === 'wsl' ? `wsl:${process.env.WSL_DISTRO_NAME}` : kind), kind,
    async exec(cmd, args, opts) {
      const r = await spawnFile(cmd, args, { timeoutMs: opts?.timeoutMs, input: opts?.input });
      return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr.toString('utf8') };
    },
    http,
    readFile: p => readFile(expandPath(p), 'utf8').catch(() => null),
    which: b => whichBin(b),
    glob: p => globFirst(expandPath(p)),
    hostCandidates: () => hostCandidates(kind, o.extraHosts ?? []),
    inventory: names => collectorFor(kind)(env, names),
  };
  return env;
}
