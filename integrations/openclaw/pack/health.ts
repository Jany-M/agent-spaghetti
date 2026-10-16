// Read-only wiring report (port of healthcheck.sh). Returns the number of problems (= exit code).
// Reads only non-secret config paths through `openclaw config get`; never opens the config file.
import type { Environment } from '@agent-spaghetti/sdk';
import { openclawJson } from '../cli.ts';
import { splitModelRef } from '../index.ts';
import { endpointOk, get, primaryModel, providers } from './config-patch.ts';
import { pickOrchestrator } from './orchestrator.ts';
import { BEGIN_PREFIX } from './block.ts';
import { stripAnsi } from './state.ts';

export const ROLE_AGENTS = ['worker', 'toolsmith', 'verifier'];
export const HANDOFF_WORDS = ['sessions_spawn', 'sessions_yield', 'jobctl brief'];

export async function health(env: Environment, exe: string, say: (s: string) => void): Promise<number> {
  let bad = 0;
  const check = (name: string, ok: boolean) => { say(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}`); if (!ok) bad++; };
  const d = { env, exe };
  say('gateway');
  const gw = await env.exec(exe, ['gateway', 'status'], { timeoutMs: 30000 });
  check('gateway service up', /running|active|enabled/i.test(stripAnsi(gw.stdout + gw.stderr)));

  say('config');
  const [prov, primary, defaults, entries, tools, mcp, list] = await Promise.all([providers(d), primaryModel(d),
    get(d, 'agents.defaults'), get(d, 'agents.entries'), get(d, 'tools'), get(d, 'mcp.servers'), openclawJson(env, exe, ['agents', 'list'])]);
  const df = (defaults ?? {}) as any, en = (entries ?? {}) as Record<string, any>;
  const orch = pickOrchestrator(list, undefined);
  check(`primary model set (${primary ?? 'none'})`, !!primary);
  const pid = splitModelRef(primary, Object.keys(prov)).provider;
  const p = pid ? prov[pid] : undefined;
  if (p?.baseUrl) {
    check(`LLM endpoint answers (${p.baseUrl})`, await endpointOk(d, p));
    check('provider timeoutSeconds >= 300', (p.timeoutSeconds ?? 0) >= 300);
  } else if (primary) check(`LLM endpoint: none to probe (managed/hosted provider '${pid}')`, true);
  check('maxConcurrent <= 2', (df.maxConcurrent ?? 99) <= 2);
  check('subagents.maxConcurrent == 1', df.subagents?.maxConcurrent === 1);
  check('tools.toolSearch == false', (tools as any)?.toolSearch === false);
  check(`agents ${ROLE_AGENTS.join('/')} exist`, ROLE_AGENTS.every(r => r in en));
  check(`orchestrator agent '${orch?.id}' uses minimal profile`, en[orch?.id ?? '']?.tools?.profile === 'minimal');
  const on = Object.entries((mcp ?? {}) as Record<string, any>).filter(([, v]) => v?.enabled !== false).map(([n]) => n);
  check(`MCP servers parked (on: ${on.join(', ') || 'none'})`, on.length <= 2);

  say('orchestrator files');
  const doc = orch?.workspace ? await env.readFile(`${orch.workspace}/AGENTS.md`) : null;
  check('AGENTS.md has orchestrator block', !!doc?.includes(BEGIN_PREFIX));
  check('hand-off text intact (tool names present)', !!doc && HANDOFF_WORDS.every(w => doc.includes(w)));
  for (const t of ['jobctl', 'ocmcp']) check(`${t} on PATH`, !!(await env.which(t)));

  say('jobs');
  const j = await env.exec('jobctl', ['status'], { timeoutMs: 30000 });
  say((j.code === 0 && j.stdout.trim() ? j.stdout.trimEnd() : 'no jobs').replace(/^/gm, '  '));
  say(bad ? `\n${bad} problem(s)` : '\nALL GOOD');
  return bad;
}
