// Per-environment commands. The SAME function answers in the daemon (host env) and in the env bundle (inside distros),
// so a command is added once here and works everywhere (core/dispatch.ts routes it).
import type { ConnectResult, Environment, Grant, Integration, Switch, TestResult } from '@agent-spaghetti/sdk';
import { connectIntegration } from './connect.ts';
import { inspectAs } from './engine/observe.ts';
import { testIntegration } from './engine/test.ts';
import { scanEnv, type EnvScan } from './scan.ts';

export const ENV_COMMANDS = ['inspect', 'switches', 'switch', 'test', 'connect'] as const;
export type EnvCommand = (typeof ENV_COMMANDS)[number];
export interface EnvResults { inspect: EnvScan; switches: Switch[]; switch: Switch; test: TestResult; connect: ConnectResult }

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
      case 'connect': {          // args: integration id, Cli JSON, 'dry-run' or ''
        const i = integrations.find(i => i.manifest.id === args[0]);
        const r = i && await inspectAs(i, env, await env.inventory(i.manifest.detect?.env ?? []), grants);
        if (!i || !r) throw new Error(`${args[0]} is not installed in ${env.id}`);
        return { integration: i.manifest.id, envId: env.id, ...await connectIntegration(env, i, r.detection, JSON.parse(args[1]), args[2] === 'dry-run') };
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
