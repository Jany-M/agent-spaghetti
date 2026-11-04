// Hermes Agent module: a delegated task through `hermes chat --query-file - -Q --format stream-json` (JSONL), task on stdin;
// checked 2026-10-30 on v0.22.5 (`hermes chat --help`). Events: {type:"system",subtype:"init"}, {type:"text",text},
// {type:"result",session_id,exit_code,text,tokens:{input,output},error?}. Non-JSON lines (e.g. "Session: …") are ignored.
// Sessions: `--resume <session_id>` continues one. Read-only is not enforceable here (Hermes has no sandbox flag): the run uses the
// tool's own approval policy, and `--yolo` is never passed. Connecting: `hermes mcp add <name> --command <cmd> --args …` (the
// generic `-- <command…>` form of speaks.mcpCli does not fit it), so the module does it. The real cause of earlier probe failures
// was the spawned probe child not finding the daemon (env/discovery), not path separators; no backslash conversion is applied.
// It asks "enable all tools?" on stdin; the add sequence feeds `Y` explicitly. Identity: shared server name 'agent-spaghetti' with '--as hermes'.
import type { IntegrationModule, RunEvent, RunRequest } from '@agent-spaghetti/sdk';
import { parseJson, programOf } from '@agent-spaghetti/sdk';

const SERVER_NAME = 'agent-spaghetti';
const CONFIG = '%LOCALAPPDATA%/hermes/config.yaml';
/** The agent-spaghetti block of Hermes' config.yaml: one YAML list item per args token; `enabled: false` is written when its probe fails. */
function serverBlock(yaml: string | null): { tokens: string[]; disabled: boolean } | null {
  const lines = (yaml ?? '').split(/\r?\n/), at = lines.findIndex(l => l.trim() === `${SERVER_NAME}:`);
  if (at < 0) return null;
  const indent = lines[at].search(/\S/), body: string[] = [];
  for (const l of lines.slice(at + 1)) { if (l.trim() && l.search(/\S/) <= indent) break; body.push(l); }
  return { tokens: body.map(l => /^\s*-\s+(.*?)\s*$/.exec(l)?.[1]).filter((t): t is string => t !== undefined).map(t => t.replace(/^(['"])(.*)\1$/, '$2')), disabled: body.some(l => /^\s*enabled:\s*false\b/i.test(l)) };
}
const isOurs = (a: string[]) => a.length >= 3 && a.slice(-3).join(' ') === 'mcp --as hermes';
/** The model server Hermes uses: `model.base_url` in config.yaml (its `hermes model` choice). */
export function modelBaseUrl(yaml: string | null): string | null {
  const lines = (yaml ?? '').split(/\r?\n/), at = lines.findIndex(l => /^model:\s*$/.test(l));
  if (at < 0) return null;
  for (const l of lines.slice(at + 1)) { if (l.trim() && !/^\s/.test(l)) break; const m = /^\s{1,4}base_url:\s*["']?([^"'\s#]+)/.exec(l); if (m) return m[1]; }
  return null;
}
const LOCAL = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i;

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
  /** Free when Hermes runs a model on this machine (its model.base_url is local), else the manifest's cost (paid). */
  async inspect(env, base) {
    const url = modelBaseUrl(await env.readFile(CONFIG).catch(() => null));
    return url && LOCAL.test(url) ? { ...base, detection: { ...base.detection, cost: 'free', why: `${base.detection.why}; its model runs locally (${url})` } } : base;
  },
  async *run(env, det, req, ctx) {
    const exe = programOf(det, 'hermes');
    if (!exe) throw new Error('Hermes Agent not found');
    for await (const line of env.execLines(exe, hermesArgs(req), { input: req.task, cwd: req.cwd, signal: ctx.signal,
      env: ctx.runId ? { AGENT_SPAGHETTI_PARENT_RUN: String(ctx.runId) } : undefined })) yield* hermesEvents(line);
  },
  async connect(env, det, cli, on, dryRun) {
    const exe = programOf(det, 'hermes');
    if (!exe) throw new Error('hermes: its program was not found');
    const remove = ['mcp', 'remove', SERVER_NAME], add = ['mcp', 'add', SERVER_NAME, '--command', cli.command, '--args', ...cli.args, 'mcp', '--as', 'hermes'];
    const line = (a: string[]) => [exe, ...a].join(' ');
    if (!on) return { description: `remove the ${SERVER_NAME} MCP server`, changes: [line(remove)], applied: false };
    const prior = await env.readFile(CONFIG).catch(() => null);
    const before = serverBlock(prior);
    const changes: string[] = [];
    if (before && isOurs(before.tokens) && !before.disabled)
      return { description: `${SERVER_NAME} is already connected as '--as hermes': nothing to do`, changes: [], applied: !dryRun };
    if (before) {
      const foreign = before.tokens[before.tokens.lastIndexOf('--as') + 1];
      changes.push(line(remove), ...(foreign && foreign !== 'hermes' ? [`replaces the existing identity '--as ${foreign}'`] : []));
    }
    changes.push(line(add));
    if (!dryRun) {
      if (before) await env.exec(exe, remove, { timeoutMs: 30000 });   // removed first, so the Overwrite prompt never appears
      const r = await env.exec(exe, add, { timeoutMs: 90000, input: 'Y\n' });   // 'Y' answers "enable all tools?"
      const after = serverBlock(await env.readFile(CONFIG).catch(() => null));
      const i = after ? after.tokens.indexOf('--as') : -1;
      if (r.code !== 0 || !after || after.disabled || i < 0 || after.tokens[i + 1] !== 'hermes') {
        if (prior !== null) await env.writeFile(CONFIG, prior).catch(() => {});
        throw new Error(`hermes mcp add verification failed (exit ${r.code}; entry missing, disabled or wrong identity): ${(r.stderr || r.stdout).trim().slice(-300)}`);
      }
    }
    return { description: `add the ${SERVER_NAME} MCP server with '--as hermes' (shared name)`, changes, applied: !dryRun };
  },
};
