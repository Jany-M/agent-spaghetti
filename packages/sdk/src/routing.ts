// Routing (ADR 0010): JEV's classification of a task, the plain target ranking (free before unknown before metered, then the least
// queued) and the ranking for one task (route). No tool is preferred by name: among equals the input order (the scan's) stays.
import type { Classification, Cost, Difficulty, RunRequest, RunRow, Target, TaskKind } from './types.ts';
import { DIFFICULTIES, TASK_KINDS } from './types.ts';
import JEV from './jev-defaults.json' with { type: 'json' };
/** The shipped defaults (word lists, thresholds, routing data), shown read-only in the Routing panel. */
export const JEV_DEFAULTS = JEV;

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
    : JEV.route.frontierKinds.includes(kind) || n > h.words || files > h.files || HEAVY.some(re => re.test(text)) || (h.editKinds.includes(kind) && files > h.editFiles) ? 'heavy'
    : n <= l.words && files <= l.files && longestCodeBlock(text) <= l.codeLines && l.kinds.includes(kind) ? 'light' : 'medium';
  return { kind, difficulty, by: caller ? 'caller' : 'rules', confidence: caller ? 1 : top.n ? Math.round(((top.n - (second?.n ?? 0)) / top.n) * 100) / 100 : 0 };
}

/** A request's classification: the one it carries (a chain's later hops), else classify() over what the target will read. */
export const classifyRequest = (req: Pick<RunRequest, 'task' | 'context' | 'files' | 'kind' | 'difficulty' | 'classification'>): Classification =>
  req.classification ?? classify([req.task, req.context].filter(Boolean).join('\n\n'), req.files?.length ?? 0, req);

// I2 (finish-line plan, Part I): what a target can handle (its tier), what past runs say about it, and the ranking for one task.
const R = JEV.route;
const level = (d: Difficulty) => DIFFICULTIES.indexOf(d);
/** A model's size in billions from its name ("7b", "e4b", "30B-A3B" → the active 3); null when the name says none. */
export function modelSize(name: string): number | null {
  const m = [...name.matchAll(/(?<![\p{L}\p{N}.])([ae]?)(\d+(?:\.\d+)?)b(?![\p{L}\p{N}])/giu)];
  const pick = m.find(x => x[1].toLowerCase() === 'a') ?? m.at(-1);
  return pick ? Number(pick[2]) : null;
}
/** The hardest task a target takes: the owner's `routing.tiers` entry (`<target>[:model]=<tier>`), else paid → heavy, an agent → medium,
 *  a model by its size (unknown → medium). */
export function tierOf(t: Pick<Target, 'id' | 'kind' | 'cost' | 'models'>, tiers: string[] = [], model = t.models[0]): Difficulty {
  const own = (key: string) => tiers.find(x => x.startsWith(`${key}=`))?.slice(key.length + 1);
  const set = (model && own(`${t.id}:${model}`)) || own(t.id);
  if ((DIFFICULTIES as readonly string[]).includes(set ?? '')) return set as Difficulty;
  if (t.cost === 'metered') return 'heavy';                  // hosted APIs and agents on their own paid plan
  if (t.kind === 'agent') return 'medium';                   // runs a configured model, not known here
  const b = model ? modelSize(model) : null;
  return b === null ? 'medium' : b <= R.lightMaxB ? 'light' : b <= R.mediumMaxB ? 'medium' : 'heavy';
}
/** A target's past runs of one kind: `rate` = share that went well, recency-weighted (half-life `route.halfLifeDays`). */
export interface RunStats { runs: number; rate: number; bad: number; medianMs?: number }
export const statKey = (kind: string, target: string) => `${kind} ${target}`;
/** Per kind and target, from the run record (computed on read). Failed = error, or graded Bad or Redo; denied, expired and cancelled
 *  runs say nothing about the target and are left out. Ungraded finished runs count as fine. */
export function summarizeRuns(rows: RunRow[], now = Date.now()): Record<string, RunStats> {
  const cells: Record<string, { w: number; ok: number; n: number; bad: number; ms: number[] }> = {};
  for (const r of rows) {
    if (r.outcome !== 'done' && r.outcome !== 'error') continue;
    const c = cells[statKey(r.kind, r.target)] ??= { w: 0, ok: 0, n: 0, bad: 0, ms: [] }, w = 0.5 ** ((now - r.ts) / (R.halfLifeDays * 864e5));
    const graded = r.verdict === 'down' || r.verdict === 'redo';
    c.w += w; c.n++; if (graded) c.bad++;
    if (r.outcome === 'done' && !graded) c.ok += w;
    if (r.outcome === 'done' && r.durationMs) c.ms.push(r.durationMs);
  }
  return Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, { runs: c.n, rate: c.w ? c.ok / c.w : 0, bad: c.bad,
    ...(c.ms.length ? { medianMs: c.ms.sort((a, b) => a - b)[Math.floor(c.ms.length / 2)] } : {}) }]));
}
/** How to rank (settings `routing.*`, the run record, live queues). `source`: the caller, never its own target. */
export interface RouteOpts { source?: string; web?: boolean;   // web: the task needs to look things up online (a webKind without its own sources)
  stats?: Record<string, RunStats>; learn?: boolean; stretch?: boolean; prefer?: string[]; never?: string[]; tiers?: string[]; queued?(id: string): number }
/** One target for one task: its tier, why it sits where it does, its history; `skip` when it may not take the task. */
export interface Ranked { target: Target; tier: Difficulty; why: string; stats?: RunStats; preferred?: true; skip?: string }
const forKind = (list: string[] | undefined, kind: string) => (list ?? []).filter(x => x.startsWith(`${kind}=`)).map(x => x.slice(kind.length + 1));
const pct = (s: RunStats) => `${s.runs} ${s.runs === 1 ? 'run' : 'runs'}, ${Math.round(s.rate * 100)}% ok${s.runs < R.minRuns ? ' (too few to count yet)' : ''}`;
/** The ranking for a task (no tool preferred by name, ADR 0010): the owner's pick for the kind first; then targets whose tier fits
 *  the difficulty, a free one a tier below when `stretch` (escalation covers a failure; never for a frontier kind such as plan), the rest last
 *  (biggest first); a task that needs the web goes to unpaid targets that have it, then unpaid ones without, then paid ones; within those cheapest first,
 *  then better history for this kind (with `learn`, from `route.minRuns` runs), then the shortest queue, then the scan's order.
 *  Targets that may not take it (the caller, `never` for the kind, a model when the task edits files: permissions mayEdit, an agent that
 *  would load its own local model beside one already loaded) come last with `skip`. */
export function route(c: { kind: TaskKind; difficulty: Difficulty; edits?: boolean }, targets: Target[], o: RouteOpts = {}): Ranked[] {
  const need = level(c.difficulty), prefer = forKind(o.prefer, c.kind), never = forKind(o.never, c.kind);
  const stretch = o.stretch && !R.frontierKinds.includes(c.kind), loaded = targets.find(t => t.kind === 'model');
  return targets.map((t, i) => {
    const tier = tierOf(t, o.tiers), s = o.stats?.[statKey(c.kind, t.id)], preferred = prefer.includes(t.id);
    const skip = t.id === o.source ? 'the caller itself' : never.includes(t.id) ? `never for ${c.kind} (your choice)`
      : c.edits && t.kind !== 'agent' ? 'edits files: needs an agent'
      : t.loads && loaded && !preferred ? `would load ${t.loads} while ${loaded.name} has a model loaded (name it as the target to do that)` : undefined;
    const fit = level(tier) >= need ? 0 : stretch && t.cost === 'free' && level(tier) === need - 1 ? 1 : 2;
    const offline = !!o.web && !t.web, paid = t.cost === 'metered';
    const history = o.learn && s && s.runs >= R.minRuns ? s.rate : 0.5;      // unknown sits between a good and a bad record
    const why = skip ?? [preferred && `your pick for ${c.kind}`, t.cost, `${tier} tier${fit === 1 ? ` (stretch: tries a ${c.difficulty} task, escalates if it fails)` : fit === 2 ? ` (below ${c.difficulty})` : ''}`,
      offline && 'no web access (answers from what its model knows)', s && `${c.kind}: ${pct(s)}`].filter(Boolean).join(', ');
    return { r: { target: t, tier, why, ...(s ? { stats: s } : {}), ...(preferred ? { preferred: true as const } : {}), ...(skip ? { skip } : {}) },
      k: [skip ? 1 : 0, preferred ? 0 : 1, fit === 2 ? 1 : 0, fit === 2 ? -level(tier) : 0, o.web && paid ? 1 : 0, offline ? 1 : 0, COST_RANK[t.cost], fit, -history, o.queued?.(t.id) ?? 0, i] };
  }).sort((a, b) => { for (let j = 0; j < a.k.length; j++) if (a.k[j] !== b.k[j]) return a.k[j] - b.k[j]; return 0; }).map(x => x.r);
}

// I3: what connected tools are told to hand off on their own, and what that saved.
/** The standing instruction for a connected tool (MCP server instructions and the delegate tool's description): the kinds of the
 *  setting `routing.offload`; none = only when the user asks. */
export const offloadText = (kinds: string[]): string => (kinds.length ? `Without being asked, hand these kinds of task to \`delegate\` with target \`auto\` `
  + `instead of doing them yourself: ${kinds.join(', ')}. Agent Spaghetti runs them on a free tool or model and returns the result, which saves the user's paid usage. `
  + 'Do it when the work is bigger than the hand-off (several files to read, a long answer, searching): a small task costs more to hand off than to do. '
  + 'Keep planning, decisions and anything that needs this conversation. Set `kind`, write the task so it stands alone, and if the result is missing or poor, do the task yourself.' : '');
/** What free targets did for other tools: finished runs there, and the tokens they reported. */
export interface Saved { tasks: number; tokens: number }
export function savings(rows: RunRow[], free: (target: string) => boolean, since = 0): Saved {
  const done = rows.filter(r => r.outcome === 'done' && r.ts >= since && r.source !== 'agent-spaghetti' && free(r.target));
  return { tasks: done.length, tokens: done.reduce((n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0) };
}
