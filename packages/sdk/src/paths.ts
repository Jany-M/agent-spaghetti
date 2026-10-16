// Our own files follow each OS's conventions (ADR 0008); AGENT_SPAGHETTI_DATA_DIR overrides.
import { mkdirSync } from 'node:fs';
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
