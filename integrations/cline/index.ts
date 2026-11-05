// Cline module: a delegated task through Cline's CLI in JSON mode (`cline --json [--plan] <prompt>`; the Cline app bundles it as
// cline-cli); checked live 2026-11-05 on 3.0.74 (`cline --help`). Its ACP mode (`--acp`) refuses sessions with "Authentication
// required" when Cline uses an API-key provider (e.g. OpenRouter), and JSON mode does not read a piped task, so the task is the
// prompt argument. Events (one JSON per line): {type:"agent_event", event:{type:"content_start", contentType:"text", text}} deltas,
// {type:"run_result", finishReason, text, usage:{inputTokens,outputTokens,totalCost}}, {type:"error", message}. Read-only work runs
// in plan mode (no edits); act mode (Cline auto-approves its tools) only with a working folder and an editing kind (sdk mayEdit).
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { mayEdit, parseJson, programOf } from '@agent-spaghetti/sdk';

export function clineArgs(req: RunRequest): string[] {
  return ['--json', ...(mayEdit(req) ? [] : ['--plan']), ...(req.cwd ? ['--cwd', req.cwd] : []), ...(req.model ? ['--model', req.model] : []), '--', req.task];
}
/** One JSON line → run events. */
export function clineEvents(line: string): RunEvent[] {
  const j = parseJson(line) as any;
  if (!j || typeof j !== 'object') return [];
  const e = j.event ?? {};
  if (j.type === 'agent_event' && e.type === 'content_start' && e.contentType === 'text' && e.text) return [{ type: 'text', text: String(e.text) }];
  if (j.type === 'error') return [{ type: 'error', message: String(j.message ?? 'failed') }];
  if (j.type !== 'run_result') return [];
  const u = j.usage ?? {};
  return [{ type: 'usage', inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.totalCost },
    j.finishReason === 'completed' ? { type: 'done', result: String(j.text ?? '') } : { type: 'error', message: `Cline stopped: ${j.finishReason}` }];
}
export const clineModule: IntegrationModule = {
  async *run(env, det, req, ctx) {
    const exe = programOf(det, 'cline');
    if (!exe) throw new Error('Cline CLI not found (the Cline app bundles cline-cli)');
    for await (const line of env.execLines(exe, clineArgs(req), { cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) yield* clineEvents(line);
  },
};
