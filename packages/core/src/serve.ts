// The one JSON-over-HTTP server helper (loopback, plus the Windows side of WSL for in-distro MCP bridges; bearer token;
// optional SSE stream). Used by the daemon
// and later listeners (gateway) so there is never a second server implementation.
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { redact } from '@agent-spaghetti/sdk';

export interface Route { method: 'GET' | 'POST'; path: string; handle(input: Record<string, unknown>): Promise<unknown> | unknown }
export interface ServeOpts { token: string; port?: number; routes: Route[]; stream?: { path: string; subscribe(fn: (data: unknown) => void): () => void } }
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
  const handler: Parameters<typeof createServer>[1] = async (req, res) => {
    const send = (code: number, b: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!same(bearer, o.token)) return send(401, { error: 'unauthorized' });
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
    if (!route) return send(404, { error: 'not found' });
    try { send(200, await route.handle({ ...Object.fromEntries(url.searchParams), ...(req.method === 'POST' ? await body(req) : {}) })); }
    catch (e) { send(500, { error: redact((e as Error).message) }); }
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
