// The model gateway (Phase 3c): an OpenAI-compatible endpoint on 127.0.0.1 for tools that take a custom one, so each tool's
// LLM is chosen here. A gateway key names the tool (the run's source); the model it asks for picks the target (`target:model`,
// a loaded model's id, else its route in `gateway.routes`, else `auto`: the loaded model routing picks for what the user last said). Every request is a run: the same permission check and
// question as a hand-off, the same server queue, the same record. Only `model` is rewritten; prompts are never stored.
import { createHash, randomBytes } from 'node:crypto';
import type { Target } from '@agent-spaghetti/sdk';
import { AUTO, classify, parseDirective, parseHop, parseJson, rankTargets, splitMessage } from '@agent-spaghetti/sdk';
import { http } from './http.ts';
import { openaiForward } from './engine/openai.ts';
import type { Bus } from './bus.ts';
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

/** Which target serves a request: an explicit `target:model`, a loaded model's id, else the tool's route, else `best` (the model
 *  routing picks for this request; without one, the best-ranked model). */
export function resolveRoute(routes: string[], source: string, requested: string, targets: Target[], best?: Target): { target: string; model: string } | { error: string } {
  const models = rankTargets(targets.filter(t => t.kind === 'model' && t.models.length));
  const p = parseHop(requested), named = models.find(t => t.id === p.target);
  if (named && p.model && named.models.includes(p.model)) return { target: named.id, model: p.model };
  const owner = models.find(t => t.models.includes(requested));
  if (owner) return { target: owner.id, model: requested };
  const use = routes.find(r => r.startsWith(`${source}=`))?.slice(source.length + 1).trim() || AUTO;
  const auto = best ?? models[0];
  if (use === AUTO) return auto ? { target: auto.id, model: auto.models[0] } : { error: 'no model is loaded: start a model server or load a model' };
  const u = parseHop(use), t = models.find(x => x.id === u.target);
  if (!t || (u.model && !t.models.includes(u.model))) return { error: `${source}'s model ${use} is not available now (Tools → ${source} → Model)` };
  return { target: t.id, model: u.model ?? t.models[0] };
}

/** What the user last said in a request (chat messages, else the prompt): what routing classifies. */
export function lastUserText(body: Record<string, unknown>): string {
  const last = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>).findLast(m => m.role === 'user')?.content : body.prompt ?? body.input;
  return typeof last === 'string' ? last : Array.isArray(last) ? last.map(p => (typeof p === 'string' ? p : (p as { text?: string })?.text ?? '')).join('\n') : '';
}

export class Gateway {
  private d: { settings: Settings; store: Store; bus: Bus; runner: Runner; best?(source: string, text: string): Target | undefined };   // best: routing's model for a request (core/dispatcher.ts)
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

  /** A real request through the gateway as a tool (Tools → Test gateway): a short answer from the model its requests go to now. */
  async test(integration: string): Promise<{ ok: boolean; lines: string[] }> {
    const url = this.status().url, has = !!this.keys()[integration];
    if (!url) return { ok: false, lines: ['The model gateway is off (Settings → gateway.port).'] };
    const token = KEY_PREFIX + randomBytes(24).toString('base64url'), t0 = Date.now();
    this.trial.set(hash(token), integration);                // this request only: the tool's own key is never shown again
    try {
      const r = await http({ url: `${url}/chat/completions`, method: 'POST', timeoutMs: 120_000, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: AUTO, max_tokens: 256, messages: [{ role: 'user', content: 'Reply with one word: ready' }] }) });   // up to 2 min: a model may load first
      if (!r) return { ok: false, lines: [`The gateway at ${url} did not answer`] };
      const j = (parseJson(r.body) ?? {}) as { model?: string; error?: { message?: string }; choices?: Array<{ message?: { content?: string } }> };
      const key = has ? `${integration} has its key` : `${integration} has no key yet: Connect it (or Set up gateway) first`;
      if (r.status !== 200) return { ok: false, lines: [`The gateway at ${url} answered ${r.status}: ${j.error?.message ?? 'no details'}`, key] };
      return { ok: has, lines: [`The gateway at ${url} works: ${j.model ?? 'a model'} answered in ${Date.now() - t0} ms ("${String(j.choices?.[0]?.message?.content ?? '').trim().slice(0, 60)}")`, key] };
    } finally { this.trial.delete(hash(token)); }
  }

  private readonly trial = new Map<string, string>();      // test tokens in flight → the tool they stand for
  private keys(): Keys { return this.d.store.getKv<Keys>(KEYS) ?? {}; }
  private who(bearer: string): string | null { const h = hash(bearer); return this.trial.get(h) ?? Object.entries(this.keys()).find(([, k]) => k.hash === h)?.[0] ?? null; }
  private models() {
    const models = this.d.runner.targets().filter(t => t.kind === 'model');
    return { object: 'list', data: [{ id: AUTO, object: 'model', owned_by: 'agent-spaghetti' }, ...models.flatMap(t => t.models.map(m => ({ id: `${t.id}:${m}`, object: 'model', owned_by: t.id })))] };
  }
  /** A message that names tools (`cline <task>`, `a <task> then b`) is handed to them, and their answer comes back as the model's reply: no local model decides. */
  private async handOff(body: Record<string, unknown>, c: CallCtx, d: NonNullable<ReturnType<typeof parseDirective>>, context: string, files: string[], asked: string): Promise<unknown> {
    const what = classify(d.task);
    const { id, done } = await this.d.runner.begin(c.who, { target: d.target, model: d.model, task: d.task, context: context || undefined, files: files.length ? files : undefined, then: d.then, kind: what.kind, difficulty: what.difficulty, classification: what,
      reason: 'named in a chat message through the model gateway', returnTo: 'none' }, { asked }).catch(e => { throw fail(400, `Agent Spaghetti: ${(e as Error).message}`); });
    c.signal.addEventListener('abort', () => this.d.runner.cancel(id), { once: true });
    const row = await done, text = this.d.runner.result(row);
    if (row.outcome !== 'done') throw fail(row.outcome === 'denied' || row.outcome === 'expired' ? 403 : 502, `Agent Spaghetti: ${row.error ?? row.outcome}`);
    const out = { id: `chatcmpl-as-${row.id}`, created: Math.floor(Date.now() / 1000), model: `agent-spaghetti:${row.target}` }, content = text ?? '';
    if (!body.stream) return { ...out, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: row.inputTokens ?? 0, completion_tokens: row.outputTokens ?? 0, total_tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0) } };
    c.res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const delta of [{ role: 'assistant', content }, {}]) c.res.write(`data: ${JSON.stringify({ ...out, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : 'stop' }] })}\n\n`);
    c.res.end('data: [DONE]\n\n');
    return WRITTEN;
  }
  private async forward(path: string, body: Record<string, unknown>, c: CallCtx): Promise<unknown> {
    const bus = this.d.bus, messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : [];
    const raw = lastUserText(body), { text: said, context, files } = splitMessage(raw);
    bus.capture('gateway', 'request', { from: c.who, path, model: body.model, stream: body.stream, tools: Array.isArray(body.tools) ? body.tools.length : 0, roles: messages.map(m => m.role).join(','), lastUser: raw });
    const directive = path === PATHS[0] ? parseDirective(said, this.d.runner.targets().filter(t => t.id !== c.who)) : null;
    bus.capture('gateway', 'read', { text: said, context: context.length, files, directive });
    if (directive) return this.handOff(body, c, directive, context, files, said);
    const what = classify(said);     // recorded under what the user asked for, not as "other"
    const r = resolveRoute(this.d.settings.get('gateway.routes'), c.who, String(body.model ?? AUTO), this.d.runner.targets(), this.d.best?.(c.who, said));
    if ('error' in r) { const o = this.d.runner.offerLoad(c.who, { need: Math.round(JSON.stringify(body).length / 4) }); throw fail(404, o ? `${r.error}; asked to load ${o.model} in ${o.name}: answer in the Agent Spaghetti tray, then try again` : r.error); }
    const t = this.d.runner.targets().find(x => x.id === r.target)!;
    // a request bigger than the model's loaded context fails at the server with a message about tokens; say what to do instead
    const room = this.d.runner.contextOf(r.target, r.model), need = Math.round(JSON.stringify(body).length / 4);
    if (room && need > room) {
      const o = this.d.runner.offerLoad(c.who, { need, reload: { target: r.target, model: r.model } });
      throw fail(400, `Agent Spaghetti: ${r.model} is loaded with room for ${room} tokens; this request needs about ${need}. ${o ? `Asked to reload it with room for ${o.context}: answer in the Agent Spaghetti tray, then try again.` : 'Load it with a larger context (e.g. 32768 in the load settings), then try again.'}`);
    }
    let started = false;
    const write = (status: number, type: string, chunk?: string) => {
      if (!started) { c.res.writeHead(status, { 'content-type': type }); started = true; }
      if (chunk !== undefined) c.res.write(chunk);
    };
    const { id, done } = this.d.runner.start(c.who, { target: r.target, model: r.model, kind: what.kind, difficulty: what.difficulty, classification: what, reason: `model gateway ${path.slice(4)}`, returnTo: 'none', jobId: this.session,
      task: JSON.stringify(body.messages ?? body.prompt ?? body.input ?? '') }, { asked: lastUserText(body),
      engine: signal => { const s = this.d.runner.server(t, r.model); return openaiForward(s.target, path.slice(3), body, { signal: AbortSignal.any([signal, c.signal]), onQueue: s.onQueue, write }); } });
    c.signal.addEventListener('abort', () => this.d.runner.cancel(id), { once: true });   // the tool gave up: no question left waiting
    const row = await done;
    if (started) { c.res.end(); return WRITTEN; }
    throw fail(row.outcome === 'denied' || row.outcome === 'expired' ? 403 : 502, `Agent Spaghetti: ${row.error ?? row.outcome}`);
  }
}
