// WSL distros (ADR 0002 as amended 2026-10-16): list them without side effects, and run the env bundle inside
// RUNNING distros over stdio. wsl.exe is only used to list, to copy the bundle (when its hash changed) and to run it.
// Always `--exec` (no shell): with `--`, wsl.exe re-parses the command line through a shell and drops/mangles arguments.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnFile } from '../proc.ts';

export type Spawn = typeof spawnFile;
export interface DistroRow { name: string; state: 'running' | 'stopped'; isDefault: boolean }

/** `wsl -l -v` (UTF-16LE or UTF-8). Header skipped; '*' marks the default distro. State words are not localized. */
export function parseWslListVerbose(raw: Buffer): DistroRow[] {
  const text = (raw.length > 1 && raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')).replace(/^﻿/, '');
  return text.split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean).flatMap(l => {
    const m = /^(\*?)\s*(\S+)\s+(\S+)\s+\d+$/.exec(l);
    return m ? [{ name: m[2], state: /^running$/i.test(m[3]) ? 'running' as const : 'stopped' as const, isDefault: m[1] === '*' }] : [];
  });
}
/** null = WSL not installed. docker-desktop* distros are infrastructure and ignored. */
export async function listDistros(spawn: Spawn = spawnFile): Promise<DistroRow[] | null> {
  const r = await spawn('wsl.exe', ['-l', '-v'], { timeoutMs: 15000 });
  if (r.code !== 0) return null;
  return parseWslListVerbose(r.stdout).filter(d => !/^docker-desktop/i.test(d.name));
}

export interface Bundle { text: Buffer; sha256: string }
export async function loadBundle(path = process.env.AGENT_SPAGHETTI_ENV_BUNDLE
  ?? fileURLToPath(new URL('../../../../dist/agent-spaghetti-env.mjs', import.meta.url))): Promise<Bundle | null> {
  const text = await readFile(path).catch(() => null);
  return text && { text, sha256: createHash('sha256').update(text).digest('hex') };
}

// Node candidates inside a distro: PATH first, then common per-user installs (data, not assumptions about one machine).
const PROBE = 'd="${XDG_DATA_HOME:-$HOME/.local/share}/agent-spaghetti"; echo "dir=$d"; '
  + 'for n in "$(command -v node 2>/dev/null)" "$HOME/.openclaw/tools/node/bin/node" "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/local/bin/node /usr/bin/node; do '
  + '[ -x "$n" ] || continue; m=$("$n" -p "process.versions.node.split(\'.\')[0]" 2>/dev/null); '
  + 'if [ "${m:-0}" -ge 20 ] 2>/dev/null; then echo "node=$n"; break; fi; done; '
  + '[ "$(cat "$d/agent-spaghetti-env.mjs.sha256" 2>/dev/null)" = "$1" ] && echo fresh=1 || echo fresh=0';
const COPY = 'd="${XDG_DATA_HOME:-$HOME/.local/share}/agent-spaghetti"; mkdir -p "$d" && cat > "$d/agent-spaghetti-env.mjs.tmp" '
  + '&& mv -f "$d/agent-spaghetti-env.mjs.tmp" "$d/agent-spaghetti-env.mjs" && printf %s "$1" > "$d/agent-spaghetti-env.mjs.sha256"';

export type DistroRun = { ok: true; stdout: string } | { ok: false; why: string };
/** Ensure the bundle is present in the distro, then run `node agent-spaghetti-env.mjs <args>` with `input` on stdin. */
export async function runInDistro(distro: string, bundle: Bundle | null, args: string[], input: string, spawn: Spawn = spawnFile,
  timeoutMs = 120000): Promise<DistroRun> {
  if (!bundle) return { ok: false, why: 'env bundle not built (run: npm run build)' };
  const wsl = (a: string[], o: { input?: string | Buffer; timeoutMs?: number } = {}) => spawn('wsl.exe', ['-d', distro, '--exec', ...a], { timeoutMs: 30000, ...o });
  const probe = await wsl(['sh', '-c', PROBE, 'sh', bundle.sha256]);
  const kv = Object.fromEntries(probe.stdout.toString('utf8').split('\n').map(l => l.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p.length === 2));
  if (probe.code !== 0 || !kv.dir) return { ok: false, why: `distro not reachable (wsl exit ${probe.code})` };
  if (!kv.node) return { ok: false, why: 'no Node.js >= 20 in this distro (needed to scan inside it)' };
  if (kv.fresh !== '1') {
    const c = await wsl(['sh', '-c', COPY, 'sh', bundle.sha256], { input: bundle.text });
    if (c.code !== 0) return { ok: false, why: `could not copy the env bundle (exit ${c.code})` };
  }
  const r = await wsl([kv.node, `${kv.dir}/agent-spaghetti-env.mjs`, ...args], { input, timeoutMs });
  return r.code === 0 ? { ok: true, stdout: r.stdout.toString('utf8') }
    : { ok: false, why: `env bundle failed (exit ${r.code}): ${r.stderr.toString('utf8').trim().slice(-300)}` };
}
