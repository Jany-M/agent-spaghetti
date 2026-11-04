// Kilo module: a delegated task through `kilo run --format json` (one JSON event per line), task on stdin; checked live 2026-11-04
// on Kilo 7.8.17 (`kilo run --help`). Its ACP mode (`kilo acp`) answers initialize and session/new but never streams a prompt's
// answer on that version, so tasks go through `run`. Events: {type:"step_start"|"text"|"tool_use"|"step_finish"|"error", sessionID,
// part:{text | tool, state:{title} | tokens:{input,output}, cost}}. Sessions: `-s <sessionID>` continues one. Edits: `--auto`
// (approve what its permission rules do not deny) only with a working folder and an editing kind (sdk mayEdit), else its own rules.
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { mayEdit, parseJson, programOf } from '@agent-spaghetti/sdk';

export function kiloArgs(req: RunRequest): string[] {
  return ['run', '--format', 'json', ...(req.model ? ['-m', req.model] : []), ...(req.session ? ['-s', req.session] : []), ...(mayEdit(req) ? ['--auto'] : [])];
}
/** One JSON line → run events (the session id once, from its first event). */
export function kiloEvents(line: string, seen: { session?: string }): RunEvent[] {
  const j = parseJson(line) as any;
  if (!j || typeof j !== 'object') return [];
  const out: RunEvent[] = [];
  if (!seen.session && typeof j.sessionID === 'string') { seen.session = j.sessionID; out.push({ type: 'session', id: j.sessionID }); }
  const p = j.part ?? {};
  if (j.type === 'text' && p.text) out.push({ type: 'text', text: String(p.text) });
  else if (j.type === 'tool_use') out.push({ type: 'tool', name: String(p.tool ?? 'tool'), summary: String(p.state?.title ?? '').slice(0, 120) });
  else if (j.type === 'step_finish' && p.tokens) out.push({ type: 'usage', inputTokens: p.tokens.input, outputTokens: p.tokens.output, costUsd: p.cost });
  else if (j.type === 'error') out.push({ type: 'error', message: String(j.error?.data?.message ?? j.error?.message ?? j.error?.name ?? 'failed') });
  return out;
}
export const kiloModule: IntegrationModule = {
  resumes: true,
  async *run(env, det, req, ctx) {
    const exe = programOf(det, 'kilo');
    if (!exe) throw new Error('Kilo CLI not found (Kilo Desktop bundles one)');
    const seen = {}, text: string[] = [];
    let failed = false, input = 0, output = 0, cost = 0;
    for await (const line of env.execLines(exe, kiloArgs(req), { input: req.task, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) {
      for (const e of kiloEvents(line, seen)) {
        if (e.type === 'usage') { input += e.inputTokens ?? 0; output += e.outputTokens ?? 0; cost += e.costUsd ?? 0; continue; }   // one total per run
        if (e.type === 'text') text.push(e.text);
        if (e.type === 'error') failed = true;
        yield e;
      }
    }
    yield { type: 'usage', inputTokens: input, outputTokens: output, costUsd: cost };
    if (!failed) yield { type: 'done', result: text.join('\n\n') };
  },
};
