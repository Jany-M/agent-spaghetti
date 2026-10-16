import { STREAM_PATH } from '@agent-spaghetti/sdk';
import { serveJson, type Server } from './serve.ts';
import { routesFor, type Services } from './ops.ts';

export function startDaemon(o: { services: Services; token: string; port?: number }): Promise<Server> {
  return serveJson({ token: o.token, port: o.port, routes: routesFor(o.services),
    stream: { path: STREAM_PATH, subscribe: fn => o.services.bus.subscribe(fn) } });
}
