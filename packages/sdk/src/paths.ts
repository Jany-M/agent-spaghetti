// Our own files follow each OS's conventions (ADR 0008); AGENT_SPAGHETTI_DATA_DIR overrides.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const dir = env.AGENT_SPAGHETTI_DATA_DIR
    ?? (platform === 'win32' ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agent-spaghetti')
      : platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'agent-spaghetti')
      : join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'agent-spaghetti'));
  mkdirSync(dir, { recursive: true });
  return dir;
}
export const tokenPath = (dir: string) => join(dir, 'token');
export const discoveryPath = (dir: string) => join(dir, 'daemon.json');   // { port, pid, startedAt }
export const userIntegrationsDir = (dir: string) => join(dir, 'integrations');
export const logsDir = (dir: string) => join(dir, 'logs');
export const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** The running daemon's discovery record, or null. A record whose pid is dead is stale: removed here, for whoever reads first. */
export function readDiscovery(dir: string): { port: number; pid?: number; startedAt?: string } | null {
  const p = discoveryPath(dir);
  let d: { port: number; pid?: number; startedAt?: string };
  try { d = JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  if (typeof d.pid === 'number' && !pidAlive(d.pid)) { rmSync(p, { force: true }); return null; }
  return d;
}
