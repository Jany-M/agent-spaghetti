// The dispatcher (ADR 0010 §6): Agent Spaghetti's own fallback and observer. It picks a target for hops that name `auto` (or,
// when it is on, one that is not available) from the ranking for the task (sdk route: the task's kind and difficulty, the
// `routing.*` settings, past runs, queues; no tool preferred), hands a run without progress for `dispatcher.stuckMin` to the next
// target, once per chain, and names the next target when a chosen one fails (runner escalation). With `dispatcher.model` set it
// also asks that model to pick among the ranked targets, through the runner itself (its runs are recorded like any other).
import type { Classification, Disposable, LiveState, Ranked, RunRequest, Target } from '@agent-spaghetti/sdk';
import { AUTO, EDIT_KINDS, classifyRequest, mayEdit, parseHop, route, summarizeRuns } from '@agent-spaghetti/sdk';
import type { Bus } from './bus.ts';
import type { Ledger } from './ledger.ts';
import type { Settings } from './settings.ts';
import type { Runner } from './runner.ts';

export const SELF = 'agent-spaghetti';
const WATCH_MS = 30_000;
const STATS_RUNS = 2000;                                    // the latest runs the ranking learns from (older ones weigh little anyway)

/** The question the dispatcher model answers: one target id for the task. */
export const routePrompt = (task: string, options: Target[]) => ['Pick the one tool that should do the task below. Answer with its id only'
  + ' (or id:model to choose one of its models), nothing else.', '', 'Tools:',
  ...options.map(t => `- ${t.id}: ${t.name}, ${t.kind}, ${t.cost}${t.models.length ? `, models: ${t.models.join(', ')}` : ''}`), '', 'Task:', task.slice(0, 4000)].join('\n');
/** The model's answer as a hop, if it names one of the options. */
export function parseRoute(answer: string, options: Target[]): { target: string; model?: string } | null {
  const word = answer.trim().split(/\s+/)[0]?.replace(/^[`'"*]+|[`'".,*]+$/g, '') ?? '';
  const hop = parseHop(word), t = options.find(o => o.id === hop.target);
  return t ? { target: t.id, ...(hop.model && t.models.includes(hop.model) ? { model: hop.model } : {}) } : null;
}

export class Dispatcher {
  private d: { runner: Runner; settings: Settings; bus: Bus; ledger: Ledger; live?(): LiveState };
  private handed = new Set<number>();                       // chains handed over once
  private reported = new Set<number>();                     // runs reported stuck
  constructor(d: Dispatcher['d']) { this.d = d; }
  on(): boolean { return !!this.d.settings.get('dispatcher.model'); }
  /** Every available target for a task, best first (skipped ones last, with why); `source` and `without` never take it. */
  ranking(c: Pick<Classification, 'kind' | 'difficulty'> & { edits?: boolean }, source?: string, without: string[] = []): Ranked[] {
    const s = this.d.settings, q = this.d.live?.().queues ?? {}, learn = s.get('routing.learn');
    return route(c, this.d.runner.targets().filter(t => !without.includes(t.id)), { source, learn, stretch: s.get('routing.stretch'),
      prefer: s.get('routing.prefer'), never: s.get('routing.never'), tiers: s.get('routing.tiers'),
      stats: summarizeRuns(this.d.ledger.list({ since: 0, limit: STATS_RUNS })), queued: id => (q[id]?.waiting ?? 0) + (q[id]?.running ?? 0) });
  }

  /** The request with a target chosen: the model's pick when on, else the ranking's first; never the caller nor `without`. */
  async route(source: string, req: RunRequest, without: string[] = []): Promise<RunRequest> {
    if (req.target !== AUTO && !this.on()) return req;      // an unknown target stays an error when the dispatcher is off
    const c = classifyRequest(req);
    const ranked = this.ranking({ ...c, edits: mayEdit({ ...req, kind: c.kind }) }, source, without), options = ranked.filter(r => !r.skip).map(r => r.target);
    if (!options.length) throw new Error(`no target can take this ${c.kind} task now${ranked.length ? ` (${ranked.map(r => `${r.target.id}: ${r.why}`).join('; ')})` : ''} (see: targets)`);
    let pick: { target: string; model?: string } = { target: options[0].id }, why = ranked[0].why;
    if (this.on()) {
      const prompt = routePrompt(req.task, options);
      this.d.bus.trace(SELF, { stage: 'route-prompt', text: prompt });
      const answer = await this.think(prompt).catch(e => { why = `dispatcher model failed (${(e as Error).message}): best-ranked target`; return ''; });
      const p = parseRoute(answer, options);
      this.d.bus.trace(SELF, { stage: 'route-answer', text: p ? `picked ${p.model ? `${p.target}:${p.model}` : p.target}` : `no target in the answer: ${answer || '(empty)'}` });
      if (p) { pick = p; why = 'chosen by the dispatcher model'; } else if (answer) why = 'dispatcher answer not a target: best-ranked target';
    }
    this.act(without.length ? 'escalated' : 'routed', { asked: req.target, to: pick.target, why, kind: c.kind, difficulty: c.difficulty, ...(without.length ? { from: without.join(', '), id: req.chainId } : {}) });
    return { ...req, ...pick, classification: c, chosen: true };
  }
  /** Every WATCH_MS: runs without progress for `dispatcher.stuckMin` go to the next-ranked target (once per chain), else are reported once. */
  watch(): Disposable {
    const timer = setInterval(() => this.check(), WATCH_MS);
    timer.unref?.();
    return { dispose: () => clearInterval(timer) };
  }
  check(now = Date.now()): void {
    if (!this.on()) return;
    const limit = this.d.settings.get('dispatcher.stuckMin') * 60_000;
    for (const r of this.d.runner.active()) {
      if (r.source === SELF || now - r.at < limit) continue;  // never acts on its own runs
      const row = this.d.ledger.get(r.id);
      const next = row && this.ranking({ kind: row.kind, difficulty: row.difficulty ?? 'medium', edits: EDIT_KINDS.has(row.kind) }, r.source, [r.target]).find(x => !x.skip)?.target;   // the folder is not recorded: an edit kind stays with agents
      if (this.handed.has(r.chainId) || !next) { if (!this.reported.has(r.id)) { this.reported.add(r.id); this.act('stuck', { id: r.id, target: r.target }); } continue; }   // the deadline ends it
      this.handed.add(r.chainId);
      if (this.d.runner.handOver(r.id, next.id)) this.act('handed-over', { id: r.id, from: r.target, to: next.id });
    }
  }
  private async think(prompt: string): Promise<string> {
    const { target, model } = parseHop(this.d.settings.get('dispatcher.model'));
    const { done } = this.d.runner.start(SELF, { target, model, task: prompt, kind: 'other', reason: 'routing a hand-off', returnTo: 'none' });
    const row = await done;
    if (row.outcome !== 'done') throw new Error(row.error ?? row.outcome);
    return this.d.ledger.result(row) ?? '';
  }
  private act(what: string, data: Record<string, unknown>) { this.d.bus.emit({ ts: Date.now(), type: 'dispatcher.action', envId: 'hub', source: SELF, data: { what, ...data } }); }
}
