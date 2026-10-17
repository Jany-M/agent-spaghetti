// `connect` both ways: plugin (Agent Plugins / Cursor), MCP config entry, module CLIs; disconnect is the exact inverse; dry runs write nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { VERSION, type Integration, type Manifest } from '@agent-spaghetti/sdk';
import { setConnection, pluginFiles } from '../../../packages/core/src/connect.ts';

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
  const r = await setConnection(env, integ({ agentPlugins: { dir: '~/.cursor/plugins/local/', variant: 'cursor' } }), det, cli, true, false);
  assert.equal(r.applied, true);
  assert.ok(env.calls.includes('write ~/.cursor/plugins/local/agent-spaghetti/hooks/hooks.json'));
  const conf = '%APPDATA%/C/mcp.json';
  const merged = fakeEnv({ files: { [conf]: '{"mcpServers":{"other":{"command":"x"}},"keep":1}' } });
  await setConnection(merged, integ({ mcpClient: { config: conf, key: 'mcpServers' } }), det, cli, true, false);
  const doc = JSON.parse((await merged.readFile(conf))!);
  assert.deepEqual(Object.keys(doc.mcpServers), ['other', 'agent-spaghetti']);
  assert.equal(doc.keep, 1);
  assert.equal(await merged.readFile(`${conf}.bak`), '{"mcpServers":{"other":{"command":"x"}},"keep":1}');
  await assert.rejects(setConnection(fakeEnv({ files: { [conf]: '{oops' } }), integ({ mcpClient: { config: conf, key: 'mcpServers' } }), det, cli, true, false), /not a JSON object; not changed/);
  assert.equal(doc.mcpServers['agent-spaghetti'].type, undefined);
  const typed = fakeEnv();
  await setConnection(typed, integ({ mcpClient: { config: conf, key: 'servers', entry: { type: 'stdio' } } }), det, cli, true, false);
  assert.equal(JSON.parse((await typed.readFile(conf))!).servers['agent-spaghetti'].type, 'stdio', 'extra entry fields from the manifest');
  const arr = fakeEnv({ files: { [conf]: '{\n  // mine\n  "mcp": { "other": { "type": "remote" }, },\n}' } });
  await setConnection(arr, integ({ mcpClient: { config: conf, key: 'mcp', entry: { type: 'local', enabled: true }, commandArray: true } }), det, cli, true, false);
  assert.deepEqual(JSON.parse((await arr.readFile(conf))!).mcp, { other: { type: 'remote' }, 'agent-spaghetti': { type: 'local', enabled: true, command: ['node', 'C:/Program Files/as/cli.ts', 'mcp', '--as', 'cursor'] } },
    'JSONC config read; command and args as one array');
  assert.match((await arr.readFile(`${conf}.bak`))!, /\/\/ mine/, 'the commented original is kept');
  const dry = fakeEnv();
  const d = await setConnection(dry, integ({ mcpClient: { config: conf, key: 'servers' } }), det, cli, true, true);
  assert.deepEqual([d.applied, d.changes], [false, [`write ${conf}`]]);
  assert.ok(!dry.calls.some(c => c.startsWith('write')));
  await assert.rejects(setConnection(fakeEnv(), integ({}), det, cli, true, false), /no MCP client or plugin support/);
});

test('disconnect is the exact inverse: plugin folder removed; only our MCP entry deleted (others and .bak kept); nothing to remove is fine', async () => {
  const env = fakeEnv();
  const both = integ({ agentPlugins: { dir: '~/.cursor/plugins/local', variant: 'cursor' }, mcpClient: { config: '~/.cursor/mcp.json', key: 'mcpServers' } });
  await setConnection(env, both, det, cli, true, false);
  assert.ok(await env.readFile('~/.cursor/plugins/local/agent-spaghetti/mcp.json'));
  assert.equal(await env.readFile('~/.cursor/mcp.json'), null, 'connect uses the plugin where the client has plugins');
  await env.writeFile('~/.cursor/mcp.json', '{"mcpServers":{"other":{"command":"x"},"agent-spaghetti":{"command":"old"}}}');
  const off = await setConnection(env, both, det, cli, false, false);
  assert.equal(await env.readFile('~/.cursor/plugins/local/agent-spaghetti/mcp.json'), null);
  assert.deepEqual(JSON.parse((await env.readFile('~/.cursor/mcp.json'))!), { mcpServers: { other: { command: 'x' } } });
  assert.ok(await env.readFile('~/.cursor/mcp.json.bak'));
  assert.deepEqual(off.changes, ['remove ~/.cursor/plugins/local/agent-spaghetti', 'write ~/.cursor/mcp.json.bak', 'write ~/.cursor/mcp.json']);
  const none = await setConnection(fakeEnv(), integ({ mcpClient: { config: '~/x.json', key: 'servers' } }), det, cli, false, false);
  assert.deepEqual(none.changes, []);
});
test('CLI connect (manifest speaks.mcpCli: Claude Code, Codex) and module connect (OpenClaw config patch, null deletes, + reload)', async () => {
  const { BUILTINS } = await import('@agent-spaghetti/integrations');
  const by = (id: string) => BUILTINS.find(b => b.manifest.id === id)!;
  const ok = { code: 0, stdout: '', stderr: '' };
  const d = (path: string) => ({ ...det, installs: [{ path: '/opt/x', via: 'path' as const }, { path, via: 'bin' as const }] });
  const env = fakeEnv({ exec: { '/b/claude mcp remove --scope user agent-spaghetti': ok, '/b/claude mcp add --scope user agent-spaghetti -- node C:/Program Files/as/cli.ts mcp --as claude-cli': ok,
    '/b/codex.exe mcp remove agent-spaghetti': ok, '/b/codex.exe mcp add agent-spaghetti -- node C:/Program Files/as/cli.ts mcp --as codex': { code: 1, stdout: '', stderr: 'boom' },
    '/b/openclaw config patch --stdin': ok, '/b/openclaw mcp reload': ok } });
  await setConnection(env, by('claude-cli'), d('/b/claude'), cli, false, false);
  assert.deepEqual(env.calls, ['exec /b/claude mcp remove --scope user agent-spaghetti']);
  const on = await setConnection(env, by('claude-cli'), d('/b/claude'), cli, true, false);
  assert.deepEqual(on.changes, ['/b/claude mcp add --scope user agent-spaghetti -- node C:/Program Files/as/cli.ts mcp --as claude-cli', 'write ~/.claude/settings.json'],
    'the server, then the >> prompt hook (no settings file yet: nothing to back up)');
  await assert.rejects(setConnection(env, by('codex'), d('/b/codex.exe'), cli, true, false), /codex mcp add failed: boom/);
  await assert.rejects(setConnection(env, by('codex'), d('/b/other'), cli, true, true), /its program was not found/);
  const oc = by('openclaw');
  await setConnection(env, oc, d('/b/openclaw'), cli, true, false);
  assert.deepEqual(JSON.parse(env.inputs['/b/openclaw config patch --stdin']), { mcp: { servers: { 'agent-spaghetti': { command: 'node', args: ['C:/Program Files/as/cli.ts', 'mcp', '--as', 'openclaw'], enabled: true } } } });
  await setConnection(env, oc, d('/b/openclaw'), cli, false, false);
  assert.deepEqual(JSON.parse(env.inputs['/b/openclaw config patch --stdin']), { mcp: { servers: { 'agent-spaghetti': null } } });
  assert.equal(env.calls.filter(c => c === 'exec /b/openclaw mcp reload').length, 2);
});
test('>> prompt hook (Claude Code): our one entry added, kept unique, removed; the user\'s own hooks stay', async () => {
  const { BUILTINS } = await import('@agent-spaghetti/integrations');
  const claude = BUILTINS.find(b => b.manifest.id === 'claude-cli')!;
  const own = { hooks: [{ type: 'command', command: 'my-check' }] };
  const spec = { files: { '~/.claude/settings.json': JSON.stringify({ model: 'x', hooks: { UserPromptSubmit: [own], Stop: [own] } }) },
    exec: { '/b/claude mcp remove --scope user agent-spaghetti': { code: 0, stdout: '', stderr: '' }, '/b/claude mcp add --scope user agent-spaghetti -- node C:/Program Files/as/cli.ts mcp --as claude-cli': { code: 0, stdout: '', stderr: '' } } };
  const env = fakeEnv(spec), d = { ...det, installs: [{ path: '/b/claude', via: 'bin' as const }] };
  const read = () => JSON.parse(spec.files['~/.claude/settings.json']);
  await setConnection(env, claude, d, cli, true, false);
  assert.deepEqual((await setConnection(env, claude, d, cli, true, false)).changes.filter(c => c.startsWith('write')), [], 'already there: the file is left alone');
  assert.deepEqual(read().hooks.UserPromptSubmit, [own, { hooks: [{ type: 'command', command: 'node', args: ['C:/Program Files/as/cli.ts', 'hook', 'claude-cli'] }] }], 'once, after the user\'s own');
  assert.deepEqual([read().model, read().hooks.Stop], ['x', [own]]);
  await setConnection(env, claude, d, cli, false, false);
  assert.deepEqual(read().hooks.UserPromptSubmit, [own]);
});
test('connectionPlan: never disconnects, always connects, unset asks once; tools that cannot connect are left alone', async () => {
  const { connectionPlan } = await import('../../../packages/core/src/connections.ts');
  const d = (integration: string, connected?: boolean, envId = 'windows') => ({ ...det, integration, envId, ...(connected === undefined ? {} : { connected }) });
  const dets = [d('a', true), d('b', false), d('c', false), d('c', true, 'wsl:T'), d('e', false), d('f', true), d('g')];
  assert.deepEqual(connectionPlan(dets, { auto: ['b', 'c'], never: ['f'] }, new Set(['e'])),
    [{ id: 'b', do: 'connect' }, { id: 'f', do: 'disconnect' }], 'c is connected somewhere; e was asked already; a connected by hand stays');
  assert.deepEqual(connectionPlan(dets, { auto: [], never: [] }, new Set()).map(s => s.id + ':' + s.do), ['b:ask', 'e:ask']);
});
