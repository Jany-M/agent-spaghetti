// The one delegation pipeline (Phase 3): permission check (`run` grant, ADR 0005) → question if needed → run on a
// local model (OpenAI engine) or an agent module → events + run record + result file. MCP, CLI and client hooks all use it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsentScope, Environment, Integration, RunEvent, RunOutcome, RunRequest, RunRow, Snapshot, Target } from '@agent-spaghetti/sdk';
import { TASK_KINDS, runDecision, withGrants } from '@agent-spaghetti/sdk';
import type { Bus } from './bus.ts';
import type { Consent } from './consent.ts';
import type { Ledger } from './ledger.ts';
import type { Settings } from './settings.ts';
import { openaiRun } from './engine/openai.ts';

export interface RunnerDeps {
  bus: Bus; consent: Consent; ledger: Ledger; settings: Settings; resultsDir: string;
  host(): Environment | null; snapshot(): Snapshot | null; integrations(): Integration[];
}
const EMPTY_INV = { installed: [], processes: [], listening: [], env: {}, partial: [] };

/** What `delegate` can use right now on this machine (from the last scan; the host environment runs it). */
export function targets(d: Pick<RunnerDeps, 'host' | 'snapshot' | 'integrations'>): Target[] {
  const snap = d.snapshot(), hostId = d.host()?.id;
  if (!snap || !hostId) return [];
  const byId = new Map(d.integrations().map(i => [i.manifest.id, i]));
  const out: Target[] = [];
  for (const det of snap.detections) {
    const i = byId.get(det.integration);
    if (!i || out.some(t => t.id === det.integration)) continue;
    const models = snap.backends.filter(b => b.integration === det.integration && b.reachableFrom.includes(hostId)).map(b => b.model);
    if (i.manifest.speaks?.openai && models.length) out.push({ id: det.integration, name: det.name, kind: 'model', cost: det.cost, envId: hostId, models });
    else if (i.module?.run && det.envId === hostId) out.push({ id: det.integration, name: det.name, kind: 'agent', cost: det.cost, envId: hostId, models: [] });
  }
  return out;
}

const SCOPES = (jobId?: string): ConsentScope[] => (jobId ? ['once', 'job', 'always'] : ['once', 'always']);
export class Runner {
  private d: RunnerDeps;
  private running = new Map<number, { ac: AbortController; done: Promise<RunRow> }>();
  constructor(d: RunnerDeps) { this.d = d; }

  /** Starts a run and returns its id at once; `done` settles with the final run record. */
  start(source: string, req: RunRequest): { id: number; done: Promise<RunRow> } {
    const t = targets(this.d).find(x => x.id === req.target);
    if (!t) throw new Error(`unknown or unavailable target ${req.target} (see: targets)`);
    if (req.model && t.kind === 'model' && !t.models.includes(req.model)) throw new Error(`${t.name} has no loaded model ${req.model} (loaded: ${t.models.join(', ')})`);
    const kind = req.kind && (TASK_KINDS as readonly string[]).includes(req.kind) ? req.kind : 'other';
    const row: Omit<RunRow, 'id'> = { ts: Date.now(), source, target: t.id, kind, reason: req.reason, parentRunId: req.parentRunId, jobId: req.jobId,
      taskHash: createHash('sha256').update(req.task).digest('hex'), outcome: 'running' };
    const id = this.d.ledger.record(row);
    const ac = new AbortController();
    this.emit('run.started', id, { source, target: t.id, kind, reason: req.reason ?? null, parentRunId: req.parentRunId ?? null });
    const done = this.run(id, source, t, { ...req, kind }, ac).finally(() => this.running.delete(id));
    this.running.set(id, { ac, done });
    return { id, done };
  }
  cancel(id: number): boolean { const r = this.running.get(id); r?.ac.abort(new Error('cancelled')); return !!r; }
  wait(id: number): Promise<RunRow> | null { return this.running.get(id)?.done ?? null; }

  private async run(id: number, source: string, t: Target, req: RunRequest, ac: AbortController): Promise<RunRow> {
    const t0 = Date.now();
    const finish = (outcome: RunOutcome, patch: Partial<RunRow> = {}) => {
      this.d.ledger.update(id, { outcome, durationMs: Date.now() - t0, ...patch });
      this.emit('run.finished', id, { outcome, target: t.id, error: patch.error ?? null });
      return this.d.ledger.get(id)!;
    };
    const s = this.d.settings;
    const decision = runDecision(s.grants(), source, t.id, t.cost, { jobId: req.jobId, spentUsd: g => this.d.ledger.spentUsd(g) });
    if (decision.mode === 'deny') return finish('denied', { error: decision.why });
    if (decision.mode === 'ask') {
      const a = await this.d.consent.request({ subject: source, action: 'run', resource: t.id, task: req.task, cost: t.cost, scopes: SCOPES(req.jobId),
        why: `${req.reason ?? 'no reason given'} (${decision.why})`, billing: t.cost === 'free' ? undefined : `uses your ${t.name} account or plan`,
        timeoutMs: s.get('consent.timeoutSec') * 1000 });
      if (a.answer !== 'granted') return finish(a.answer, { error: a.answer === 'denied' ? 'denied by the user' : 'no answer in time' });
      if (a.scope !== 'once') s.setGrants(withGrants(s.grants(), [{ subject: source, action: 'run', resource: t.id, mode: 'allow', by: 'user', ts: Date.now(),
        ...(a.scope === 'job' ? { jobId: req.jobId } : {}) }]));
    }
    const deadline = setTimeout(() => ac.abort(new Error('deadline reached')), req.deadlineMs ?? s.get('delegate.deadlineSec') * 1000);
    let result = '', usage: Extract<RunEvent, { type: 'usage' }> | undefined, error: string | undefined, model = req.model;
    try {
      for await (const e of this.engine(id, t, req, ac.signal, m => { model = m; })) {
        if (e.type === 'text') result += e.text;
        else if (e.type === 'tool') this.emit('run.event', id, { tool: e.name, summary: e.summary });
        else if (e.type === 'usage') usage = e;
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
    const host = this.d.host(), i = this.d.integrations().find(x => x.manifest.id === t.id);
    if (!host || !i) throw new Error(`${t.id} is not available`);
    if (t.kind === 'model') {
      const model = req.model ?? t.models[0];
      const b = this.d.snapshot()!.backends.find(x => x.integration === t.id && x.model === model)!;
      onModel(model);
      return openaiRun(host, { endpoint: b.endpoint, base: i.manifest.speaks!.openai!.base, model, concurrency: this.d.settings.get('backend.concurrency') }, req,
        { signal, onQueue: (waiting, running) => this.d.bus.emit({ ts: Date.now(), type: 'backend.queue', envId: host.id, source: t.id, data: { endpoint: b.endpoint, waiting, running } }) });
    }
    const det = this.d.snapshot()!.detections.find(x => x.integration === t.id && x.envId === host.id)!;
    return i.module!.run!(host, det, req, { signal, inventory: EMPTY_INV, runId: id });
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
