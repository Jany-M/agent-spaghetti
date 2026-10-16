// Daemon wiring (no logic of its own). Started by `agent-spaghetti daemon`.
import { join } from 'node:path';
import { dataDir, userIntegrationsDir, type Snapshot } from '@agent-spaghetti/sdk';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { Store } from './store.ts';
import { Bus } from './bus.ts';
import { loadIntegrations, type Loaded } from './registry.ts';
import { discoverEnvironments } from './env/discover.ts';
import { extraHostsFromEnv } from './env/hosts.ts';
import { loadBundle } from './env/wsl.ts';
import { runScan } from './scan.ts';
import { startDaemon } from './daemon.ts';
import { loadOrCreateToken, writeDiscovery } from './config.ts';
import type { Services } from './ops.ts';

export async function runDaemon(env: NodeJS.ProcessEnv = process.env) {
  const dir = dataDir(env);
  const store = new Store(join(dir, 'store.db'));
  const bus = new Bus(store);
  const load = () => loadIntegrations(BUILTINS, userIntegrationsDir(dir));
  let loaded: Loaded = await load();
  const services: Services = {
    store, bus, loaded: () => loaded,
    async scan(): Promise<Snapshot> {
      loaded = await load();                                   // drop-ins are re-read on every scan
      const extraHosts = extraHostsFromEnv(env);
      const pending = loaded.integrations.filter(i => i.source === 'user')
        .map(i => ({ id: i.manifest.id, why: 'pending review (permissions arrive in Phase 1b, ADR 0005)' }));
      return runScan(await discoverEnvironments({ extraHosts }), loaded.integrations.filter(i => i.source === 'builtin'), bus,
        { rejected: [...loaded.rejected, ...pending], bundle: await loadBundle(), extraHosts });
    },
  };
  const server = await startDaemon({ services, token: loadOrCreateToken(dir), port: Number(env.AGENT_SPAGHETTI_PORT ?? 0) });
  const removeDiscovery = writeDiscovery(dir, server.port);
  return { port: server.port, dir, services, close: async () => { removeDiscovery(); await server.close(); store.close(); } };
}
