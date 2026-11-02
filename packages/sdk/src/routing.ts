// The one target ranking (ADR 0010): free before unknown before metered, then the least queued (targets are available already).
// No tool is preferred by name: among equals the input order (the scan's) stays. Used by the dispatcher and by setup hooks.
import type { Cost } from './types.ts';

/** `target[:model]` (target ids never contain ':'; models may): one hop of a hand-off. */
export const parseHop = (hop: string): { target: string; model?: string } => {
  const i = hop.indexOf(':');
  return i < 0 ? { target: hop } : { target: hop.slice(0, i), model: hop.slice(i + 1) || undefined };
};
const COST_RANK: Record<Cost, number> = { free: 0, unknown: 1, metered: 2 };
export interface RankInfo { queued?(id: string): number }   // requests waiting at the target (its model server's queue)
export function rankTargets<T extends { id: string; cost: Cost }>(items: T[], info: RankInfo = {}): T[] {
  const key = (t: T) => [COST_RANK[t.cost], info.queued?.(t.id) ?? 0];
  return items.map((t, i) => ({ t, i, k: key(t) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i).map(x => x.t);
}
