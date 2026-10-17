// Claude Code CLI module: runs a delegated task headless (`claude -p`, stream-json), checked 2026-10-16 against
// https://code.claude.com/docs/en/headless . The task goes through stdin (never the command line).
// Least privilege: read-only (dontAsk) unless the request names a working folder and the kind changes files.
// Connecting is data (manifest speaks.mcpCli: `claude mcp add --scope user`, https://code.claude.com/docs/en/mcp).
// Sessions: the init event carries `session_id`; `--resume <id>` continues it (results handed back, ADR 0010).
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { mayEdit, parseJsonLoose, programOf } from '@agent-spaghetti/sdk';

export function claudeArgs(req: RunRequest): string[] {
  return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mayEdit(req) ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none',
    ...(req.model ? ['--model', req.model] : []), ...(req.session ? ['--resume', req.session] : [])];
}
/** stream-json lines → run events (main conversation only; subagent messages carry a parent_tool_use_id). */
export function toEvents(line: string): RunEvent[] {
  const j = parseJsonLoose(line) as any;
  if (!j || typeof j !== 'object') return [];
  if (j.type === 'system' && j.subtype === 'init' && typeof j.session_id === 'string') return [{ type: 'session', id: j.session_id }];
  if (j.type === 'assistant' && !j.parent_tool_use_id) return (j.message?.content ?? []).flatMap((c: any): RunEvent[] =>
    c?.type === 'text' && c.text ? [{ type: 'text', text: c.text }]
      : c?.type === 'tool_use' ? [{ type: 'tool', name: String(c.name), summary: JSON.stringify(c.input ?? {}).slice(0, 120) }] : []);
  if (j.type === 'result') return [
    { type: 'usage', inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens, costUsd: j.total_cost_usd },
    j.is_error ? { type: 'error', message: String(j.result ?? j.subtype ?? 'failed') } : { type: 'done', result: String(j.result ?? '') }];
  return [];
}
export const claudeCliModule: IntegrationModule = {
  resumes: true,
  async *run(env, det, req, ctx) {
    const exe = programOf(det, 'claude');
    if (!exe) throw new Error('Claude Code CLI not found');
    for await (const line of env.execLines(exe, claudeArgs(req), { input: req.task, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) yield* toEvents(line);
  },
};
