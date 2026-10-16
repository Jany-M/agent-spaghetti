// Where an environment may reach local servers. Re-resolved on every call (addresses change).
import { readFile } from 'node:fs/promises';
import type { EnvKind } from '@agent-spaghetti/sdk';

/** /proc/net/route stores IPv4 addresses as little-endian hex. */
export const hexToIp = (hex: string) => { const n = parseInt(hex, 16); return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join('.'); };
/** Default gateway from /proc/net/route (little-endian hex). In WSL this is the Windows host. */
export function parseDefaultGateway(route: string): string | null {
  for (const line of route.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === '00000000' && f[2] && f[2] !== '00000000') return hexToIp(f[2]);
  }
  return null;
}
export async function hostCandidates(kind: EnvKind, extra: string[]): Promise<string[]> {
  const out = ['127.0.0.1'];
  if (kind === 'wsl' || kind === 'linux') {
    const gw = parseDefaultGateway(await readFile('/proc/net/route', 'utf8').catch(() => ''));
    if (gw) out.push(gw);
  }
  return [...new Set([...out, ...extra.filter(Boolean)])];
}
/** LLM_HOSTS (space/comma separated): the same variable the OpenClaw pack already used. */
export const extraHostsFromEnv = (e: NodeJS.ProcessEnv = process.env) => (e.LLM_HOSTS ?? '').split(/[\s,]+/).filter(Boolean);
