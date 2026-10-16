// The ONLY way the CLI, the tray, the app and bridges talk to the daemon.
import { readFileSync } from 'node:fs';
import type { StoredEvent } from './types.ts';
import { OPS, STREAM_PATH, type OpId, type OpIO } from './ops.ts';
import { dataDir, discoveryPath, tokenPath } from './paths.ts';

export class DaemonDown extends Error {}
export class HubClient {
  readonly base: string; private token: string;
  constructor(o: { port: number; token: string }) { this.base = `http://127.0.0.1:${o.port}`; this.token = o.token; }
  /** AGENT_SPAGHETTI_PORT overrides the discovery file. */
  static fromDiscovery(env: NodeJS.ProcessEnv = process.env): HubClient {
    const dir = dataDir(env);
    try {
      const port = Number(env.AGENT_SPAGHETTI_PORT) || JSON.parse(readFileSync(discoveryPath(dir), 'utf8')).port;
      return new HubClient({ port, token: readFileSync(tokenPath(dir), 'utf8').trim() });
    } catch { throw new DaemonDown('the daemon is not running'); }
  }
  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    try { return await fetch(this.base + path, { ...init, headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' } }); }
    catch { throw new DaemonDown('the daemon is not running'); }
  }
  async call<K extends OpId>(op: K, input: OpIO[K]['in'] = {} as OpIO[K]['in']): Promise<OpIO[K]['out']> {
    const spec = OPS[op] as { method: string; path: string };
    const q = spec.method === 'GET' ? '?' + new URLSearchParams(Object.entries(input).map(([k, v]) => [k, String(v)])) : '';
    const r = await this.fetch(spec.path + (q === '?' ? '' : q), spec.method === 'POST' ? { method: 'POST', body: JSON.stringify(input) } : {});
    const body = await r.json() as any;
    if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
    return body;
  }
  /** fetch-based SSE reader (works in Electron, unlike EventSource which cannot send auth headers). */
  async *stream(signal?: AbortSignal): AsyncIterable<StoredEvent> {
    const r = await this.fetch(STREAM_PATH, { signal });
    const reader = r.body!.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('');
        if (data) yield JSON.parse(data);
      }
    }
  }
}
