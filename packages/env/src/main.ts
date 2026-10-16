// agent-spaghetti-env.mjs: the one program that runs INSIDE a WSL distro (review R2). Built-ins are embedded;
// the host sends user manifests and hosts on stdin. Output is JSON on stdout. No server, no port, no token.
import { readFileSync } from 'node:fs';
import type { Integration } from '@agent-spaghetti/sdk';
import { BUILTINS } from '@agent-spaghetti/integrations';
import { localEnvironment, scanEnv, type InspectPayload } from '@agent-spaghetti/core/portable';

export const VERSION = '0.1.0';
const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };

export async function main(argv: string[], stdin: () => string = readStdin): Promise<number> {
  const [cmd] = argv;
  if (cmd === 'version') { process.stdout.write(VERSION + '\n'); return 0; }
  if (cmd === 'inspect') {
    const p: InspectPayload = { envId: '', extraHosts: [], user: [], ...JSON.parse(stdin() || '{}') };
    const env = localEnvironment({ id: p.envId || undefined, extraHosts: p.extraHosts });
    const user: Integration[] = p.user.map(manifest => ({ manifest, source: 'user' }));
    const ids = new Set(user.map(u => u.manifest.id));
    process.stdout.write(JSON.stringify(await scanEnv(env, [...BUILTINS.filter(b => !ids.has(b.manifest.id)), ...user])));
    return 0;
  }
  process.stderr.write('usage: agent-spaghetti-env.mjs inspect|version\n');
  return 1;
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
