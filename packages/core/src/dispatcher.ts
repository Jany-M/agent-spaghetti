// The dispatcher (ADR 0010 §6): Agent Spaghetti's own fallback and observer. It picks a target for hops that name `auto` (or,
// when it is on, one that is not available), and hands a run without progress for `dispatcher.stuckMin` to the next target,
// once per chain. It thinks with `dispatcher.model` through the runner itself (its runs are recorded like any other);
// without a model it is off and `auto` takes the best-ranked target (sdk rankTargets: free first, no tool preferred).
import type { Disposable, RunRequest, Target } from '@agent-spaghetti/sdk';
import { AUTO, parseHop, rankTargets } from '@agent-spaghetti/sdk';
import type { Bus } from './bus.ts';
import type { Ledger } from './ledger.ts';
import type { Settings } from './settings.ts';
import type { Runner } from './runner.ts';

export const SELF = 'agent-spaghetti';
const WATCH_MS = 30_000;

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
  private d: { runner: Runner; settings: Settings; bus: Bus; ledger: Ledger };
  private handed = new Set<number>();                       // chains handed over once
  private reported = new Set<number>();                     // runs reported stuck
  constructor(d: Dispatcher['d']) { this.d = d; }
  on(): boolean { return !!this.d.settings.get('dispatcher.model'); }

  /** The request with a target chosen: the model's pick when on, else the ranking's first. Never the caller itself. */
  async route(source: string, req: RunRequest): Promise<RunRequest> {
    if (req.target !== AUTO && !this.on()) return req;      // an unknown target stays an error when the dispatcher is off
    const options = rankTargets(this.d.runner.targets().filter(t => t.id !== source));
    if (!options.length) throw new Error('no target is available for this task (see: targets)');
    let pick: { target: string; model?: string } = { target: options[0].id }, why = 'best-ranked target';
    if (this.on()) {
      const answer = await this.think(routePrompt(req.task, options)).catch(e => { why = `dispatcher model failed (${(e as Error).message}): best-ranked target`; return ''; });
      const p = parseRoute(answer, options);
      if (p) { pick = p; why = 'chosen by the dispatcher model'; } else if (answer) why = 'dispatcher answer not a target: best-ranked target';
    }
    this.act('routed', { asked: req.target, to: pick.target, why });
    return { ...req, ...pick };
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
      const next = rankTargets(this.d.runner.targets().filter(t => t.id !== r.target && t.id !== r.source))[0];
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
