// The one place that turns data into text (CLI, tray tooltip, app). Names always come from manifests.
import type { AgentInfo, BackendInfo, Snapshot } from './types.ts';

const portOf = (url?: string) => { try { return url ? new URL(url).port : ''; } catch { return ''; } };
/** Same model AND (same port when the agent knows its endpoint, else integration === provider). */
export function linkBackend(a: AgentInfo, backends: BackendInfo[]): BackendInfo | undefined {
  return backends.find(b => b.model === a.model && (a.endpoint ? portOf(a.endpoint) === portOf(b.endpoint) : b.integration === a.provider));
}
export const ctxLabel = (n?: number) => (n ? ` · ctx ${Math.round(n / 1000)}k` : '');

export function renderTree(s: Snapshot): string {
  const name = new Map(s.detections.map(d => [d.integration, d.name]));
  const nice = (id: string) => name.get(id) ?? id;
  const used = new Set<string>(), lines: string[] = [];
  for (const a of s.agents) {
    const b = linkBackend(a, s.backends);
    const left = `${nice(a.integration)} · ${a.name}`;
    if (b) { used.add(b.id + b.endpoint); lines.push(`${left} → ${nice(b.integration)} · ${b.model}${ctxLabel(b.contextLength)}`); }
    else lines.push(a.provider ? `${left} → ${a.provider} · ${a.model} (not observed)` : `${left} → (model unknown)`);
  }
  for (const b of s.backends) if (!used.has(b.id + b.endpoint)) lines.push(`${nice(b.integration)} · ${b.model}${ctxLabel(b.contextLength)} (no agent attached)`);
  for (const e of s.envs) {
    if (e.state !== 'running') lines.push(`! ${e.id} ${e.state}${e.why ? ` (${e.why})` : ''}`);
    else if (e.partial?.length) lines.push(`! ${e.id} partial: ${e.partial.join(', ')}`);
  }
  return lines.join('\n');
}
export function detectionRows(s: Snapshot): string[][] {
  return [['Tool', 'Env', 'Version', 'Levels', 'Connectable', 'Why'],
    ...s.detections.map(d => [d.name, d.envId, d.version ?? '-', d.levels.join(','), d.connectable, d.why])];
}
export function renderTable(rows: string[][]): string {
  const w = rows[0]?.map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length))) ?? [];
  return rows.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ')).join('\n');
}
