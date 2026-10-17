// The OpenClaw pack: model patch, ocmcp, health report, AGENTS.md block (setup apply end to end: tests/integration/pack-apply.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExecResult } from '@agent-spaghetti/sdk';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { applyBlock, BEGIN, END } from '../../integrations/openclaw/pack/block.ts';
import { entryFor, search, derive } from '../../integrations/openclaw/pack/catalog.ts';
import { buildPatch, providerIdFor, stripProvider } from '../../integrations/openclaw/pack/config-patch.ts';
import { pickOrchestrator } from '../../integrations/openclaw/pack/orchestrator.ts';
import { packCli } from '../../integrations/openclaw/pack/main.ts';

const OC = '/home/u/.openclaw/tools/node/bin/openclaw';
const ok = (v: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
const cfg = (paths: Record<string, unknown>) => Object.fromEntries(Object.entries(paths).map(([k, v]) => [`${OC} config get ${k} --json`, ok(v)]));
const LMS = { integration: 'lmstudio', base: 'http://192.0.2.10:1234/v1', model: 'test-model', contextLength: 16384 };

test('block: replaces an earlier version of our block, else the old section, else appends', () => {
  const fresh = `${BEGIN}\nNEW\n${END}\n`;
  assert.equal(applyBlock('# A\n<!-- BEGIN ORCHESTRATOR (managed by old-name) -->\nOLD\n<!-- END ORCHESTRATOR -->\n# B\n', 'NEW\n'), `# A\n${fresh}# B\n`);
  assert.equal(applyBlock('## X\nx\n## Background Work and Completion Reporting\nold\n## Y\ny\n', 'NEW'), `## X\nx\n${fresh}\n## Y\ny\n`);
  assert.equal(applyBlock('# Doc\n', 'NEW'), `# Doc\n\n${fresh}`);
  assert.equal(applyBlock('', 'NEW'), fresh);
  assert.equal(applyBlock(applyBlock('# Doc\n', 'NEW'), 'NEW'), applyBlock('# Doc\n', 'NEW'), 'idempotent');
  assert.equal(applyBlock('', 'cost $& $1'), `${BEGIN}\ncost $& $1\n${END}\n`, 'replacement text is literal');
});

test('catalog: local > exact > longest generic substring (+qualifiers) > derived; search ranks', () => {
  const generic = { github: { summary: 'GitHub', keywords: ['git'] }, git: { summary: 'git' }, _comment: { summary: 'x' } };
  const s = (name: string, extra = {}) => ({ name, enabled: false, ...extra });
  assert.equal(entryFor(s('github'), generic, { github: { summary: 'mine' } }).summary, 'mine');
  assert.equal(entryFor(s('github'), generic, {}).summary, 'GitHub');
  assert.deepEqual(entryFor(s('github-prod'), generic, {}), { summary: 'GitHub', keywords: ['git', 'github', 'prod'] });
  assert.deepEqual(derive(s('x', { url: 'https://mcp.example.com/sse' })), { summary: 'remote MCP server at mcp.example.com', keywords: ['mcp.example.com'] });
  assert.deepEqual(derive(s('x', { command: 'npx', args: ['-y', 'KEY=v', '@scope/tool-mcp'] })), { summary: 'MCP server (@scope/tool-mcp)', keywords: ['scope', 'tool', 'mcp'] });
  const hits = search([s('github'), s('other')], x => entryFor(x, generic, {}), ['git', 'repo']);
  assert.deepEqual(hits.map(h => h.server.name), ['github']);
});

test('orchestrator: the default agent, else the first; ~ expanded', () => {
  const list = [{ id: 'a', workspace: '~/ws-a' }, { id: 'b', isDefault: true, workspace: '/w/b' }];
  assert.deepEqual(pickOrchestrator(list, '/home/u'), { id: 'b', workspace: '/w/b' });
  assert.deepEqual(pickOrchestrator([list[0]], '/home/u'), { id: 'a', workspace: '/home/u/ws-a' });
  assert.equal(pickOrchestrator([]), undefined);
});

test('provider ids for detected local servers', () => {
  assert.equal(providerIdFor('lmstudio'), 'lmstudio');
  assert.equal(providerIdFor('ollama'), 'local-ollama');
});

const say = () => {};
test('patch auto: endpoint up → keep primary, only timeout + MCP parking', async () => {
  const env = fakeEnv({ kind: 'linux', exec: cfg({ 'models.providers': { lmstudio: {} }, 'models.providers.lmstudio': { baseUrl: 'http://192.0.2.10:1234/v1', apiKey: 'NEVER', models: [{ id: 'm1' }] },
    'agents.defaults.model': { primary: 'lmstudio/m1' }, 'mcp.servers': { s1: {}, s2: { enabled: true } } }),
    http: { 'http://192.0.2.10:1234/v1/models': { status: 200, body: '{}' } } });
  let detected = false;
  const p = await buildPatch({ env, exe: OC, model: 'auto', say, detect: async () => { detected = true; return [LMS]; } });
  assert.equal(detected, false);
  assert.deepEqual(p, { models: { providers: { lmstudio: { timeoutSeconds: 900 } } }, mcp: { servers: { s1: { enabled: false }, s2: { enabled: false } } } });
  assert.ok(!JSON.stringify(p).includes('NEVER'), 'apiKey is never copied');
});

test('patch auto: endpoint down → re-detect, new provider gets api + default key, primary set', async () => {
  const env = fakeEnv({ kind: 'linux', exec: cfg({ 'models.providers': { lmstudio: {} }, 'models.providers.lmstudio': { baseUrl: 'http://192.0.2.99:1234/v1', models: [] },
    'agents.defaults.model': 'lmstudio/old' }) });
  const p = await buildPatch({ env, exe: OC, model: 'auto', say, detect: async () => [{ ...LMS, integration: 'ollama' }, { ...LMS, integration: 'vllm' }] });
  assert.deepEqual(p.agents, { defaults: { model: { primary: 'local-ollama/test-model' } } });
  assert.equal(p.models.providers['local-ollama'].api, 'openai-completions');
  assert.equal(p.models.providers['local-ollama'].apiKey, 'local');
  assert.deepEqual(p.models.providers['local-ollama'].models, [{ id: 'test-model', name: 'test-model', contextWindow: 16384, maxTokens: 8192 }]);
});

test('patch auto: endpoint down and nothing found → keep the current model with a warning', async () => {
  const env = fakeEnv({ kind: 'linux', exec: cfg({ 'models.providers': { lmstudio: {} }, 'models.providers.lmstudio': { baseUrl: 'http://192.0.2.99:1234/v1' }, 'agents.defaults.model': 'lmstudio/m1' }) });
  const said: string[] = [];
  const p = await buildPatch({ env, exe: OC, model: '', say: s => said.push(s), detect: async () => [] });
  assert.deepEqual(p, { models: { providers: { lmstudio: { timeoutSeconds: 900 } } } });
  assert.match(said.join('\n'), /WARNING: the endpoint of lmstudio\/m1 does not answer/);
});
test('patch <server>:<model> uses that loaded model (declared window follows the server); keep never touches it; clear errors', async () => {
  const env = fakeEnv({ kind: 'linux', exec: cfg({ 'models.providers': { lmstudio: {} }, 'models.providers.lmstudio': { baseUrl: LMS.base, models: [{ id: 'test-model', contextWindow: 4096 }] },
    'agents.defaults.model': 'lmstudio/other' }) });
  const p = await buildPatch({ env, exe: OC, model: 'lmstudio:test-model', say, detect: async () => [LMS] });
  assert.equal(p.models.providers.lmstudio.models[0].contextWindow, 16384);
  assert.equal(p.models.providers.lmstudio.apiKey, undefined, 'existing provider keeps its own key');
  assert.deepEqual(p.agents, { defaults: { model: { primary: 'lmstudio/test-model' } } });
  assert.deepEqual(await buildPatch({ env, exe: OC, model: 'keep', say, detect: async () => [LMS] }), { models: { providers: { lmstudio: { timeoutSeconds: 900 } } } });
  await assert.rejects(buildPatch({ env, exe: OC, model: 'lmstudio:nope', say, detect: async () => [LMS] }), /lmstudio has no loaded model nope/);
  await assert.rejects(buildPatch({ env: fakeEnv({ kind: 'linux', exec: cfg({ 'models.providers': {} }) }), exe: OC, model: 'auto', say, detect: async () => [] }), /no local LLM server/);
  assert.deepEqual(stripProvider({ models: {}, agents: { defaults: {} }, mcp: { servers: {} } }), { mcp: { servers: {} } });
});

test('OpenClaw cli (tool openclaw …): unknown command → usage; no openclaw → exit 1; mcp list/on go through its CLI; health exit code = problems', async () => {
  const lines: string[] = [], say = (s: string) => lines.push(s);
  const det = { integration: 'openclaw', name: 'OpenClaw', envId: 'linux', installs: [{ via: 'bin' as const, path: OC }], levels: [], cost: 'free' as const, connectable: 'yes' as const, why: '' };
  assert.equal(await packCli(fakeEnv(), det, ['patch'], say), 1);
  assert.match(lines[0], /^usage: tool openclaw mcp/);
  assert.equal(await packCli(fakeEnv(), { ...det, installs: [] }, ['mcp', 'list'], say), 1);
  const env = fakeEnv({ kind: 'linux', exec: { ...cfg({ 'mcp.servers': { github: { enabled: false }, zz: { url: 'https://h.example.com/x' } } }),
    [`${OC} config file`]: { code: 0, stdout: '\x1b[1m~/.openclaw/openclaw.json\x1b[0m\n', stderr: '' },
    [`${OC} config patch --stdin`]: ok({}), [`${OC} mcp reload`]: ok({}) } });
  const vars = { HOME: '/home/u' };
  lines.length = 0;
  assert.equal(await packCli(env, det, ['mcp', 'list'], say, vars), 0);
  assert.deepEqual(lines, ['off  github                     GitHub repos, issues, pull requests, code search, files', 'ON   zz                         remote MCP server at h.example.com'], 'the generic catalog is built in');
  assert.equal(await packCli(env, det, ['mcp', 'on', 'nope'], say, vars), 1);
  assert.equal(await packCli(env, det, ['mcp', 'on', 'github'], say, vars), 0);
  assert.deepEqual(JSON.parse(env.inputs[`${OC} config patch --stdin`]), { mcp: { servers: { github: { enabled: true } } } });
  assert.ok(env.calls.includes(`exec ${OC} mcp reload`));
  lines.length = 0;
  assert.ok(await packCli(env, det, ['health'], say, vars) > 0);
  assert.match(lines.join('\n'), /FAIL  gateway service up/);
});

test('health: one step per check; reads AGENTS.md of the default agent', async () => {
  const good = { ...cfg({ 'models.providers': { lmstudio: {} }, 'models.providers.lmstudio': { baseUrl: LMS.base, timeoutSeconds: 900 },
    'agents.defaults.model': 'lmstudio/test-model', 'agents.defaults': { maxConcurrent: 2, subagents: { maxConcurrent: 1 } },
    'agents.entries': { main: { tools: { profile: 'minimal' } }, worker: {}, toolsmith: {}, verifier: {} }, tools: { toolSearch: false }, 'mcp.servers': { a: { enabled: false } } }),
    [`${OC} agents list --json`]: ok([{ id: 'main', isDefault: true, workspace: '/w' }]),
    [`${OC} gateway status`]: { code: 0, stdout: 'Gateway: running', stderr: '' } };
  const { healthSteps } = await import('../../integrations/openclaw/pack/health.ts');
  const env = fakeEnv({ kind: 'linux', exec: good, http: { [`${LMS.base}/models`]: { status: 200, body: '' } }, bins: { jobctl: '/b/jobctl', ocmcp: '/b/ocmcp' },
    files: { '/w/AGENTS.md': `${BEGIN}\nsessions_spawn sessions_yield jobctl brief\n${END}` } });
  const steps = await healthSteps(env, OC);
  assert.deepEqual(steps.filter(s => !s.ok), []);
  assert.equal(steps.find(s => s.name === 'primary model set')!.detail, 'lmstudio/test-model');
  const bad = await healthSteps(fakeEnv({ kind: 'linux', exec: good }), OC);
  assert.deepEqual(bad.filter(s => !s.ok).map(s => s.name), ['LLM endpoint answers', 'AGENTS.md has the orchestrator block', 'hand-off text intact', 'jobctl installed', 'ocmcp installed']);
});
