import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { discoveryPath, tokenPath } from '@agent-spaghetti/sdk';

/** 64 hex chars, user-only file. On Windows the file lives under the user's private %LOCALAPPDATA%. */
export function loadOrCreateToken(dir: string): string {
  const p = tokenPath(dir);
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  const t = randomBytes(32).toString('hex');
  writeFileSync(p, t, { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* windows */ }
  return t;
}
/** Writes daemon.json; returns its remover. */
export function writeDiscovery(dir: string, port: number): () => void {
  const p = discoveryPath(dir);
  writeFileSync(p, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }));
  return () => rmSync(p, { force: true });
}
