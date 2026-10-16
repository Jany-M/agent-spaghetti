// WSL distros (ADR 0002 as amended 2026-10-16): list them without side effects, and run the env bundle inside
// RUNNING distros over stdio. wsl.exe is only used to list, to copy the bundle (when its hash changed) and to run it.
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

export type Prepared = { ok: true; node: string; bundlePath: string } | { ok: false; why: string };
/** Find Node >= 20 in the distro and make sure the current bundle is there (copied only when its hash changed). */
export async function prepareDistro(distro: string, bundle: Bundle | null, spawn: Spawn = spawnFile): Promise<Prepared> {
  if (!bundle) return { ok: false, why: 'env bundle not built (run: npm run build)' };
  const probe = await spawn('wsl.exe', wslArgs(distro, ['sh', '-c', PROBE, 'sh', bundle.sha256]), { timeoutMs: 30000 });
  const kv = Object.fromEntries(probe.stdout.toString('utf8').split('\n').map(l => l.trim().split(/=(.*)/s).slice(0, 2)).filter(p => p.length === 2));
  if (probe.code !== 0 || !kv.dir) return { ok: false, why: `distro not reachable (wsl exit ${probe.code})` };
  if (!kv.node) return { ok: false, why: 'no Node.js >= 20 in this distro (needed to scan inside it)' };
  if (kv.fresh !== '1') {
    const c = await spawn('wsl.exe', wslArgs(distro, ['sh', '-c', COPY, 'sh', bundle.sha256]), { input: bundle.text, timeoutMs: 30000 });
    if (c.code !== 0) return { ok: false, why: `could not copy the env bundle (exit ${c.code})` };
  }
  return { ok: true, node: kv.node, bundlePath: `${kv.dir}/agent-spaghetti-env.mjs` };
}
/** Always `--exec` (no shell): with `--`, wsl.exe re-parses the command line through a shell and mangles arguments. */
export const wslArgs = (distro: string, argv: string[]) => ['-d', distro, '--exec', ...argv];

export type DistroRun = { ok: true; stdout: string } | { ok: false; why: string };
/** Run `node agent-spaghetti-env.mjs <args>` inside the distro with `input` on stdin. */
export async function runInDistro(distro: string, bundle: Bundle | null, args: string[], input: string, spawn: Spawn = spawnFile,
  timeoutMs = 120000): Promise<DistroRun> {
  const p = await prepareDistro(distro, bundle, spawn);
  if (!p.ok) return p;
  const r = await spawn('wsl.exe', wslArgs(distro, [p.node, p.bundlePath, ...args]), { input, timeoutMs });
  return r.code === 0 ? { ok: true, stdout: r.stdout.toString('utf8') }
    : { ok: false, why: `env bundle failed (exit ${r.code}): ${r.stderr.toString('utf8').trim().slice(-300)}` };
}

/** What the host gives the env bundle for every command (argv, base64 JSON: no stdin needed, works for long-running observe). */
export interface EnvPayload {
  envId: string; extraHosts: string[]; user: import('@agent-spaghetti/sdk').Manifest[]; grants: import('@agent-spaghetti/sdk').Grant[];
  observe?: { backendPollMs: number; sessionPollMs: number };
}
/** What a distro needs to run the same code as the host: user manifests, grants, hosts. */
export function payloadFor(envId: string, o: { integrations: import('@agent-spaghetti/sdk').Integration[]; grants?: import('@agent-spaghetti/sdk').Grant[]; extraHosts?: string[] }, observe?: EnvPayload['observe']): EnvPayload {
  return { envId, extraHosts: o.extraHosts ?? [], grants: o.grants ?? [], user: o.integrations.filter(i => i.source === 'user').map(i => i.manifest), ...(observe ? { observe } : {}) };
}
export const encodePayload = (p: EnvPayload) => Buffer.from(JSON.stringify(p)).toString('base64');
export const decodePayload = (s: string | undefined): EnvPayload =>
  ({ envId: '', extraHosts: [], user: [], grants: [], ...(s ? JSON.parse(Buffer.from(s, 'base64').toString('utf8')) : {}) });

/** One-shot bundle command inside a distro, JSON result. */
export async function distroCall<T>(distro: string, bundle: Bundle | null, cmd: string, payload: EnvPayload, args: string[] = [], spawn: Spawn = spawnFile): Promise<T> {
  const r = await runInDistro(distro, bundle, [cmd, encodePayload(payload), ...args], '', spawn);
  if (!r.ok) throw new Error(`${distro}: ${r.why}`);
  try { return JSON.parse(r.stdout) as T; } catch { throw new Error(`${distro}: env bundle returned no JSON`); }
}
