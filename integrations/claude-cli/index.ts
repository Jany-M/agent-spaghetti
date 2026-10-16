// Claude Code CLI module: runs a delegated task headless (`claude -p`, stream-json), checked 2026-10-16 against
// https://code.claude.com/docs/en/headless . The task goes through stdin (never the command line).
// Least privilege: read-only (dontAsk) unless the request names a working folder and the kind changes files.
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { parseJsonLoose } from '@agent-spaghetti/sdk';

const EDIT_KINDS = new Set(['code-edit', 'refactor', 'tests', 'docs']);
export function claudeArgs(req: RunRequest): string[] {
  const edits = !!req.cwd && EDIT_KINDS.has(req.kind ?? 'other');
  return ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', edits ? 'acceptEdits' : 'dontAsk', '--permission-prompts', 'none',
    ...(req.model ? ['--model', req.model] : [])];
}
/** stream-json lines → run events (main conversation only; subagent messages carry a parent_tool_use_id). */
export function toEvents(line: string): RunEvent[] {
  const j = parseJsonLoose(line) as any;
  if (!j || typeof j !== 'object') return [];
  if (j.type === 'assistant' && !j.parent_tool_use_id) return (j.message?.content ?? []).flatMap((c: any): RunEvent[] =>
    c?.type === 'text' && c.text ? [{ type: 'text', text: c.text }]
      : c?.type === 'tool_use' ? [{ type: 'tool', name: String(c.name), summary: JSON.stringify(c.input ?? {}).slice(0, 120) }] : []);
  if (j.type === 'result') return [
    { type: 'usage', inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens, costUsd: j.total_cost_usd },
    j.is_error ? { type: 'error', message: String(j.result ?? j.subtype ?? 'failed') } : { type: 'done', result: String(j.result ?? '') }];
  return [];
}
const exeOf = (det: { installs: Array<{ via: string; path?: string }> }) => det.installs.find(i => (i.via === 'bin' || i.via === 'path') && i.path)?.path;
export const claudeCliModule: IntegrationModule = {
  /** `claude mcp add|remove --scope user` is the documented way (https://code.claude.com/docs/en/mcp, checked 2026-10-16). */
  async connect(env, det, cli, on, dryRun) {
    const exe = exeOf(det);
    if (!exe) throw new Error('Claude Code CLI not found');
    const remove = ['mcp', 'remove', '--scope', 'user', 'agent-spaghetti'];
    const add = ['mcp', 'add', '--scope', 'user', 'agent-spaghetti', '--', cli.command, ...cli.args, 'mcp', '--as', 'claude-cli'];
    if (!dryRun) {
      await env.exec(exe, remove, { timeoutMs: 30000 });   // also replaces an older entry
      const r = on ? await env.exec(exe, add, { timeoutMs: 30000 }) : { code: 0, stdout: '', stderr: '' };
      if (r.code !== 0) throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    }
    return { description: `${on ? 'add' : 'remove'} the agent-spaghetti MCP server ${on ? 'to' : 'from'} Claude Code (user scope)`,
      changes: [`claude ${(on ? add : remove).join(' ')}`], applied: !dryRun };
  },
  async *run(env, det, req, ctx) {
    const exe = exeOf(det);
    if (!exe) throw new Error('Claude Code CLI not found');
    for await (const line of env.execLines(exe, claudeArgs(req), { input: req.task, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) yield* toEvents(line);
  },
};
