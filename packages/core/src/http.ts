// The only HTTP client in core (PLAN §3.5).
import type { HttpRequest, HttpResult } from '@agent-spaghetti/sdk';

export async function http(req: HttpRequest): Promise<HttpResult | null> {
  try {
    const r = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeoutMs ?? 3000) });
    return { status: r.status, body: (await r.text()).slice(0, 2_000_000) };
  } catch { return null; }
}
