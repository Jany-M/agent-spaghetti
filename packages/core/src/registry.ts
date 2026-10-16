// Built-in integrations come from the static index; third-party manifests are read from the user folder.
// Every manifest is schema-validated and secret-checked the same way (ADR 0004).
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Integration, Manifest } from '@agent-spaghetti/sdk';
import { scanText, validate } from '@agent-spaghetti/sdk';

const SCHEMA = createRequire(import.meta.url)('@agent-spaghetti/sdk/manifest.schema.json');
export interface Loaded { integrations: Integration[]; rejected: Array<{ id: string; why: string }> }

/** Returns an error message, or null when the manifest is acceptable. */
export function checkManifest(m: unknown, text: string, expectedId?: string): string | null {
  const errors = validate(SCHEMA, m);
  if (errors.length) return `invalid manifest: ${errors.slice(0, 3).join('; ')}`;
  if (scanText(text).length) return 'manifest contains a secret-looking value';
  if (expectedId && (m as Manifest).id !== expectedId) return `id "${(m as Manifest).id}" does not match its file/folder "${expectedId}"`;
  return null;
}

/** userDir: `<dataDir>/integrations/*.json`. A user manifest with a built-in id replaces that manifest (without its module). */
export async function loadIntegrations(builtins: Integration[], userDir: string | null): Promise<Loaded> {
  const rejected: Loaded['rejected'] = [];
  const byId = new Map<string, Integration>();
  for (const b of builtins) {
    const err = checkManifest(b.manifest, JSON.stringify(b.manifest));
    if (err) rejected.push({ id: b.manifest.id, why: err }); else byId.set(b.manifest.id, b);
  }
  for (const f of userDir ? (await readdir(userDir).catch(() => [] as string[])).filter(f => f.endsWith('.json')).sort() : []) {
    const id = f.slice(0, -5);
    const text = await readFile(join(userDir!, f), 'utf8').catch(() => '');
    let m: unknown;
    try { m = JSON.parse(text); } catch { rejected.push({ id, why: 'not valid JSON' }); continue; }
    const err = checkManifest(m, text, id);
    if (err) { rejected.push({ id, why: err }); continue; }
    byId.set(id, { manifest: m as Manifest, source: 'user', hash: createHash('sha256').update(text).digest('hex') });
  }
  return { integrations: [...byId.values()], rejected };
}
