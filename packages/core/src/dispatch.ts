// Route a per-environment command: the host env runs it in-process, a running distro through the env bundle.
import type { Grant, Integration } from '@agent-spaghetti/sdk';
import { runEnvCommand, type EnvCommand, type EnvResults } from './actions.ts';
import type { EnvEntry } from './env/discover.ts';
import { distroCall, payloadFor, type Bundle, type Spawn } from './env/wsl.ts';

export interface EnvCtx { integrations: Integration[]; grants?: Grant[]; extraHosts?: string[]; bundle?: Bundle | null; spawn?: Spawn }
export function onEnv<C extends EnvCommand>(e: EnvEntry, c: EnvCtx, cmd: C, args: string[] = []): Promise<EnvResults[C]> {
  if (e.env) return runEnvCommand(e.env, c.integrations, cmd, args, c.grants ?? []);
  if (!e.distro) return Promise.reject(new Error(`${e.status.id} is ${e.status.state}`));
  return distroCall<EnvResults[C]>(e.distro, c.bundle ?? null, cmd, payloadFor(e.status.id, c), args, c.spawn);
}
