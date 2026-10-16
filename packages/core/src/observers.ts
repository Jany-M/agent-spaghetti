// Daemon side of live observation: the host env in-process, each running distro through `env bundle observe`
// (one long-running child per distro, JSON lines on stdout). Same observeEnv() code in both places.
import type { Disposable, HubEvent, Integration } from '@agent-spaghetti/sdk';
import { parseJson } from '@agent-spaghetti/sdk';
import type { EnvEntry } from './env/discover.ts';
import { encodePayload, payloadFor, prepareDistro, wslArgs, type Bundle } from './env/wsl.ts';
import { observeEnv, type ObserveOpts } from './engine/observe.ts';
import { spawnLines } from './proc.ts';

export type HostEmit = (envId: string, e: Pick<HubEvent, 'type' | 'data' | 'source'>) => void;
export function startObservers(entries: EnvEntry[], integrations: Integration[], o: ObserveOpts & { bundle: Bundle | null; extraHosts: string[] }, emit: HostEmit): Disposable {
  const stops: Array<() => void> = [];
  let disposed = false;
  for (const e of entries) {
    if (e.env) { const d = observeEnv(e.env, integrations, x => emit(e.env!.id, x), o); stops.push(() => d.dispose()); continue; }
    if (!e.distro) continue;
    const envId = e.status.id, distro = e.distro;
    void prepareDistro(distro, o.bundle).then(p => {
      if (!p.ok || disposed) return;
      const payload = payloadFor(envId, { ...o, integrations }, { backendPollMs: o.backendPollMs, sessionPollMs: o.sessionPollMs });
      const child = spawnLines('wsl.exe', wslArgs(distro, [p.node, p.bundlePath, 'observe', encodePayload(payload)]), line => {
        const ev = parseJson(line) as Pick<HubEvent, 'type' | 'data' | 'source'> | undefined;
        if (ev?.type) emit(envId, ev);
      });
      stops.push(child.stop);
      void child.exited.then(code => { if (!disposed) emit(envId, { type: 'env.status', source: 'observer', data: { id: envId, state: 'stopped', why: `observer exited (${code})` } }); });
    });
  }
  return { dispose() { disposed = true; stops.forEach(s => s()); } };
}
