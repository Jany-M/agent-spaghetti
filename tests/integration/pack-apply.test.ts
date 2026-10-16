// End to end: packs/openclaw/scripts/apply.sh against a fake `openclaw` CLI (Linux/WSL only). No Python involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnFile } from '../../packages/core/src/proc.ts';

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
  "config patch --stdin"*) cat > "$HOME/patch.$(echo "$*" | tr -dc a-z).json" ;;
  "config patch --file"*) cp "$4" "$HOME/static.json5" ;;
  "gateway status") echo running ;;
  *) : ;;
esac
`;
test('apply.sh: dry run changes nothing; real run installs shims, patches config and writes the AGENTS.md block', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'as-home-'));
  const bin = join(home, 'bin'); mkdirSync(bin); mkdirSync(join(home, '.openclaw'));
  writeFileSync(join(home, '.openclaw', 'openclaw.json'), '{}');
  writeFileSync(join(bin, 'openclaw'), FAKE); chmodSync(join(bin, 'openclaw'), 0o755);
  const build = await spawnFile(process.execPath, ['scripts/build.mjs'], { timeoutMs: 60000 });
  assert.equal(build.code, 0, build.stderr.toString());
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  const run = (args: string[]) => spawnFile('bash', ['packs/openclaw/scripts/apply.sh', ...args], { timeoutMs: 120000, env });

  const dry = await run(['--dry-run']);
  assert.equal(dry.code, 0, dry.stdout.toString() + dry.stderr.toString());
  assert.ok(!existsSync(join(home, '.openclaw', 'agent-spaghetti')), 'dry run installs nothing');
  assert.ok(existsSync(join(home, 'patch.configpatchstdindryrun.json')));

  const r = await run([]);
  const out = r.stdout.toString() + r.stderr.toString();
  assert.equal(r.code, 0, out);
  assert.match(out, /keeping current primary model hosted\/big \(no local endpoint to probe\)/);
  const patch = JSON.parse(readFileSync(join(home, 'patch.configpatchstdin.json'), 'utf8'));
  assert.deepEqual(patch, { models: { providers: { hosted: { timeoutSeconds: 900 } } }, mcp: { servers: { github: { enabled: false } } } });
  assert.match(readFileSync(join(home, 'static.json5'), 'utf8'), new RegExp(`${home}/.openclaw/workspace-worker`));
  const od = join(home, '.openclaw', 'agent-spaghetti', 'bin');
  for (const f of ['jobctl', 'ocmcp', 'agent-spaghetti-healthcheck', 'agent-spaghetti-env.mjs', 'node.path']) assert.ok(existsSync(join(od, f)), f);
  assert.equal(readlinkSync(join(home, '.local', 'bin', 'ocmcp')), join(od, 'ocmcp'));
  assert.match(readFileSync(join(home, '.openclaw', 'workspace', 'AGENTS.md'), 'utf8'), /BEGIN ORCHESTRATOR \(managed by agent-spaghetti/);
  assert.ok(existsSync(join(home, '.openclaw', 'workspace-verifier', 'AGENTS.md')));

  const oc = await spawnFile(join(home, '.local', 'bin', 'ocmcp'), ['status'], { timeoutMs: 60000, env });
  assert.equal(oc.code, 0, oc.stderr.toString());
  assert.match(oc.stdout.toString(), /^on : github$/m);
  const calls = readFileSync(join(home, 'calls.log'), 'utf8');
  assert.ok(!calls.includes('NEVER') && !out.includes('NEVER'), 'secrets never echoed');
});
