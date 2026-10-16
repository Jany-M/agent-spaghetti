// The one JSON-over-HTTP server helper (127.0.0.1 only, bearer token, optional SSE stream). Used by the daemon now
// and by later listeners (gateway, MCP) so there is never a second server implementation.
import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { redact } from '@agent-spaghetti/sdk';

export interface Route { method: 'GET' | 'POST'; path: string; handle(input: Record<string, unknown>): Promise<unknown> | unknown }
export interface ServeOpts { token: string; port?: number; routes: Route[]; stream?: { path: string; subscribe(fn: (data: unknown) => void): () => void } }
export interface Server { port: number; close(): Promise<void> }

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = ''; for await (const c of req) s += c;
  if (!s) return {};
  try { const j = JSON.parse(s); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}

export async function serveJson(o: ServeOpts): Promise<Server> {
  const server = createServer(async (req, res) => {
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
  });
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(o.port ?? 0, '127.0.0.1', r); });
  return { port: (server.address() as { port: number }).port,
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }) };
}
