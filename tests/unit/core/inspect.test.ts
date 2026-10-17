import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, fakeInventory, type FakeSpec } from '@agent-spaghetti/sdk/testing';
import type { Integration, Manifest } from '@agent-spaghetti/sdk';
import { inspect } from '../../../packages/core/src/engine/inspect.ts';
import { BUILTINS } from '@agent-spaghetti/integrations';

const run = async (m: Partial<Manifest>, spec: FakeSpec, module?: Integration['module']) => {
  const env = fakeEnv(spec);
  return { env, r: await inspect({ source: 'builtin', module, manifest: { manifest: 1, id: 'x', name: 'X', roles: ['backend'], ...m } as Manifest },
    env, { signal: new AbortController().signal, inventory: fakeInventory(spec.inventory) }) };
};
const LMS: Partial<Manifest> = {
  detect: { installed: ['LM Studio*'], process: ['LM Studio'], bin: ['lms'], version: { from: 'installed' }, http: { port: 1234, path: '/api/v0/models' } },
  models: { list: 'data', id: 'id', filter: [{ field: 'state', in: ['loaded'] }], context: ['loaded_context_length', 'max_context_length'] },
};
const body = (data: unknown[]) => ({ status: 200, body: JSON.stringify({ data }) });

test('platform filter: nothing is called', async () => {
  const { env, r } = await run({ platforms: ['windows'], detect: { bin: ['x'] } }, { kind: 'wsl' });
  assert.equal(r, null); assert.deepEqual(env.calls, []);
});
test('custom install dir via installed apps + non-default port via the process listening socket', async () => {
  const { r } = await run(LMS, {
    inventory: { installed: [{ name: 'LM Studio 0.4.26', version: '0.4.26', location: 'D:/Apps/LM Studio', source: 'uninstall' }],
      processes: [{ name: 'LM Studio', pid: 42, path: 'D:/Apps/LM Studio/LM Studio.exe' }], listening: [{ port: 4321, address: '127.0.0.1', pid: 42 }] },
    http: { 'http://127.0.0.1:4321/api/v0/models': body([{ id: 'm1', state: 'loaded', loaded_context_length: 8192 }, { id: 'm2', state: 'not-loaded' }]) },
  });
  assert.equal(r!.detection.version, '0.4.26');
  assert.equal(r!.detection.endpoint, 'http://127.0.0.1:4321');
  assert.deepEqual(r!.detection.installs.map(i => i.via), ['installed', 'process']);
  assert.deepEqual(r!.backends.map(b => [b.id, b.contextLength, b.reachableFrom]), [['x:m1', 8192, ['windows']]]);
  assert.equal(r!.detection.why, '1 model(s) loaded');
});
test('two installs (per-user + system) are both listed; same path twice is one', async () => {
  const { r } = await run({ detect: { installed: ['Tool*'], bin: ['tool'] } }, {
    inventory: { installed: [{ name: 'Tool (User)', location: 'C:/Users/u/Tool', source: 'uninstall' }, { name: 'Tool', location: 'C:/Program Files/Tool', source: 'uninstall' }] },
    bins: { tool: 'c:\\users\\u\\tool' } });
  assert.equal(r!.detection.installs.length, 2);
  assert.equal(r!.detection.why, '2 installs');
});
test('env override: bind-all host → port on every candidate; explicit URL → that URL only', async () => {
  const d: Partial<Manifest> = { detect: { env: ['OLLAMA_HOST'], http: { port: 11434, path: '/api/version' }, version: { json: 'version' } } };
  const a = await run(d, { hosts: ['127.0.0.1', '192.0.2.10'], inventory: { env: { OLLAMA_HOST: '0.0.0.0:5555' } },
    http: { 'http://192.0.2.10:5555/api/version': { status: 200, body: '{"version":"0.12.3"}' } } });
  assert.equal(a.r!.detection.endpoint, 'http://192.0.2.10:5555');
  assert.equal(a.r!.detection.version, '0.12.3');
  const b = await run(d, { inventory: { env: { OLLAMA_HOST: 'http://192.0.2.20:6000' } } });
  assert.equal(b.r, null);
  assert.deepEqual(b.env.calls.slice(0, 1), ['GET http://192.0.2.20:6000/api/version']);
});
test('server off: installed + needs-setup; non-JSON answer counts as off; nothing found → null', async () => {
  const off = await run(LMS, { bins: { lms: 'C:/x/lms.exe' } });
  assert.equal(off.r!.detection.connectable, 'needs-setup');
  assert.match(off.r!.detection.why, /server not running/);
  const html = await run(LMS, { bins: { lms: 'C:/x/lms.exe' }, http: { 'http://127.0.0.1:1234/api/v0/models': { status: 200, body: '<html>' } } });
  assert.equal(html.r!.detection.endpoint, undefined);
  assert.equal((await run(LMS, {})).r, null);
});
test('server up with nothing loaded; models.path fetched separately; per-platform default paths', async () => {
  const a = await run(LMS, { http: { 'http://127.0.0.1:1234/api/v0/models': body([]) } });
  assert.equal(a.r!.detection.why, 'server up, no model loaded');
  const b = await run({ detect: { http: { port: 11434, path: '/api/version' } }, models: { path: '/api/ps', list: 'models', id: 'model', context: ['context_length'] } },
    { http: { 'http://127.0.0.1:11434/api/version': { status: 200, body: '{}' }, 'http://127.0.0.1:11434/api/ps': { status: 200, body: '{"models":[{"model":"m:8b","context_length":8192}]}' } } });
  assert.deepEqual(b.r!.backends.map(x => [x.model, x.contextLength]), [['m:8b', 8192]]);
  const c = await run({ detect: { paths: { linux: ['~/x'], windows: ['~/y.exe'] } } }, { kind: 'wsl', files: { '~/x': '' } });
  assert.deepEqual(c.r!.detection.installs, [{ path: '~/x', via: 'path' }]);
});
test('version from args runs the found executable, never an install folder; process without path still counts', async () => {
  const a = await run({ detect: { bin: ['t'], version: { args: ['--version'] } } }, { bins: { t: '/usr/bin/t' }, exec: { '/usr/bin/t --version': { code: 0, stdout: 'T 1.2.3\n', stderr: '' } } });
  assert.equal(a.r!.detection.version, '1.2.3');
  const b = await run({ detect: { installed: ['T'], version: { args: ['--version'] } } }, { inventory: { installed: [{ name: 'T', location: 'C:/T', source: 'uninstall' }] } });
  assert.equal(b.r!.detection.version, undefined);
  assert.deepEqual(b.env.calls, []);
  const c = await run({ detect: { process: ['t.exe'] } }, { inventory: { processes: [{ name: 'T', pid: 9 }] } });
  assert.equal(c.r!.detection.why, 'running');
});
test('alternative bin names are ONE install; a running GUI process is never executed for --version; installer version is the fallback', async () => {
  const a = await run({ detect: { bin: ['tool-mcp', 'tool'] } }, { bins: { 'tool-mcp': '/b/tool-mcp', tool: '/b/tool' } });
  assert.equal(a.r!.detection.installs.length, 1);
  const b = await run({ detect: { installed: ['App'], process: ['App'], version: { args: ['--version'] } } },
    { inventory: { installed: [{ name: 'App', version: '9.9', location: 'C:/App', source: 'uninstall' }], processes: [{ name: 'App', pid: 3, path: 'C:/App/App.exe' }] } });
  assert.deepEqual(b.env.calls, []);
  assert.equal(b.r!.detection.version, '9.9');
});
test('a module enriches the base result', async () => {
  const { r } = await run({ detect: { bin: ['t'] } }, { bins: { t: '/t' } }, { async inspect(env, base) { return { ...base, agents: [{ id: 'x:a', integration: 'x', name: 'a', envId: env.id }] }; } });
  assert.equal(r!.agents[0].name, 'a');
  assert.ok(r!.detection.levels.includes('observe'));
});
test('processNotIn: a copy bundled inside another tool (any slash, any case) is not this tool', async () => {
  const llama = BUILTINS.find(b => b.manifest.id === 'llamacpp')!;
  const inv = (path: string) => ({ installed: [], processes: [{ name: 'llama-server', pid: 9, path }], listening: [], env: {}, partial: [] });
  const ctx = (path: string) => ({ signal: AbortSignal.timeout(5000), inventory: inv(path) });
  assert.equal(await inspect(llama, fakeEnv(), ctx('C:\\Users\\u\\.LMStudio\\extensions\\backends\\x\\llama-server.exe')), null);
  assert.equal((await inspect(llama, fakeEnv(), ctx('/home/u/llama.cpp/build/bin/llama-server')))!.detection.installs[0].via, 'process');
});
test('a running program at the manifest path is the program (bundled CLI), a desktop app exe is not', async () => {
  const exe = '%LOCALAPPDATA%/App/app-*/bin/tool.exe';   // the fake glob() returns the pattern itself as the match
  const { r } = await run({ roles: ['agent'], detect: { process: ['tool', 'App'], paths: ['%LOCALAPPDATA%/App/app-*/bin/tool.exe'] } }, {
    inventory: { processes: [{ name: 'tool', pid: 7, path: exe }, { name: 'App', pid: 8, path: 'C:/Users/u/AppData/Local/App/App.exe' }] },
    files: { [exe]: '' } });
  assert.deepEqual(r!.detection.installs.map(i => [i.via, i.path]), [['path', exe], ['process', 'C:/Users/u/AppData/Local/App/App.exe']]);
});
test('hosted API: probed at its url with its headers once the key variable is set; the live poll leaves it alone', async () => {
  const { probeLive } = await import('../../../packages/core/src/engine/inspect.ts');
  const m: Partial<Manifest> = { roles: ['backend'], cost: 'metered', detect: { env: ['K'], http: { url: 'https://api.test', path: '/v1/models' } }, models: { list: 'data', id: 'id' },
    speaks: { openai: { base: '/v1', headers: { Authorization: 'Bearer {env:K}' } } } };
  const seen: Array<Record<string, string> | undefined> = [];
  const spec: FakeSpec = { inventory: { env: { K: 'test-key' } }, http: { 'https://api.test/v1/models': { status: 200, body: '{"data":[{"id":"m"}]}' } } };
  const env = fakeEnv(spec), http = env.http.bind(env);
  env.http = async r => { seen.push(r.headers); return http(r); };
  const r = await inspect({ source: 'builtin', manifest: { manifest: 1, id: 'h', name: 'H', ...m } as Manifest }, env, { signal: new AbortController().signal, inventory: fakeInventory(spec.inventory) });
  assert.deepEqual([r!.backends.map(b => b.model), r!.detection.endpoint, seen[0]], [['m'], 'https://api.test', { Authorization: 'Bearer test-key' }]);
  assert.equal(await probeLive(env, { manifest: 1, id: 'h', name: 'H', ...m } as Manifest, fakeInventory(spec.inventory)), null);
  const { openaiHeaders } = await import('../../../packages/core/src/engine/openai.ts');
  assert.throws(() => openaiHeaders({ manifest: 1, id: 'h', name: 'H', ...m } as Manifest, {}), /H needs K set/);
});
