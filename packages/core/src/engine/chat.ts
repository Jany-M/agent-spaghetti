// Chat injection (ADR 0010 §2): the task goes into a tool's own chat (e.g. `code chat -m agent -r … -`, checked 2026-10-17 at
// https://code.visualstudio.com/docs/configure/command-line), with a footer asking its agent to call `report` when done.
// The launch runs where the tool is (actions.ts runHere); the runner then waits for the report (or the deadline).
import type { Environment, RunRequest } from '@agent-spaghetti/sdk';

/** The prompt argument: inert words only (Windows .cmd shims refuse quotes and the like); the task itself goes on stdin. */
export const CHAT_PROMPT = 'Do the task in the attached text. It comes from Agent Spaghetti';
/** What the chat's agent must do with its result; a report run (a result handed back) asks for nothing. */
export const chatTask = (req: RunRequest, runId: number) => req.kind === 'report' ? req.task
  : `${req.task}\n\n---\nWhen you have finished, call the agent-spaghetti MCP tool \`report\` with run_id ${runId} and your complete result as \`result\``
    + ` (status "failed" if you could not do it). To hand part of the work to another tool, use \`delegate\`.`;

export async function chatLaunch(env: Environment, exe: string, command: string[], task: string): Promise<void> {
  const r = await env.exec(exe, [...command, CHAT_PROMPT, '-'], { input: task, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`could not open the chat: ${(r.stderr || r.stdout).trim().slice(-300) || `exit ${r.code}`}`);
}
