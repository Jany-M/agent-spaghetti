// OpenClaw pack commands, run inside the environment that hosts OpenClaw (via the env bundle: `agent-spaghetti-env.mjs openclaw …`).
//   patch [--dry-run]            machine-specific config patch (provider/model/timeout + park MCP servers)
//   info                         key=value lines: openclaw, config, state, agent (orchestrator id), workspace
//   block <AGENTS.md> <block.md> insert/replace the orchestrator section
//   mcp <command> [...]          ocmcp (list | search | on | off | off-all | probe | status)
//   health                       read-only wiring report; exit code = problems
// Finding OpenClaw and local LLM servers is the engine's job; the caller injects it (integrations never import core).
import type { Environment, Inspection, Manifest } from '@agent-spaghetti/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { openclawExe, openclawJson } from '../cli.ts';
import { applyBlock } from './block.ts';
import { buildPatch, pickBackend, stripProvider } from './config-patch.ts';
import { health } from './health.ts';
import { mcpMain } from './ocmcp.ts';
import { pickOrchestrator } from './orchestrator.ts';
import { configPath, dirOf, packDir, stripAnsi } from './state.ts';

export interface PackDeps {
  /** Runs the engine on this environment for the given integration ids. */
  inspect(ids: string[]): Promise<Inspection[]>;
  manifests: Manifest[];
  vars?: NodeJS.ProcessEnv;
  say?(s: string): void;
}
export const USAGE = 'usage: openclaw patch [--dry-run] | info | block <AGENTS.md> <block.md> | mcp <command> … | health';

export async function packMain(args: string[], env: Environment, deps: PackDeps): Promise<number> {
  const [cmd, ...a] = args;
  const say = deps.say ?? ((s: string) => process.stdout.write(s + '\n'));
  const vars = deps.vars ?? process.env;
  if (cmd === 'block') {
    if (a.length !== 2) { say(USAGE); return 1; }
    let doc = ''; try { doc = readFileSync(a[0], 'utf8'); } catch { /* new file */ }
    writeFileSync(a[0], applyBlock(doc, readFileSync(a[1], 'utf8'))); say('AGENTS.md orchestrator block applied'); return 0;
  }
  const oc = (await deps.inspect(['openclaw']))[0]?.detection;
  const exe = oc && openclawExe(oc);
  if (!exe) { say('openclaw not found (PATH, its default install folders). Install OpenClaw first.'); return 1; }
  switch (cmd) {
    case 'info': {
      const cfg = await configPath(env, exe, vars);
      const o = pickOrchestrator(await openclawJson(env, exe, ['agents', 'list']), vars.ORCH_AGENT_ID, vars.HOME);
      if (!cfg || !o) { say('OpenClaw is not set up (no config or no agents); run `openclaw onboard` first'); return 1; }
      say(Object.entries({ openclaw: exe, config: cfg, state: dirOf(cfg), agent: o.id, workspace: o.workspace || `${dirOf(cfg)}/workspace` }).map(([k, v]) => `${k}=${v}`).join('\n'));
      return 0;
    }
    case 'mcp': { const cfg = await configPath(env, exe, vars); return mcpMain(a[0] ?? '', a.slice(1), { env, exe, pack: cfg && packDir(cfg), vars, say }); }
    case 'health': return health(env, exe, say);
    case 'patch': {
      const dry = a.includes('--dry-run');
      const baseOf = (id: string) => deps.manifests.find(m => m.id === id)?.speaks?.openai?.base;
      const backendIds = deps.manifests.filter(m => m.roles.includes('backend') && m.speaks?.openai).map(m => m.id);
      const detect = async () => pickBackend((await deps.inspect(backendIds)).flatMap(i => i.backends), baseOf);
      let patch = await buildPatch({ env, exe, vars, say, detect });
      if (!Object.keys(patch).length) { say('nothing machine-specific to change'); return 0; }
      const apply = (p: object, check: boolean) => env.exec(exe, ['config', 'patch', '--stdin', ...(check ? ['--dry-run'] : [])], { input: JSON.stringify(p), timeoutMs: 60000 });
      if ((await apply(patch, true)).code !== 0) { say('note: provider block rejected by schema; applying without it'); patch = stripProvider(patch); }
      const r = await apply(patch, dry);
      say(stripAnsi(r.stdout + r.stderr).trimEnd());
      return r.code === 0 ? 0 : 1;
    }
  }
  say(USAGE); return 1;
}
