// agent-spaghetti's MCP server over stdio: tools generated from the ops that declare `mcp` (sdk/ops.ts), each call forwarded to
// the daemon through HubClient. Runs as `agent-spaghetti mcp --as <client>` on the host and as the env bundle's `mcp` inside WSL.
// Dual-era (MCP spec 2026-07-28, checked 2026-10-17): stateless requests with `_meta` and `server/discover`, plus the `initialize`
// handshake of 2025-11-25 and earlier. For use from inside a tool (Phase 3e) it also offers: the `delegate` prompt with argument
// completion, the targets as resources (`target://<id>`), server instructions, the client's workspace (roots) as the default
// folder, and questions in the tool (elicitation: pick a target, approve a paid hand-off). Questions to the client go as
// requests on stdio (older eras) or as multi round-trip `input_required` results (2026-07-28), always only when declared.
import { createHmac, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { HubClient } from './client.ts';
import { parseJson } from './json.ts';
import { uriPath } from './match.ts';
import { OPS, type OpId, type RunView } from './ops.ts';
import { rankTargets } from './routing.ts';
import { validate } from './schema.ts';
import { AUTO, HANDOFF_KINDS, VERSION, type Target } from './types.ts';
import { SCOPE_LABEL, type ConsentScope } from './permissions.ts';

export const MCP_VERSION = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'agent-spaghetti', version: VERSION };
const TOOLS = (Object.entries(OPS) as Array<[OpId, (typeof OPS)[OpId]]>).flatMap(([op, s]) => ('mcp' in s ? [{ op, ...s.mcp }] : []));
const CAPABILITIES = { tools: {}, prompts: {}, resources: {}, completions: {} };
export const INSTRUCTIONS = [
  'Agent Spaghetti hands work to the other AI tools and models on this machine and brings the result back here.',
  'To hand off: call `delegate` with the task, the target (an id from `targets`, `auto`, or leave it out to let the user pick), the files the user',
  'attached or means as `files`, and the open workspace as `cwd`. The result comes back to this chat unless `returnTo` is `none`.',
  'Users can also type the `delegate` prompt, or mention a target resource (target://<id>).'].join(' ');
const PROMPT = { name: 'delegate', title: 'Hand off to another tool (Agent Spaghetti)',
  description: 'Hand a task to another AI tool or model on this machine; the result comes back here.',
  arguments: [{ name: 'target', description: 'Who does it (a target, or auto)', required: true }, { name: 'task', description: 'What to do', required: true },
    { name: 'then', description: 'Hand the result on to (targets, comma separated)' }, { name: 'kind', description: HANDOFF_KINDS.join(', ') }] };
type Msg = { jsonrpc: '2.0'; id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: any };
type Send = (m: object) => void;
type Requests = Record<string, { method: string; params: object }>;
export interface BridgeOpts { source: string; parentRunId?: number; waitMs?: number; pollMs?: number; askMs?: number }

const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
export function describeRun(v: RunView): ReturnType<typeof text> {
  const r = v.run;
  if (r.outcome === 'running') return text(`Run ${v.id} on ${r.target} is still running. Call run_status with id ${v.id} later.`);
  if (r.outcome === 'done') return text(v.result ?? '(no output)');
  return text(`Run ${v.id} on ${r.target} ${r.outcome}${r.error ? `: ${r.error}` : ''}.${v.result ? `\n\n${v.result}` : ''}`, true);
}
/** What a user can pick for a target: every target, its models, and auto (best-ranked first). */
export const targetChoices = (ts: Target[]) => [...rankTargets(ts).flatMap(t => [{ value: t.id, label: `${t.name} (${t.cost})` },
  ...t.models.map(m => ({ value: `${t.id}:${m}`, label: `${t.name}: ${m}` }))]), { value: AUTO, label: 'Let Agent Spaghetti choose' }];
const targetCard = (t: Target) => `# ${t.name} (target \`${t.id}\`)\n\n${t.kind}, ${t.cost}, takes tasks through ${t.engine}${t.models.length ? `; models/agents: ${t.models.join(', ')}` : ''}.\n\n`
  + `Hand the task to it with the agent-spaghetti \`delegate\` tool (target \`${t.id}\`).`;
const elicit = (message: string, name: string, title: string, options: Array<{ value: string; label: string }>) => ({ method: 'elicitation/create', params: { mode: 'form', message,
  requestedSchema: { type: 'object', properties: { [name]: { type: 'string', title, oneOf: options.map(o => ({ const: o.value, title: o.label })) } }, required: [name] } } });

/** The client needs to answer first (2026-07-28: the call ends with these questions and comes back with the answers). */
class InputRequired { requests: Requests; state: unknown; constructor(requests: Requests, state: unknown) { this.requests = requests; this.state = state; } }

/** One MCP message in, the reply out (null for notifications and answers). `send` carries progress and, in older eras, our questions. */
export function mcpHandler(client: HubClient, o: BridgeOpts, send: Send) {
  let legacy = false, legacyCaps: Record<string, any> = {}, asked = 0;
  const waiting = new Map<string, (r: any) => void>();          // our questions to an older-era client, by request id
  const key = randomBytes(32);                                    // requestState is ours alone: signed, checked on the way back
  const seal = (s: unknown) => { const b = Buffer.from(JSON.stringify(s)).toString('base64url'); return `${b}.${createHmac('sha256', key).update(b).digest('base64url')}`; };
  const open = (s: unknown) => {
    const [b, mac] = String(s ?? '').split('.');
    return b && mac === createHmac('sha256', key).update(b).digest('base64url') ? JSON.parse(Buffer.from(b, 'base64url').toString()) : undefined;
  };
  const reply = (id: Msg['id'], result: object, modern: boolean) => ({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result } : result });
  const fail = (id: Msg['id'], code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

  /** How this call can reach the user: what the client declared, and how to ask it. */
  interface Io { can(cap: 'roots' | 'elicitation'): boolean; ask(requests: Requests, state: unknown): Promise<Record<string, any>>; modern: boolean }
  function io(p: Record<string, any>, modern: boolean): Io {
    const caps = modern ? p._meta?.['io.modelcontextprotocol/clientCapabilities'] ?? {} : legacyCaps;
    const answers = modern ? p.inputResponses ?? {} : {};
    return { modern, can: c => !!caps[c],
      ask: (requests, state) => {
        if (modern) return Object.keys(requests).every(k => k in answers) ? Promise.resolve(answers) : Promise.reject(new InputRequired(requests, state));
        return Promise.all(Object.entries(requests).map(([k, r]) => new Promise<[string, any]>(res => {
          const id = `as-${++asked}`, t = setTimeout(() => { waiting.delete(id); res([k, null]); }, o.askMs ?? 120_000);
          waiting.set(id, v => { clearTimeout(t); res([k, v]); });
          send({ jsonrpc: '2.0', id, ...r });
        }))).then(Object.fromEntries);
      } };
  }

  /** delegate from a tool: its workspace as the folder, a picked target, the approval asked in the tool too, then the result. */
  async function delegate(args: Record<string, any>, progressToken: unknown, x: Io, resumed: { args?: Record<string, any>; runId?: number } = {}): Promise<object> {
    const a = resumed.args ?? { ...args }, state = () => ({ args: a, runId });
    let runId = resumed.runId;
    if (!runId) {
      if (!a.cwd && x.can('roots')) a.cwd = uriPath((await x.ask({ roots: { method: 'roots/list', params: {} } }, state())).roots?.roots?.[0]?.uri ?? '');
      const ts = await client.call('targets');
      if ((!a.target || (a.target !== AUTO && !ts.some(t => t.id === String(a.target).split(':')[0]))) && x.can('elicitation') && ts.length) {
        const r = (await x.ask({ target: elicit(`Agent Spaghetti: who should do this?\n\n${String(a.task).slice(0, 300)}`, 'target', 'Target', targetChoices(ts)) }, state())).target;
        if (r?.action !== 'accept') return text('Not handed off: no target picked.', true);
        a.target = r.content.target;
      }
      if (!a.cwd) delete a.cwd;
      runId = (await client.call('delegate', { ...a, target: a.target || AUTO, source: o.source, parentRunId: o.parentRunId, waitMs: 0 } as never)).id;
    }
    let offered = false;
    const until = Date.now() + (o.waitMs ?? 100_000);
    for (let n = 1; ; n++) {
      const v = (await client.call('runs', { id: runId, watch: true, source: o.source })).final!;
      if (v.run.outcome !== 'running' || Date.now() >= until) return describeRun(v);
      const q = (await client.call('status')).consents.find(c => c.subject === o.source && c.action === 'run' && c.resource === v.run.target);
      if (q && !offered && x.can('elicitation')) {                 // the same question as in the tray; the first answer wins
        offered = true;
        const ask = x.ask({ approve: elicit(`Agent Spaghetti: ${q.why}${q.billing ? ` (${q.billing})` : ''}. Allow ${v.run.target}?`, 'answer', 'Your answer',
          [...q.scopes.map(s => ({ value: s, label: SCOPE_LABEL[s as ConsentScope] })), { value: 'deny', label: 'Deny' }]) }, state())
          .then(r => { const ans = r.approve; if (ans?.action === 'decline' || ans?.content?.answer === 'deny') return client.call('consent', { id: q.id, allow: false });
            if (ans?.action === 'accept') return client.call('consent', { id: q.id, allow: true, scope: ans.content.answer }); })
          .catch(e => { if (e instanceof InputRequired) throw e; });   // answered in the tray meanwhile: nothing to do
        if (x.modern) await ask; else void ask;
      }
      if (progressToken !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n,
        message: q ? 'waiting for approval (here or in Agent Spaghetti)' : `running on ${v.run.target}` } });
      await new Promise(r => setTimeout(r, o.pollMs ?? 1500));
    }
  }
  /** One run (its chain's final state), or every result waiting for this caller. */
  async function status(id: number | undefined): Promise<object> {
    if (id !== undefined) return describeRun((await client.call('runs', { id, watch: true, source: o.source })).final!);
    const waiting = (await client.call('runs', { unread: true, source: o.source })).unread ?? [];
    return text(waiting.length ? waiting.map(v => `## Run ${v.id} (${v.run.target}): ${v.run.outcome}\n\n${v.result ?? v.run.error ?? '(no output)'}`).join('\n\n') : 'No new results.');
  }
  async function call(name: string, args: Record<string, any>, p: Record<string, any>, x: Io): Promise<object> {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
    const errors = validate(tool.input, args);
    if (errors.length) return text(`invalid arguments: ${errors.join('; ')}`, true);
    try {
      if (tool.op === 'delegate') return await delegate(args, p._meta?.progressToken, x, p.requestState ? open(p.requestState) ?? {} : {});
      if (tool.op === 'runs') return await status(args.id);
      return text(JSON.stringify(await client.call(tool.op, { ...args, source: o.source } as never), null, 2));   // the caller, for ops that check it (report)
    } catch (e) {
      if (e instanceof InputRequired) throw e;
      return text((e as Error).message, true);                    // daemon down or the op refused: a tool error the agent can read
    }
  }
  /** Argument completion for the delegate prompt: targets (the last of a comma list for `then`) and kinds, by prefix. */
  async function complete(arg: string, value: string): Promise<string[]> {
    const head = arg === 'then' ? value.slice(0, value.lastIndexOf(',') + 1) : '', typed = value.slice(head.length).trim().toLowerCase();
    const all = arg === 'kind' ? [...HANDOFF_KINDS] : arg === 'target' || arg === 'then' ? targetChoices(await client.call('targets')).map(c => c.value) : [];
    return all.filter(v => v.toLowerCase().startsWith(typed)).map(v => head + v);
  }
  const promptText = (a: Record<string, string>) => [`Hand this off with the agent-spaghetti \`delegate\` tool: target \`${a.target || AUTO}\``,
    a.then ? `, then \`${a.then}\`` : '', a.kind ? `, kind \`${a.kind}\`` : '', '. Pass my open workspace as `cwd` and the files I attached or mention as `files`.',
    ' Show me the result when it comes back.', `\n\nTask: ${a.task ?? ''}`].join('');

  return async function handle(m: Msg): Promise<object | null> {
    if (!m.method) { if (m.id !== undefined) { waiting.get(String(m.id))?.(m.error ? null : m.result); waiting.delete(String(m.id)); } return null; }   // answers to our questions
    if (m.id === undefined) return null;                                        // notifications
    const p = m.params ?? {}, version = p._meta?.['io.modelcontextprotocol/protocolVersion'];
    if (m.method === 'initialize') {
      legacy = true; legacyCaps = p.capabilities ?? {};
      return reply(m.id, { protocolVersion: LEGACY.includes(p.protocolVersion) ? p.protocolVersion : LEGACY[0], capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, false);
    }
    if (version !== undefined && version !== MCP_VERSION && !LEGACY.includes(version)) return fail(m.id, -32022, 'Unsupported protocol version', { supported: [MCP_VERSION, ...LEGACY], requested: version });
    const modern = version === MCP_VERSION;
    if (!modern && !legacy) return fail(m.id, -32602, 'missing io.modelcontextprotocol/protocolVersion in _meta (or send initialize first)');
    const withInfo = (r: object) => (modern ? { ...r, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } : r);
    try {
      switch (m.method) {
        case 'server/discover': return reply(m.id, withInfo({ supportedVersions: [MCP_VERSION, ...LEGACY], capabilities: CAPABILITIES, instructions: INSTRUCTIONS }), true);
        case 'ping': return reply(m.id, {}, modern);
        case 'tools/list': return reply(m.id, withInfo({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.input })) }), modern);
        case 'tools/call': return reply(m.id, withInfo(await call(String(p.name), p.arguments ?? {}, p, io(p, modern))), modern);
        case 'prompts/list': return reply(m.id, withInfo({ prompts: [PROMPT] }), modern);
        case 'prompts/get':
          if (p.name !== PROMPT.name) return fail(m.id, -32602, `unknown prompt ${p.name}`);
          return reply(m.id, withInfo({ description: PROMPT.description, messages: [{ role: 'user', content: { type: 'text', text: promptText(p.arguments ?? {}) } }] }), modern);
        case 'completion/complete': {
          const values = p.ref?.type === 'ref/prompt' && p.ref?.name === PROMPT.name ? await complete(String(p.argument?.name), String(p.argument?.value ?? '')) : [];
          return reply(m.id, withInfo({ completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 } }), modern);
        }
        case 'resources/list': return reply(m.id, withInfo({ resources: (await client.call('targets')).map(t => ({ uri: `target://${t.id}`, name: t.id, title: t.name,
          description: `${t.kind}, ${t.cost}: hand tasks to ${t.name}`, mimeType: 'text/markdown' })) }), modern);
        case 'resources/read': {
          const t = (await client.call('targets')).find(x => `target://${x.id}` === p.uri);
          if (!t) return fail(m.id, -32002, `no target ${p.uri} available now`);
          return reply(m.id, withInfo({ contents: [{ uri: p.uri, mimeType: 'text/markdown', text: targetCard(t) }] }), modern);
        }
        default: return fail(m.id, -32601, `method not found: ${m.method}`);
      }
    } catch (e) {
      if (e instanceof InputRequired) return { jsonrpc: '2.0', id: m.id, result: { resultType: 'input_required', inputRequests: e.requests, requestState: seal(e.state) } };
      return fail(m.id, (e as { code?: number }).code ?? -32603, (e as Error).message);
    }
  };
}

/** Newline-delimited JSON-RPC on stdin/stdout. */
export function serveMcpStdio(client: HubClient, o: BridgeOpts): Promise<void> {
  const send: Send = m => { process.stdout.write(JSON.stringify(m) + '\n'); };
  const handle = mcpHandler(client, o, send);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', line => {
    const m = parseJson(line) as Msg | undefined;
    if (!m || typeof m !== 'object') { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    void handle(m).then(r => { if (r) send(r); });
  });
  return new Promise(r => rl.on('close', () => r()));
}
