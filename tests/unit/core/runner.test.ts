// Delegation: run decisions, ledger (run record), the runner pipeline, the OpenAI engine queue, claude-cli parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDecision, type Detection, type Grant, type Integration, type Manifest, type RunEvent, type Snapshot } from '@agent-spaghetti/sdk';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';
import { Consent } from '../../../packages/core/src/consent.ts';
import { Settings } from '../../../packages/core/src/settings.ts';
import { Ledger } from '../../../packages/core/src/ledger.ts';
import { Runner, targets } from '../../../packages/core/src/runner.ts';
import { openaiRun } from '../../../packages/core/src/engine/openai.ts';
import { claudeArgs, toEvents } from '../../../integrations/claude-cli/index.ts';

const g = (o: Partial<Grant>): Grant => ({ subject: 'cursor', action: 'run', resource: 'claude-cli', mode: 'allow', by: 'user', ts: 0, ...o });
test('runDecision: deny wins, job-bound grants only for their job, budgets turn into a question, defaults by cost', () => {
  const spent = (n: number) => ({ spentUsd: () => n });
  assert.equal(runDecision([], 'cursor', 'lmstudio', 'free', spent(0)).mode, 'allow');
  assert.equal(runDecision([], 'cursor', 'claude-cli', 'metered', spent(0)).mode, 'ask');
  assert.equal(runDecision([g({ mode: 'deny' })], 'cursor', 'claude-cli', 'free', spent(0)).mode, 'deny');
  assert.equal(runDecision([g({ jobId: 'j1' })], 'cursor', 'claude-cli', 'metered', { jobId: 'j2', ...spent(0) }).mode, 'ask');
  assert.equal(runDecision([g({ jobId: 'j1' })], 'cursor', 'claude-cli', 'metered', { jobId: 'j1', ...spent(0) }).mode, 'allow');
  assert.equal(runDecision([g({ budgetUsd: 1 })], 'cursor', 'claude-cli', 'metered', spent(0.4)).mode, 'allow');
  const over = runDecision([g({ budgetUsd: 1 })], 'cursor', 'claude-cli', 'metered', spent(1.2));
  assert.deepEqual([over.mode, over.why], ['ask', 'budget used: $1.20 of $1.00']);
  assert.equal(runDecision([g({ resource: '*' })], 'cursor', 'anything', 'metered', spent(0)).mode, 'allow');
});

test('ledger: chain from any run, spent under a grant, no task text stored', () => {
  const store = new Store(':memory:'), l = new Ledger(store);
  const base = { ts: 10, source: 'cursor', target: 'lmstudio', kind: 'other' as const, taskHash: 'h', outcome: 'done' as const };
  const a = l.record(base), b = l.record({ ...base, parentRunId: a, target: 'claude-cli', costUsd: 0.5 }), c = l.record({ ...base, parentRunId: b, costUsd: 0.25, target: 'claude-cli' });
  assert.deepEqual(l.chain(b).map(r => r.id), [a, b, c]);
  assert.deepEqual(l.chain(c).map(r => r.id), [a, b, c]);
  assert.equal(l.spentUsd(g({ ts: 0 })), 0.75);
  assert.equal(l.spentUsd(g({ ts: 11 })), 0);
  l.update(b, { verdict: 'redo' });
  assert.equal(l.get(b)!.verdict, 'redo');
  assert.equal(l.list({ limit: 2 }).map(r => r.id).join(), `${c},${b}`);
});

const lms = BUILTINS.find(i => i.manifest.id === 'lmstudio')!;
const agentEvents: RunEvent[] = [{ type: 'tool', name: 'Read', summary: '{}' }, { type: 'text', text: 'partial ' }, { type: 'usage', inputTokens: 5, outputTokens: 7, costUsd: 0.25 }, { type: 'done', result: 'final answer' }];
const agent: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'paid-agent', name: 'Paid Agent', roles: ['agent'], cost: 'metered' } as Manifest,
  module: { async *run(_e, _d, req, ctx) { if (req.task === 'boom') throw new Error('kaput'); if (req.task === 'slow') { await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('stop')))); } yield* agentEvents; } } };
const det = (integration: string, cost: 'free' | 'metered', envId = 'windows', installs: Detection['installs'] = [{ path: '/b/x', via: 'bin' }]) =>
  ({ integration, name: integration, envId, installs, levels: [], cost, connectable: 'yes' as const, why: '' });
const snap: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }], agents: [], rejected: [], detections: [det('lmstudio', 'free'), det('paid-agent', 'metered')],
  backends: [{ id: 'b', integration: 'lmstudio', model: 'm', envId: 'windows', endpoint: 'http://127.0.0.1:1234', reachableFrom: ['windows'] }] };
function setup() {
  const store = new Store(':memory:'), bus = new Bus(store), consent = new Consent(bus), settings = new Settings(store), ledger = new Ledger(store);
  const host = fakeEnv({ lines: { 'POST http://127.0.0.1:1234/v1/chat/completions': ['data: {"choices":[{"delta":{"content":"He"}}]}', 'data: {"choices":[{"delta":{"content":"llo"}}]}', 'data: [DONE]'] } });
  const resultsDir = mkdtempSync(join(tmpdir(), 'as-res-'));
  const runner = new Runner({ bus, consent, ledger, settings, resultsDir, host: () => host, snapshot: () => snap, integrations: () => [lms, agent],
    runOn: (envId, id, req, o) => agent.module!.run!(host, det(id, 'metered', envId), req, { ...o, inventory: { installed: [], processes: [], listening: [], env: {}, partial: [] } }) });
  return { store, bus, consent, settings, ledger, runner, resultsDir, host };
}
const firstQuestion = async (c: Consent) => { for (let i = 0; i < 50 && !c.pending().length; i++) await new Promise(r => setTimeout(r, 5)); return c.pending()[0]; };
const answerNext = async (c: Consent, allow: boolean, scope?: 'once' | 'job' | 'always') => { c.respond((await firstQuestion(c)).id, allow, scope); };

test('targets: loaded models the host reaches; agents with run() where their program was found, in a running env (host first), listing their agents', () => {
  const s = setup();
  const t = (sn: Snapshot) => targets({ host: () => s.host, snapshot: () => sn, integrations: () => [lms, agent] }).map(x => [x.id, x.kind, x.cost, x.envId, x.models.join()]);
  assert.deepEqual(t(snap), [['lmstudio', 'model', 'free', 'windows', 'm'], ['paid-agent', 'agent', 'metered', 'windows', '']]);
  const wsl: Snapshot = { ...snap, envs: [...snap.envs, { id: 'wsl:T', state: 'running' }],
    detections: [det('lmstudio', 'free'), det('paid-agent', 'metered', 'windows', [{ path: 'C:/Apps/Agent', via: 'installed' }]), det('paid-agent', 'metered', 'wsl:T')],
    agents: [{ id: 'paid-agent:main', integration: 'paid-agent', name: 'Main', envId: 'wsl:T' }, { id: 'paid-agent:other', integration: 'paid-agent', name: 'O', envId: 'windows' }] };
  assert.deepEqual(t(wsl), [['lmstudio', 'model', 'free', 'windows', 'm'], ['paid-agent', 'agent', 'metered', 'wsl:T', 'main']], 'an app without its program cannot run tasks');
  assert.deepEqual(t({ ...wsl, envs: snap.envs }), [['lmstudio', 'model', 'free', 'windows', 'm']], 'stopped env: no target');
});
test('runner: free model runs at once; result file + sha; the prompt never reaches the database', async () => {
  const s = setup();
  const { done } = s.runner.start('cursor', { target: 'lmstudio', task: 'SECRET-TASK say hello', kind: 'summarize', reason: 'r' });
  const row = await done;
  assert.deepEqual([row.outcome, row.model, row.kind, row.reason], ['done', 'm', 'summarize', 'r']);
  assert.equal(readFileSync(row.resultPath!, 'utf8'), 'Hello');
  assert.equal(row.resultSha256!.length, 64);
  assert.ok(!JSON.stringify(s.store.db.prepare('SELECT * FROM runs').all()).includes('SECRET-TASK'));
  assert.ok(!JSON.stringify(s.store.eventsSince(0)).includes('SECRET-TASK'));
});
test('runner: paid target asks; once / job / always; deny and expiry are recorded, nothing runs', async () => {
  const s = setup();
  let r = s.runner.start('cursor', { target: 'paid-agent', task: 'do it', reason: 'needs Claude' });
  await answerNext(s.consent, true, 'once');
  let row = await r.done;
  assert.deepEqual([row.outcome, row.costUsd, row.inputTokens], ['done', 0.25, 5]);
  assert.equal(readFileSync(row.resultPath!, 'utf8'), 'final answer');
  assert.equal(s.settings.grants().length, 0, 'once leaves no grant');
  assert.ok(s.store.eventsSince(0).some(e => e.type === 'run.event' && e.data.tool === 'Read'));
  r = s.runner.start('cursor', { target: 'paid-agent', task: 'x', jobId: 'j1' });
  assert.deepEqual((await firstQuestion(s.consent)).scopes, ['once', 'job', 'always']);
  await answerNext(s.consent, true, 'job'); await r.done;
  assert.equal(s.settings.grants()[0].jobId, 'j1');
  assert.equal((await s.runner.start('cursor', { target: 'paid-agent', task: 'x', jobId: 'j1' }).done).outcome, 'done', 'same job: no question');
  r = s.runner.start('cursor', { target: 'paid-agent', task: 'x' });
  await answerNext(s.consent, false);
  row = await r.done;
  assert.deepEqual([row.outcome, row.error], ['denied', 'denied by the user']);
  s.settings.set('consent.timeoutSec', 0.02 as never);
  row = await s.runner.start('cursor', { target: 'paid-agent', task: 'x' }).done;
  assert.equal(row.outcome, 'expired');
  s.settings.setGrants([g({ subject: 'cursor', resource: 'paid-agent', mode: 'deny' })]);
  assert.equal((await s.runner.start('cursor', { target: 'paid-agent', task: 'x' }).done).outcome, 'denied');
});
test('runner: errors and cancellation end the run cleanly; nested delegations link to the running parent; unknown target and model are refused up front', async () => {
  const s = setup();
  s.settings.setGrants([g({ resource: 'paid-agent' })]);
  const boom = await s.runner.start('cursor', { target: 'paid-agent', task: 'boom' }).done;
  assert.deepEqual([boom.outcome, boom.error], ['error', 'kaput']);
  const slow = s.runner.start('cursor', { target: 'paid-agent', task: 'slow' });
  await new Promise(r => setTimeout(r, 20));
  const nested = await s.runner.start('paid-agent', { target: 'lmstudio', task: 'sub-task' }).done;
  assert.equal(nested.parentRunId, slow.id, 'a delegation from a running agent belongs to its task');
  assert.equal(s.runner.cancel(slow.id), true);
  assert.equal((await slow.done).outcome, 'cancelled');
  assert.throws(() => s.runner.start('cursor', { target: 'nope', task: 'x' }), /unknown or unavailable target nope/);
  assert.throws(() => s.runner.start('cursor', { target: 'lmstudio', task: 'x', model: 'other' }), /no loaded model other/);
});

test('OpenAI engine: one request at a time per server; queue reported; usage parsed', async () => {
  const env = fakeEnv({ lines: { 'POST http://h/v1/chat/completions': ['data: {"choices":[{"delta":{"content":"a"}}]}', 'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}', 'data: [DONE]'] } });
  const queue: string[] = [];
  const run = async () => { const out: RunEvent[] = []; for await (const e of openaiRun(env, { endpoint: 'http://h', base: '/v1', model: 'm', concurrency: 1 }, { target: 't', task: 'x' },
    { signal: new AbortController().signal, onQueue: (w, r) => queue.push(`${w}/${r}`) })) out.push(e); return out; };
  const [a] = await Promise.all([run(), run()]);
  assert.deepEqual(a, [{ type: 'text', text: 'a' }, { type: 'usage', inputTokens: 2, outputTokens: 1, costUsd: 0 }, { type: 'done', result: 'a' }]);
  assert.ok(queue.includes('1/1'), `second request waited: ${queue}`);
  assert.equal(queue.at(-1), '0/0');
  assert.match(env.inputs['POST http://h/v1/chat/completions'], /"stream":true,"stream_options":\{"include_usage":true\}/);
});
test('claude-cli: read-only unless a folder and an editing kind; stream-json → events (subagents skipped); sessions resume', () => {
  assert.deepEqual(claudeArgs({ target: 'claude-cli', task: 'x' }).slice(4, 6), ['--permission-mode', 'dontAsk']);
  assert.deepEqual(claudeArgs({ target: 'claude-cli', task: 'x', kind: 'code-edit', cwd: '/w' }).slice(4, 6), ['--permission-mode', 'acceptEdits']);
  assert.deepEqual(claudeArgs({ target: 'claude-cli', task: 'x', kind: 'review', cwd: '/w', model: 'opus' }).slice(4), ['--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--model', 'opus']);
  assert.deepEqual(toEvents('{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Read","input":{"file":"a"}}]}}'),
    [{ type: 'text', text: 'hi' }, { type: 'tool', name: 'Read', summary: '{"file":"a"}' }]);
  assert.deepEqual(toEvents('{"type":"assistant","parent_tool_use_id":"t1","message":{"content":[{"type":"text","text":"sub"}]}}'), []);
  assert.deepEqual(toEvents('{"type":"result","is_error":false,"result":"done!","total_cost_usd":0.01,"usage":{"input_tokens":3,"output_tokens":4}}'),
    [{ type: 'usage', inputTokens: 3, outputTokens: 4, costUsd: 0.01 }, { type: 'done', result: 'done!' }]);
  assert.deepEqual(toEvents('{"type":"result","is_error":true,"result":"Not logged in"}').at(-1), { type: 'error', message: 'Not logged in' });
  assert.deepEqual(toEvents('not json'), []);
  assert.deepEqual(toEvents('{"type":"system","subtype":"init","session_id":"s-1"}'), [{ type: 'session', id: 's-1' }]);
  assert.deepEqual(claudeArgs({ target: 'claude-cli', task: 'x', session: 's-1' }).slice(-2), ['--resume', 's-1']);
});
