// OpenClaw MCP servers on/off: the ONE implementation, used by the module's switches and by `ocmcp` (the pack).
// Only `enabled` is ever read or written; env/headers/args (credentials) are never read into output.
import type { Environment } from '@agent-spaghetti/sdk';
import { openclawJson } from '../cli.ts';

export interface McpServer { name: string; enabled: boolean; url?: string; command?: string; args?: string[] }
export async function mcpServers(env: Environment, exe: string): Promise<McpServer[]> {
  const j = await openclawJson(env, exe, ['config', 'get', 'mcp.servers']);
  if (!j || typeof j !== 'object') return [];
  return Object.entries(j as Record<string, any>).map(([name, s]) => ({ name, enabled: s?.enabled !== false,
    url: typeof s?.url === 'string' ? s.url : undefined, command: typeof s?.command === 'string' ? s.command : undefined,
    args: Array.isArray(s?.args) ? s.args.filter((a: unknown) => typeof a === 'string') : undefined }));
}
/** agent-spaghetti's own server: added by `connect`, never parked by the pack. */
export const MCP_NAME = 'agent-spaghetti';
/** One validated merge-patch through OpenClaw's own CLI (objects merge, null deletes), then reload. */
async function patchServers(env: Environment, exe: string, servers: Record<string, Record<string, unknown> | null>): Promise<void> {
  const r = await env.exec(exe, ['config', 'patch', '--stdin'], { input: JSON.stringify({ mcp: { servers } }), timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`openclaw config patch failed: ${(r.stderr || r.stdout).slice(-400)}`);
  await env.exec(exe, ['mcp', 'reload'], { timeoutMs: 60000 });
}
export const setMcpEnabled = (env: Environment, exe: string, map: Record<string, boolean>) =>
  patchServers(env, exe, Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { enabled: v }])));
/** Ours on (with this command) or removed. */
export const setOurServer = (env: Environment, exe: string, s: { command: string; args: string[] } | null) =>
  patchServers(env, exe, { [MCP_NAME]: s && { command: s.command, args: s.args, enabled: true } });
