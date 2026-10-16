import type { EnvStatus, Environment } from '@agent-spaghetti/sdk';
import { currentKind, localEnvironment } from './local.ts';
import { listDistros, type Spawn } from './wsl.ts';
import { spawnFile } from '../proc.ts';

/** Local env (always), plus WSL distros on Windows. Stopped distros are listed, never started. */
export interface EnvEntry { status: EnvStatus; env?: Environment; distro?: string }
export async function discoverEnvironments(o: { extraHosts?: string[]; spawn?: Spawn } = {}): Promise<EnvEntry[]> {
  const env = localEnvironment({ extraHosts: o.extraHosts });
  const out: EnvEntry[] = [{ status: { id: env.id, state: 'running' }, env }];
  if (currentKind() !== 'windows' && !o.spawn) return out;
  for (const d of (await listDistros(o.spawn ?? spawnFile)) ?? []) {
    out.push(d.state === 'running'
      ? { status: { id: `wsl:${d.name}`, state: 'running' }, distro: d.name }
      : { status: { id: `wsl:${d.name}`, state: 'stopped', why: 'not started by scan' } });
  }
  return out;
}
