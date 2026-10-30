// Starting and stopping the daemon as a process: shared by the CLI (`daemon --detached`, `daemon stop`) and the tray.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HubClient, dataDir, discoveryPath, logsDir, pidAlive, readDiscovery } from '@agent-spaghetti/sdk';
import { spawnDetached } from './proc.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Starts `daemon` as a detached process (survives its parent); output goes to `<dataDir>/logs/daemon.log`. `cli` is the path of the CLI entry (required: no `import.meta` here, the tray bundles this as CJS). */
export function spawnDaemon(env: NodeJS.ProcessEnv = process.env, cli: string): number | undefined {
  const logs = logsDir(dataDir(env));
  mkdirSync(logs, { recursive: true });
  return spawnDetached('node', [cli, 'daemon'], { logFile: join(logs, 'daemon.log'), env });
}

/** Graceful stop (the stop op over HTTP), then waits until the process is gone. Returns false when no daemon was running. */
export async function stopDaemon(env: NodeJS.ProcessEnv = process.env, timeoutMs = 10000): Promise<boolean> {
  const dir = dataDir(env), found = readDiscovery(dir);
  if (!found) return false;
  try { await HubClient.fromDiscovery(env).call('shutdown'); } catch { /* already going away */ }
  const until = Date.now() + timeoutMs;
  while (found.pid !== undefined && pidAlive(found.pid) && Date.now() < until) await sleep(100);
  if (found.pid !== undefined && pidAlive(found.pid)) throw new Error(`the daemon (pid ${found.pid}) did not stop`);
  rmSync(discoveryPath(dir), { force: true });
  return true;
}
