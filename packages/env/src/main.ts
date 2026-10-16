// agent-spaghetti-env.mjs: the one program that runs INSIDE a WSL distro (review R2). Built-in integrations are
// embedded; the host passes user manifests, grants and hosts as a base64 JSON argument. JSON out. No server, no port.
//   inspect <payload>                 one-shot scan of this environment (scanEnv)
//   observe <payload>                 long-running; one JSON event per line
//   switches <payload> | switch <payload> <id> on|off | test <payload> <integration>
//   openclaw <command> [...]          OpenClaw pack commands (apply.sh / ocmcp), see integrations/openclaw/pack
//   version
import type { Integration } from '@agent-spaghetti/sdk';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { decodePayload, ENV_COMMANDS, extraHostsFromEnv, localEnvironment, observeEnv, runEnvCommand, scanEnv, type EnvCommand } from '@agent-spaghetti/core/portable';
import { packMain } from '@agent-spaghetti/integrations/openclaw/pack/main.ts';

export const VERSION = '0.2.0';
const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');

export async function main(argv: string[]): Promise<number> {
  const [cmd, raw, ...rest] = argv;
  if (cmd === 'version') { process.stdout.write(VERSION + '\n'); return 0; }
  if (cmd === 'openclaw') {
    const env = localEnvironment({ extraHosts: extraHostsFromEnv(process.env) });   // LLM_HOSTS from overrides.env
    const inspect = async (ids: string[]) => (await scanEnv(env, BUILTINS.filter(b => ids.includes(b.manifest.id)))).inspections;
    return packMain([raw, ...rest].filter(a => a !== undefined), env, { inspect, manifests: BUILTINS.map(b => b.manifest) });
  }
  const p = decodePayload(raw);
  const env = localEnvironment({ id: p.envId || undefined, extraHosts: p.extraHosts });
  const ids = new Set(p.user.map(m => m.id));
  const integrations: Integration[] = [...BUILTINS.filter(b => !ids.has(b.manifest.id)), ...p.user.map(manifest => ({ manifest, source: 'user' as const }))];
  if (cmd === 'observe') {
    observeEnv(env, integrations, e => out(e), { grants: p.grants, ...(p.observe ?? { backendPollMs: 3000, sessionPollMs: 2000 }) });
    setInterval(() => { if (process.ppid === 1) process.exit(0); }, 5000);   // host side gone (wsl.exe killed) → stop
    process.stdout.on('error', () => process.exit(0));
    return new Promise<number>(() => {});
  }
  if ((ENV_COMMANDS as readonly string[]).includes(cmd)) { out(await runEnvCommand(env, integrations, cmd as EnvCommand, rest, p.grants)); return 0; }
  process.stderr.write('usage: agent-spaghetti-env.mjs inspect|observe|switches|switch|test <payload> … | openclaw <command> | version\n');
  return 1;
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
