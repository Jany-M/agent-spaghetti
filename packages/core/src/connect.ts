// `connect`: give a client agent-spaghetti's MCP server (ADR 0006). One plan builder for both generic ways:
// install the plugin (Agent Plugins / Cursor variant) or merge one entry into the client's MCP config file.
// A module's own connect() wins where the tool's CLI is the documented way (claude-cli, openclaw).
import { readFileSync } from 'node:fs';
import type { Cli, Connected, Detection, Environment, Integration, Manifest } from '@agent-spaghetti/sdk';
import { VERSION, parseJson, pluginDir } from '@agent-spaghetti/sdk';

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
function installPlugin(env: Environment, spec: NonNullable<NonNullable<Manifest['speaks']>['agentPlugins']>, cli: Cli, client: string, dryRun: boolean) {
  const dir = pluginDir(spec.dir);
  const files = Object.fromEntries(Object.entries(pluginFiles(spec.variant ?? 'agent-plugins', cli, client)).map(([k, v]) => [`${dir}/${k}`, v]));
  return write(env, files, dryRun).then(changes => ({ description: `install the agent-spaghetti plugin in ${dir} (reload the client to load it)`, changes }));
}
/** JSON-merge one server entry; the previous file is kept as .bak; a file that is not JSON is never touched. */
async function mergeMcp(env: Environment, spec: NonNullable<NonNullable<Manifest['speaks']>['mcpClient']>, cli: Cli, client: string, dryRun: boolean) {
  const text = await env.readFile(spec.config);
  const json = text === null ? {} : parseJson(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${spec.config} is not a JSON object; not changed`);
  const doc = json as Record<string, Record<string, unknown>>;
  doc[spec.key] = { ...(doc[spec.key] ?? {}), [SERVER_NAME]: { ...(spec.type ? { type: 'stdio' } : {}), ...mcpEntry(cli, client) } };
  const files: Record<string, string> = { ...(text === null ? {} : { [`${spec.config}.bak`]: text }), [spec.config]: JSON.stringify(doc, null, 2) };
  return write(env, files, dryRun).then(changes => ({ description: `add the ${SERVER_NAME} MCP server to ${spec.config} (restart the client to load it)`, changes }));
}

export async function connectIntegration(env: Environment, i: Integration, det: Detection, cli: Cli, dryRun: boolean): Promise<Connected> {
  if (i.module?.connect) return i.module.connect(env, det, cli, dryRun);
  const sp = i.manifest.speaks, client = i.manifest.id;
  const r = sp?.agentPlugins ? await installPlugin(env, sp.agentPlugins, cli, client, dryRun)
    : sp?.mcpClient ? await mergeMcp(env, sp.mcpClient, cli, client, dryRun)
    : null;
  if (!r) throw new Error(`${i.manifest.name} has no MCP client or plugin support agent-spaghetti knows of`);
  return { ...r, applied: !dryRun };
}
