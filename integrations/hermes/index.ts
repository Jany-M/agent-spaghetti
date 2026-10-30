// Hermes Agent module: a delegated task through `hermes chat --query-file - -Q --format stream-json` (JSONL), task on stdin;
// checked 2026-10-30 on v0.22.5 (`hermes chat --help`). Events: {type:"system",subtype:"init"}, {type:"text",text},
// {type:"result",session_id,exit_code,text,tokens:{input,output},error?}. Non-JSON lines (e.g. "Session: …") are ignored.
// Sessions: `--resume <session_id>` continues one. Read-only is not enforceable here (Hermes has no sandbox flag): the run uses the
// tool's own approval policy, and `--yolo` is never passed. Connecting: `hermes mcp add <name> --command <cmd> --args …` (the
// generic `-- <command…>` form of speaks.mcpCli does not fit it), so the module does it. Backslash paths make its probe fail: args go in with '/'.
// It also asks "enable all tools?" on stdin.
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { parseJson, programOf } from '@agent-spaghetti/sdk';

const SERVER_NAME = 'agent-spaghetti';

export function hermesArgs(req: RunRequest): string[] {
  return ['chat', '--query-file', '-', '-Q', '--format', 'stream-json', ...(req.model ? ['--model', req.model] : []), ...(req.session ? ['--resume', req.session] : [])];
}
/** One stream-json line → run events. */
export function hermesEvents(line: string): RunEvent[] {
  const j = parseJson(line) as any;
  if (!j || typeof j !== 'object') return [];
  if (j.type === 'text' && j.text) return [{ type: 'text', text: String(j.text) }];
  if (j.type !== 'result') return [];
  const out: RunEvent[] = [];
  if (typeof j.session_id === 'string' && j.session_id) out.push({ type: 'session', id: j.session_id });
  out.push({ type: 'usage', inputTokens: j.tokens?.input, outputTokens: j.tokens?.output });
  out.push(j.error || j.exit_code ? { type: 'error', message: String(j.error ?? `exit code ${j.exit_code}`) } : { type: 'done', result: String(j.text ?? '') });
  return out;
}
export const hermesModule: IntegrationModule = {
  resumes: true,
  async *run(env, det, req, ctx) {
    const exe = programOf(det, 'hermes');
    if (!exe) throw new Error('Hermes Agent not found');
    for await (const line of env.execLines(exe, hermesArgs(req), { input: req.task, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) yield* hermesEvents(line);
  },
  async connect(env, det, cli, on, dryRun) {
    const exe = programOf(det, 'hermes');
    if (!exe) throw new Error('hermes: its program was not found');
    const remove = ['mcp', 'remove', SERVER_NAME], add = ['mcp', 'add', SERVER_NAME, '--command', cli.command, '--args', ...cli.args.map(a => a.replaceAll('\\', '/')), 'mcp', '--as', 'hermes'];
    if (!dryRun) {
      await env.exec(exe, remove, { timeoutMs: 30000 });
      // its probe asks "enable all tools?" on stdin; EOF on a failed probe's save prompt cancels (nothing broken is saved)
      const r = on ? await env.exec(exe, add, { timeoutMs: 90000, input: 'Y\n' }) : null;
      if (r && r.code !== 0) throw new Error(`hermes mcp add failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    }
    return { description: `${on ? 'add' : 'remove'} the ${SERVER_NAME} MCP server with the tool's own CLI`, changes: [`${exe} ${(on ? add : remove).join(' ')}`], applied: !dryRun };
  },
};
