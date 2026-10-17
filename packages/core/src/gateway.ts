// The model gateway (Phase 3c): an OpenAI-compatible endpoint on 127.0.0.1 for tools that take a custom one, so each tool's
// LLM is chosen here. A gateway key names the tool (the run's source); the model it asks for picks the target (`target:model`,
// a loaded model's id, else its route in `gateway.routes`, else `auto`). Every request is a run: the same permission check and
// question as a hand-off, the same server queue, the same record. Only `model` is rewritten; prompts are never stored.
import { createHash, randomBytes } from 'node:crypto';
import type { Target } from '@agent-spaghetti/sdk';
import { AUTO, parseHop, rankTargets } from '@agent-spaghetti/sdk';
import { openaiForward } from './engine/openai.ts';
import type { Runner } from './runner.ts';
import { serveJson, WRITTEN, type CallCtx, type Server } from './serve.ts';
import type { Settings } from './settings.ts';
import type { Store } from './store.ts';

export const KEY_PREFIX = 'sk-agent-spaghetti-';
const KEYS = 'gateway.keys';
const PATHS = ['/v1/chat/completions', '/v1/completions', '/v1/embeddings'];
type Keys = Record<string, { hash: string; ts: number }>;
const hash = (k: string) => createHash('sha256').update(k).digest('hex');
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const ERROR_TYPE: Record<number, string> = { 401: 'invalid_api_key', 403: 'permission_denied', 404: 'model_not_found' };

/** Which target serves a request: an explicit `target:model`, a loaded model's id, else the tool's route, else the best-ranked model. */
export function resolveRoute(routes: string[], source: string, requested: string, targets: Target[]): { target: string; model: string } | { error: string } {
  const models = rankTargets(targets.filter(t => t.kind === 'model' && t.models.length));
  const p = parseHop(requested), named = models.find(t => t.id === p.target);
  if (named && p.model && named.models.includes(p.model)) return { target: named.id, model: p.model };
  const owner = models.find(t => t.models.includes(requested));
  if (owner) return { target: owner.id, model: requested };
  const use = routes.find(r => r.startsWith(`${source}=`))?.slice(source.length + 1).trim() || AUTO;
  if (use === AUTO) return models[0] ? { target: models[0].id, model: models[0].models[0] } : { error: 'no model is loaded: start a model server or load a model' };
  const u = parseHop(use), t = models.find(x => x.id === u.target);
  if (!t || (u.model && !t.models.includes(u.model))) return { error: `${source}'s model ${use} is not available now (Tools → ${source} → Model)` };
  return { target: t.id, model: u.model ?? t.models[0] };
}

export class Gateway {
  private d: { settings: Settings; store: Store; runner: Runner };
  private server: Server | null = null;
  private port = 0;
  private readonly session = `gateway-${Date.now()}`;      // "Allow for this job" = until the daemon restarts
  constructor(d: Gateway['d']) { this.d = d; }

  /** Listens on `gateway.port` (0 = off); call after the setting changes. */
  async sync(): Promise<void> {
    const want = this.d.settings.get('gateway.port');
    if (want === this.port && (!!this.server || !want)) return;
    await this.close();
    if (!want) return;
    this.server = await serveJson({ port: want, auth: b => this.who(b), error: (status, message) => ({ error: { message, type: ERROR_TYPE[status] ?? 'server_error' } }),
      routes: [{ method: 'GET', path: '/v1/models', handle: () => this.models() }, ...PATHS.map(path => ({ method: 'POST' as const, path, handle: (i: Record<string, unknown>, c: CallCtx) => this.forward(path, i, c) }))] });
    this.port = want;
  }
  async close() { await this.server?.close(); this.server = null; this.port = 0; }
  status() { return { port: this.server ? this.port : 0, url: this.server ? `http://127.0.0.1:${this.port}/v1` : null, clients: Object.entries(this.keys()).map(([id, k]) => ({ id, since: k.ts })) }; }
  /** A new key for a tool (shown once; only its hash is kept), or none (revoked). */
  key(integration: string, create: boolean): string | null {
    const { [integration]: _, ...rest } = this.keys();
    const key = create ? KEY_PREFIX + randomBytes(24).toString('base64url') : null;
    this.d.store.setKv(KEYS, key ? { ...rest, [integration]: { hash: hash(key), ts: Date.now() } } : rest);
    return key;
  }

  private keys(): Keys { return this.d.store.getKv<Keys>(KEYS) ?? {}; }
  private who(bearer: string): string | null { const h = hash(bearer); return Object.entries(this.keys()).find(([, k]) => k.hash === h)?.[0] ?? null; }
  private models() {
    const models = this.d.runner.targets().filter(t => t.kind === 'model');
    return { object: 'list', data: [{ id: AUTO, object: 'model', owned_by: 'agent-spaghetti' }, ...models.flatMap(t => t.models.map(m => ({ id: `${t.id}:${m}`, object: 'model', owned_by: t.id })))] };
  }
  private async forward(path: string, body: Record<string, unknown>, c: CallCtx): Promise<typeof WRITTEN> {
    const r = resolveRoute(this.d.settings.get('gateway.routes'), c.who, String(body.model ?? AUTO), this.d.runner.targets());
    if ('error' in r) throw fail(404, r.error);
    const t = this.d.runner.targets().find(x => x.id === r.target)!;
    let started = false;
    const write = (status: number, type: string, chunk?: string) => {
      if (!started) { c.res.writeHead(status, { 'content-type': type }); started = true; }
      if (chunk !== undefined) c.res.write(chunk);
    };
    const { id, done } = this.d.runner.start(c.who, { target: r.target, model: r.model, kind: 'other', reason: `model gateway ${path.slice(4)}`, returnTo: 'none', jobId: this.session,
      task: JSON.stringify(body.messages ?? body.prompt ?? body.input ?? '') }, {
      engine: signal => { const s = this.d.runner.server(t, r.model); return openaiForward(s.target, path.slice(3), body, { signal: AbortSignal.any([signal, c.signal]), onQueue: s.onQueue, write }); } });
    c.signal.addEventListener('abort', () => this.d.runner.cancel(id), { once: true });   // the tool gave up: no question left waiting
    const row = await done;
    if (started) { c.res.end(); return WRITTEN; }
    throw fail(row.outcome === 'denied' || row.outcome === 'expired' ? 403 : 502, `Agent Spaghetti: ${row.error ?? row.outcome}`);
  }
}
