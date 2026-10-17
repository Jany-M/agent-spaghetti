// Per-environment commands. The SAME function answers in the daemon (host env) and in the env bundle (inside distros),
// so a command is added once here and works everywhere (core/dispatch.ts routes it).
import type { ConnectResult, Environment, Grant, Integration, RunEvent, RunRequest, Switch, TestResult } from '@agent-spaghetti/sdk';
import { rankTargets } from '@agent-spaghetti/sdk';
import { setConnection } from './connect.ts';
import { inspectAs } from './engine/observe.ts';
import { testIntegration } from './engine/test.ts';
import { scanEnv, type EnvScan } from './scan.ts';

export const ENV_COMMANDS = ['inspect', 'switches', 'switch', 'test', 'connect', 'setup'] as const;
export type EnvCommand = (typeof ENV_COMMANDS)[number];
export interface EnvResults { inspect: EnvScan; switches: Switch[]; switch: Switch; test: TestResult; connect: ConnectResult; setup: TestResult }

/** Integrations with switches, with the detection the engine made (modules never re-detect). */
async function withSwitches(env: Environment, integrations: Integration[], grants: Grant[]) {
  const inventory = await env.inventory([]);
  const out = [];
  for (const i of integrations.filter(i => i.module?.switches)) {
    const r = await inspectAs(i, env, inventory, grants).catch(() => null);
    if (r) out.push({ i, det: r.detection, ctx: { signal: AbortSignal.timeout(60000), inventory } });
  }
  return out;
}
export async function runEnvCommand<C extends EnvCommand>(env: Environment, integrations: Integration[], cmd: C, args: string[], grants: Grant[]): Promise<EnvResults[C]> {
  const r = async (): Promise<EnvResults[EnvCommand]> => {
    switch (cmd) {
      case 'inspect': return scanEnv(env, integrations, { grants });
      case 'switches': return (await Promise.all((await withSwitches(env, integrations, grants)).map(({ i, det, ctx }) => i.module!.switches!(env, det, ctx)))).flat();
      case 'switch': {
        const [id, state] = args;
        for (const { i, det, ctx } of await withSwitches(env, integrations, grants)) {
          const sw = (await i.module!.switches!(env, det, ctx)).find(s => s.id === id);
          if (sw) { await i.module!.setSwitch!(env, det, id, state === 'on', ctx); return { ...sw, on: state === 'on' }; }
        }
        throw new Error(`unknown switch ${id} in ${env.id}`);
      }
      case 'connect': {          // args: integration id, Cli JSON, 'on' | 'off', 'dry-run' or ''
        const i = integrations.find(i => i.manifest.id === args[0]);
        const r = i && await inspectAs(i, env, await env.inventory(i.manifest.detect?.env ?? []), grants);
        if (!i || !r) throw new Error(`${args[0]} is not installed in ${env.id}`);
        return { integration: i.manifest.id, envId: env.id, ...await setConnection(env, i, r.detection, JSON.parse(args[1]), args[2] !== 'off', args[3] === 'dry-run') };
      }
      case 'setup': {            // args: integration id, Cli JSON, 'check' | 'apply', 'dry-run' or '', options JSON
        const i = integrations.find(i => i.manifest.id === args[0]);
        const r = i?.module?.setup && await inspectAs(i, env, await env.inventory(i.manifest.detect?.env ?? []), grants);
        if (!i || !r) throw new Error(`${args[0]} has nothing to set up in ${env.id}`);
        const servers = integrations.filter(x => x.manifest.models && x.manifest.speaks?.openai);
        const localModels = async () => rankTargets((await scanEnv(env, servers, { grants })).inspections.flatMap(x => x.backends.map(b => {
          const m = servers.find(y => y.manifest.id === b.integration)!.manifest;
          return { id: b.integration, cost: m.cost ?? 'unknown', integration: b.integration, base: b.endpoint + m.speaks!.openai!.base, model: b.model, contextLength: b.contextLength };
        }))).map(({ id: _, cost: __, ...l }) => l);
        const steps = await i.module!.setup!(env, r.detection, { action: args[2] === 'check' ? 'check' : 'apply', dryRun: args[3] === 'dry-run', cli: JSON.parse(args[1]),
          options: JSON.parse(args[4] || '{}'), localModels });
        return { ok: steps.every(s => s.ok), steps };
      }
      case 'test': {
        const i = integrations.find(i => i.manifest.id === args[0]);
        if (!i) throw new Error(`unknown integration ${args[0]}`);
        return testIntegration(env, i, grants);
      }
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return r() as Promise<EnvResults[C]>;
}

/** A delegated task in this environment (the same code in the daemon and in the env bundle's `run`): fresh detection, then the module's run. */
export async function* runHere(env: Environment, integrations: Integration[], id: string, req: RunRequest, grants: Grant[],
  o: { signal?: AbortSignal; runId?: number } = {}): AsyncIterable<RunEvent> {
  const i = integrations.find(x => x.manifest.id === id);
  const inventory = await env.inventory(i?.manifest.detect?.env ?? []);
  const r = i?.module?.run ? await inspectAs(i, env, inventory, grants) : null;
  if (!i || !r) throw new Error(`${id} cannot run tasks in ${env.id}`);
  yield* i.module!.run!(env, r.detection, req, { signal: o.signal ?? new AbortController().signal, inventory, runId: o.runId });
}
