// The MCP bridge (both protocol eras) and the >> hook decisions (Cursor, Claude Code).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_VERSION, OPS, mcpHandler, type HubClient, type RunView } from '@agent-spaghetti/sdk';
import * as hookMod from '../../../packages/cli/src/hook.ts';
const { planHook } = hookMod;

const meta = { 'io.modelcontextprotocol/protocolVersion': MCP_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} };
function fakeClient(views: RunView[], asking = false) {
  const calls: Array<[string, any]> = [];
  let i = 0;
  const client = { call: async (op: string, input: any) => {
    calls.push([op, input]);
    if (op === 'delegate') return views[0];
    if (op === 'runs' && input.unread) return { runs: [], unread: views.filter(v => v.run.outcome !== 'running') };
    if (op === 'runs' && input.id === 1) throw new Error('no run 1');
    if (op === 'runs') { const v = views[Math.min(++i, views.length - 1)]; return { runs: [v.run], result: v.result, final: v }; }
    if (op === 'status') return { consents: asking ? [{ id: 'q1', subject: 'cursor', action: 'run', resource: 'claude-cli', why: 'w', scopes: ['once'] }] : [] };
    if (op === 'targets') return [{ id: 'lmstudio' }];
    throw new Error('daemon down');
  } } as unknown as HubClient;
  return { client, calls };
}
const run = (outcome: string, result?: string): RunView => ({ id: 7, run: { id: 7, ts: 1, source: 'cursor', target: 'claude-cli', kind: 'other', taskHash: 'h', outcome } as never, result });

test('MCP: modern discover, legacy initialize, version errors, tools = ops with mcp', async () => {
  const h = mcpHandler(fakeClient([]).client, { source: 'cursor' }, () => {});
  const d: any = await h({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } });
  assert.deepEqual([d.result.resultType, d.result.supportedVersions[0], d.result._meta['io.modelcontextprotocol/serverInfo'].name], ['complete', MCP_VERSION, 'agent-spaghetti']);
  const bad: any = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } });
  assert.equal(bad.error.code, -32022);
  const missing: any = await h({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.equal(missing.error.code, -32602);
  const list: any = await h({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: meta } });
  assert.deepEqual(list.result.tools.map((t: any) => t.name), Object.values(OPS).flatMap(o => ('mcp' in o ? [o.mcp.name] : [])));
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['delegate', 'targets', 'run_status', 'report']);
  const legacy = mcpHandler(fakeClient([]).client, { source: 'cursor' }, () => {});
  const init: any = await legacy({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const l2: any = await legacy({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(l2.result.resultType, undefined, 'legacy results have no resultType');
  assert.equal(await legacy({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(((await legacy({ jsonrpc: '2.0', id: 3, method: 'nope' })) as any).error.code, -32601);
});
test('MCP delegate: progress while waiting for approval, result text, still-running fallback, errors as tool errors', async () => {
  const sent: any[] = [];
  const f = fakeClient([run('running'), run('running'), run('done', 'the answer')], true);
  const h = mcpHandler(f.client, { source: 'cursor', parentRunId: 3, pollMs: 1 }, m => sent.push(m));
  const r: any = await h({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delegate', arguments: { target: 'claude-cli', task: 't', kind: 'review' }, _meta: { ...meta, progressToken: 'p' } } });
  assert.deepEqual(r.result.content, [{ type: 'text', text: 'the answer' }]);
  assert.deepEqual(f.calls.find(c => c[0] === 'delegate'), ['delegate', { target: 'claude-cli', task: 't', kind: 'review', source: 'cursor', parentRunId: 3, waitMs: 0 }]);
  assert.equal(sent[0].params.message, 'waiting for approval (here or in Agent Spaghetti)');
  assert.ok(!f.calls.some(c => c[0] === 'consent'), 'no elicitation declared: the tray alone asks');
  const slow = mcpHandler(fakeClient([run('running')]).client, { source: 'cursor', waitMs: 0 }, () => {});
  const s: any = await slow({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate', arguments: { target: 'x', task: 't' }, _meta: meta } });
  assert.match(s.result.content[0].text, /still running\. Call run_status with id 7/);
  const denied: any = await mcpHandler(fakeClient([{ ...run('denied'), run: { ...run('denied').run, error: 'denied by the user' } }]).client, { source: 'cursor' }, () => {})(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate', arguments: { target: 'x', task: 't' }, _meta: meta } });
  assert.deepEqual([denied.result.isError, denied.result.content[0].text], [true, 'Run 7 on claude-cli denied: denied by the user.']);
  const invalid: any = await h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delegate', arguments: { target: 'x' }, _meta: meta } });
  assert.match(invalid.result.content[0].text, /invalid arguments: \/task: required/);
  const st: any = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_status', arguments: { id: 7 }, _meta: meta } });
  assert.deepEqual(st.result.content, [{ type: 'text', text: 'the answer' }]);
  const gone: any = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'run_status', arguments: { id: 1 }, _meta: meta } });
  assert.deepEqual([gone.result.isError, gone.result.content[0].text], [true, 'no run 1']);
  assert.ok(f.calls.filter(c => c[0] === 'runs' && c[1].id).every(c => c[1].watch && c[1].source === 'cursor'), 'polling marks the caller as waiting (result inline)');
  const un: any = await h({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'run_status', arguments: {}, _meta: meta } });
  assert.deepEqual(f.calls.at(-1), ['runs', { unread: true, source: 'cursor' }]);
  assert.equal(un.result.content[0].text, '## Run 7 (claude-cli): done\n\nthe answer');
  const none: any = await mcpHandler(fakeClient([run('running')]).client, { source: 'cursor' }, () => {})({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_status', arguments: {}, _meta: meta } });
  assert.equal(none.result.content[0].text, 'No new results.');
});

test('>> hooks (Cursor, Claude Code): one parser for target[:model] and chains; workspace and attached files go along; other prompts pass; metadata only', () => {
  const { parsePrefix } = hookMod;
  assert.deepEqual(parsePrefix('>>openclaw do x'), { target: 'openclaw', then: [], task: 'do x' });
  assert.deepEqual(parsePrefix('  >> lms:qwen/q:7b >>claude-cli  review\nthis'), { target: 'lms', model: 'qwen/q:7b', then: ['claude-cli'], task: 'review\nthis' });
  assert.equal(parsePrefix('>>only'), null); assert.equal(parsePrefix('hello >>x y'), null);
  const p = planHook({ hook_event_name: 'beforeSubmitPrompt', prompt: '>>lmstudio >>openclaw:worker write tests for utils.ts', workspace_roots: ['/w'], conversation_id: 'c1',
    attachments: [{ type: 'file', file_path: '/w/utils.ts' }, { type: 'rule', file_path: '/w/r.mdc' }] });
  assert.ok('delegate' in p);
  assert.deepEqual(p.delegate, { target: 'lmstudio', then: ['openclaw:worker'], task: 'write tests for utils.ts', files: ['/w/utils.ts'], reason: 'sent with the >> prefix', cwd: '/w', resultDir: '/w/.agent-spaghetti/results' });
  assert.deepEqual(p.block('sent'), { continue: false, user_message: 'sent' });
  const cc = planHook({ hook_event_name: 'UserPromptSubmit', prompt: '>>codex fix it', cwd: 'E:\\proj', session_id: 's' });
  assert.ok('delegate' in cc);
  assert.deepEqual([cc.delegate.cwd, cc.block('sent')], ['E:\\proj', { decision: 'block', reason: 'sent' }]);
  assert.deepEqual(planHook({ hook_event_name: 'UserPromptSubmit', prompt: 'plain' }), { reply: {}, report: { event: 'UserPromptSubmit', data: {} } });
  assert.deepEqual(planHook({ hook_event_name: 'UserPromptSubmit', prompt: '>>codex fix it', cursor_version: '3.22', workspace_roots: ['/w'] }, 'claude-cli'), { reply: {} },
    'Claude Code\'s hook run by Cursor (third-party import) stays out: Cursor\'s own hook sends it');
  assert.deepEqual(planHook({ hook_event_name: 'beforeSubmitPrompt', prompt: 'normal SECRET-MARKER question', conversation_id: 'c1' }),
    { reply: { continue: true }, report: { event: 'beforeSubmitPrompt', data: { conversation_id: 'c1' } } });
  assert.deepEqual((planHook({ hook_event_name: 'beforeSubmitPrompt', prompt: '>>' }) as { reply: unknown }).reply, { continue: true }, 'no target and task: pass through');
  const mcp = planHook({ hook_event_name: 'beforeMCPExecution', tool_name: 'x', tool_input: '{"SECRET-MARKER":1}', mcp_server_name: 's' });
  assert.deepEqual(mcp, { reply: { permission: 'allow' }, report: { event: 'beforeMCPExecution', data: { tool_name: 'x', mcp_server_name: 's' } } });
  assert.ok(!JSON.stringify(planHook({ hook_event_name: 'afterAgentResponse', text: 'SECRET-MARKER' })).includes('SECRET-MARKER'));
});
