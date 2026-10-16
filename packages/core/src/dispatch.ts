// Route a per-environment command: the host env runs it in-process, a running distro through the env bundle.
import type { Grant, Integration, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { parseJson } from '@agent-spaghetti/sdk';
import { runEnvCommand, runHere, type EnvCommand, type EnvResults } from './actions.ts';
import type { EnvEntry } from './env/discover.ts';
import { distroCall, encodePayload, payloadFor, prepareDistro, wslArgs, type Bundle, type Spawn } from './env/wsl.ts';
import { execLines } from './proc.ts';

export interface EnvCtx { integrations: Integration[]; grants?: Grant[]; extraHosts?: string[]; bundle?: Bundle | null; spawn?: Spawn }
export function onEnv<C extends EnvCommand>(e: EnvEntry, c: EnvCtx, cmd: C, args: string[] = []): Promise<EnvResults[C]> {
  if (e.env) return runEnvCommand(e.env, c.integrations, cmd, args, c.grants ?? []);
  if (!e.distro) return Promise.reject(new Error(`${e.status.id} is ${e.status.state}`));
  return distroCall<EnvResults[C]>(e.distro, c.bundle ?? null, cmd, payloadFor(e.status.id, c), args, c.spawn);
}

/** A delegated run in an environment: in-process on the host; in a distro `env bundle run` streams one RunEvent per line
 *  (request on stdin, never on the command line). */
export async function* runOnEnv(e: EnvEntry, c: EnvCtx, id: string, req: RunRequest, o: { signal: AbortSignal; runId?: number }): AsyncIterable<RunEvent> {
  if (e.env) { yield* runHere(e.env, c.integrations, id, req, c.grants ?? [], o); return; }
  if (!e.distro) throw new Error(`${e.status.id} is ${e.status.state}`);
  const p = await prepareDistro(e.distro, c.bundle ?? null);
  if (!p.ok) throw new Error(p.why);
  const argv = wslArgs(e.distro, [p.node, p.bundlePath, 'run', encodePayload(payloadFor(e.status.id, c)), id]);
  for await (const line of execLines('wsl.exe', argv, { input: JSON.stringify({ req, runId: o.runId }), signal: o.signal })) {
    const ev = parseJson(line) as RunEvent | undefined;
    if (ev?.type) yield ev;
  }
}
