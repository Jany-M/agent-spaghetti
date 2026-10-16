// Regression guards for the project rules (AGENTS.md): one owner per concern, dependency direction,
// manifest index = folders, no ignored source files, placeholders only, Python only in jobctl.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { BUILTIN_MANIFESTS } from '@agent-spaghetti/integrations';
import { spawnFile } from '../../packages/core/src/proc.ts';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SKIP = new Set(['node_modules', 'dist', '.git', '_dev', '.as-tmp']);
function files(dir: string, re = /\.(ts|mjs|js|sh|json|json5|md|ps1)$/): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(n => {
    const p = join(dir, n);
    if (SKIP.has(n)) return [];
    return statSync(join(ROOT, p)).isDirectory() ? files(p, re) : re.test(n) ? [p.split(sep).join('/')] : [];
  });
}
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Files under `dirs` whose text matches `re`. */
const where = (re: RegExp, dirs: string[], ext = /\.ts$/) => dirs.flatMap(d => files(d, ext)).filter(f => re.test(read(f)));
const SRC = ['packages', 'integrations'];

test('one owner per concern: processes, HTTP, OS listing, the Environment test double', () => {
  assert.deepEqual(where(/node:child_process|\bexecFile\(/, SRC), ['packages/core/src/proc.ts']);
  assert.deepEqual(where(/(^|[^.\w])fetch\(/m, SRC), ['packages/core/src/http.ts', 'packages/sdk/src/client.ts']);
  assert.deepEqual(where(/Get-Process|Get-AppxPackage|Get-NetTCPConnection|tasklist|\/proc\/(net\/tcp|\[0-9\]|\$\{|\d)/, SRC).filter(f => !f.startsWith('packages/core/src/env/inventory/')), []);
  assert.deepEqual(where(/function fakeEnv\b/, [...SRC, 'tests']).filter(f => !f.startsWith('tests/guards/')), ['packages/sdk/src/testing.ts']);
  assert.deepEqual(where(/from 'node:sqlite'/, SRC), ['packages/core/src/store.ts']);
});
test('dependency direction: sdk imports no package; integrations never import core', () => {
  assert.deepEqual(where(/from '@agent-spaghetti\//, ['packages/sdk']), []);
  assert.deepEqual(where(/@agent-spaghetti\/core|packages\/core/, ['integrations']), []);
  assert.deepEqual(where(/from '@agent-spaghetti\/(cli|env)'/, ['packages/core', 'integrations']), []);
  assert.deepEqual(where(/from 'node:|from '@agent-spaghetti\/(sdk|core)'/, ['packages/ui']), [], 'ui runs in the sandboxed renderer: sdk/web only');
  assert.deepEqual(where(/from '@agent-spaghetti\/core(?!\/proc')/, ['packages/app']), [], 'the tray only needs core/proc');
});
test('built-in index = integration folders (each has manifest.json + fixtures.json)', () => {
  const dirs = readdirSync(join(ROOT, 'integrations')).filter(n => existsSync(join(ROOT, 'integrations', n, 'manifest.json'))).sort();
  assert.deepEqual(BUILTIN_MANIFESTS.map(m => m.id).sort(), dirs);
  for (const d of dirs) assert.ok(existsSync(join(ROOT, 'integrations', d, 'fixtures.json')), `${d}/fixtures.json`);
});
test('the OpenClaw pack: no Python except jobctl; no hard-coded LLM ports or probing in pack code', () => {
  const py = files('packs', /.*/).filter(f => /^#!.*python|\.py$/m.test(f.endsWith('.py') ? '.py' : read(f).split('\n')[0]));
  assert.deepEqual(py, ['packs/openclaw/scripts/jobctl']);
  assert.deepEqual(where(/python3/, ['packs'], /\.(sh|ps1)$/), []);
  assert.deepEqual(where(/\b(1234|11434|8080|8000)\b|urllib/, ['packs', 'integrations/openclaw/pack'], /\.(ts|sh)$/), []);
});
test('no source file is hidden by .gitignore', { skip: !existsSync(join(ROOT, '.git')) }, async () => {
  const r = await spawnFile('git', ['-C', ROOT, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory',
    'packages', 'integrations', 'packs', 'scripts', 'tests', 'config'], { timeoutMs: 30000 });
  assert.equal(r.code, 0, r.stderr.toString());
  const hidden = r.stdout.toString().split('\n').filter(l => l && !/(^|\/)(node_modules|dist)\/?$/.test(l) && !/overrides\.env$/.test(l));
  assert.deepEqual(hidden, []);
});
test('secretscan is clean (no tokens, credentials or private LAN IPs in committed files)', async () => {
  const r = await spawnFile(process.execPath, [join(ROOT, 'scripts', 'secretscan.mjs')], { timeoutMs: 60000 });
  assert.equal(r.code, 0, r.stdout.toString() + r.stderr.toString());
});
test('placeholders only: no real-looking user homes or drive paths in code, manifests or fixtures', () => {
  const offenders = [...files('packages'), ...files('integrations'), ...files('packs'), ...files('tests')]
    .filter(f => !f.startsWith('tests/guards/'))
    .flatMap(f => (read(f).match(/(?:C:[\\/]+Users[\\/]+|\/home\/|\/Users\/)([A-Za-z][\w.-]*)/g) ?? []).map(m => `${f}: ${m}`))
    .filter(m => !/(Users[\\/]+|home\/|Users\/)(u|user|test|TestUser)$/.test(m.split(': ')[1]));
  assert.deepEqual(offenders, []);
});
