// End to end: OpenClaw `setup` (check / dry run / apply) through the built env bundle against a fake `openclaw` CLI
// (Linux/WSL only): the pack files come embedded in the bundle, nothing else is copied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestResult } from '@agent-spaghetti/sdk';
import { spawnFile } from '../../packages/core/src/proc.ts';
import { encodePayload } from '../../packages/core/src/env/wsl.ts';

const skip = process.platform === 'win32';
const FAKE = `#!/bin/sh
# fake openclaw: logs every call, answers the documented JSON shapes
echo "$*" >> "$HOME/calls.log"
case "$*" in
  "config file") echo "~/.openclaw/openclaw.json" ;;
  "agents list --json") echo '[{"id":"main","isDefault":true,"workspace":"~/.openclaw/workspace"}]' ;;
  "config get models.providers --json") echo '{"hosted":{}}' ;;
  "config get models.providers.hosted --json") echo '{"apiKey":"NEVER"}' ;;
  "config get agents.defaults.model --json") echo '{"primary":"hosted/big"}' ;;
  "config get mcp.servers --json") echo '{"github":{"enabled":true}}' ;;
  "config patch --stdin"*) n=$(ls "$HOME"/patch.* 2>/dev/null | wc -l); cat > "$HOME/patch.$n.$(echo "$*" | tr -dc a-z)" ;;
  "gateway status") echo running ;;
  *) : ;;
esac
`;
test('setup: dry run validates both patches and writes nothing; apply installs helpers, patches, role files and the AGENTS.md block', { skip, timeout: 180000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'as-home-'));
  const bin = join(home, 'bin'); mkdirSync(bin); mkdirSync(join(home, '.openclaw'));
  writeFileSync(join(home, '.openclaw', 'openclaw.json'), '{"secret":"NEVER"}');
  writeFileSync(join(bin, 'openclaw'), FAKE); chmodSync(join(bin, 'openclaw'), 0o755);
  const out = join(home, 'dist');
  const build = await spawnFile(process.execPath, ['scripts/build.mjs', out], { timeoutMs: 60000 });
  assert.equal(build.code, 0, build.stderr.toString());
  const bundle = join(out, 'agent-spaghetti-env.mjs');
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const cli = JSON.stringify({ command: process.execPath, args: [bundle] });
  const setup = async (action: string, dry: boolean) => {
    const r = await spawnFile(process.execPath, [bundle, 'setup', encodePayload({ envId: 'linux', extraHosts: [], user: [], grants: [] }), 'openclaw', cli, action, dry ? 'dry-run' : '', '{"model":"auto"}'], { timeoutMs: 120000, env });
    assert.equal(r.code, 0, r.stderr.toString());
    return JSON.parse(r.stdout.toString()) as TestResult;
  };
  const patches = () => readdirSync(home).filter(f => f.startsWith('patch.')).sort();

  const dry = await setup('apply', true);
  assert.equal(dry.ok, true, JSON.stringify(dry.steps));
  assert.deepEqual(dry.steps.map(s => [s.name, s.detail.startsWith('skipped')]), [['OpenClaw found', false], ['backup', true], ['helpers installed', true],
    ['workflow settings patch', false], ['model patch', false], ['role files', true], ['orchestrator block', true], ['gateway restarted', true]]);
  assert.ok(!existsSync(join(home, '.openclaw', 'agent-spaghetti')), 'dry run installs nothing');
  assert.ok(patches().every(f => f.endsWith('dryrun')), patches().join());

  const r = await setup('apply', false);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.match(r.steps.find(s => s.name === 'model patch')!.detail, /keeping current primary model hosted\/big \(no local endpoint to probe\)/);
  const real = patches().filter(f => !f.endsWith('dryrun')).map(f => readFileSync(join(home, f), 'utf8'));
  assert.match(real[0], new RegExp(`${home}/.openclaw/workspace-worker`), 'static workflow patch with the state folder filled in');
  assert.deepEqual(JSON.parse(real[1]), { models: { providers: { hosted: { timeoutSeconds: 900 } } }, mcp: { servers: { github: { enabled: false } } } });
  const od = join(home, '.openclaw', 'agent-spaghetti', 'bin');
  for (const f of ['jobctl', 'ocmcp', 'agent-spaghetti-healthcheck']) assert.equal(readlinkSync(join(home, '.local', 'bin', f)), join(od, f));
  assert.match(readFileSync(join(home, '.openclaw', 'workspace', 'AGENTS.md'), 'utf8'), /BEGIN ORCHESTRATOR \(managed by agent-spaghetti/);
  assert.ok(existsSync(join(home, '.openclaw', 'workspace-verifier', 'AGENTS.md')));
  const backup = readdirSync(join(home, '.openclaw', 'agent-spaghetti-backups'));
  assert.equal(backup.length, 1);

  const oc = await spawnFile(join(home, '.local', 'bin', 'ocmcp'), ['status'], { timeoutMs: 60000, env });
  assert.equal(oc.code, 0, oc.stderr.toString());
  assert.match(oc.stdout.toString(), /^on : github$/m);
  const check = await setup('check', false);
  assert.ok(check.steps.some(s => s.name === 'gateway service up' && s.ok));
  const calls = readFileSync(join(home, 'calls.log'), 'utf8');
  assert.ok(!calls.includes('NEVER') && !JSON.stringify([dry, r, check]).includes('NEVER'), 'secrets never echoed');
});
