// The one delegation pipeline: permission check (`run` grant, ADR 0005) → question if needed → run on the target's engine
// → events + run record + result file; then the next hop of the chain, and at the end the result goes back (ADR 0010).
// MCP, CLI, tray and client hooks all use it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsentScope, Delivery, Environment, Integration, RunEvent, RunOutcome, RunRequest, RunRow, Snapshot, Target } from '@agent-spaghetti/sdk';
import { AUTO, TASK_KINDS, programOf, runDecision, withGrants } from '@agent-spaghetti/sdk';
import type { Bus } from './bus.ts';
import type { Consent } from './consent.ts';
import type { Ledger } from './ledger.ts';
import type { Settings } from './settings.ts';
import { openaiHeaders, openaiRun } from './engine/openai.ts';
import { chatTask } from './engine/chat.ts';
import { deliver } from './returns.ts';

export interface RunnerDeps {
  bus: Bus; consent: Consent; ledger: Ledger; settings: Settings; resultsDir: string;
  host(): Environment | null; snapshot(): Snapshot | null; integrations(): Integration[];
  /** A target for a hop that names `auto` or an unavailable one (core/dispatcher.ts); without it such hops are refused. */
  route?(source: string, req: RunRequest): Promise<RunRequest>;
  /** An agent's run in the environment where it was found (core/dispatch.ts runOnEnv). */
  runOn(envId: string, id: string, req: RunRequest, o: { signal: AbortSignal; runId: number }): AsyncIterable<RunEvent>;
}
/** What the runner keeps about a hand-off chain while it runs: who asked and where the result goes. */
export interface Chain { id: number; source: string; returnTo: 'caller' | 'none'; returnSession?: string; parentRunId?: number; watchedAt?: number }
/** What `delegate` can use right now on this machine (from the last scan). Models: servers the host reaches. Agents: tools that speak
 *  ACP, have a run hook or take tasks in their chat, in a running environment where their own program was found (the host first); `models` lists their agents. */
export function targets(d: Pick<RunnerDeps, 'host' | 'snapshot' | 'integrations'>): Target[] {
  const snap = d.snapshot(), hostId = d.host()?.id;
  if (!snap || !hostId) return [];
  const byId = new Map(d.integrations().map(i => [i.manifest.id, i]));
  const running = new Set(snap.envs.filter(e => e.state === 'running').map(e => e.id));
  const out: Target[] = [];
  for (const det of [...snap.detections].sort((a, b) => Number(b.envId === hostId) - Number(a.envId === hostId))) {
    const i = byId.get(det.integration);
    if (!i || out.some(t => t.id === det.integration)) continue;
    const models = snap.backends.filter(b => b.integration === det.integration && b.reachableFrom.includes(hostId)).map(b => b.model);
    const sp = i.manifest.speaks, engine = sp?.acp ? 'acp' : i.module?.run ? 'module' : sp?.chat ? 'chat' : null;   // a tool's best engine (ADR 0010 §2)
    if (sp?.openai && models.length) out.push({ id: det.integration, name: det.name, kind: 'model', cost: det.cost, envId: hostId, models, engine: 'openai', resumable: false });
    else if (engine && running.has(det.envId) && programOf(det, (sp?.acp ?? (engine === 'chat' ? sp?.chat : undefined))?.command[0] ?? i.manifest.detect?.bin?.[0]))
      out.push({ id: det.integration, name: det.name, kind: 'agent', cost: det.cost, envId: det.envId, engine, resumable: engine === 'acp' || (engine === 'module' && !!i.module?.resumes),
        models: snap.agents.filter(a => a.integration === det.integration && a.envId === det.envId).map(a => a.id.slice(det.integration.length + 1)) });
  }
  return out;
}

const SCOPES = (jobId?: string): ConsentScope[] => (jobId ? ['once', 'job', 'always'] : ['once', 'always']);
/** `target[:model]` (target ids never contain ':'; models may). */
export const parseHop = (hop: string) => { const i = hop.indexOf(':'); return i < 0 ? { target: hop } : { target: hop.slice(0, i), model: hop.slice(i + 1) || undefined }; };
const withContext = (req: RunRequest) => (req.context ? `${req.task}\n\n## Context from the previous step\n${req.context}` : req.task);
const INLINE_MS = 5000;   // a caller that polled this recently is still waiting for the result

export class Runner {
  private d: RunnerDeps;
  private running = new Map<number, { ac: AbortController; done: Promise<RunRow>; target: string; source: string; chainId: number; at: number }>();
  private retries = new Map<number, string>();                                               // stuck hop → the target that takes it over
  private chains = new Map<number, Chain & { done: Promise<RunRow>; resolve(r: RunRow): void }>();
  private reports = new Map<number, (r: { result: string; failed: boolean }) => void>();   // chat runs waiting for `report`
  constructor(d: RunnerDeps) { this.d = d; }

  /** Starts a hand-off and returns its id at once; `done` settles with the chain's last run record.
   *  `preapproved`: a result going back to its caller (no new question, still recorded). */
  start(source: string, req: RunRequest, o: { preapproved?: boolean } = {}): { id: number; done: Promise<RunRow> } {
    const t = this.targets().find(x => x.id === req.target);
    if (!t) throw new Error(`unknown or unavailable target ${req.target} (see: targets)`);
    if (req.model && t.models.length && !t.models.includes(req.model))
      throw new Error(`${t.name} has no ${t.kind === 'model' ? 'loaded model' : 'agent'} ${req.model} (${t.kind === 'model' ? 'loaded' : 'agents'}: ${t.models.join(', ')})`);
    for (const hop of req.then ?? []) if (parseHop(hop).target !== AUTO && !this.targets().some(x => x.id === parseHop(hop).target)) throw new Error(`unknown or unavailable target ${parseHop(hop).target} in then (see: targets)`);
    const kind = req.kind && (TASK_KINDS as readonly string[]).includes(req.kind) ? req.kind : 'other';
    // An agent that delegates while it runs a delegated task works on that task (one such run: it is the parent).
    const busy = [...this.running].filter(([, r]) => r.target === source);
    req = { ...req, kind, parentRunId: req.parentRunId ?? (busy.length === 1 ? busy[0][0] : undefined) };
    const max = this.d.settings.get('delegate.maxHops');
    if (!o.preapproved && this.d.ledger.depth(req.parentRunId) + 1 > max) throw new Error(`hop budget reached: ${max} hand-offs in one chain (setting delegate.maxHops)`);
    const id = this.d.ledger.record({ ts: Date.now(), source, target: t.id, kind, reason: req.reason, parentRunId: req.parentRunId, jobId: req.jobId,
      taskHash: createHash('sha256').update(req.task).digest('hex'), outcome: 'running', chainId: req.chainId, returnTo: req.returnTo ?? 'caller' });
    const chainId = req.chainId ?? id;
    if (!req.chainId) {
      let resolve!: (r: RunRow) => void;
      const done = new Promise<RunRow>(r => { resolve = r; });
      this.chains.set(chainId, { id: chainId, source, returnTo: req.returnTo ?? 'caller', returnSession: req.returnSession, parentRunId: req.parentRunId, done, resolve });
    }
    req = { ...req, chainId, jobId: req.jobId ?? `chain-${chainId}` };      // "Allow for this job" covers the whole chain
    const ac = new AbortController();
    this.emit('run.started', id, { source, target: t.id, kind, reason: req.reason ?? null, parentRunId: req.parentRunId ?? null, chainId });
    const hop = this.run(id, source, t, req, ac, !!o.preapproved).finally(() => this.running.delete(id));
    this.running.set(id, { ac, done: hop, target: t.id, source, chainId, at: Date.now() });
    void hop.then(r => this.next(r, req));
    return { id, done: this.chains.get(chainId)!.done };
  }
  /** A chat run's result, sent by the agent that did it (only the run's target may report it). */
  report(id: number, source: string, result: string, failed = false): void {
    const run = this.d.ledger.get(id), done = this.reports.get(id);
    if (!run || !done) throw new Error(`run ${id} is not waiting for a report`);
    if (run.target !== source) throw new Error(`only ${run.target} can report run ${id}`);
    done({ result, failed });
  }
  targets(): Target[] { return targets(this.d); }
  /** start(), after the dispatcher picked a target when the request names `auto` or one that is not available. */
  async begin(source: string, req: RunRequest, o: { preapproved?: boolean } = {}) {
    const known = this.targets().some(t => t.id === req.target);
    return this.start(source, known || !this.d.route ? req : await this.d.route(source, req), o);
  }
  cancel(id: number, why = 'cancelled'): boolean { const r = this.running.get(id); r?.ac.abort(new Error(why)); return !!r; }
  /** Runs in progress and when each last showed progress (the dispatcher's watchdog). */
  active() { return [...this.running].map(([id, r]) => ({ id, target: r.target, source: r.source, chainId: r.chainId, at: r.at })); }
  /** A stuck hop goes to another target: cancelled here, started again there in the same chain. */
  handOver(id: number, target: string): boolean { if (!this.running.has(id)) return false; this.retries.set(id, target); return this.cancel(id, `no progress: handed to ${target}`); }
  /** The caller is polling this chain: it gets the result inline when the chain ends. */
  watch(chainId: number): void { const c = this.chains.get(chainId); if (c) c.watchedAt = Date.now(); }
  wait(chainId: number): Promise<RunRow> | null { return this.chains.get(chainId)?.done ?? null; }

  /** After a hop: the next one (previous result as context, same chain), or the chain ends and its result goes back. */
  private async next(row: RunRow, req: RunRequest) {
    const over = this.retries.get(row.id);
    if (over) {
      this.retries.delete(row.id);
      try { this.start(row.source, { ...req, target: over, model: undefined, session: undefined }); return; }
      catch (e) { this.d.ledger.update(row.id, { error: `${row.error}; not handed over: ${(e as Error).message}` }); }
    }
    const [hop, ...rest] = req.then ?? [];
    if (row.outcome === 'done' && hop) {
      try {
        await this.begin(row.target, { ...req, ...parseHop(hop), session: undefined, context: this.d.ledger.result(row), then: rest, parentRunId: row.id }); return;
      } catch (e) { this.d.ledger.update(row.id, { error: `next hop not started: ${(e as Error).message}` }); }
    }
    const c = this.chains.get(req.chainId!);
    if (!c) return;
    this.chains.delete(c.id);
    const last = this.d.ledger.get(row.id)!;
    c.resolve(last);
    if (c.returnTo === 'none') return;
    if (c.watchedAt && Date.now() - c.watchedAt < INLINE_MS) return this.setDelivered(c.id, 'inline');
    try { this.setDelivered(c.id, deliver(c, last, this.targets().find(t => t.id === c.source), this.d.ledger, this)); }
    catch (e) { this.d.ledger.update(c.id, { error: `result not delivered: ${(e as Error).message}` }); }
  }
  /** Where the chain's result went (on the chain's first row, the one its caller knows). */
  setDelivered(chainId: number, how: Delivery) {
    this.d.ledger.update(chainId, { delivered: how });
    this.d.bus.emit({ ts: Date.now(), type: 'run.delivered', envId: 'hub', source: 'runner', data: { id: chainId, how } });
  }

  private async run(id: number, source: string, t: Target, req: RunRequest, ac: AbortController, preapproved: boolean): Promise<RunRow> {
    const t0 = Date.now();
    const finish = (outcome: RunOutcome, patch: Partial<RunRow> = {}) => {
      this.d.ledger.update(id, { outcome, durationMs: Date.now() - t0, ...patch });
      this.emit('run.finished', id, { outcome, target: t.id, error: patch.error ?? null, chainId: req.chainId });
      return this.d.ledger.get(id)!;
    };
    const s = this.d.settings;
    const decision = preapproved ? { mode: 'allow' as const, why: 'a result going back to its caller' }
      : runDecision(s.grants(), source, t.id, t.cost, { jobId: req.jobId, spentUsd: g => this.d.ledger.spentUsd(g) });
    if (decision.mode === 'deny') return finish('denied', { error: decision.why });
    if (decision.mode === 'ask') {
      const a = await this.d.consent.request({ subject: source, action: 'run', resource: t.id, task: withContext(req), cost: t.cost, scopes: SCOPES(req.jobId),
        why: `${req.reason ?? 'no reason given'} (${decision.why})`, billing: t.cost === 'free' ? undefined : `uses your ${t.name} account or plan`,
        timeoutMs: s.get('consent.timeoutSec') * 1000 });
      if (a.answer !== 'granted') return finish(a.answer, { error: a.answer === 'denied' ? 'denied by the user' : 'no answer in time' });
      if (a.scope !== 'once') s.setGrants(withGrants(s.grants(), [{ subject: source, action: 'run', resource: t.id, mode: 'allow', by: 'user', ts: Date.now(),
        ...(a.scope === 'job' ? { jobId: req.jobId } : {}) }]));
    }
    const deadline = setTimeout(() => ac.abort(new Error('deadline reached')), req.deadlineMs ?? s.get('delegate.deadlineSec') * 1000);
    let result = '', usage: Extract<RunEvent, { type: 'usage' }> | undefined, error: string | undefined, model = req.model;
    try {
      for await (const e of this.engine(id, t, { ...req, task: withContext(req) }, ac.signal, m => { model = m; })) {
        const r = this.running.get(id); if (r) r.at = Date.now();
        if (e.type === 'text') result += e.text;
        else if (e.type === 'tool') this.emit('run.event', id, { tool: e.name, summary: e.summary });
        else if (e.type === 'usage') usage = e;
        else if (e.type === 'session') this.d.ledger.update(id, { session: e.id });
        else if (e.type === 'done') result = e.result || result;
        else error = e.message;
      }
    } catch (err) { error = ((ac.signal.aborted ? ac.signal.reason : err) as Error).message; }   // cancel and deadline say why
    finally { clearTimeout(deadline); }
    const file = this.writeResult(id, req, result, error);
    const outcome: RunOutcome = !error ? 'done' : error === 'cancelled' ? 'cancelled' : 'error';
    return finish(outcome, { model, error, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens, costUsd: usage?.costUsd, ...file });
  }
  private engine(id: number, t: Target, req: RunRequest, signal: AbortSignal, onModel: (m: string) => void): AsyncIterable<RunEvent> {
    if (t.kind === 'model') {
      const host = this.d.host(), i = this.d.integrations().find(x => x.manifest.id === t.id);
      if (!host || !i) throw new Error(`${t.id} is not available`);
      const model = req.model ?? t.models[0];
      const b = this.d.snapshot()!.backends.find(x => x.integration === t.id && x.model === model)!;
      onModel(model);
      const headers = openaiHeaders(i.manifest);
      return openaiRun(host, { endpoint: b.endpoint, base: i.manifest.speaks!.openai!.base, model, concurrency: this.d.settings.get('backend.concurrency'), headers }, req,
        { signal, onQueue: (waiting, running) => this.d.bus.emit({ ts: Date.now(), type: 'backend.queue', envId: host.id, source: t.id, data: { endpoint: b.endpoint, waiting, running } }) });
    }
    return t.engine === 'chat' ? this.chatRun(id, t, req, signal) : this.d.runOn(t.envId, t.id, req, { signal, runId: id });
  }
  /** Opens the task in the tool's chat, then waits for its `report` (a report run, a result handed back, waits for nothing). */
  private async *chatRun(id: number, t: Target, req: RunRequest, signal: AbortSignal): AsyncIterable<RunEvent> {
    const waiting = req.kind === 'report' ? null : new Promise<{ result: string; failed: boolean }>((res, rej) => {
      this.reports.set(id, res); signal.addEventListener('abort', () => rej(signal.reason), { once: true });
    });
    waiting?.catch(() => { /* awaited below; a failed launch never gets there */ });
    try {
      yield* this.d.runOn(t.envId, t.id, { ...req, task: chatTask(req, id) }, { signal, runId: id });
      const r = await waiting;
      yield r?.failed ? { type: 'error', message: r.result || 'the agent reported a failure' } : { type: 'done', result: r?.result ?? '' };
    } finally { this.reports.delete(id); }
  }
  /** `<data>/results/<id>.md`, plus a copy in the caller's folder when asked (e.g. the Cursor workspace). */
  private writeResult(id: number, req: RunRequest, result: string, error?: string): Partial<RunRow> {
    const text = error ? `${result}\n\n**Failed:** ${error}\n` : result;
    if (!text.trim()) return {};
    for (const dir of [this.d.resultsDir, req.resultDir].filter((x): x is string => !!x)) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${id}.md`), text); }
    return { resultPath: join(this.d.resultsDir, `${id}.md`), resultSha256: createHash('sha256').update(text).digest('hex') };
  }
  private emit(type: 'run.started' | 'run.event' | 'run.finished', id: number, data: Record<string, unknown>) {
    this.d.bus.emit({ ts: Date.now(), type, envId: 'hub', source: 'runner', data: { id, ...data } });
  }
}
