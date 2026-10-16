// Daemon wiring (no logic of its own). Started by `agent-spaghetti daemon`.
import { join } from 'node:path';
import { dataDir, declaredActions, emptyLive, liveState, userIntegrationsDir, withGrants, type Disposable, type LiveState, type Snapshot } from '@agent-spaghetti/sdk';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { Store } from './store.ts';
import { Bus } from './bus.ts';
import { loadIntegrations, type Loaded } from './registry.ts';
import { discoverEnvironments, type EnvEntry } from './env/discover.ts';
import { extraHostsFromEnv } from './env/hosts.ts';
import { loadBundle } from './env/wsl.ts';
import { runScan } from './scan.ts';
import { startDaemon } from './daemon.ts';
import { loadOrCreateToken, writeDiscovery } from './config.ts';
import { Settings } from './settings.ts';
import { onEnv } from './dispatch.ts';
import { startObservers } from './observers.ts';
import { Consent } from './consent.ts';
import { handlers, type Services } from './ops.ts';

const DAY = 86400000;
export interface DaemonOpts {
  observe?: boolean; scanOnStart?: boolean;                                   // both on by default
  discover?: (extraHosts: string[]) => Promise<EnvEntry[]>;                  // tests replace the machine
}
/** The first scan (on by default) also starts live observation. */
export async function runDaemon(env: NodeJS.ProcessEnv = process.env, o: DaemonOpts = {}) {
  const discover = o.discover ?? ((extraHosts: string[]) => discoverEnvironments({ extraHosts }));
  const dir = dataDir(env);
  const store = new Store(join(dir, 'store.db'));
  const bus = new Bus(store);
  const settings = new Settings(store);
  const prune = () => store.pruneEvents(Date.now() - settings.get('events.retentionDays') * DAY);
  prune();
  const pruneTimer = setInterval(prune, DAY); pruneTimer.unref();

  // Live state starts now: observers report what is running when they start.
  let live: LiveState = { ...emptyLive(), lastEventId: store.lastEventId() };
  bus.subscribe(e => { live = liveState([e], live); });

  const consent = new Consent(bus);
  const load = () => loadIntegrations(BUILTINS, userIntegrationsDir(dir));
  let loaded: Loaded = await load();
  let entries: EnvEntry[] = [];
  let observers: Disposable | null = null;
  const ctx = async () => ({
    integrations: loaded.integrations.filter(i => !settings.get('disabled').includes(i.manifest.id)),
    grants: settings.grants(), extraHosts: [...extraHostsFromEnv(env), ...settings.get('llmHosts')], bundle: await loadBundle(),
  });
  let rescan: NodeJS.Timeout | undefined;
  /** Third-party asks from a scan become questions; an answer is a lasting grant, then a rescan picks it up. */
  const ask = (pending: Snapshot['pending'] = []) => {
    for (const p of pending) {
      const m = loaded.integrations.find(i => i.manifest.id === p.subject)?.manifest;
      const why = (m && declaredActions(m).find(d => d.action === p.action && d.resource === p.resource)?.why) ?? 'requested by the integration';
      void consent.request({ ...p, why, scopes: ['always'] }).then(a => {
        if (a.answer === 'expired') return;
        settings.setGrants(withGrants(settings.grants(), [{ ...p, mode: a.answer === 'granted' ? 'allow' : 'deny', by: 'user', ts: Date.now() }]));
        clearTimeout(rescan); rescan = setTimeout(() => void handlers.scan({}, services), 2000);   // several answers → one rescan
      });
    }
  };
  const services: Services = {
    store, bus, settings, consent, loaded: () => loaded, live: () => live,
    shutdown: () => void close().then(() => process.exit(0)),
    async scan(): Promise<Snapshot> {
      loaded = await load();                                   // drop-ins are re-read on every scan
      const c = await ctx();
      entries = await discover(c.extraHosts);
      const snap = await runScan(entries, c.integrations, bus, { ...c, rejected: loaded.rejected });
      ask(snap.pending);
      if (o.observe !== false) {
        observers?.dispose();
        observers = startObservers(entries, c.integrations, { ...c, backendPollMs: settings.get('observe.backendPollMs'), sessionPollMs: settings.get('observe.sessionPollMs') },
          (envId, e) => bus.emit({ ts: Date.now(), envId, ...e }));
      }
      return snap;
    },
    async onEnvs(cmd, args, envIds) {
      if (!entries.length) entries = await discover((await ctx()).extraHosts);
      const c = await ctx();
      const targets = envIds ? envIds.map(id => entries.find(e => e.status.id === id) ?? { status: { id, state: 'error' as const, why: 'unknown environment' } })
        : entries.filter(e => e.status.state === 'running');
      return Promise.all(targets.map(async e => {
        try { return { envId: e.status.id, result: await onEnv(e, c, cmd, args) }; }
        catch (err) { return { envId: e.status.id, error: (err as Error).message }; }
      }));
    },
  };
  const server = await startDaemon({ services, token: loadOrCreateToken(dir), port: Number(env.AGENT_SPAGHETTI_PORT ?? 0) });
  const removeDiscovery = writeDiscovery(dir, server.port);
  ask(store.loadSnapshot<Snapshot>('scan')?.pending);
  const close = async () => { clearTimeout(rescan); observers?.dispose(); clearInterval(pruneTimer); removeDiscovery(); await server.close(); store.close(); };
  if (o.scanOnStart !== false) void Promise.resolve(handlers.scan({}, services)).catch(e => process.stderr.write(`first scan failed: ${(e as Error).message}\n`));
  return { port: server.port, dir, services, close };
}
