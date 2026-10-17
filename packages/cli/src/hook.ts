// `agent-spaghetti hook <client>`: run by a client's prompt hooks. Pure decisions, thin I/O in index.ts.
// A prompt `>>target[:model] [>>next …] task` goes to that target (and the next ones) instead of the client's model; the
// workspace and attached files go with it. Every other event only reports metadata (never prompt, response or file content).
// Hook shapes: Cursor beforeSubmitPrompt (https://cursor.com/docs/hooks), Claude Code UserPromptSubmit
// (https://code.claude.com/docs/en/hooks: block = {"decision":"block","reason"}), checked 2026-10-17. Cursor also runs Claude Code's
// hooks (https://cursor.com/docs/reference/third-party-hooks, on by default). A client that runs hooks names itself in the input
// (`<client>_version`, e.g. Cursor's `cursor_version`); a hook installed for another client stays out, the client's own hook answers.
import { parseHop, type RunRequest } from '@agent-spaghetti/sdk';

export const PREFIX = '>>';
const META = ['conversation_id', 'session_id', 'generation_id', 'tool_name', 'mcp_server_name', 'status', 'model'];
/** How each client's prompt hook passes a prompt on, or stops it with a message for the user. */
const PROMPT_EVENTS: Record<string, { pass: Record<string, unknown>; block(message: string): Record<string, unknown> }> = {
  beforeSubmitPrompt: { pass: { continue: true }, block: m => ({ continue: false, user_message: m }) },
  UserPromptSubmit: { pass: {}, block: m => ({ decision: 'block', reason: m }) },
};
export type HookPlan =
  | { delegate: RunRequest & { resultDir?: string }; block(message: string): Record<string, unknown> }
  | { reply: Record<string, unknown>; report?: { event: string; data: Record<string, unknown> } };

/** `>>a[:m] >>b … task` → the first hop, the next ones and the task; null when the prompt does not start with the prefix. */
export function parsePrefix(prompt: string): { target: string; model?: string; then: string[]; task: string } | null {
  const m = /^((?:>>\s*\S+\s+)+)([\s\S]+)$/.exec(prompt.trimStart());
  if (!m) return null;
  const [first, ...then] = m[1].split(PREFIX).map(x => x.trim()).filter(Boolean);
  return { ...parseHop(first), then, task: m[2].trim() };
}

export function planHook(input: Record<string, any>, client = 'client'): HookPlan {
  const runner = Object.keys(input).find(k => /^[a-z]+_version$/.test(k))?.slice(0, -'_version'.length);
  if (runner && runner !== client) return { reply: {} };
  const event = String(input.hook_event_name ?? '');
  const report = { event, data: Object.fromEntries(META.filter(k => typeof input[k] === 'string').map(k => [k, input[k]])) };
  if (event === 'beforeMCPExecution') return { reply: { permission: 'allow' }, report };
  const kind = PROMPT_EVENTS[event];
  if (!kind) return { reply: {}, report };
  const p = parsePrefix(String(input.prompt ?? ''));
  if (!p) return { reply: kind.pass, report };
  const root = Array.isArray(input.workspace_roots) ? String(input.workspace_roots[0] ?? '') : String(input.cwd ?? '');
  const files = (Array.isArray(input.attachments) ? input.attachments : []).filter((a: any) => a?.type === 'file' && a.file_path).map((a: any) => String(a.file_path));
  return { block: kind.block, delegate: { target: p.target, ...(p.model ? { model: p.model } : {}), ...(p.then.length ? { then: p.then } : {}), task: p.task,
    ...(files.length ? { files } : {}), reason: 'sent with the >> prefix', ...(root ? { cwd: root, resultDir: [root, '.agent-spaghetti', 'results'].join(root.includes('\\') ? '\\' : '/') } : {}) } };
}
