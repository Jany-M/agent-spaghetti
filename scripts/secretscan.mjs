// Fails when committed files contain secrets or private LAN addresses. Rules come from the one shared list.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanText } from '../packages/sdk/src/secrets.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '_dev']);
const ALLOW = [/^tests\//, /^packages\/sdk\/src\/secrets\.ts$/];   // tests carry fake secrets on purpose
function* walk(dir) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) yield* walk(p); else if (s.size < 2_000_000) yield p;
  }
}
let bad = 0;
for (const f of walk(process.cwd())) {
  const rel = relative(process.cwd(), f).replaceAll('\\', '/');
  if (ALLOW.some(re => re.test(rel))) continue;
  let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
  for (const h of scanText(t, 'repo')) { console.error(`${rel}: ${h}`); bad++; }
}
if (bad) process.exit(1);
console.log('secretscan: clean');
