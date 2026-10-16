// agent-spaghetti-env.mjs: the one program that runs INSIDE a WSL distro (review R2). Built-in integrations are
// embedded; the host passes user manifests, grants and hosts as a base64 JSON argument. JSON out. No server, no port.
//   inspect <payload>                 one-shot scan of this environment (scanEnv)
//   observe <payload>                 long-running; one JSON event per line
//   switches <payload> | switch <payload> <id> on|off | test <payload> <integration>
//   run <payload> <integration>       a delegated task, { req, runId } on stdin; one RunEvent per line
//   openclaw <command> [...]          OpenClaw pack commands (apply.sh / ocmcp), see integrations/openclaw/pack
//   mcp --as <client>                 agent-spaghetti's MCP server for a client in this distro (talks to the daemon on Windows)
//   version
import type { Integration } from '@agent-spaghetti/sdk';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { HubClient, VERSION, serveMcpStdio } from '@agent-spaghetti/sdk';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodePayload, ENV_COMMANDS, extraHostsFromEnv, localEnvironment, observeEnv, runEnvCommand, runHere, scanEnv, type EnvCommand } from '@agent-spaghetti/core/portable';
import { packMain } from '@agent-spaghetti/integrations/openclaw/pack/main.ts';

const out = (v: unknown) => process.stdout.write(JSON.stringify(v) + '\n');

export async function main(argv: string[]): Promise<number> {
  const [cmd, raw, ...rest] = argv;
  if (cmd === 'version') { process.stdout.write(VERSION + '\n'); return 0; }
  if (cmd === 'mcp') {      // MCP bridge for clients in this distro; the daemon wrote where it listens for us (hub.json)
    const hub = JSON.parse(readFileSync(join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agent-spaghetti', 'hub.json'), 'utf8'));
    const all = [raw, ...rest];
    await serveMcpStdio(new HubClient(hub), { source: all[all.indexOf('--as') + 1] ?? 'mcp', parentRunId: Number(process.env.AGENT_SPAGHETTI_PARENT_RUN) || undefined });
    return 0;
  }
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
    observeEnv(env, integrations, e => out(e), { grants: p.grants, ...(p.observe ?? { toolPollMs: 3000, sessionPollMs: 2000 }) });
    setInterval(() => { if (process.ppid === 1) process.exit(0); }, 5000);   // host side gone (wsl.exe killed) → stop
    process.stdout.on('error', () => process.exit(0));
    return new Promise<number>(() => {});
  }
  if (cmd === 'run') {
    const { req, runId } = JSON.parse(await new Response(process.stdin as never).text());
    const ac = new AbortController();
    process.on('SIGTERM', () => ac.abort());
    setInterval(() => { if (process.ppid === 1) ac.abort(); }, 2000).unref();   // host side gone (cancel kills wsl.exe) → stop the run
    try { for await (const e of runHere(env, integrations, rest[0], req, p.grants, { signal: ac.signal, runId })) out(e); }
    catch (err) { out({ type: 'error', message: (err as Error).message }); }
    return 0;
  }
  if ((ENV_COMMANDS as readonly string[]).includes(cmd)) { out(await runEnvCommand(env, integrations, cmd as EnvCommand, rest, p.grants)); return 0; }
  process.stderr.write('usage: agent-spaghetti-env.mjs inspect|observe|switches|switch|test|run <payload> … | openclaw <command> | version\n');
  return 1;
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
