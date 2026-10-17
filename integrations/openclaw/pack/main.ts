// OpenClaw's commands inside its environment (module hook `cli`; the env bundle runs them as `tool openclaw …`, and setup
// installs them as `ocmcp` and `agent-spaghetti-healthcheck`):
//   mcp <command> [...]   ocmcp (list | search | on | off | off-all | probe | status)
//   health                read-only wiring report; exit code = problems
import type { Detection, Environment } from '@agent-spaghetti/sdk';
import { testLines } from '@agent-spaghetti/sdk';
import { openclawExe } from '../cli.ts';
import { healthSteps } from './health.ts';
import { mcpMain } from './ocmcp.ts';
import { configPath, packDir } from './state.ts';

export const USAGE = 'usage: tool openclaw mcp <command> … | health';

export async function packCli(env: Environment, det: Detection, [cmd, ...a]: string[], say: (s: string) => void, vars: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    if (cmd !== 'mcp' && cmd !== 'health') { say(USAGE); return 1; }
    const exe = openclawExe(det);
    if (!exe) { say('openclaw not found (PATH, its default install folders). Install OpenClaw first.'); return 1; }
    if (cmd === 'mcp') { const cfg = await configPath(env, exe, vars); return mcpMain(a[0] ?? '', a.slice(1), { env, exe, pack: cfg && packDir(cfg), vars, say }); }
    const steps = await healthSteps(env, exe, vars.HOME);
    testLines({ ok: steps.every(s => s.ok), steps }).forEach(l => say(l));
    return steps.filter(s => !s.ok).length;
  } catch (e) { say(`ERROR: ${(e as Error).message}`); return 1; }   // a clear message, never a stack trace
}
