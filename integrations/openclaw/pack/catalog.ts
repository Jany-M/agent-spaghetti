// MCP catalog lookup (port of ocmcp's entry/derive): local catalog > exact generic entry > longest generic substring
// (keeping qualifiers like -dev/-prod as keywords) > a summary derived from package name or URL host. Never reads env/headers.
import type { McpServer } from './mcp.ts';

export interface CatalogEntry { summary?: string; keywords?: string[]; broken?: string }
export type Catalog = Record<string, CatalogEntry>;
const words = (s: string) => s.toLowerCase().split(/[\W_]+/).filter(Boolean);

export function derive(s: McpServer): CatalogEntry {
  if (s.url) { const host = s.url.replace(/^https?:\/\//, '').split('/')[0]; return { summary: `remote MCP server at ${host}`, keywords: [host] }; }
  const pkg = (s.args ?? []).find(a => !a.startsWith('-') && !a.includes('=') && a.length < 80) ?? (s.command ?? '').split(/[\\/]/).pop() ?? '';
  return { summary: pkg ? `MCP server (${pkg})` : 'MCP server', keywords: words(pkg) };
}
export function entryFor(s: McpServer, generic: Catalog, local: Catalog): CatalogEntry {
  if (local[s.name]) return local[s.name];
  if (generic[s.name]) return generic[s.name];
  const low = s.name.toLowerCase();
  const hit = Object.keys(generic).filter(k => !k.startsWith('_') && low.includes(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? { ...generic[hit], keywords: [...(generic[hit].keywords ?? []), ...words(low)] } : derive(s);
}
/** Up to six best matches: number of query-word occurrences in name + summary + keywords. */
export function search(servers: McpServer[], cat: (s: McpServer) => CatalogEntry, query: string[]): Array<{ server: McpServer; entry: CatalogEntry }> {
  const q = words(query.join(' '));
  const count = (hay: string, w: string) => hay.split(w).length - 1;
  return servers.map(server => {
    const e = cat(server), hay = `${server.name} ${e.summary ?? ''} ${(e.keywords ?? []).join(' ')}`.toLowerCase();
    return { server, entry: e, score: q.reduce((n, w) => n + count(hay, w), 0) };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.server.name.localeCompare(a.server.name)).slice(0, 6)
    .map(({ server, entry }) => ({ server, entry }));
}
