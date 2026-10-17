// The only HTTP client in core (PLAN §3.5).
import type { HttpRequest, HttpResult } from '@agent-spaghetti/sdk';

export async function http(req: HttpRequest): Promise<HttpResult | null> {
  try {
    const r = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs ?? 3000) });
    return { status: r.status, body: (await r.text()).slice(0, 2_000_000) };
  } catch { return null; }
}

/** The upstream response as it comes (status, type, body stream): for passing a server's answer through unchanged. Throws when
 *  nothing answers. */
export async function httpRaw(req: HttpRequest): Promise<Response> {
  return fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, signal: req.signal });
}
/** Streaming body as lines (OpenAI SSE). Throws on no answer or a non-2xx status (with the start of the body). */
export async function* httpLines(req: HttpRequest): AsyncIterable<string> {
  const r = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body,
    signal: req.timeoutMs ? AbortSignal.any([AbortSignal.timeout(req.timeoutMs), ...(req.signal ? [req.signal] : [])]) : req.signal });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); }
  }
  if (buf) yield buf;
}
