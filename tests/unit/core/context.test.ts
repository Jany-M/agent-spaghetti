// What travels with a hand-off (Phase 3e): the folder and the files meant, in the target environment's spelling; files listed for
// agents, their text for models; a `>>` caller's folder gets the chain's result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Detection, Integration, Manifest, RunRequest, Snapshot } from '@agent-spaghetti/sdk';
import { envPath, uriPath } from '@agent-spaghetti/sdk';
import { fakeEnv } from '@agent-spaghetti/sdk/testing';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { Store } from '../../../packages/core/src/store.ts';
import { Bus } from '../../../packages/core/src/bus.ts';
import { Consent } from '../../../packages/core/src/consent.ts';
import { Settings } from '../../../packages/core/src/settings.ts';
import { Ledger } from '../../../packages/core/src/ledger.ts';
import { Runner } from '../../../packages/core/src/runner.ts';

test('paths across environments: Windows ↔ WSL, \\\\wsl$ shares, file: URIs from MCP roots', () => {
  assert.deepEqual(['E:\\Dropbox\\proj', 'C:/x/y.ts', 'E:\\', '\\\\wsl$\\Ubuntu\\home\\u', '//wsl.localhost/Ubuntu/home/u', '/home/u'].map(p => envPath(p, 'posix')),
    ['/mnt/e/Dropbox/proj', '/mnt/c/x/y.ts', '/mnt/e', '/home/u', '/home/u', '/home/u']);
  assert.deepEqual(['/mnt/e/Dropbox/proj', '/mnt/c', '/home/u', 'C:\\x', 'e:/proj/a.ts'].map(p => envPath(p, 'windows')), ['E:\\Dropbox\\proj', 'C:\\', '/home/u', 'C:\\x', 'e:\\proj\\a.ts']);
  assert.deepEqual(['file:///e%3A/My%20proj', 'file:///home/u/p', 'file://wsl.localhost/Ubuntu/home', 'http://x'].map(uriPath),
    ['e:/My proj', '/home/u/p', '//wsl.localhost/Ubuntu/home', undefined]);
});

const seen: RunRequest[] = [];
const agent: Integration = { source: 'builtin', manifest: { manifest: 1, id: 'wsl-agent', name: 'W', roles: ['agent'], cost: 'free' } as Manifest,
  module: { async *run(_e, _d, req) { seen.push(req); yield { type: 'done', result: 'ok' }; } } };
const lms = BUILTINS.find(i => i.manifest.id === 'lmstudio')!;
const det = (integration: string, envId: string): Detection => ({ integration, name: integration, envId, installs: [{ path: '/b/x', via: 'bin' }], levels: [], cost: 'free', connectable: 'yes', why: '' });
const snap: Snapshot = { ts: 1, envs: [{ id: 'windows', state: 'running' }, { id: 'wsl:T', state: 'running' }], agents: [], rejected: [],
  detections: [det('wsl-agent', 'wsl:T'), det('lmstudio', 'windows')],
  backends: [{ id: 'lmstudio:m', integration: 'lmstudio', model: 'm', envId: 'windows', endpoint: 'http://127.0.0.1:1234', reachableFrom: ['windows'] }] };
function setup() {
  const store = new Store(':memory:'), bus = new Bus(store), settings = new Settings(store);
  const host = fakeEnv({ files: { 'E:\\proj\\a.ts': 'export const a = 1;', 'E:\\proj\\big.bin': 'x'.repeat(250_000) },
    lines: { 'POST http://127.0.0.1:1234/v1/chat/completions': ['data: {"choices":[{"delta":{"content":"fine"}}]}', 'data: [DONE]'] } });
  const runner = new Runner({ bus, consent: new Consent(bus), ledger: new Ledger(store), settings, resultsDir: mkdtempSync(join(tmpdir(), 'as-ctx-')), host: () => host, snapshot: () => snap,
    integrations: () => [agent, lms], runOn: (_e, id, req, o) => agent.module!.run!(host, det(id, 'wsl:T'), req, { ...o, inventory: { installed: [], processes: [], listening: [], env: {}, partial: [] } }) });
  return { runner, host };
}

test('an agent in WSL gets the Windows folder and files as /mnt paths, listed relative to the folder; the next hop gets them too', async () => {
  const { runner } = setup(); seen.length = 0;
  await runner.start('vscode', { target: 'wsl-agent', task: 'review', cwd: 'E:\\proj', files: ['E:\\proj\\src\\a.ts', 'notes.md', 'C:\\other\\x.md'], then: ['wsl-agent'] }).done;
  assert.deepEqual([seen[0].cwd, seen[0].files], ['/mnt/e/proj', ['/mnt/e/proj/src/a.ts', '/mnt/e/proj/notes.md', '/mnt/c/other/x.md']]);
  assert.equal(seen[0].task, 'review\n\n## Files\n- src/a.ts\n- notes.md\n- /mnt/c/other/x.md');
  assert.equal(seen[1].cwd, '/mnt/e/proj', 'the chain keeps the folder');
});
test('a model gets the text of the files (small text files only), and a >> caller\'s folder gets the chain\'s result as <chain>.md', async () => {
  const { runner, host } = setup();
  const out = mkdtempSync(join(tmpdir(), 'as-ws-'));
  const row = await runner.start('cursor', { target: 'lmstudio', task: 'explain', cwd: 'E:\\proj', files: ['a.ts', 'big.bin', 'gone.ts'], resultDir: out }).done;
  const sent = JSON.parse((host as any).inputs['POST http://127.0.0.1:1234/v1/chat/completions']).messages[0].content;
  assert.equal(sent, 'explain\n\n## Files\n### E:\\proj\\a.ts\n```\nexport const a = 1;\n```\n\n- E:\\proj\\big.bin (not included: too large)\n\n- E:\\proj\\gone.ts (not included: not readable)');
  assert.equal(readFileSync(join(out, `${row.chainId}.md`), 'utf8'), 'fine');
});
