// Port of scripts/lib/orch_config.py: the machine-specific part of the OpenClaw config patch. Modes (PROVIDER_MODE):
//   auto (default) keep the current primary model while its endpoint answers (or has none to probe); else re-detect,
//                  and if nothing is found keep it anyway with a warning (the server may just not be started yet)
//   keep           never touch provider/model;  follow  always use what a local server has loaded right now
//   manual         PROVIDER_ID / BASE_URL / MODEL_ID (+ CONTEXT_WINDOW, MAX_TOKENS, API_KEY)
// Detection is the engine's (injected): loaded models only. Reads only non-secret config paths via `openclaw config get`.
import type { BackendInfo, Environment } from '@agent-spaghetti/sdk';
import { openclawJson } from '../cli.ts';
import { splitModelRef } from '../index.ts';
import { MCP_NAME } from './mcp.ts';

export interface Detected { integration: string; base: string; model: string; contextLength?: number }
export interface ConfigDeps { env: Environment; exe: string }
export interface PatchDeps extends ConfigDeps { vars: NodeJS.ProcessEnv; detect(): Promise<Detected | null>; say(s: string): void }
/** Provider id OpenClaw gets for a detected backend (same ids the Python version used). */
export const providerIdFor = (integration: string) => (integration === 'lmstudio' ? 'lmstudio' : `local-${integration}`);
/** Preference order when several local servers answer. */
export const BACKEND_ORDER = ['lmstudio', 'ollama', 'llamacpp', 'vllm'];
export function pickBackend(backends: BackendInfo[], baseOf: (integration: string) => string | undefined): Detected | null {
  const b = [...backends].filter(b => baseOf(b.integration) !== undefined)
    .sort((x, y) => BACKEND_ORDER.indexOf(x.integration) - BACKEND_ORDER.indexOf(y.integration))[0];
  return b ? { integration: b.integration, base: b.endpoint + baseOf(b.integration)!, model: b.model, contextLength: b.contextLength } : null;
}

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
function providerPatch(d: PatchDeps, existing: Provider | undefined, det: Detected, pid: string, timeout: number, keepModel?: string) {
  const models = [...(existing?.models ?? [])];
  const model = keepModel && keepModel === det.model ? keepModel : det.model;
  const ctx = Number(det.contextLength ?? d.vars.CONTEXT_WINDOW ?? 32768);
  const ent = models.find(m => m.id === model);
  if (!ent) models.push({ id: model, name: model, contextWindow: ctx, maxTokens: Number(d.vars.MAX_TOKENS ?? 8192) });
  else if (det.contextLength && ent.contextWindow !== ctx) ent.contextWindow = ctx;   // declared window must match what the server loaded
  const p: Record<string, unknown> = { baseUrl: det.base, timeoutSeconds: timeout, models };
  if (!existing) Object.assign(p, { apiKey: d.vars.API_KEY ?? 'local', api: 'openai-completions' });
  return { pid, model, p };
}

/** agents.defaults.model is a string or { primary }. */
export async function primaryModel(d: ConfigDeps): Promise<string | undefined> {
  const dm = await get(d, 'agents.defaults.model');
  return typeof dm === 'string' ? dm : typeof (dm as any)?.primary === 'string' ? (dm as any).primary : undefined;
}
export async function buildPatch(d: PatchDeps): Promise<Record<string, any>> {
  const mode = (d.vars.PROVIDER_MODE ?? 'auto').toLowerCase();
  const timeout = Number(d.vars.PROVIDER_TIMEOUT_SECONDS ?? 900);
  const prov = await providers(d);
  const primary = await primaryModel(d);
  let choice: { pid: string; model?: string; p: Record<string, unknown> } | undefined;
  if (mode === 'manual') {
    const { PROVIDER_ID: pid, BASE_URL: base, MODEL_ID: model } = d.vars;
    if (!pid || !base || !model) throw new Error('PROVIDER_MODE=manual needs PROVIDER_ID, BASE_URL and MODEL_ID');
    choice = providerPatch(d, prov[pid], { integration: pid, base, model, contextLength: d.vars.CONTEXT_WINDOW ? Number(d.vars.CONTEXT_WINDOW) : undefined }, pid, timeout);
    d.say(`manual provider: ${pid}/${model} @ ${base}`);
  } else {
    const cur = splitModelRef(primary, Object.keys(prov));
    const needDetect = mode === 'follow' || (mode === 'auto' && (!primary || !(await endpointOk(d, prov[cur.provider!]))));
    const det = needDetect ? await d.detect() : null;
    const keepCurrent = mode === 'keep' || !needDetect || (mode === 'auto' && !det && !!primary && !!prov[cur.provider!]);
    if (needDetect && !det && keepCurrent) d.say(`WARNING: the endpoint of ${primary} does not answer and no other local LLM server with a loaded model was found; keeping it (start your LLM server, or set LLM_HOSTS / PROVIDER_MODE)`);
    if (keepCurrent) {
      if (primary && cur.provider && prov[cur.provider]) {
        if (!needDetect) d.say(`keeping current primary model ${primary} (${prov[cur.provider].baseUrl ? 'endpoint answers' : 'no local endpoint to probe'})`);
        choice = { pid: cur.provider, model: cur.model, p: { timeoutSeconds: timeout } };
      } else if (!primary) d.say('no primary model configured and PROVIDER_MODE=keep: nothing to set');
    } else {
      if (!det) throw new Error('no local LLM server with a loaded model found (LM Studio, Ollama, llama.cpp, vLLM; default ports, running processes, LLM_HOSTS). '
        + 'Start one and load a model, set LLM_HOSTS, or use PROVIDER_MODE=manual.');
      const pid = providerIdFor(det.integration);
      choice = providerPatch(d, prov[pid], det, pid, timeout, mode === 'auto' && cur.provider === pid ? cur.model : undefined);
      d.say(`${mode === 'follow' ? 'following loaded model' : 'primary endpoint was down; re-detected'}: ${pid}/${choice.model} @ ${det.base}`);
    }
  }
  const patch: Record<string, any> = {};
  if (choice) {
    patch.models = { providers: { [choice.pid]: choice.p } };
    if (mode === 'follow' || mode === 'manual' || 'models' in choice.p || !primary) patch.agents = { defaults: { model: { primary: `${choice.pid}/${choice.model}` } } };
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
