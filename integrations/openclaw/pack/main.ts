// OpenClaw pack commands for agents and people inside the distro (installed by `setup` as `ocmcp` and
// `agent-spaghetti-healthcheck`; they run `agent-spaghetti-env.mjs openclaw …`):
//   mcp <command> [...]   ocmcp (list | search | on | off | off-all | probe | status)
//   health                read-only wiring report; exit code = problems
// Finding OpenClaw is the engine's job; the caller injects it (integrations never import core).
import type { Environment, Inspection } from '@agent-spaghetti/sdk';
import { testLines } from '@agent-spaghetti/sdk';
import { openclawExe } from '../cli.ts';
import { healthSteps } from './health.ts';
import { mcpMain } from './ocmcp.ts';
import { configPath, packDir } from './state.ts';

export interface PackDeps {
  /** Runs the engine on this environment for the given integration ids. */
  inspect(ids: string[]): Promise<Inspection[]>;
  vars?: NodeJS.ProcessEnv;
  say?(s: string): void;
}
export const USAGE = 'usage: openclaw mcp <command> … | health';

export async function packMain(args: string[], env: Environment, deps: PackDeps): Promise<number> {
  const say = deps.say ?? ((s: string) => process.stdout.write(s + '\n'));
  try { return await run(args, env, deps, say); }
  catch (e) { say(`ERROR: ${(e as Error).message}`); return 1; }   // a clear message, never a stack trace
}
async function run([cmd, ...a]: string[], env: Environment, deps: PackDeps, say: (s: string) => void): Promise<number> {
  const vars = deps.vars ?? process.env;
  if (cmd !== 'mcp' && cmd !== 'health') { say(USAGE); return 1; }
  const oc = (await deps.inspect(['openclaw']))[0]?.detection;
  const exe = oc && openclawExe(oc);
  if (!exe) { say('openclaw not found (PATH, its default install folders). Install OpenClaw first.'); return 1; }
  if (cmd === 'mcp') { const cfg = await configPath(env, exe, vars); return mcpMain(a[0] ?? '', a.slice(1), { env, exe, pack: cfg && packDir(cfg), vars, say }); }
  const steps = await healthSteps(env, exe, vars.HOME);
  testLines({ ok: steps.every(s => s.ok), steps }).forEach(l => say(l));
  return steps.filter(s => !s.ok).length;
}
