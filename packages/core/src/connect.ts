// `connect`: give a client agent-spaghetti's MCP server (ADR 0006). One plan builder for both generic ways:
// install the plugin (Agent Plugins / Cursor variant) or merge one entry into the client's MCP config file.
// A module's own connect() wins where the tool's CLI is the documented way.
import { readFileSync } from 'node:fs';
import type { Cli, Connected, Detection, Environment, Integration, Manifest } from '@agent-spaghetti/sdk';
import { VERSION, parseJsonc, pluginDir, programOf } from '@agent-spaghetti/sdk';

export const SERVER_NAME = 'agent-spaghetti';
const PLUGIN = new URL('../../../clients/plugin/', import.meta.url);
const source = (rel: string) => readFileSync(new URL(rel, PLUGIN), 'utf8');
const shellQuote = (a: string) => (/^[\w./:\\-]+$/.test(a) ? a : `"${a.replaceAll('"', '\\"')}"`);
export const mcpEntry = (cli: Cli, client: string) => ({ command: cli.command, args: [...cli.args, 'mcp', '--as', client] });

/** The plugin's files for one client: the shared source plus what depends on this machine (bridge command, hook command). */
export function pluginFiles(variant: 'agent-plugins' | 'cursor', cli: Cli, client: string): Record<string, string> {
  const manifest = { ...JSON.parse(source('plugin.json')), version: VERSION };
  const mcp = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { [SERVER_NAME]: { type: 'stdio', ...mcpEntry(cli, client) } } };
  const files: Record<string, string> = { 'mcp.json': JSON.stringify(mcp, null, 2), 'skills/delegate/SKILL.md': source('skills/delegate/SKILL.md') };
  if (variant === 'agent-plugins') return { ...files, 'plugin.json': JSON.stringify(manifest, null, 2) };
  const { $schema: _, ...cursorManifest } = manifest;
  const hook = [cli.command, ...cli.args, 'hook', client].map(shellQuote).join(' ');
  const hooks = { version: 1, hooks: Object.fromEntries(['beforeSubmitPrompt', 'sessionStart', 'beforeMCPExecution', 'afterAgentResponse', 'stop']
    .map(e => [e, [{ command: hook, timeout: e === 'beforeSubmitPrompt' ? 30 : 5 }]])) };
  return { ...files, '.cursor-plugin/plugin.json': JSON.stringify(cursorManifest, null, 2), 'commands/delegate.md': source('commands/delegate.md'), 'hooks/hooks.json': JSON.stringify(hooks, null, 2) };
}

async function write(env: Environment, files: Record<string, string>, dryRun: boolean): Promise<string[]> {
  if (!dryRun) for (const [p, c] of Object.entries(files)) await env.writeFile(p, c);
  return Object.keys(files).map(p => `write ${p}`);
}
type Speaks = NonNullable<Manifest['speaks']>;
async function plugin(env: Environment, spec: NonNullable<Speaks['agentPlugins']>, cli: Cli, client: string, on: boolean, dryRun: boolean) {
  const dir = pluginDir(spec.dir);
  if (!on) {
    if (!dryRun) await env.remove(dir);
    return { description: `remove the agent-spaghetti plugin from ${dir} (reload the client)`, changes: [`remove ${dir}`] };
  }
  const files = Object.fromEntries(Object.entries(pluginFiles(spec.variant ?? 'agent-plugins', cli, client)).map(([k, v]) => [`${dir}/${k}`, v]));
  return { description: `install the agent-spaghetti plugin in ${dir} (reload the client to load it)`, changes: await write(env, files, dryRun) };
}
/** JSON-merge (or delete) our one server entry; the previous file is kept as .bak (comments in a JSONC file live on only there);
 *  a file that is not JSON(C) is never touched. */
async function mcpConfig(env: Environment, spec: NonNullable<Speaks['mcpClient']>, cli: Cli, client: string, on: boolean, dryRun: boolean) {
  const text = await env.readFile(spec.config);
  const json = text === null ? {} : parseJsonc(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${spec.config} is not a JSON object; not changed`);
  const doc = json as Record<string, Record<string, unknown>>;
  const { [SERVER_NAME]: _, ...others } = doc[spec.key] ?? {};
  if (!on && text === null) return { description: `${spec.config} does not exist; nothing to remove`, changes: [] };
  const e = mcpEntry(cli, client);
  doc[spec.key] = on ? { ...others, [SERVER_NAME]: { ...spec.entry, ...(spec.commandArray ? { command: [e.command, ...e.args] } : e) } } : others;
  const files: Record<string, string> = { ...(text === null ? {} : { [`${spec.config}.bak`]: text }), [spec.config]: JSON.stringify(doc, null, 2) };
  return { description: `${on ? 'add' : 'remove'} the ${SERVER_NAME} MCP server ${on ? 'to' : 'from'} ${spec.config} (restart the client)`, changes: await write(env, files, dryRun) };
}

/** Through the tool's own CLI: remove (also replaces an older entry), then add. */
async function mcpCli(env: Environment, spec: NonNullable<Speaks['mcpCli']>, exe: string | undefined, cli: Cli, client: string, on: boolean, dryRun: boolean) {
  if (!exe) throw new Error(`${client}: its program was not found`);
  const e = mcpEntry(cli, client), remove = [...spec.remove, SERVER_NAME], add = [...spec.add, SERVER_NAME, '--', e.command, ...e.args];
  if (!dryRun) {
    await env.exec(exe, remove, { timeoutMs: 30000 });
    const r = on ? await env.exec(exe, add, { timeoutMs: 30000 }) : null;
    if (r && r.code !== 0) throw new Error(`${client} ${spec.add.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  }
  return { description: `${on ? 'add' : 'remove'} the ${SERVER_NAME} MCP server with the tool's own CLI`, changes: [`${exe} ${(on ? add : remove).join(' ')}`] };
}

/** Connect (on) or disconnect a client: the module's own way, else the plugin and/or the MCP config entry. Disconnect is the exact inverse. */
export async function setConnection(env: Environment, i: Integration, det: Detection, cli: Cli, on: boolean, dryRun: boolean): Promise<Connected> {
  if (i.module?.connect) return i.module.connect(env, det, cli, on, dryRun);
  const sp = i.manifest.speaks, client = i.manifest.id;
  if (sp?.mcpCli) return { ...await mcpCli(env, sp.mcpCli, programOf(det, i.manifest.detect?.bin?.[0]), cli, client, on, dryRun), applied: !dryRun };
  if (!sp?.agentPlugins && !sp?.mcpClient) throw new Error(`${i.manifest.name} has no MCP client or plugin support agent-spaghetti knows of`);
  // connect: the plugin where supported, else the MCP config; disconnect: both (whichever a user or an older version added)
  const steps = on ? [sp.agentPlugins ? plugin(env, sp.agentPlugins, cli, client, on, dryRun) : mcpConfig(env, sp.mcpClient!, cli, client, on, dryRun)]
    : [...(sp.agentPlugins ? [plugin(env, sp.agentPlugins, cli, client, on, dryRun)] : []), ...(sp.mcpClient ? [mcpConfig(env, sp.mcpClient, cli, client, on, dryRun)] : [])];
  const r = await Promise.all(steps);
  return { description: r.map(x => x.description).join('; '), changes: r.flatMap(x => x.changes), applied: !dryRun };
}
