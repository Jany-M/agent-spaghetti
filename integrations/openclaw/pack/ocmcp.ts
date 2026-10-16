// `ocmcp` (port of the Python script): OpenClaw MCP servers are OFF by default; turn them on/off on demand.
// list | search <words> | on <names> | off <names> | off-all | probe <names> | status. Same output as before.
import type { Environment } from '@agent-spaghetti/sdk';
import { readFileSync } from 'node:fs';
import { entryFor, search, type Catalog } from './catalog.ts';
import { MCP_NAME, mcpServers, setMcpEnabled, type McpServer } from './mcp.ts';
import { stripAnsi } from './state.ts';

export interface McpDeps { env: Environment; exe: string; pack: string | null; vars: NodeJS.ProcessEnv; say(s: string): void }
const load = (p: string): Catalog => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
export const MCP_COMMANDS = ['list', 'search', 'on', 'off', 'off-all', 'probe', 'status'] as const;

export async function mcpMain(cmd: string, a: string[], d: McpDeps): Promise<number> {
  if (!(MCP_COMMANDS as readonly string[]).includes(cmd)) { d.say(`ocmcp: turn OpenClaw MCP servers on/off (they are OFF by default)\ncommands: ${MCP_COMMANDS.join(', ')}`); return 2; }
  const servers = (await mcpServers(d.env, d.exe)).filter(s => s.name !== MCP_NAME);   // ours is managed by `connect`
  const generic = load(d.vars.MCP_CATALOG ?? `${d.pack}/mcp/catalog.json`), local = d.pack ? load(`${d.pack}/catalog.local.json`) : {};
  const cat = (s: McpServer) => entryFor(s, generic, local);
  const broken = (s: McpServer) => cat(s).broken ? `  [BROKEN: ${cat(s).broken}]` : '';
  const names = new Set(servers.map(s => s.name));
  const unknown = a.filter(n => !names.has(n));
  if (['on', 'off', 'probe'].includes(cmd) && unknown.length) { d.say(`unknown server(s): ${unknown.join(', ')}. Known: ${[...names].sort().join(', ')}`); return 1; }
  const sorted = [...servers].sort((x, y) => x.name.localeCompare(y.name));
  switch (cmd) {
    case 'list': for (const s of sorted) d.say(`${s.enabled ? 'ON ' : 'off'}  ${s.name.padEnd(26)} ${cat(s).summary ?? '(no catalog entry)'}${broken(s)}`); return 0;
    case 'search': {
      const hits = search(servers, cat, a);
      for (const { server, entry } of hits) d.say(`${server.name.padEnd(26)} ${entry.summary ?? ''}${broken(server)}`);
      if (!hits.length) d.say('no match; run: ocmcp list');
      return 0;
    }
    case 'on': case 'off': {
      if (cmd === 'on') for (const s of servers.filter(s => a.includes(s.name) && cat(s).broken)) d.say(`WARNING: ${s.name} is marked broken: ${cat(s).broken}`);
      await setMcpEnabled(d.env, d.exe, Object.fromEntries(a.map(n => [n, cmd === 'on'])));
      d.say(`${cmd === 'on' ? 'enabled' : 'disabled'}: ${a.join(', ')}`); return 0;
    }
    case 'off-all': {
      const on = sorted.filter(s => s.enabled).map(s => s.name);
      if (on.length) await setMcpEnabled(d.env, d.exe, Object.fromEntries(servers.map(s => [s.name, false])));
      d.say(`all MCP servers off (was on: ${on.join(', ') || 'none'})`); return 0;
    }
    case 'probe': { const r = await d.env.exec(d.exe, ['mcp', 'probe', ...a], { timeoutMs: 120000 }); d.say(stripAnsi(r.stdout + r.stderr).slice(-3000)); return r.code === 0 ? 0 : 1; }
    default: // status
      d.say(`on : ${sorted.filter(s => s.enabled).map(s => s.name).join(', ') || 'none'}`);
      d.say(`off: ${servers.filter(s => !s.enabled).length} servers`); return 0;
  }
}
