// OpenClaw module (ADR 0004 tier 2). Uses only OpenClaw's documented CLI JSON (checked 2026-10-16 on 2026.9.5):
//   openclaw agents list --json          → [{ id, name, model: "<provider>/<model…>", isDefault, … }]
//   openclaw config get models.providers --json → { <providerId>: { baseUrl, … } }   (only baseUrl is kept)
// The config file itself is never opened by the hub.
import type { AgentInfo, Environment, Inspection, IntegrationModule } from '@agent-spaghetti/sdk';
import { parseJsonLoose } from '@agent-spaghetti/sdk';

const CLI_MS = 30000;
/** Longest configured provider id wins (ids may contain '/'); otherwise the first segment. */
export function splitModelRef(ref: unknown, providerIds: string[]): { provider?: string; model?: string } {
  if (typeof ref !== 'string' || !ref.includes('/')) return {};
  const pid = [...providerIds].sort((a, b) => b.length - a.length).find(p => ref.startsWith(p + '/')) ?? ref.slice(0, ref.indexOf('/'));
  return { provider: pid, model: ref.slice(pid.length + 1) };
}
/** scheme://host:port only: credentials, path and query never leave the module. */
export function endpointOf(baseUrl: unknown): string | undefined {
  try { const u = new URL(String(baseUrl)); return `${u.protocol}//${u.host}`; } catch { return undefined; }
}
/** The openclaw executable this env found (PATH or default path), if any. */
export const openclawExe = (base: Inspection) => base.detection.installs.find(i => (i.via === 'bin' || i.via === 'path') && i.path)?.path;
export async function openclawJson(env: Environment, exe: string, args: string[]): Promise<unknown> {
  const r = await env.exec(exe, [...args, '--json'], { timeoutMs: CLI_MS });
  return r.code === 0 ? parseJsonLoose(r.stdout) : undefined;
}

export function toAgents(list: unknown, providers: unknown, envId: string): AgentInfo[] {
  const prov = providers && typeof providers === 'object' ? (providers as Record<string, { baseUrl?: unknown }>) : {};
  return (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === 'string').map(a => {
    const { provider, model } = splitModelRef(a.model, Object.keys(prov));
    return { id: `openclaw:${a.id}`, integration: 'openclaw', name: typeof a.name === 'string' && a.name ? a.name : a.id, envId,
      provider, model, endpoint: provider ? endpointOf(prov[provider]?.baseUrl) : undefined, isDefault: a.isDefault === true };
  });
}

export const openclawModule: IntegrationModule = {
  async inspect(env, base) {
    const exe = openclawExe(base);
    if (!exe) return base;
    const [list, providers] = await Promise.all([openclawJson(env, exe, ['agents', 'list']), openclawJson(env, exe, ['config', 'get', 'models.providers'])]);
    if (!Array.isArray(list)) return { ...base, detection: { ...base.detection, connectable: 'needs-setup', why: 'installed; `openclaw agents list --json` failed (is OpenClaw configured?)' } };
    return { ...base, agents: toAgents(list, providers, env.id) };
  },
};
