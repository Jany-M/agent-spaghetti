// Routing (ADR 0010): JEV's classification of a task, and the one target ranking (free before unknown before metered, then the
// least queued; targets are available already). No tool is preferred by name: among equals the input order (the scan's) stays.
import type { Classification, Cost, Difficulty, TaskKind } from './types.ts';
import { DIFFICULTIES, TASK_KINDS } from './types.ts';
import JEV from './jev-defaults.json' with { type: 'json' };

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

// JEV step 2, the shipped defaults (jev-defaults.json): the kind whose word list scores highest (a phrase scores its word count,
// times `lead.weight` when it starts within the first `lead.words` words), ties to the more specific kind; difficulty from what can be counted. The caller's own kind/difficulty, when valid, win.
const words = (t: string) => t.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
const phrase = (p: string) => new RegExp(`(?<![\\p{L}\\p{N}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
const LISTS = Object.entries(JEV.kinds).map(([kind, list]) => ({ kind: kind as TaskKind,
  res: list.map(p => ({ re: phrase(p), w: words(p) })).sort((a, b) => b.w - a.w) }));   // longest first: "unit tests" is not also "tests"
const HEAVY = JEV.heavyWords.map(phrase);
const longestCodeBlock = (t: string) => Math.max(0, ...[...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1].split('\n').length - 1));
/** `text`: what the target will read (task plus the previous step's result); `files`: how many files go with it. */
export function classify(text: string, files = 0, given: { kind?: string; difficulty?: string } = {}): Classification {
  const lead = (i: number) => words(text.slice(0, i)) < JEV.lead.words ? JEV.lead.weight : 1;   // the action is usually said first ("Summarize … why unit tests matter")
  const score = LISTS.map(l => {
    let rest = text, n = 0;                                   // each part of the text counts once per kind: matched parts are blanked
    for (const r of l.res) for (const x of [...rest.matchAll(r.re)]) { n += r.w * lead(x.index); rest = rest.slice(0, x.index) + ' '.repeat(x[0].length) + rest.slice(x.index + x[0].length); }
    return { kind: l.kind, n };
  })
    .sort((a, b) => b.n - a.n || JEV.tieOrder.indexOf(a.kind) - JEV.tieOrder.indexOf(b.kind));
  const [top, second] = score, caller = (TASK_KINDS as readonly string[]).includes(given.kind ?? '');
  const kind = caller ? given.kind as TaskKind : top.n ? top.kind : 'other';
  const n = words(text), h = JEV.heavy, l = JEV.light;
  const difficulty: Difficulty = (DIFFICULTIES as readonly string[]).includes(given.difficulty ?? '') ? given.difficulty as Difficulty
    : n > h.words || files > h.files || HEAVY.some(re => re.test(text)) || (h.editKinds.includes(kind) && files > h.editFiles) ? 'heavy'
    : n <= l.words && files <= l.files && longestCodeBlock(text) <= l.codeLines && l.kinds.includes(kind) ? 'light' : 'medium';
  return { kind, difficulty, by: caller ? 'caller' : 'rules', confidence: caller ? 1 : top.n ? Math.round(((top.n - (second?.n ?? 0)) / top.n) * 100) / 100 : 0 };
}
