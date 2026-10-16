// agent-spaghetti's MCP server over stdio: tools generated from the ops that declare `mcp` (sdk/ops.ts), each call
// forwarded to the daemon through HubClient. Runs as `agent-spaghetti mcp --as <client>` on the host and as the env
// bundle's `mcp` inside WSL. Dual-era (MCP spec 2026-07-28, checked 2026-10-16): stateless requests with `_meta`
// and `server/discover`, plus the `initialize` handshake of 2025-11-25 and earlier for older clients.
import { createInterface } from 'node:readline';
import type { HubClient } from './client.ts';
import { OPS, type OpId, type RunView } from './ops.ts';
import { validate } from './schema.ts';
import { VERSION } from './types.ts';

export const MCP_VERSION = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'agent-spaghetti', version: VERSION };
const TOOLS = (Object.entries(OPS) as Array<[OpId, (typeof OPS)[OpId]]>).flatMap(([op, s]) => ('mcp' in s ? [{ op, ...s.mcp }] : []));
type Msg = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, any> };
type Send = (m: object) => void;
export interface BridgeOpts { source: string; parentRunId?: number; waitMs?: number; pollMs?: number }

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
export function describeRun(v: RunView): ReturnType<typeof text> {
  const r = v.run;
  if (r.outcome === 'running') return text(`Run ${v.id} on ${r.target} is still running. Call run_status with id ${v.id} later.`);
  if (r.outcome === 'done') return text(v.result ?? '(no output)');
  return text(`Run ${v.id} on ${r.target} ${r.outcome}${r.error ? `: ${r.error}` : ''}.${v.result ? `\n\n${v.result}` : ''}`, true);
}

/** One MCP message in, the reply out (null for notifications). Progress goes through `send` while a delegation runs. */
export function mcpHandler(client: HubClient, o: BridgeOpts, send: Send) {
  let legacy = false;
  const reply = (id: Msg['id'], result: object, modern: boolean) => ({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result } : result });
  const fail = (id: Msg['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  async function delegate(args: Record<string, any>, progressToken: unknown): Promise<object> {
    const started = await client.call('delegate', { ...args, source: o.source, parentRunId: o.parentRunId, waitMs: 0 } as never);
    const until = Date.now() + (o.waitMs ?? 100_000);
    for (let n = 1, v: RunView = started; ; n++) {
      if (v.run.outcome !== 'running' || Date.now() >= until) return describeRun(v);
      if (progressToken !== undefined) {
        const asking = (await client.call('status')).consents.some(c => c.subject === o.source && c.action === 'run' && c.resource === v.run.target);
        send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n,
          message: asking ? 'waiting for approval in Agent Spaghetti' : `running on ${v.run.target}` } });
      }
      await new Promise(r => setTimeout(r, o.pollMs ?? 1500));
      const r = await client.call('runs', { id: v.id });
      v = { id: v.id, run: r.runs.find(x => x.id === v.id)!, result: r.result };
    }
  }
  async function call(name: string, args: Record<string, any>, progressToken: unknown): Promise<object> {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
    const errors = validate(tool.input, args);
    if (errors.length) return text(`invalid arguments: ${errors.join('; ')}`, true);
    try {
      if (tool.op === 'delegate') return await delegate(args, progressToken);
      if (tool.op === 'runs') { const r = await client.call('runs', { id: args.id }); const run = r.runs.find(x => x.id === args.id); return run ? describeRun({ id: run.id, run, result: r.result }) : text(`no run ${args.id}`, true); }
      return text(JSON.stringify(await client.call(tool.op, args as never), null, 2));
    } catch (e) { return text((e as Error).message, true); }   // daemon down or the op refused: a tool error the agent can read
  }
  return async function handle(m: Msg): Promise<object | null> {
    if (m.id === undefined || !m.method) return null;                          // notifications and stray responses
    const p = m.params ?? {}, version = p._meta?.['io.modelcontextprotocol/protocolVersion'];
    if (m.method === 'initialize') {
      legacy = true;
      return reply(m.id, { protocolVersion: LEGACY.includes(p.protocolVersion) ? p.protocolVersion : LEGACY[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO }, false);
    }
    if (version !== undefined && version !== MCP_VERSION && !LEGACY.includes(version)) return fail(m.id, -32022, 'Unsupported protocol version', { supported: [MCP_VERSION, ...LEGACY], requested: version });
    const modern = version === MCP_VERSION;
    if (!modern && !legacy) return fail(m.id, -32602, 'missing io.modelcontextprotocol/protocolVersion in _meta (or send initialize first)');
    const withInfo = (r: object) => (modern ? { ...r, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } : r);
    try {
      switch (m.method) {
        case 'server/discover': return reply(m.id, withInfo({ supportedVersions: [MCP_VERSION, ...LEGACY], capabilities: { tools: {} } }), true);
        case 'ping': return reply(m.id, {}, modern);
        case 'tools/list': return reply(m.id, withInfo({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.input })) }), modern);
        case 'tools/call': return reply(m.id, withInfo(await call(String(p.name), p.arguments ?? {}, p._meta?.progressToken)), modern);
        default: return fail(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) { return fail(m.id, (e as { code?: number }).code ?? -32603, (e as Error).message); }
  };
}

/** Newline-delimited JSON-RPC on stdin/stdout. */
export function serveMcpStdio(client: HubClient, o: BridgeOpts): Promise<void> {
  const send: Send = m => { process.stdout.write(JSON.stringify(m) + '\n'); };
  const handle = mcpHandler(client, o, send);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    let m: Msg;
    try { m = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    void handle(m).then(r => { if (r) send(r); });
  });
  return new Promise(r => rl.on('close', () => r()));
}
