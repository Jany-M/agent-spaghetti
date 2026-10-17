// The generic run engine for every integration that speaks the OpenAI API (LM Studio, Ollama, llama.cpp, vLLM, …):
// streamed chat completion, one queue per server so a single local GPU is never overloaded.
import type { Environment, Manifest, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { fillEnv, parseJsonLoose } from '@agent-spaghetti/sdk';
import { Semaphore } from '../async.ts';
import { httpRaw } from '../http.ts';

const queues = new Map<string, Semaphore>();
export const queueFor = (endpoint: string, limit: number) => {
  const q = queues.get(endpoint) ?? new Semaphore(limit);
  q.limit = limit; queues.set(endpoint, q);
  return q;
};
/** A server's request headers, its {env:NAME} values read now (keys never stored or logged). */
export function openaiHeaders(m: Manifest, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const h = fillEnv(m.speaks?.openai?.headers, env);
  if (!h) throw new Error(`${m.name} needs ${(m.detect?.env ?? []).join(', ')} set where Agent Spaghetti runs`);
  return h;
}
export interface OpenAiTarget { endpoint: string; base: string; model: string; concurrency: number; headers?: Record<string, string> }

export async function* openaiRun(env: Environment, t: OpenAiTarget, req: RunRequest, o: { signal: AbortSignal; onQueue(waiting: number, running: number): void }): AsyncIterable<RunEvent> {
  const q = queueFor(t.endpoint, t.concurrency);
  const report = () => o.onQueue(q.waiting, q.running);
  const pending = q.acquire(o.signal); report();
  const release = await pending; report();
  try {
    let text = '';
    const body = JSON.stringify({ model: t.model, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: req.task }] });
    for await (const line of env.httpLines({ method: 'POST', url: `${t.endpoint}${t.base}/chat/completions`, headers: { ...t.headers, 'content-type': 'application/json' }, body, signal: o.signal })) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      const j = parseJsonLoose(data) as { choices?: Array<{ delta?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
      const delta = j?.choices?.[0]?.delta?.content;
      if (delta) { text += delta; yield { type: 'text', text: delta }; }
      if (j?.usage) yield { type: 'usage', inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens, costUsd: 0 };
    }
    yield { type: 'done', result: text };
  } finally { release(); report(); }
}

/** A client's own request passed to a server (the model gateway): only `model` is rewritten; unknown fields stay. Shares the
 *  server's queue with delegated runs. Streams are piped line by line; when the client did not ask for usage it is asked for
 *  here and its extra chunk is kept from the client. `write` gets the status, the content type and each piece of the body. */
export async function* openaiForward(t: OpenAiTarget, path: string, body: Record<string, any>, o: { signal: AbortSignal; onQueue(waiting: number, running: number): void;
  write(status: number, type: string, chunk?: string): void }): AsyncIterable<RunEvent> {
  const q = queueFor(t.endpoint, t.concurrency);
  const report = () => o.onQueue(q.waiting, q.running);
  const pending = q.acquire(o.signal); report();
  const release = await pending; report();
  try {
    const ownUsage = !!body.stream && !body.stream_options?.include_usage;
    const sent = { ...body, model: t.model, ...(ownUsage ? { stream_options: { ...body.stream_options, include_usage: true } } : {}) };
    const r = await httpRaw({ method: 'POST', url: `${t.endpoint}${t.base}${path}`, headers: { ...t.headers, 'content-type': 'application/json' }, body: JSON.stringify(sent), signal: o.signal });
    const type = r.headers.get('content-type') ?? 'application/json';
    if (!r.ok || !body.stream || !r.body) {
      const text = await r.text();
      o.write(r.status, type, text);
      if (!r.ok) { yield { type: 'error', message: `HTTP ${r.status}: ${text.slice(0, 300)}` }; return; }
      const u = (parseJsonLoose(text) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined)?.usage;
      if (u) yield { type: 'usage', inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, costUsd: 0 };
      yield { type: 'done', result: '' };
      return;
    }
    o.write(r.status, type);
    const dec = new TextDecoder(); let buf = '';
    const line = function* (l: string): Generator<RunEvent> {
      const j = l.startsWith('data:') ? parseJsonLoose(l.slice(5).trim()) as { choices?: unknown[]; usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined : undefined;
      if (j?.usage) yield { type: 'usage', inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens, costUsd: 0 };
      if (ownUsage && j?.usage && !j.choices?.length) return;      // the usage chunk we asked for: not the client's
      o.write(r.status, type, l + '\n');
    };
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { yield* line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    if (buf) yield* line(buf);
    yield { type: 'done', result: '' };
  } finally { release(); report(); }
}
