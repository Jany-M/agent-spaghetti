// The one JSON-over-HTTP server helper (loopback, plus the Windows side of WSL for in-distro MCP bridges; bearer token or a
// caller lookup; optional SSE stream; handlers may write the response themselves, e.g. a proxied stream). Used by the daemon
// and the model gateway so there is never a second server implementation.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { redact } from '@agent-spaghetti/sdk';

/** What a handler gets besides its input: who called (the `auth` result), the client going away, and the raw response. */
export interface CallCtx { who: string; signal: AbortSignal; res: ServerResponse }
/** A handler that wrote the response itself returns this. */
export const WRITTEN = Symbol('written');
export interface Route { method: 'GET' | 'POST'; path: string; handle(input: Record<string, unknown>, ctx: CallCtx): Promise<unknown> | unknown }
export interface ServeOpts {
  /** One shared token (the daemon), or a lookup from a bearer key to the caller (null = refused). */
  token?: string; auth?(bearer: string): string | null;
  port?: number; routes: Route[]; stream?: { path: string; subscribe(fn: (data: unknown) => void): () => void };
  /** The error body for a status (default `{ error: message }`), e.g. OpenAI's shape for the gateway. */
  error?(status: number, message: string): unknown;
}
export interface Server {
  port: number; close(): Promise<void>;
  /** Also answer on another local address, same port and token (the Windows side of WSL for in-distro bridges). */
  listenOn(host: string): Promise<boolean>;
}

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = ''; for await (const c of req) s += c;
  if (!s) return {};
  try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

export async function serveJson(o: ServeOpts): Promise<Server> {
  const auth = o.auth ?? ((b: string) => (o.token && same(b, o.token) ? 'hub' : null));
  const handler: Parameters<typeof createServer>[1] = async (req, res) => {
    const send = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const fail = (code: number, message: string) => send(code, o.error ? o.error(code, message) : { error: message });
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = auth(bearer);
    if (who === null) return fail(401, 'unauthorized');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (o.stream && req.method === 'GET' && url.pathname === o.stream.path) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const off = o.stream.subscribe(d => res.write(`data: ${JSON.stringify(d)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { off(); clearInterval(ping); });
      return;
    }
    const route = o.routes.find(r => r.method === req.method && r.path === url.pathname);
    if (!route) return fail(404, 'not found');
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(new Error('the client went away')); });
    try {
      const out = await route.handle({ ...Object.fromEntries(url.searchParams), ...(req.method === 'POST' ? await body(req) : {}) }, { who, signal: ac.signal, res });
      if (out !== WRITTEN) send(200, out);
    } catch (e) { if (res.headersSent) res.end(); else fail((e as { status?: number }).status ?? 500, redact((e as Error).message)); }
  };
  const servers = new Map<string, ReturnType<typeof createServer>>();
  const listen = (host: string, port: number) => new Promise<number>((r, j) => {
    const s = createServer(handler);
    s.once('error', j);
    s.listen(port, host, () => { servers.set(host, s); r((s.address() as { port: number }).port); });
  });
  const port = await listen('127.0.0.1', o.port ?? 0);
  return { port,
    listenOn: async host => servers.has(host) || listen(host, port).then(() => true, () => false),
    close: () => Promise.all([...servers.values()].map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))).then(() => {}) };
}
