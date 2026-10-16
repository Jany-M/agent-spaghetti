// Fails when any installed package (dev or runtime) is copyleft: BSL 1.1 cannot include it (ADR 0001/0003).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CC-BY-SA)/i;
const bad = [];
function scan(dir) {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.')) continue;
    if (n.startsWith('@')) { scan(join(dir, n)); continue; }
    const pj = join(dir, n, 'package.json');
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, 'utf8'));
    const lic = typeof p.license === 'string' ? p.license : JSON.stringify(p.license ?? p.licenses ?? 'UNKNOWN');
    if (COPYLEFT.test(lic) && !/OR (MIT|Apache|BSD|ISC)/i.test(lic)) bad.push(`${p.name}@${p.version}: ${lic}`);
    scan(join(dir, n, 'node_modules'));
  }
}
scan(join(process.cwd(), 'node_modules'));
if (bad.length) { console.error('copyleft dependencies:\n' + bad.join('\n')); process.exit(1); }
console.log('licensecheck: no copyleft dependencies');
