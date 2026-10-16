// Read-only wiring report: `setup` check in the Tools panel, `agent-spaghetti-healthcheck` in the distro.
// Reads only non-secret config paths through `openclaw config get`; never opens the config file.
import type { Environment, TestStep } from '@agent-spaghetti/sdk';
import { openclawJson } from '../cli.ts';
import { splitModelRef } from '../index.ts';
import { endpointOk, get, primaryModel, providers } from './config-patch.ts';
import { pickOrchestrator } from './orchestrator.ts';
import { BEGIN_PREFIX } from './block.ts';
import { stripAnsi } from './state.ts';

export const ROLE_AGENTS = ['worker', 'toolsmith', 'verifier'];
export const HANDOFF_WORDS = ['sessions_spawn', 'sessions_yield', 'jobctl brief'];

export async function healthSteps(env: Environment, exe: string, home = ''): Promise<TestStep[]> {
  const steps: TestStep[] = [];
  const check = (name: string, ok: boolean, detail = '') => { steps.push({ name, ok, detail, ms: 0 }); };
  const d = { env, exe };
  const gw = await env.exec(exe, ['gateway', 'status'], { timeoutMs: 30000 });
  check('gateway service up', /running|active|enabled/i.test(stripAnsi(gw.stdout + gw.stderr)));
  const [prov, primary, defaults, entries, tools, mcp, list] = await Promise.all([providers(d), primaryModel(d),
    get(d, 'agents.defaults'), get(d, 'agents.entries'), get(d, 'tools'), get(d, 'mcp.servers'), openclawJson(env, exe, ['agents', 'list'])]);
  const df = (defaults ?? {}) as any, en = (entries ?? {}) as Record<string, any>;
  const orch = pickOrchestrator(list, home);
  check('primary model set', !!primary, primary ?? 'none');
  const pid = splitModelRef(primary, Object.keys(prov)).provider;
  const p = pid ? prov[pid] : undefined;
  if (p?.baseUrl) {
    check('LLM endpoint answers', await endpointOk(d, p), p.baseUrl);
    check('provider timeoutSeconds >= 300', (p.timeoutSeconds ?? 0) >= 300, String(p.timeoutSeconds ?? 'unset'));
  } else if (primary) check('LLM endpoint', true, `none to probe (managed/hosted provider '${pid}')`);
  check('maxConcurrent <= 2', (df.maxConcurrent ?? 99) <= 2);
  check('subagents.maxConcurrent == 1', df.subagents?.maxConcurrent === 1);
  check('tools.toolSearch == false', (tools as any)?.toolSearch === false);
  check(`agents ${ROLE_AGENTS.join('/')} exist`, ROLE_AGENTS.every(r => r in en));
  check('orchestrator uses the minimal profile', en[orch?.id ?? '']?.tools?.profile === 'minimal', orch?.id ?? 'no agent');
  const on = Object.entries((mcp ?? {}) as Record<string, any>).filter(([, v]) => v?.enabled !== false).map(([n]) => n);
  check('MCP servers parked', on.length <= 2, `on: ${on.join(', ') || 'none'}`);
  const doc = orch?.workspace ? await env.readFile(`${orch.workspace}/AGENTS.md`) : null;
  check('AGENTS.md has the orchestrator block', !!doc?.includes(BEGIN_PREFIX));
  check('hand-off text intact', !!doc && HANDOFF_WORDS.every(w => doc.includes(w)), HANDOFF_WORDS.join(', '));
  for (const t of ['jobctl', 'ocmcp']) check(`${t} on PATH`, !!(await env.which(t)));
  const j = await env.exec('jobctl', ['status'], { timeoutMs: 30000 });
  check('jobs', true, j.code === 0 && j.stdout.trim() ? j.stdout.trim().split('\n').join('; ') : 'no jobs');
  return steps;
}
