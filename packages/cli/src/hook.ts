// `agent-spaghetti hook <client>`: run by the client's hooks (Cursor, ADR 0006). Pure decisions, thin I/O in index.ts.
// beforeSubmitPrompt: a prompt starting with `>>target ` goes to that target instead of the client's model (true bypass);
// every other event only reports metadata (never prompt, response or file content) and never blocks.
// Hook shapes: https://cursor.com/docs/hooks (checked 2026-10-16).
import type { RunRequest } from '@agent-spaghetti/sdk';

export const PREFIX = '>>';
export type HookPlan =
  | { reply: Record<string, unknown>; delegate: RunRequest & { resultDir?: string } }
  | { reply: Record<string, unknown>; report?: { event: string; data: Record<string, unknown> } };
const META = ['conversation_id', 'session_id', 'generation_id', 'tool_name', 'mcp_server_name', 'status', 'model'];

export function planHook(input: Record<string, any>): HookPlan {
  const event = String(input.hook_event_name ?? '');
  const report = { event, data: Object.fromEntries(META.filter(k => typeof input[k] === 'string').map(k => [k, input[k]])) };
  if (event === 'beforeMCPExecution') return { reply: { permission: 'allow' }, report };
  if (event !== 'beforeSubmitPrompt') return { reply: {}, report };
  const prompt = String(input.prompt ?? '');
  const m = prompt.startsWith(PREFIX) ? /^>>\s*(\S+)\s+([\s\S]+)$/.exec(prompt) : null;
  if (!m) return { reply: { continue: true }, report };
  const root = Array.isArray(input.workspace_roots) ? String(input.workspace_roots[0] ?? '') : '';
  const files = (Array.isArray(input.attachments) ? input.attachments : []).filter((a: any) => a?.type === 'file' && a.file_path).map((a: any) => String(a.file_path));
  return { reply: { continue: false }, delegate: { target: m[1], task: files.length ? `${m[2].trim()}\n\nFiles: ${files.join(', ')}` : m[2].trim(),
    reason: 'sent with the >> prefix', ...(root ? { cwd: root, resultDir: `${root}/.agent-spaghetti/results` } : {}) } };
}
