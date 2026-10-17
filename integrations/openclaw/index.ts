// OpenClaw module (ADR 0004 tier 2). Uses only OpenClaw's documented CLI (checked 2026-10-16 on 2026.9.5):
//   openclaw agents list --json                          → [{ id, name, model: "<provider>/<model…>", isDefault, … }]
//   openclaw config get models.providers --json          → { <providerId>: { baseUrl, … } }   (only baseUrl is kept)
//   openclaw sessions --all-agents --active <min> --json → { sessions: [{ key, agentId, kind, status, model, … }] }
//   openclaw config get mcp.servers --json / config patch --stdin / mcp reload   (switches, shared with the pack)
//   openclaw agent --agent <id> --session-id <id> --message-file /dev/stdin --json → { status, result: { payloads: [{ text }],
//     meta: { agentMeta: { usage: { input, output }, costUsd, model } } } } or { ok: false, error: { message } }, exit 1 (checked live 2026.9.5)
//   gateway GET /healthz → {"ok":true,"status":"live"}, no auth (manifest detect.http; docs/gateway/health.md, checked 2026-10-16)
// The config file itself is never opened by the hub.
import type { AgentInfo, IntegrationModule, RunEvent } from '@agent-spaghetti/sdk';
import { parseJsonLoose } from '@agent-spaghetti/sdk';
import { MCP_NAME, mcpServers, setMcpEnabled, setOurServer } from './pack/mcp.ts';
import { healthSteps } from './pack/health.ts';
import { applySetup } from './pack/setup.ts';
import { packCli } from './pack/main.ts';
import { openclawExe, openclawJson } from './cli.ts';
export { openclawExe, openclawJson };
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
export function toAgents(list: unknown, providers: unknown, envId: string): AgentInfo[] {
  const prov = providers && typeof providers === 'object' ? (providers as Record<string, { baseUrl?: unknown }>) : {};
  return (Array.isArray(list) ? list : []).filter(a => a && typeof a.id === 'string').map(a => {
    const { provider, model } = splitModelRef(a.model, Object.keys(prov));
    return { id: `openclaw:${a.id}`, integration: 'openclaw', name: typeof a.name === 'string' && a.name ? a.name : a.id, envId,
      provider, model, endpoint: provider ? endpointOf(prov[provider]?.baseUrl) : undefined, isDefault: a.isDefault === true };
  });
}

const SESSION_FIELDS = ['key', 'agentId', 'kind', 'status', 'model', 'modelProvider', 'updatedAt', 'totalTokens', 'spawnDepth'] as const;
/** Whitelisted session fields; diffing by key gives started / updated / ended. The first poll reports running sessions as updated. */
export function diffSessions(prev: Map<string, string>, list: unknown, seed: boolean) {
  const now = new Map<string, Record<string, unknown>>();
  for (const s of Array.isArray(list) ? list : []) if (s && typeof s.key === 'string') now.set(s.key, Object.fromEntries(SESSION_FIELDS.map(f => [f, s[f] ?? null])));
  const events: Array<{ type: 'session.started' | 'session.updated' | 'session.ended'; data: Record<string, unknown> }> = [];
  for (const [k, d] of now) {
    const sig = JSON.stringify(d), before = prev.get(k);
    if (before === undefined) { if (d.status !== 'done') events.push({ type: seed ? 'session.updated' : 'session.started', data: d }); }   // seed: already running when observing began
    else if (before !== sig) events.push({ type: d.status === 'done' ? 'session.ended' : 'session.updated', data: d });
    prev.set(k, sig);
  }
  for (const k of [...prev.keys()]) if (!now.has(k)) { prev.delete(k); if (!seed) events.push({ type: 'session.ended', data: { key: k, status: 'gone' } }); }
  return events;
}

/** `openclaw agent --json` output → run events. */
export function agentResult(stdout: string): RunEvent[] {
  const j = parseJsonLoose(stdout) as any;
  if (!j || typeof j !== 'object') return [{ type: 'error', message: 'openclaw agent returned no JSON' }];
  if (j.ok === false || j.status !== 'ok') return [{ type: 'error', message: String(j.error?.message ?? j.summary ?? j.status ?? 'failed') }];
  const m = j.result?.meta?.agentMeta ?? {};
  return [{ type: 'usage', inputTokens: m.usage?.input, outputTokens: m.usage?.output, costUsd: m.costUsd },
    { type: 'done', result: (j.result?.payloads ?? []).map((p: any) => p?.text).filter((t: unknown) => typeof t === 'string').join('\n\n') }];
}

export const openclawModule: IntegrationModule = {
  async inspect(env, base) {
    const exe = openclawExe(base.detection);
    if (!exe) return base;
    const [list, providers] = await Promise.all([openclawJson(env, exe, ['agents', 'list']), openclawJson(env, exe, ['config', 'get', 'models.providers'])]);
    if (!Array.isArray(list)) return { ...base, detection: { ...base.detection, connectable: 'needs-setup', why: 'installed; `openclaw agents list --json` failed (is OpenClaw configured?)' } };
    const connected = (await mcpServers(env, exe)).some(s => s.name === MCP_NAME);
    return { detection: { ...base.detection, connected }, backends: base.backends, agents: toAgents(list, providers, env.id) };
  },
  observe(env, det, emit, ctx) {
    const exe = openclawExe(det);
    if (!exe || !det.endpoint) return { dispose() {} };    // gateway down: nothing runs (a rescan follows when it comes back)
    const prev = new Map<string, string>(); let seed = true, busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const j = await openclawJson(env, exe, ['sessions', '--all-agents', '--active', '120']) as { sessions?: unknown } | undefined;
        if (j) { for (const e of diffSessions(prev, j.sessions, seed)) emit({ type: e.type, data: e.data }); seed = false; }
      } finally { busy = false; }
    };
    void tick();
    const timer = setInterval(tick, ctx.pollMs ?? 2000);
    return { dispose: () => clearInterval(timer) };
  },
  /** One turn of an OpenClaw agent (req.model = agent id, else the default agent): in `req.session` when continuing one, else its own session per run. */
  resumes: true,
  async *run(env, det, req, ctx) {
    const exe = openclawExe(det);
    if (!exe) throw new Error('openclaw not found');
    if (!det.endpoint) throw new Error('the OpenClaw gateway is not running');
    if (env.kind === 'windows') throw new Error('OpenClaw tasks run where its CLI reads the task from /dev/stdin (Linux, macOS, WSL)');
    const agent = req.model ?? toAgents(await openclawJson(env, exe, ['agents', 'list']), {}, env.id).find(a => a.isDefault)?.id.slice('openclaw:'.length) ?? 'main';
    const session = req.session ?? `agent-spaghetti-${ctx.runId ?? Date.now()}`;
    yield { type: 'session', id: session };
    const lines: string[] = [];
    try {
      // through `cat |`: Node gives children a socket as stdin, which /dev/stdin cannot open (ENXIO); a pipe it can
      const args = ['agent', '--agent', agent, '--session-id', session, '--message-file', '/dev/stdin', '--json'];
      for await (const l of env.execLines('sh', ['-c', 'cat | "$0" "$@"', exe, ...args], { input: req.task, cwd: req.cwd, signal: ctx.signal })) lines.push(l);
    } catch (e) { if (ctx.signal.aborted || !lines.length) throw e; }   // exit 1 still prints the JSON reason
    yield* agentResult(lines.join('\n'));
  },
  async connect(env, det, cli, on, dryRun) {
    const exe = openclawExe(det);
    if (!exe) throw new Error('openclaw not found');
    if (!dryRun) await setOurServer(env, exe, on ? { command: cli.command, args: [...cli.args, 'mcp', '--as', 'openclaw'] } : null);
    return { description: on ? `add the ${MCP_NAME} MCP server to OpenClaw (kept on; other servers stay parked)` : `remove the ${MCP_NAME} MCP server from OpenClaw`,
      changes: [`openclaw config patch: mcp.servers.${MCP_NAME}${on ? '' : ' = null'}`, 'openclaw mcp reload'], applied: !dryRun };
  },
  /** The workflow pack: check = the wiring report; apply = install it (model from the `openclaw.model` setting). */
  async setup(env, det, o) {
    const exe = openclawExe(det);
    if (!exe) throw new Error('openclaw not found');
    return o.action === 'check' ? healthSteps(env, exe) : applySetup({ env, exe, dryRun: o.dryRun, model: o.options.model ?? 'auto', cli: o.cli, localModels: o.localModels });
  },
  cli: (env, det, args, say) => packCli(env, det, args, say),
  settings: { model: { default: 'auto', help: 'Model the OpenClaw setup gives its workflow: auto (keep it while it answers, else the best loaded local model), keep, or <server>:<model> from targets' } },
  async switches(env, det) {
    const exe = openclawExe(det);
    return exe ? (await mcpServers(env, exe)).map(s => ({ id: `openclaw-mcp:${s.name}`, label: `OpenClaw MCP server ${s.name}`, on: s.enabled, envId: env.id, integration: 'openclaw' })) : [];
  },
  async setSwitch(env, det, id, on) {
    const exe = openclawExe(det);
    if (!exe || !id.startsWith('openclaw-mcp:')) throw new Error(`unknown switch ${id}`);
    await setMcpEnabled(env, exe, { [id.slice('openclaw-mcp:'.length)]: on });
  },
};
