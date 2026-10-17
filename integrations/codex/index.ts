// Codex CLI module: a delegated task through `codex exec --json` (JSONL events), task on stdin (`-`); checked 2026-10-17 against
// https://learn.chatgpt.com/docs/non-interactive-mode . Read-only sandbox unless a working folder and an editing kind (sdk mayEdit).
// Sessions: `thread.started` carries the thread id; `codex exec … resume <id> -` continues it. Connecting is data (speaks.mcpCli).
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { mayEdit, parseJson, programOf } from '@agent-spaghetti/sdk';

export function codexArgs(req: RunRequest): string[] {
  return ['exec', '--json', '--skip-git-repo-check', '--sandbox', mayEdit(req) ? 'workspace-write' : 'read-only', ...(req.model ? ['--model', req.model] : []),
    ...(req.session ? ['resume', req.session] : []), '-'];
}
/** JSONL events → run events. */
export function codexEvents(line: string): RunEvent[] {
  const j = parseJson(line) as any;
  if (!j || typeof j !== 'object') return [];
  const item = j.item ?? {};
  switch (j.type) {
    case 'thread.started': return typeof j.thread_id === 'string' ? [{ type: 'session', id: j.thread_id }] : [];
    case 'item.completed':
      return item.type === 'agent_message' && item.text ? [{ type: 'text', text: item.text }]
        : item.type && item.type !== 'reasoning' ? [{ type: 'tool', name: String(item.type), summary: String(item.command ?? item.server ?? item.query ?? '').slice(0, 120) }] : [];
    case 'turn.completed': return [{ type: 'usage', inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens }];
    case 'turn.failed': return [{ type: 'error', message: String(j.error?.message ?? 'the turn failed') }];
    case 'error': return [{ type: 'error', message: String(j.message ?? 'failed') }];
    default: return [];
  }
}
export const codexModule: IntegrationModule = {
  resumes: true,
  async *run(env, det, req, ctx) {
    const exe = programOf(det, 'codex');
    if (!exe) throw new Error('Codex CLI not found');
    let last = '', failed = false;
    for await (const line of env.execLines(exe, codexArgs(req), { input: req.task, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) {
      for (const e of codexEvents(line)) { if (e.type === 'text') last = e.text; if (e.type === 'error') failed = true; yield e; }
    }
    if (!failed) yield { type: 'done', result: last };   // the final agent message is the answer
  },
};
