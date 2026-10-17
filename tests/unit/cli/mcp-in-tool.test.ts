// Using Agent Spaghetti from inside a tool (Phase 3e): the delegate prompt with completion, targets as resources, instructions,
// the workspace (roots) as the default folder, and questions in the tool (elicitation) in both protocol eras.
import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS, MCP_VERSION, mcpHandler, type HubClient } from '@agent-spaghetti/sdk';

const T = (id: string, cost: string, models: string[] = []) => ({ id, name: id.toUpperCase(), kind: 'agent', cost, envId: 'w', models, engine: 'acp', resumable: false });
/** A daemon double: targets, a delegate that runs, an optional pending question, answers recorded. */
function daemon(o: { asking?: boolean } = {}) {
  const calls: Array<[string, any]> = [];
  let asking = !!o.asking, polls = 0;
  const client = { call: async (op: string, input: any) => {
    calls.push([op, input]);
    if (op === 'whoami') return { id: input.name === 'Visual Studio Code' ? 'vscode' : input.as };
    if (op === 'targets') return [T('paid', 'metered'), T('lms', 'free', ['m1'])];
    if (op === 'delegate') return { id: 7 };
    if (op === 'status') return { consents: asking ? [{ id: 'q1', subject: 'vscode', action: 'run', resource: 'paid', why: 'paid run', scopes: ['once', 'always'] }] : [] };
    if (op === 'consent') { asking = false; return { ok: true }; }
    if (op === 'runs') return { final: { id: 7, run: { id: 7, target: 'paid', outcome: asking || ++polls < 2 ? 'running' : 'done' }, result: 'done!' } };
    throw new Error(`unexpected ${op}`);
  } } as unknown as HubClient;
  return { client, calls };
}
const meta = (caps: object = {}) => ({ 'io.modelcontextprotocol/protocolVersion': MCP_VERSION, 'io.modelcontextprotocol/clientCapabilities': caps });

test('prompt, completion, resources and instructions: the same targets as everywhere', async () => {
  const h = mcpHandler(daemon().client, { source: 'vscode' }, () => {});
  const d: any = await h({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta() } });
  assert.deepEqual([Object.keys(d.result.capabilities), d.result.instructions], [['tools', 'prompts', 'resources', 'completions'], INSTRUCTIONS]);
  const list: any = await h({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: { _meta: meta() } });
  assert.deepEqual(list.result.prompts.map((p: any) => [p.name, p.arguments.map((a: any) => a.name)]), [['delegate', ['target', 'task', 'then', 'kind']]]);
  const get: any = await h({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'delegate', arguments: { target: 'lms:m1', task: 'sum up', then: 'paid' }, _meta: meta() } });
  assert.match(get.result.messages[0].content.text, /^Hand this off with the agent-spaghetti `delegate` tool: target `lms:m1`, then `paid`\. Pass my open workspace as `cwd`.*\n\nTask: sum up$/s);
  const c = async (name: string, value: string) => ((await h({ jsonrpc: '2.0', id: 4, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'delegate' }, argument: { name, value }, _meta: meta() } })) as any).result.completion.values;
  assert.deepEqual(await c('target', ''), ['lms', 'lms:m1', 'paid', 'auto'], 'free first, models, auto last');
  assert.deepEqual(await c('target', 'L'), ['lms', 'lms:m1']);
  assert.deepEqual(await c('then', 'lms, p'), ['lms,paid'], 'the last of a comma list');
  assert.deepEqual(await c('kind', 're'), ['review', 'research', 'refactor']);
  assert.deepEqual(await c('task', 'x'), []);
  const res: any = await h({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: { _meta: meta() } });
  assert.deepEqual(res.result.resources.map((r: any) => [r.uri, r.title]), [['target://paid', 'PAID'], ['target://lms', 'LMS']]);
  const read: any = await h({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'target://lms', _meta: meta() } });
  assert.match(read.result.contents[0].text, /^# LMS \(target `lms`\)\n\nagent, free, takes tasks through acp; models\/agents: m1\.\n\nHand the task to it with the agent-spaghetti `delegate` tool/);
  assert.equal(((await h({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'target://gone', _meta: meta() } })) as any).error.code, -32002);
  const legacy = mcpHandler(daemon().client, { source: 'vscode' }, () => {});
  const init: any = await legacy({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } });
  assert.equal(init.result.instructions, INSTRUCTIONS);
});

test('2026-07-28: roots and a target picked in the tool come back with the retry; the approval too; the state is ours alone', async () => {
  const d = daemon({ asking: true }), h = mcpHandler(d.client, { source: 'vscode', pollMs: 1 }, () => {});
  const call = async (id: number, extra: object = {}) => ((await h({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'delegate', arguments: { task: 'review it', files: ['a.ts'] }, _meta: meta({ roots: {}, elicitation: {} }), ...extra } })) as any).result;
  const r1 = await call(1);
  assert.deepEqual([r1.resultType, Object.keys(r1.inputRequests)], ['input_required', ['roots']]);
  const r2 = await call(2, { inputResponses: { roots: { roots: [{ uri: 'file:///e%3A/proj' }] } }, requestState: r1.requestState });
  assert.deepEqual(Object.keys(r2.inputRequests), ['target']);
  assert.deepEqual(r2.inputRequests.target.params.requestedSchema.properties.target.oneOf.map((o: any) => o.const), ['lms', 'lms:m1', 'paid', 'auto']);
  const r3 = await call(3, { inputResponses: { target: { action: 'accept', content: { target: 'paid' } } }, requestState: r2.requestState });
  assert.deepEqual(d.calls.find(c => c[0] === 'delegate')![1], { task: 'review it', files: ['a.ts'], cwd: 'e:/proj', target: 'paid', source: 'vscode', parentRunId: undefined, waitMs: 0 });
  assert.deepEqual(Object.keys(r3.inputRequests), ['approve'], 'the paid question, asked in the tool');
  assert.deepEqual(r3.inputRequests.approve.params.requestedSchema.properties.answer.oneOf.map((o: any) => o.const), ['once', 'always', 'deny']);
  const r4 = await call(4, { inputResponses: { approve: { action: 'accept', content: { answer: 'once' } } }, requestState: r3.requestState });
  assert.deepEqual([r4.resultType, r4.content[0].text], ['complete', 'done!']);
  assert.deepEqual(d.calls.filter(c => c[0] === 'delegate').length, 1, 'the retry resumes the same run');
  assert.deepEqual(d.calls.find(c => c[0] === 'consent')![1], { id: 'q1', allow: true, scope: 'once' });
  const forged = await call(5, { inputResponses: { approve: { action: 'accept', content: { answer: 'once' } } }, requestState: `${r3.requestState.split('.')[0]}.bad` });
  assert.equal(forged.resultType, 'input_required', 'a tampered state starts over');
  const declined = await mcpHandler(daemon().client, { source: 'vscode' }, () => {})({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate', arguments: { task: 't' },
    _meta: meta({ elicitation: {} }), inputResponses: { target: { action: 'decline' } } } }) as any;
  assert.deepEqual([declined.result.isError, declined.result.content[0].text], [true, 'Not handed off: no target picked.']);
});

test('older eras: our questions go out as requests and their answers come back on the same stdio; nothing asked unless declared', async () => {
  const d = daemon({ asking: true }), sent: any[] = [];
  const h = mcpHandler(d.client, { source: 'claude-desktop', pollMs: 1 }, (m: any) => {
    sent.push(m);
    const answer = m.method === 'roots/list' ? { roots: [{ uri: 'file:///home/u/p' }] } : m.method === 'elicitation/create' ? { action: 'accept', content: { answer: 'always' } } : null;
    if (answer) setImmediate(() => void h({ jsonrpc: '2.0', id: m.id, result: answer }));
  });
  await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: {}, elicitation: {} }, clientInfo: { name: 'Visual Studio Code', version: '1' } } });
  const r: any = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: { target: 'paid', task: 't' } } });
  assert.equal(r.result.content[0].text, 'done!');
  assert.deepEqual(sent.filter(m => m.method && m.id).map(m => m.method), ['roots/list', 'elicitation/create']);
  assert.deepEqual([d.calls.find(c => c[0] === 'delegate')![1].cwd, d.calls.find(c => c[0] === 'delegate')![1].source], ['/home/u/p', 'vscode'],
    'the client named itself: hand-offs are its own even from a server set up for another tool');
  assert.deepEqual(d.calls.find(c => c[0] === 'consent')![1], { id: 'q1', allow: true, scope: 'always' });
  const plain = daemon(), out: any[] = [], h2 = mcpHandler(plain.client, { source: 'vscode', pollMs: 1 }, m => out.push(m));
  await h2({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  await h2({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: { task: 't' } } });
  assert.deepEqual([out.filter(m => m.id).length, plain.calls.find(c => c[0] === 'delegate')![1].target], [0, 'auto'], 'no capabilities: no questions, no folder, auto');
});
