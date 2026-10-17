// The one way to call the OpenClaw CLI (module, observers, switches and the pack).
import type { Detection, Environment } from '@agent-spaghetti/sdk';
import { parseJsonLoose, programOf } from '@agent-spaghetti/sdk';

const CLI_MS = 30000;
/** The openclaw executable this env found (PATH or default path), if any. */
export const openclawExe = (det: Detection) => programOf(det, 'openclaw');
/** One way to call the CLI for JSON, used by the module and the pack. */
export async function openclawJson(env: Environment, exe: string, args: string[]): Promise<unknown> {
  const r = await env.exec(exe, [...args, '--json'], { timeoutMs: CLI_MS });
  return r.code === 0 ? parseJsonLoose(r.stdout) : undefined;
}

