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
/** One validated merge-patch through OpenClaw's own CLI, then reload. */
export async function setMcpEnabled(env: Environment, exe: string, map: Record<string, boolean>): Promise<void> {
  const body = JSON.stringify({ mcp: { servers: Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { enabled: v }])) } });
  const r = await env.exec(exe, ['config', 'patch', '--stdin'], { input: body, timeoutMs: 60000 });
  if (r.code !== 0) throw new Error(`openclaw config patch failed: ${(r.stderr || r.stdout).slice(-400)}`);
  await env.exec(exe, ['mcp', 'reload'], { timeoutMs: 60000 });
}
