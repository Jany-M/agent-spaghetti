// `connect`: plugin install (Agent Plugins / Cursor) and MCP config merge; dry runs write nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { VERSION, type Integration, type Manifest } from '@agent-spaghetti/sdk';
import { connectIntegration, pluginFiles } from '../../../packages/core/src/connect.ts';

const cli = { command: 'node', args: ['C:/Program Files/as/cli.ts'] };
const det = { integration: 'x', name: 'X', envId: 'windows', installs: [], levels: [], cost: 'free' as const, connectable: 'yes' as const, why: '' };
const integ = (speaks: Manifest['speaks']): Integration => ({ source: 'builtin', manifest: { manifest: 1, id: 'cursor', name: 'Cursor', roles: ['client'], speaks } as Manifest });

test('plugin files: Agent Plugins variant vs Cursor variant from the same source; bridge and hook commands filled in', () => {
  const ap = pluginFiles('agent-plugins', cli, 'vscode');
  assert.deepEqual(Object.keys(ap).sort(), ['mcp.json', 'plugin.json', 'skills/delegate/SKILL.md']);
  const manifest = JSON.parse(ap['plugin.json']);
  assert.deepEqual([manifest.$schema, manifest.name, manifest.version], ['https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'agent-spaghetti', VERSION]);
  assert.deepEqual(JSON.parse(ap['mcp.json']).mcpServers['agent-spaghetti'], { type: 'stdio', command: 'node', args: ['C:/Program Files/as/cli.ts', 'mcp', '--as', 'vscode'] });
  const cu = pluginFiles('cursor', cli, 'cursor');
  assert.deepEqual(Object.keys(cu).sort(), ['.cursor-plugin/plugin.json', 'commands/delegate.md', 'hooks/hooks.json', 'mcp.json', 'skills/delegate/SKILL.md']);
  assert.equal(JSON.parse(cu['.cursor-plugin/plugin.json']).$schema, undefined);
  const hooks = JSON.parse(cu['hooks/hooks.json']);
  assert.equal(hooks.version, 1);
  assert.equal(hooks.hooks.beforeSubmitPrompt[0].command, 'node "C:/Program Files/as/cli.ts" hook cursor');
  assert.match(cu['skills/delegate/SKILL.md'], /^---\nname: delegate\n/);
});
test('connect: plugin into the client folder; MCP merge keeps other servers and a .bak; malformed config untouched; dry run writes nothing', async () => {
  const env = fakeEnv();
  const r = await connectIntegration(env, integ({ agentPlugins: { dir: '~/.cursor/plugins/local/', variant: 'cursor' } }), det, cli, false);
  assert.equal(r.applied, true);
  assert.ok(env.calls.includes('write ~/.cursor/plugins/local/agent-spaghetti/hooks/hooks.json'));
  const conf = '%APPDATA%/C/mcp.json';
  const merged = fakeEnv({ files: { [conf]: '{"mcpServers":{"other":{"command":"x"}},"keep":1}' } });
  await connectIntegration(merged, integ({ mcpClient: { config: conf, key: 'mcpServers' } }), det, cli, false);
  const doc = JSON.parse((await merged.readFile(conf))!);
  assert.deepEqual(Object.keys(doc.mcpServers), ['other', 'agent-spaghetti']);
  assert.equal(doc.keep, 1);
  assert.equal(await merged.readFile(`${conf}.bak`), '{"mcpServers":{"other":{"command":"x"}},"keep":1}');
  await assert.rejects(connectIntegration(fakeEnv({ files: { [conf]: '{oops' } }), integ({ mcpClient: { config: conf, key: 'mcpServers' } }), det, cli, false), /not a JSON object; not changed/);
  assert.equal(doc.mcpServers['agent-spaghetti'].type, undefined);
  const typed = fakeEnv();
  await connectIntegration(typed, integ({ mcpClient: { config: conf, key: 'servers', type: true } }), det, cli, false);
  assert.equal(JSON.parse((await typed.readFile(conf))!).servers['agent-spaghetti'].type, 'stdio', 'VS Code needs "type"');
  const dry = fakeEnv();
  const d = await connectIntegration(dry, integ({ mcpClient: { config: conf, key: 'servers' } }), det, cli, true);
  assert.deepEqual([d.applied, d.changes], [false, [`write ${conf}`]]);
  assert.ok(!dry.calls.some(c => c.startsWith('write')));
  await assert.rejects(connectIntegration(fakeEnv(), integ({}), det, cli, false), /no MCP client or plugin support/);
});
