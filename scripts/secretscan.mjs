// Fails when files that git would commit contain secrets or private LAN addresses. Rules come from the one shared list.
// Without git (e.g. an unpacked archive) it walks the tree instead, skipping generated and private folders.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanText } from '../packages/sdk/src/secrets.ts';
import { spawnFile } from '../packages/core/src/proc.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '_dev', '.as-tmp']);
const ALLOW = [/^tests\//, /^integrations\/[^/]+\/fixtures\.json$/, /^packages\/sdk\/src\/secrets\.ts$/];   // tests carry fake secrets on purpose
function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* walk(p); else yield relative(process.cwd(), p);
  }
}
const git = await spawnFile('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeoutMs: 30000 });
const files = git.code === 0 ? git.stdout.toString('utf8').split('\0').filter(Boolean) : [...walk(process.cwd())];
let bad = 0;
for (const f of files) {
  const rel = f.replaceAll('\\', '/');
  if (ALLOW.some(re => re.test(rel))) continue;
  let t; try { if (statSync(f).size > 2_000_000) continue; t = readFileSync(f, 'utf8'); } catch { continue; }
  for (const h of scanText(t, 'repo')) { console.error(`${rel}: ${h}`); bad++; }
}
if (bad) process.exit(1);
console.log('secretscan: clean');
