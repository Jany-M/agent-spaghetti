// The generic manifest interpreter (ADR 0004 + ADR 0008). Order: installed apps → processes → PATH → default paths.
// Endpoints: env override → ports the tool's processes listen on → manifest default, on every host candidate.
import type { BackendInfo, Ctx, Detection, Environment, Install, Inspection, Integration, Inventory, Manifest } from '@agent-spaghetti/sdk';
import { firstNumber, levelsOf, parseJson, pick, samePath, wildcard, type Engines } from '@agent-spaghetti/sdk';

type Detect = NonNullable<Manifest['detect']>;
export const ENGINES: Engines = { openai: false, acp: false };   // flipped by the phase that adds each run engine
const PROBE_MS = 2500, EXEC_MS = 10000, DEFAULT_VERSION = /(\d+\.\d+\.\d+)/;
export const platformOf = (k: Environment['kind']) => (k === 'windows' ? 'windows' : k === 'macos' ? 'macos' : 'linux');
const pathsFor = (p: Detect['paths'], k: Environment['kind']) => (Array.isArray(p) ? p : p?.[platformOf(k)] ?? []);
const exeName = (n: string) => n.replace(/\.exe$/i, '');
export const httpGet = (env: Environment, url: string) => env.http({ url, timeoutMs: PROBE_MS });

async function findInstalls(env: Environment, d: Detect, inv: Inventory): Promise<Install[]> {
  const out: Install[] = [];
  const add = (x: Install) => {
    if (!x.path && x.via !== 'process') return;
    if (x.path && out.some(o => o.path && samePath(o.path, x.path!, env.kind))) return;
    out.push(x);
  };
  for (const a of inv.installed) if (d.installed?.some(p => wildcard(p, a.name))) add({ path: a.location, version: a.version, via: 'installed' });
  for (const p of inv.processes) if (d.process?.some(n => wildcard(exeName(n), p.name))) add({ path: p.path, via: 'process', pid: p.pid });
  for (const b of d.bin ?? []) add({ path: (await env.which(b)) ?? undefined, via: 'bin' });
  for (const g of pathsFor(d.paths, env.kind)) add({ path: (await env.glob(g)) ?? undefined, via: 'path' });
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
async function reach(env: Environment, d: Detect, inv: Inventory, installs: Install[]) {
  for (const endpoint of endpointsToTry(d, inv, installs, await env.hostCandidates())) {
    const r = await httpGet(env, endpoint + d.http!.path);
    if (r?.status === 200 && parseJson(r.body) !== undefined) return { endpoint, body: r.body };
  }
  return null;
}
async function readVersion(env: Environment, v: Detect['version'], installs: Install[], body?: string) {
  if (!v) return undefined;
  if ('from' in v) return installs.find(i => i.version)?.version;
  if ('args' in v) {
    const exe = installs.find(i => i.path && i.via !== 'installed')?.path;   // an executable, never an install folder
    if (!exe) return undefined;
    const r = await env.exec(exe, v.args, { timeoutMs: EXEC_MS });
    return r.code === 0 ? new RegExp(v.regex ?? DEFAULT_VERSION.source).exec(r.stdout + r.stderr)?.[1] : undefined;
  }
  const text = 'file' in v ? await env.glob(v.file).then(p => (p ? env.readFile(p) : null)) : body;
  const val = pick(parseJson(text), v.json);
  return typeof val === 'string' ? val : undefined;
}
export async function listModels(env: Environment, m: Manifest, hit: { endpoint: string; body: string }): Promise<BackendInfo[]> {
  const spec = m.models!;
  const body = spec.path ? (await httpGet(env, hit.endpoint + spec.path))?.body : hit.body;
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
function explain(m: Manifest, installs: Install[], hit: unknown, backends: BackendInfo[], inv: Inventory): Pick<Detection, 'connectable' | 'why'> {
  const partial = inv.partial.length ? ` (partial scan: ${inv.partial.join(', ')})` : '';
  if (m.detect?.http && !hit) return { connectable: 'needs-setup', why: 'installed, server not running' + partial };
  if (m.models) return { connectable: 'yes', why: backends.length ? `${backends.length} model(s) loaded` : 'server up, no model loaded' };
  if (m.speaks?.mcpClient || m.speaks?.agentPlugins) return { connectable: 'needs-setup', why: 'can connect to agent-spaghetti once its MCP server and plugin exist (Phase 3)' };
  return { connectable: 'yes', why: installs.length > 1 ? `${installs.length} installs` : installs.some(i => i.via === 'process') ? 'running' : 'installed' };
}

export async function inspect(i: Integration, env: Environment, ctx: Ctx): Promise<Inspection | null> {
  const m = i.manifest;
  if (m.platforms && !m.platforms.includes(platformOf(env.kind))) return null;
  const d = m.detect ?? {};
  const installs = await findInstalls(env, d, ctx.inventory);
  const hit = d.http ? await reach(env, d, ctx.inventory, installs) : null;
  if (!installs.length && !hit) return null;
  const backends = m.models && hit ? await listModels(env, m, hit) : [];
  const detection: Detection = {
    integration: m.id, name: m.name, envId: env.id, installs, endpoint: hit?.endpoint,
    version: await readVersion(env, d.version, installs, hit?.body), levels: levelsOf(i, ENGINES), cost: m.cost ?? 'unknown',
    ...explain(m, installs, hit, backends, ctx.inventory),
  };
  const base: Inspection = { detection, agents: [], backends };
  return i.module?.inspect ? i.module.inspect(env, base, ctx) : base;
}
