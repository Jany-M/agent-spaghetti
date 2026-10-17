// The machine-specific part of the OpenClaw config patch. The model choice is the setting `openclaw.model`:
//   auto (default)       keep the current primary model while its endpoint answers (or has none to probe); else use the first
//                        local server with a loaded model, and if none is found keep it anyway with a warning (not started yet?)
//   keep                 never touch provider/model
//   <server>:<model>     use that loaded model (e.g. lmstudio:<loaded model>), from `agent-spaghetti targets`
// Detection is the engine's (injected): loaded models only. Reads only non-secret config paths via `openclaw config get`.
import type { Environment, LocalModel } from '@agent-spaghetti/sdk';
import { openclawJson } from '../cli.ts';
import { splitModelRef } from '../index.ts';
import { MCP_NAME } from './mcp.ts';

/** Seconds one model request may take (queue wait + long prompts on a single-slot local server). */
export const TIMEOUT_SECONDS = 900;
export interface ConfigDeps { env: Environment; exe: string }
export interface PatchDeps extends ConfigDeps { model: string; detect(): Promise<LocalModel[]>; say(s: string): void }   // detect: best first
/** Provider id OpenClaw gets for a detected backend (same ids the Python version used). */
export const providerIdFor = (integration: string) => (integration === 'lmstudio' ? 'lmstudio' : `local-${integration}`);

export type Provider = { baseUrl?: string; timeoutSeconds?: number; models?: Array<Record<string, unknown>> };
export const get = async (d: ConfigDeps, path: string) => openclawJson(d.env, d.exe, ['config', 'get', path]);
/** Only baseUrl and models (ids, names, windows) are read; apiKey and headers never are. */
export async function providers(d: ConfigDeps): Promise<Record<string, Provider>> {
  const ids = Object.keys((await get(d, 'models.providers') as object) ?? {});
  const out: Record<string, Provider> = {};
  for (const id of ids) {
    const p = (await get(d, `models.providers.${id}`) ?? {}) as Record<string, unknown>;
    out[id] = { baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : undefined, timeoutSeconds: typeof p.timeoutSeconds === 'number' ? p.timeoutSeconds : undefined,
      models: Array.isArray(p.models) ? p.models.map((m: any) => ({ id: m?.id, name: m?.name, contextWindow: m?.contextWindow, maxTokens: m?.maxTokens })) : [] };
  }
  return out;
}
export async function endpointOk(d: ConfigDeps, p?: Provider): Promise<boolean> {
  if (!p?.baseUrl) return true;                      // managed / hosted / built-in: nothing to probe, trust it
  return (await d.env.http({ url: p.baseUrl.replace(/\/$/, '') + '/models', timeoutMs: 5000 })) !== null;   // any HTTP answer = up
}
function providerPatch(existing: Provider | undefined, det: LocalModel, pid: string) {
  const models = [...(existing?.models ?? [])];
  const ctx = det.contextLength ?? 32768;
  const ent = models.find(m => m.id === det.model);
  if (!ent) models.push({ id: det.model, name: det.model, contextWindow: ctx, maxTokens: 8192 });
  else if (det.contextLength && ent.contextWindow !== ctx) ent.contextWindow = ctx;   // declared window must match what the server loaded
  const p: Record<string, unknown> = { baseUrl: det.base, timeoutSeconds: TIMEOUT_SECONDS, models };
  if (!existing) Object.assign(p, { apiKey: 'local', api: 'openai-completions' });   // local servers take any key
  return { pid, model: det.model, p };
}

/** agents.defaults.model is a string or { primary }. */
export async function primaryModel(d: ConfigDeps): Promise<string | undefined> {
  const dm = await get(d, 'agents.defaults.model');
  return typeof dm === 'string' ? dm : typeof (dm as any)?.primary === 'string' ? (dm as any).primary : undefined;
}
export async function buildPatch(d: PatchDeps): Promise<Record<string, any>> {
  const mode = d.model.trim() || 'auto';
  const prov = await providers(d);
  const primary = await primaryModel(d);
  const cur = splitModelRef(primary, Object.keys(prov));
  const keep = () => {
    if (primary && cur.provider && prov[cur.provider]) return { pid: cur.provider, model: cur.model, p: { timeoutSeconds: TIMEOUT_SECONDS } as Record<string, unknown> };
    d.say('no primary model configured: nothing to keep'); return undefined;
  };
  let choice: { pid: string; model?: string; p: Record<string, unknown> } | undefined;
  if (mode === 'keep') choice = keep();
  else if (mode === 'auto') {
    if (primary && (await endpointOk(d, prov[cur.provider!]))) {
      d.say(`keeping current primary model ${primary} (${prov[cur.provider!]?.baseUrl ? 'endpoint answers' : 'no local endpoint to probe'})`);
      choice = keep();
    } else {
      const det = (await d.detect())[0];   // already ranked by the engine (sdk/routing.ts)
      if (det) {
        const pid = providerIdFor(det.integration);
        choice = providerPatch(prov[pid], det, pid);
        d.say(`primary endpoint was down; re-detected: ${pid}/${det.model} @ ${det.base}`);
      } else if (primary && cur.provider && prov[cur.provider]) {
        d.say(`WARNING: the endpoint of ${primary} does not answer and no local LLM server with a loaded model was found; keeping it (start your LLM server, or set llmHosts)`);
        choice = keep();
      } else throw new Error('no local LLM server with a loaded model found (LM Studio, Ollama, llama.cpp, vLLM). Start one and load a model, or set llmHosts.');
    }
  } else {
    const [integration, ...rest] = mode.split(':'), model = rest.join(':');
    const det = (await d.detect()).find(x => x.integration === integration && x.model === model);
    if (!det) throw new Error(`openclaw.model is ${mode}, but ${integration} has no loaded model ${model || '(none given)'} (see: agent-spaghetti targets)`);
    const pid = providerIdFor(det.integration);
    choice = providerPatch(prov[pid], det, pid);
    d.say(`using ${pid}/${det.model} @ ${det.base}`);
  }
  const patch: Record<string, any> = {};
  if (choice) {
    patch.models = { providers: { [choice.pid]: choice.p } };
    if ('models' in choice.p || !primary) patch.agents = { defaults: { model: { primary: `${choice.pid}/${choice.model}` } } };
  }
  const servers = Object.keys((await get(d, 'mcp.servers') as object) ?? {}).filter(n => n !== MCP_NAME);   // names only: park every MCP server but ours
  if (servers.length) patch.mcp = { servers: Object.fromEntries(servers.map(n => [n, { enabled: false }])) };
  return patch;
}
/** Fallback when OpenClaw's schema rejects the provider block: keep only MCP parking and the rest. */
export function stripProvider(patch: Record<string, any>): Record<string, any> {
  const p = structuredClone(patch);
  delete p.models; if (p.agents) delete p.agents.defaults;
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v && Object.keys(v).length));
}
