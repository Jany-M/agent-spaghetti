// Daemon wiring (no logic of its own). Started by `agent-spaghetti daemon`.
import { join } from 'node:path';
import { dataDir, declaredActions, emptyLive, liveState, userIntegrationsDir, withGrants, type Disposable, type LiveState, type RunRequest, type Snapshot } from '@agent-spaghetti/sdk';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { Store } from './store.ts';
import { Bus } from './bus.ts';
import { loadIntegrations, type Loaded } from './registry.ts';
import { discoverEnvironments, type EnvEntry } from './env/discover.ts';
import { extraHostsFromEnv } from './env/hosts.ts';
import { loadBundle, prepared, writeDistroFile } from './env/wsl.ts';
import { runScan } from './scan.ts';
import { startDaemon } from './daemon.ts';
import { loadOrCreateToken, writeDiscovery } from './config.ts';
import { Settings } from './settings.ts';
import { onEnv, runOnEnv } from './dispatch.ts';
import { startObservers } from './observers.ts';
import { Consent } from './consent.ts';
import { handlers, type Services } from './ops.ts';
import { CONNECT_LABELS, connectionPlan } from './connections.ts';
import { Ledger } from './ledger.ts';
import { Runner } from './runner.ts';
import { Dispatcher } from './dispatcher.ts';
import { fileURLToPath } from 'node:url';

/** How a client on the host runs agent-spaghetti (Agent Plugins need a bare command: node from PATH). */
const HOST_CLI = { command: 'node', args: [fileURLToPath(new URL('../../cli/src/index.ts', import.meta.url))] };

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
  const settings = new Settings(store, () => loaded.integrations);
  const prune = () => store.pruneEvents(Date.now() - settings.get('events.retentionDays') * DAY);
  prune();
  const pruneTimer = setInterval(prune, DAY); pruneTimer.unref();

  // Live state starts now: observers report what is running when they start.
  let live: LiveState = { ...emptyLive(), lastEventId: store.lastEventId() };
  bus.subscribe(e => { live = liveState([e], live); });

  const consent = new Consent(bus);
  const ledger = new Ledger(store);
  ledger.abandonRunning();                                    // runs a previous daemon left behind
  const token = loadOrCreateToken(dir);
  const load = () => loadIntegrations(BUILTINS, userIntegrationsDir(dir));
  let loaded: Loaded = await load();
  let entries: EnvEntry[] = [];
  let observers: Disposable | null = null;
  const ctx = async () => ({
    integrations: loaded.integrations.filter(i => !settings.get('disabled').includes(i.manifest.id)),
    grants: settings.grants(), extraHosts: [...extraHostsFromEnv(env), ...settings.get('llmHosts')], bundle: await loadBundle(),
  });
  let rescan: NodeJS.Timeout | undefined;
  const rescanSoon = () => { clearTimeout(rescan); rescan = setTimeout(() => void services.scan().catch(() => {}), 3000); };
  /** Third-party asks from a scan become questions; an answer is a lasting grant, then a rescan picks it up. */
  const ask = (pending: Snapshot['pending'] = []) => {
    for (const p of pending) {
      const m = loaded.integrations.find(i => i.manifest.id === p.subject)?.manifest;
      const why = (m && declaredActions(m).find(d => d.action === p.action && d.resource === p.resource)?.why) ?? 'requested by the integration';
      void consent.request({ ...p, why, scopes: ['always'] }).then(a => {
        if (a.answer === 'expired') return;
        settings.setGrants(withGrants(settings.grants(), [{ ...p, mode: a.answer === 'granted' ? 'allow' : 'deny', by: 'user', ts: Date.now() }]));
        rescanSoon();                                            // several answers → one rescan
      });
    }
  };
  const host = () => entries.find(e => e.env)?.env ?? null;
  const runner: Runner = new Runner({ bus, consent, ledger, settings, resultsDir: join(dir, 'results'), host, snapshot: () => store.loadSnapshot<Snapshot>('scan'),
    integrations: () => loaded.integrations.filter(i => !settings.get('disabled').includes(i.manifest.id)),
    route: (source, req): Promise<RunRequest> => dispatcher.route(source, req),
    async *runOn(envId, id, req, ro) {
      const e = entries.find(x => x.status.id === envId);
      if (!e) throw new Error(`environment ${envId} is gone (rescan)`);
      yield* runOnEnv(e, await ctx(), id, req, ro);
    } });
  const dispatcher = new Dispatcher({ runner, settings, bus, ledger });
  const watchdog = dispatcher.watch();
  const hubFiles = new Map<string, string>();
  /** Running distros reach the daemon on the Windows side of their network: listen there and tell them where (hub.json, user-only). */
  const shareWithDistros = async () => {
    for (const e of entries.filter(e => e.distro && e.status.state === 'running')) {
      const p = prepared(e.distro!);
      if (!p?.gateway || !(await server.listenOn(p.gateway))) continue;
      const json = JSON.stringify({ host: p.gateway, port: server.port, token });
      if (hubFiles.get(e.distro!) !== json && await writeDistroFile(e.distro!, 'hub.json', json)) hubFiles.set(e.distro!, json);
    }
  };
  let scanning: Promise<Snapshot> | null = null;
  async function fullScan(): Promise<Snapshot> {
    loaded = await load();                                   // drop-ins are re-read on every scan
    const c = await ctx();
    entries = await discover(c.extraHosts);
    const snap = await runScan(entries, c.integrations, bus, { ...c, rejected: loaded.rejected });
    store.saveSnapshot('scan', snap);
    ask(snap.pending);
    await shareWithDistros();
    if (o.observe !== false) {
      observers?.dispose();
      observers = startObservers(entries, c.integrations, { ...c, toolPollMs: settings.get('observe.toolPollMs'), sessionPollMs: settings.get('observe.sessionPollMs') },
        (envId, e) => bus.emit({ ts: Date.now(), envId, ...e }));
    }
    await applyConnections(snap);
    return snap;
  }
  // Connection preferences (ADR 0009). Session connections live in kv until undone: on shutdown, or at the next start after a crash.
  const SESSION = 'connect.session';
  const session = () => store.getKv<string[]>(SESSION) ?? [];
  const setSession = (ids: string[]) => store.setKv(SESSION, [...new Set(ids)]);
  const leftover = new Set(session());                       // a crash left these connected
  const asked = new Set<string>();
  const connect = (id: string, on: boolean) => Promise.resolve(handlers.connect({ integration: id, on }, services))
    .catch(e => process.stderr.write(`${on ? 'connect' : 'disconnect'} ${id} failed: ${(e as Error).message}\n`));
  async function applyConnections(snap: Snapshot) {
    for (const id of leftover) if (!settings.get('connect.auto').includes(id)) await connect(id, false);
    if (leftover.size) { leftover.clear(); setSession([]); }
    const now = store.loadSnapshot<Snapshot>('scan') ?? snap;   // connect/disconnect above patched it
    for (const step of connectionPlan(now.detections, { auto: settings.get('connect.auto'), never: settings.get('connect.never') }, asked)) {
      if (step.do !== 'ask') { await connect(step.id, step.do === 'connect'); continue; }
      asked.add(step.id);
      const name = now.detections.find(d => d.integration === step.id)?.name ?? step.id;
      void consent.request({ subject: step.id, action: 'config', resource: 'agent-spaghetti MCP server', scopes: ['once', 'always'], labels: { ...CONNECT_LABELS, title: `Connect ${name} to agent-spaghetti?` },
        why: `${name} was found. Connected, it can hand tasks to your other AI tools through agent-spaghetti (each paid one still asks first).` }).then(async a => {
        if (a.answer === 'expired') return;                      // ask again at the next start
        const list = a.answer === 'denied' ? 'connect.never' : a.scope === 'always' ? 'connect.auto' : null;
        if (list) settings.set(list, [...settings.get(list).filter(x => x !== step.id), step.id]);
        if (a.answer === 'granted') { if (a.scope === 'once') setSession([...session(), step.id]); await connect(step.id, true); }
      });
    }
  }
  const services: Services = {
    store, bus, settings, consent, ledger, runner, host, loaded: () => loaded, live: () => live,
    cli: envId => {
      const e = entries.find(x => x.status.id === envId);
      const p = e?.distro ? prepared(e.distro) : null;
      return e?.env ? HOST_CLI : p ? { command: p.node, args: [p.bundlePath] } : null;
    },
    shutdown: () => void close().then(() => process.exit(0)),
    scan: () => (scanning ??= fullScan().finally(() => { scanning = null; })),   // one scan at a time; callers share it
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
  const server = await startDaemon({ services, token, port: Number(env.AGENT_SPAGHETTI_PORT ?? 0) });
  const removeDiscovery = writeDiscovery(dir, server.port);
  ask(store.loadSnapshot<Snapshot>('scan')?.pending);
  // Status stays current by itself: a tool starting or stopping triggers a rescan, and a full rescan runs every `scan.everyMin`.
  bus.subscribe(e => { if (e.type === 'tool.changed' && e.data.changed) rescanSoon(); });
  const autoScan = setInterval(() => {
    const every = settings.get('scan.everyMin') * 60000, last = store.loadSnapshot<Snapshot>('scan')?.ts ?? 0;
    if (every > 0 && Date.now() - last >= every) void services.scan().catch(() => {});
  }, 60000);
  autoScan.unref();
  const close = async () => {
    for (const id of session()) await connect(id, false);    // "Connect for this session" ends here
    setSession([]);
    clearTimeout(rescan); clearInterval(autoScan); observers?.dispose(); watchdog.dispose(); clearInterval(pruneTimer); removeDiscovery(); await server.close(); store.close(); };
  if (o.scanOnStart !== false) void services.scan().catch(e => process.stderr.write(`first scan failed: ${(e as Error).message}\n`));
  return { port: server.port, dir, services, close };
}
