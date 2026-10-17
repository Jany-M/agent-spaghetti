// `setup apply`: the OpenClaw workflow pack, applied in the environment that hosts the gateway.
// Idempotent; every step is reported (Tools → OpenClaw → Set up). Dry run: OpenClaw validates both patches, nothing is written.
import type { Cli, Environment, LocalModel, TestStep } from '@agent-spaghetti/sdk';
import { openclawJson } from '../cli.ts';
import { applyBlock } from './block.ts';
import { buildPatch, stripProvider } from './config-patch.ts';
import { packFile } from './files.ts';
import { ROLE_AGENTS } from './health.ts';
import { pickOrchestrator } from './orchestrator.ts';
import { configPath, dirOf, packDir, stripAnsi } from './state.ts';

export interface ApplyDeps { env: Environment; exe: string; dryRun: boolean; model: string; cli: Cli; localModels(): Promise<LocalModel[]> }
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
/** `ocmcp` and `agent-spaghetti-healthcheck` in the distro: agent-spaghetti's own pack commands. */
export const shim = (cli: Cli, cmd: string) => `#!/bin/sh\nexec ${[cli.command, ...cli.args, 'tool', 'openclaw', cmd].map(q).join(' ')} "$@"\n`;

export async function applySetup(d: ApplyDeps): Promise<TestStep[]> {
  const { env, exe, dryRun } = d, steps: TestStep[] = [];
  const run = async (cmd: string, args: string[], input?: string) => {
    const r = await env.exec(cmd, args, { input, timeoutMs: 120000 });
    if (r.code !== 0) throw new Error(`${cmd.split('/').pop()} ${args[0]} failed: ${stripAnsi(r.stderr || r.stdout).trim().slice(-300)}`);
    return stripAnsi(r.stdout).trim();
  };
  /** `checks`: the step only validates in a dry run, so it runs then too; the others are skipped. */
  const step = async (name: string, fn: () => Promise<string>, checks = false) => {
    const t0 = Date.now();
    try { steps.push({ name, ok: true, detail: dryRun && !checks ? 'skipped (dry run)' : await fn(), ms: Date.now() - t0 }); return true; }
    catch (e) { steps.push({ name, ok: false, detail: (e as Error).message, ms: Date.now() - t0 }); return false; }
  };
  const patch = (p: string, check = dryRun) => run(exe, ['config', 'patch', '--stdin', ...(check ? ['--dry-run'] : [])], p);
  if (env.kind === 'windows') return [{ name: 'OpenClaw found', ok: false, detail: 'set up OpenClaw where its gateway runs (WSL, Linux or macOS)', ms: 0 }];
  const home = await run('sh', ['-c', 'printf %s "$HOME"']);
  const cfg = await configPath(env, exe, { HOME: home });
  const orch = pickOrchestrator(await openclawJson(env, exe, ['agents', 'list']), home);
  if (!cfg || !orch) return [{ name: 'OpenClaw found', ok: false, detail: 'OpenClaw is not set up yet (no config or no agents): run `openclaw onboard` first', ms: 0 }];
  const state = dirOf(cfg), ws = orch.workspace || `${state}/workspace`, bin = `${packDir(cfg)}/bin`;
  await step('OpenClaw found', async () => `config ${cfg}; orchestrator: ${orch.id}`, true)
    && await step('backup', async () => {
      const dir = `${state}/agent-spaghetti-backups/${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await env.writeFile(`${dir}/openclaw.json`, (await env.readFile(cfg)) ?? '');
      const agents = await env.readFile(`${ws}/AGENTS.md`);
      if (agents !== null) await env.writeFile(`${dir}/AGENTS.md`, agents);
      await run('chmod', ['-R', 'go-rwx', `${state}/agent-spaghetti-backups`]);   // the config holds API keys
      return dir;
    })
    && await step('helpers installed', async () => {
      await env.remove(bin);                                                     // fresh every time: no stale helpers
      await env.writeFile(`${bin}/jobctl`, packFile('scripts/jobctl'));
      await env.writeFile(`${bin}/ocmcp`, shim(d.cli, 'mcp'));
      await env.writeFile(`${bin}/agent-spaghetti-healthcheck`, shim(d.cli, 'health'));
      const tools = ['jobctl', 'ocmcp', 'agent-spaghetti-healthcheck'];
      await run('chmod', ['755', ...tools.map(t => `${bin}/${t}`)]);
      await run('mkdir', ['-p', `${home}/.local/bin`, `${state}/jobs`]);
      for (const t of tools) await run('ln', ['-sf', `${bin}/${t}`, `${home}/.local/bin/${t}`]);
      return `${tools.join(', ')} in ~/.local/bin`;
    })
    && await step('workflow settings patch', async () => {
      await patch(packFile('config/orchestrator.patch.json5').replaceAll('{{STATE}}', state).replaceAll('{{ORCH}}', orch.id));
      return dryRun ? 'valid (dry run)' : 'applied';
    }, true)
    && await step('model patch', async () => {
      const said: string[] = [];
      let p = await buildPatch({ env, exe, model: d.model, detect: d.localModels, say: s => said.push(s) });
      if (!Object.keys(p).length) return 'nothing to change';
      if (await patch(JSON.stringify(p), true).then(() => false, () => true)) { said.push('provider block rejected by the schema; applied without it'); p = stripProvider(p); }
      await patch(JSON.stringify(p));
      return said.join('; ') || (dryRun ? 'valid (dry run)' : 'applied');
    }, true)
    && await step('role files', async () => {
      for (const r of ROLE_AGENTS) {
        await env.writeFile(`${state}/workspace-${r}/AGENTS.md`, packFile(`roles/${r}.AGENTS.md` as `roles/${'worker' | 'toolsmith' | 'verifier'}.AGENTS.md`));
        await run('mkdir', ['-p', `${state}/agents/${r}/agent`]);
      }
      return ROLE_AGENTS.join(', ');
    })
    && await step('orchestrator block', async () => {
      await env.writeFile(`${ws}/AGENTS.md`, applyBlock((await env.readFile(`${ws}/AGENTS.md`)) ?? '', packFile('roles/orchestrator.block.md')));
      return `${ws}/AGENTS.md`;
    })
    && await step('gateway restarted', async () => {
      await env.exec(exe, ['gateway', 'restart'], { timeoutMs: 120000 });
      for (let i = 0; i < 30; i++) {
        const r = await env.exec(exe, ['gateway', 'status'], { timeoutMs: 30000 });
        if (/running|active/i.test(stripAnsi(r.stdout + r.stderr))) return 'running';
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('the gateway did not come back within 60 s (check: openclaw gateway status)');
    });
  return steps;
}
