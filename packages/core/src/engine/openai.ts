// The generic run engine for every integration that speaks the OpenAI API (LM Studio, Ollama, llama.cpp, vLLM, …):
// streamed chat completion, one queue per server so a single local GPU is never overloaded.
import type { Environment, Manifest, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { fillEnv, parseJsonLoose } from '@agent-spaghetti/sdk';
import { Semaphore } from '../async.ts';

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
