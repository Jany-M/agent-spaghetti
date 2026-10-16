// Where this OpenClaw keeps its config and where the pack installs its files (<state>/agent-spaghetti).
import type { Environment } from '@agent-spaghetti/sdk';

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');
/** `openclaw config file` prints the path (last line; may start with ~). OPENCLAW_CONFIG_PATH wins. */
export async function configPath(env: Environment, exe: string, vars: NodeJS.ProcessEnv): Promise<string | null> {
  if (vars.OPENCLAW_CONFIG_PATH) return vars.OPENCLAW_CONFIG_PATH;
  const r = await env.exec(exe, ['config', 'file'], { timeoutMs: 30000 });
  const last = stripAnsi(r.stdout).trim().split('\n').pop()?.trim();
  return r.code === 0 && last ? last.replace(/^~(?=$|[\\/])/, vars.HOME ?? vars.USERPROFILE ?? '~') : null;
}
export const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
export const packDir = (cfg: string) => `${dirOf(cfg)}/agent-spaghetti`;
