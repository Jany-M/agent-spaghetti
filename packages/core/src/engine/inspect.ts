// The generic manifest interpreter (ADR 0004 + ADR 0008). Order: installed apps → processes → PATH → default paths.
// Endpoints: env override → ports the tool's processes listen on → manifest default, on every host candidate.
import type { BackendInfo, Ctx, Detection, Environment, Install, Inspection, Integration, Inventory, Manifest } from '@agent-spaghetti/sdk';
import { fillEnv, firstNumber, levelsOf, parseJson, parseJsonc, pick, pluginDir, samePath, wildcard, type Engines } from '@agent-spaghetti/sdk';

type Detect = NonNullable<Manifest['detect']>;
export const ENGINES: Engines = { openai: true, acp: false };    // openai: engine/openai.ts (Phase 3); acp arrives in Phase 5
const PROBE_MS = 2500, EXEC_MS = 10000, DEFAULT_VERSION = /(\d+\.\d+\.\d+)/;
export const platformOf = (k: Environment['kind']) => (k === 'windows' ? 'windows' : k === 'macos' ? 'macos' : 'linux');
const pathsFor = (p: Detect['paths'], k: Environment['kind']) => (Array.isArray(p) ? p : p?.[platformOf(k)] ?? []);
const exeName = (n: string) => n.replace(/\.exe$/i, '');
export const httpGet = (env: Environment, url: string, headers?: Record<string, string>) => env.http({ url, headers, timeoutMs: PROBE_MS });

const processInstalls = (d: Detect, inv: Inventory): Install[] =>
  inv.processes.filter(p => d.process?.some(n => wildcard(exeName(n), p.name))
    && !d.processNotIn?.some(f => p.path?.replaceAll('\\', '/').toLowerCase().includes(f.toLowerCase()))).map((p): Install => ({ path: p.path, via: 'process', pid: p.pid }));
async function findInstalls(env: Environment, d: Detect, inv: Inventory): Promise<Install[]> {
  const out: Install[] = [];
  const add = (x: Install) => {
    if (!x.path && x.via !== 'process') return;
    const same = x.path ? out.find(o => o.path && samePath(o.path, x.path!, env.kind)) : undefined;
    if (!same) out.push(x);
    else if (same.via === 'process' && (x.via === 'bin' || x.via === 'path')) same.via = x.via;   // a running program found where the manifest says: it is the program
  };
  for (const a of inv.installed) if (d.installed?.some(p => wildcard(p, a.name))) add({ path: a.location, version: a.version, via: 'installed' });
  for (const x of processInstalls(d, inv)) add(x);
  // bin names and default paths are alternatives for ONE install: the first hit counts (several installs come from the OS list)
  for (const b of d.bin ?? []) { const p = await env.which(b); if (p) { add({ path: p, via: 'bin' }); break; } }
  if (!out.some(i => i.via === 'bin'))
    for (const g of pathsFor(d.paths, env.kind)) { const p = await env.glob(g); if (p) { add({ path: p, via: 'path' }); break; } }
  return out;
}
export function endpointsToTry(d: Detect, inv: Inventory, installs: Install[], hosts: string[]): string[] {
  const urls: string[] = [], ports: number[] = [];
  for (const name of d.env ?? []) {                                    // "host:port", ":port", "http://host:port"
    const v = inv.env[name]; if (!v) continue;
    let u: URL;
    try { u = /^[a-z]+:\/\//i.test(v) ? new URL(v) : new URL(`http://${v.startsWith(':') ? '0.0.0.0' + v : v}`); } catch { continue; }
    if (!u.port) continue;
    if (['0.0.0.0', '[::]', '::'].includes(u.hostname)) ports.push(Number(u.port)); else urls.push(`${u.protocol}//${u.host}`);
  }
  const pids = new Set(installs.map(i => i.pid).filter(Boolean));
  for (const l of inv.listening) if (l.pid && pids.has(l.pid)) ports.push(l.port);
  if (d.http?.port) ports.push(d.http.port);
  return [...new Set([...urls, ...[...new Set(ports)].flatMap(p => hosts.map(h => `http://${h}:${p}`))])];
}
type Hit = { endpoint: string; body: string; headers?: Record<string, string> };
/** The tool's server: a hosted API at its url (once its env vars are set), else the first local endpoint that answers. */
async function reach(env: Environment, m: Manifest, inv: Inventory, installs: Install[]): Promise<Hit | null> {
  const d = m.detect!, headers = fillEnv(m.speaks?.openai?.headers, inv.env);
  if (!headers) return null;
  for (const endpoint of d.http!.url ? [d.http!.url] : endpointsToTry(d, inv, installs, await env.hostCandidates())) {
    const r = await httpGet(env, endpoint + d.http!.path, headers);
    if (r?.status === 200 && parseJson(r.body) !== undefined) return { endpoint, body: r.body, headers };
  }
  return null;
}
async function readVersion(env: Environment, v: Detect['version'], installs: Install[], body?: string) {
  return (v && !('from' in v) ? await readDeclaredVersion(env, v, installs, body) : undefined) ?? installs.find(i => i.version)?.version;
}
async function readDeclaredVersion(env: Environment, v: Exclude<Detect['version'], undefined | { from: 'installed' }>, installs: Install[], body?: string) {
  if ('args' in v) {
    const exe = installs.find(i => i.path && (i.via === 'bin' || i.via === 'path'))?.path;   // only declared binaries (ADR 0004 trust)
    if (!exe) return undefined;
    const r = await env.exec(exe, v.args, { timeoutMs: EXEC_MS });
    return r.code === 0 ? new RegExp(v.regex ?? DEFAULT_VERSION.source).exec(r.stdout + r.stderr)?.[1] : undefined;
  }
  const text = 'file' in v ? await env.glob(v.file).then(p => (p ? env.readFile(p) : null)) : body;
  const val = pick(parseJson(text), v.json);
  return typeof val === 'string' ? val : undefined;
}
export async function listModels(env: Environment, m: Manifest, hit: Hit): Promise<BackendInfo[]> {
  const spec = m.models!;
  const body = spec.path ? (await httpGet(env, hit.endpoint + spec.path, hit.headers))?.body : hit.body;
  const list = pick(parseJson(body), spec.list);
  if (!Array.isArray(list)) return [];
  return list
    .filter(x => (spec.filter ?? []).every(f => f.in.includes(pick(x, f.field) as string | boolean)))
    .flatMap(x => {
      const model = pick(x, spec.id);
      return typeof model === 'string' && model
        ? [{ id: `${m.id}:${model}`, integration: m.id, model, envId: env.id, endpoint: hit.endpoint,
             contextLength: firstNumber(x, spec.context), reachableFrom: [env.id] }]
        : [];
    });
}
/** Whether the client already has agent-spaghetti (its plugin folder, the entry in its MCP config, or a config its CLI writes naming it). Read-only. */
export async function isConnected(env: Environment, m: Manifest): Promise<boolean> {
  const s = m.speaks;
  if (s?.agentPlugins && await env.glob(`${pluginDir(s.agentPlugins.dir)}/mcp.json`)) return true;
  if (!s?.mcpClient) return !!s?.mcpCli?.config && !!(await env.readFile(s.mcpCli.config))?.includes('agent-spaghetti');
  const servers = pick(parseJsonc(await env.readFile(s.mcpClient.config)), s.mcpClient.key);
  return !!servers && typeof servers === 'object' && 'agent-spaghetti' in servers;
}
function explain(m: Manifest, installs: Install[], hit: unknown, backends: BackendInfo[], inv: Inventory, connected: boolean | undefined): Pick<Detection, 'connectable' | 'why'> {
  const partial = inv.partial.length ? ` (partial scan: ${inv.partial.join(', ')})` : '';
  if (m.detect?.http && !hit) return { connectable: 'needs-setup', why: 'installed, server not running' + partial };
  if (m.models) return { connectable: 'yes', why: backends.length ? `${backends.length} model(s) loaded` : 'server up, no model loaded' };
  if (connected !== undefined) return { connectable: 'yes', why: connected ? 'connected to agent-spaghetti' : 'not connected to agent-spaghetti' };
  return { connectable: 'yes', why: installs.length > 1 ? `${installs.length} installs` : hit || installs.some(i => i.via === 'process') ? 'running' : 'installed' };
}

/** Cheap liveness for the live observer: a matching process, or the tool's server answering (+ its models). No version, no module code.
 *  null = nothing observable (no `process`, no `http` in the manifest). */
export async function probeLive(env: Environment, m: Manifest, inv: Inventory): Promise<{ running: boolean; endpoint?: string; backends: BackendInfo[] } | null> {
  const d = m.detect ?? {};
  if ((!d.http || d.http.url) && !d.process?.length) return null;          // hosted APIs: the scan only, never every few seconds
  if (m.platforms && !m.platforms.includes(platformOf(env.kind))) return null;
  const procs = processInstalls(d, inv);
  const hit = d.http && !d.http.url ? await reach(env, m, inv, procs) : null;
  return { running: !!hit || procs.length > 0, endpoint: hit?.endpoint, backends: m.models && hit ? await listModels(env, m, hit) : [] };
}

export async function inspect(i: Integration, env: Environment, ctx: Ctx): Promise<Inspection | null> {
  const m = i.manifest;
  if (m.platforms && !m.platforms.includes(platformOf(env.kind))) return null;
  const d = m.detect ?? {};
  const installs = await findInstalls(env, d, ctx.inventory);
  const hit = d.http ? await reach(env, m, ctx.inventory, installs) : null;
  if (!installs.length && !hit) return null;
  const backends = m.models && hit ? await listModels(env, m, hit) : [];
  const connected = m.speaks?.mcpClient || m.speaks?.agentPlugins || m.speaks?.mcpCli ? await isConnected(env, m) : undefined;
  const detection: Detection = {
    integration: m.id, name: m.name, envId: env.id, installs, endpoint: hit?.endpoint,
    version: await readVersion(env, d.version, installs, hit?.body), levels: levelsOf(i, ENGINES), cost: m.cost ?? 'unknown',
    ...explain(m, installs, hit, backends, ctx.inventory, connected), ...(connected === undefined ? {} : { connected }),
  };
  const base: Inspection = { detection, agents: [], backends };
  return i.module?.inspect ? i.module.inspect(env, base, ctx) : base;
}
