// Agent Client Protocol engine (ADR 0010 §2): any agent that speaks ACP over stdio runs tasks the same way.
// Spec checked 2026-10-17: agentclientprotocol.com/protocol (v1: initialize → session/new | session/load → session/prompt;
// session/update notifications; session/request_permission; newline-delimited JSON-RPC on stdio).
// We offer no fs/terminal capabilities; tool permissions follow least privilege (sdk mayEdit), like the CLI modules.
import { tmpdir } from 'node:os';
import type { Ctx, Environment, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { mayEdit, parseJson } from '@agent-spaghetti/sdk';

export const ACP_VERSION = 1;
const SAFE = new Set(['read', 'search', 'think', 'fetch']);   // tool kinds that change nothing
type Msg = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
type Option = { optionId: string; kind: string };

/** Which permission option to pick for a tool call; null = cancel (no fitting option). */
export function permissionChoice(req: Pick<RunRequest, 'cwd' | 'kind'>, toolKind: string | undefined, options: Option[]): string | null {
  const allow = SAFE.has(toolKind ?? 'other') || mayEdit(req);
  const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const k of order) { const o = options.find(x => x.kind === k); if (o) return o.optionId; }
  return null;
}

/** A line-at-a-time queue the process's stdin reads from. */
function outbox() {
  const q: string[] = []; let wake: (() => void) | null = null, closed = false;
  return {
    send(m: object) { q.push(JSON.stringify({ jsonrpc: '2.0', ...m })); wake?.(); },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) { if (q.length) { yield q.shift()!; continue; } if (closed) return; await new Promise<void>(r => { wake = r; }); wake = null; }
    },
  };
}

/** One task: a new session (or `req.session` loaded, when the agent can), one prompt, its updates as RunEvents. */
export async function* acpRun(env: Environment, program: string, args: string[], req: RunRequest, ctx: Pick<Ctx, 'signal' | 'runId'>): AsyncIterable<RunEvent> {
  const out = outbox(), cwd = req.cwd ?? tmpdir();
  let phase: 'init' | 'session' | 'prompt' = 'init', session = req.session, text = '';
  out.send({ id: 1, method: 'initialize', params: { protocolVersion: ACP_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'agent-spaghetti' } } });
  try {
    for await (const line of env.execLines(program, args, { input: out, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) {
      const m = parseJson(line) as Msg | undefined;
      if (!m || typeof m !== 'object') continue;
      if (m.method === 'session/update') {                   // a loaded session replays its history first: only this turn counts
        const u = m.params?.update ?? {};
        if (phase !== 'prompt') continue;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { text += u.content.text; yield { type: 'text', text: u.content.text }; }
        else if (u.sessionUpdate === 'tool_call') yield { type: 'tool', name: String(u.kind ?? 'other'), summary: String(u.title ?? '').slice(0, 120) };
        continue;
      }
      if (m.method && m.id !== undefined) {                  // a request from the agent
        if (m.method === 'session/request_permission') {
          const choice = permissionChoice(req, m.params?.toolCall?.kind, m.params?.options ?? []);
          out.send({ id: m.id, result: { outcome: choice ? { outcome: 'selected', optionId: choice } : { outcome: 'cancelled' } } });
        } else out.send({ id: m.id, error: { code: -32601, message: `${m.method} is not offered` } });
        continue;
      }
      if (m.error) { yield { type: 'error', message: `${phase === 'init' ? 'initialize' : phase === 'session' ? 'session' : 'prompt'}: ${m.error.message ?? 'failed'}` }; return; }
      if (m.id === 1) {
        if (session && !m.result?.agentCapabilities?.loadSession) { yield { type: 'error', message: 'this agent cannot continue a session (no session/load)' }; return; }
        phase = 'session';
        out.send(session ? { id: 2, method: 'session/load', params: { sessionId: session, cwd, mcpServers: [] } } : { id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
      } else if (m.id === 2) {
        session ??= String(m.result?.sessionId);
        yield { type: 'session', id: session };
        phase = 'prompt';
        out.send({ id: 3, method: 'session/prompt', params: { sessionId: session, prompt: [{ type: 'text', text: req.task }] } });
      } else if (m.id === 3) {
        const stop = String(m.result?.stopReason ?? 'end_turn');
        yield stop === 'end_turn' ? { type: 'done', result: text } : { type: 'error', message: stop === 'cancelled' ? 'cancelled' : `the agent stopped: ${stop}` };
        return;
      }
    }
    yield { type: 'error', message: 'the agent exited before answering' };
  } finally { out.close(); }
}
