// The one place that turns data into text (CLI, tray tooltip, app). Names always come from manifests.
import type { AgentInfo, BackendInfo, Snapshot, Switch, TestResult } from './types.ts';
import type { LiveState } from './state.ts';
import type { ConsentRequest, DeclaredAction, Grant } from './permissions.ts';

const portOf = (url?: string) => { try { return url ? new URL(url).port : ''; } catch { return ''; } };
/** Same model AND (same port when the agent knows its endpoint, else integration === provider). */
export function linkBackend(a: AgentInfo, backends: BackendInfo[]): BackendInfo | undefined {
  return backends.find(b => b.model === a.model && (a.endpoint ? portOf(a.endpoint) === portOf(b.endpoint) : b.integration === a.provider));
}
export const ctxLabel = (n?: number) => (n ? ` · ctx ${Math.round(n / 1000)}k` : '');

export function renderTree(s: Snapshot, live?: LiveState): string {
  const name = new Map(s.detections.map(d => [d.integration, d.name]));
  const nice = (id: string) => name.get(id) ?? id;
  const used = new Set<string>(), lines: string[] = [];
  for (const a of s.agents) {
    const b = linkBackend(a, s.backends);
    const left = `${nice(a.integration)} · ${a.name}`;
    if (b) { used.add(b.id + b.endpoint); lines.push(`${left} → ${nice(b.integration)} · ${b.model}${ctxLabel(b.contextLength)}`); }
    else lines.push(a.provider ? `${left} → ${a.provider} · ${a.model} (not observed)` : `${left} → (model unknown)`);
    const local = a.id.slice(a.integration.length + 1);
    for (const x of Object.values(live?.sessions ?? {}).filter(x => x.envId === a.envId && x.agentId === local))
      lines.push(`  └ ${[x.kind ?? 'session', x.status].filter(Boolean).join(' ')}${x.model ? ` · ${x.model}` : ''}`);
  }
  for (const b of s.backends) if (!used.has(b.id + b.endpoint)) lines.push(`${nice(b.integration)} · ${b.model}${ctxLabel(b.contextLength)} (no agent attached)`);
  for (const e of s.envs) {
    if (e.state !== 'running') lines.push(`! ${e.id} ${e.state}${e.why ? ` (${e.why})` : ''}`);
    else if (e.partial?.length) lines.push(`! ${e.id} partial: ${e.partial.join(', ')}`);
  }
  return lines.join('\n');
}
export function detectionRows(s: Snapshot): string[][] {
  return [['Tool', 'Env', 'Version', 'Levels', 'Connectable', 'Why'],
    ...s.detections.map(d => [d.name, d.envId, d.version ?? '-', d.levels.join(','), d.connectable, d.why])];
}
export function renderTable(rows: string[][]): string {
  const w = rows[0]?.map((_, i) => Math.max(...rows.map(r => (r[i] ?? '').length))) ?? [];
  return rows.map(r => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join('  ')).join('\n');
}

export const switchRows = (sw: Switch[]) => [['Switch', 'Env', 'State'], ...sw.map(s => [s.id, s.envId, s.on ? 'on' : 'off'])];
export const testLines = (r: TestResult) => [...r.steps.map(s => `${s.ok ? 'OK  ' : 'FAIL'}  ${s.name.padEnd(20)} ${s.detail} (${s.ms} ms)`), r.ok ? 'ALL OK' : 'FAILED'];
export function permissionRows(subject: string, declared: DeclaredAction[], grants: Grant[], pending: Array<{ action: string; resource: string }>) {
  const mode = (a: DeclaredAction) => grants.find(g => g.subject === subject && g.action === a.action && g.resource === a.resource)?.mode
    ?? (pending.some(p => p.action === a.action && p.resource === a.resource) ? 'pending' : 'not asked yet');
  return [['Action', 'Resource', 'Mode', 'Why'], ...declared.map(a => [a.action, a.resource, mode(a), a.why])];
}

/** Machine configuration report (ADR 0007): the one renderer, used by the CLI now and the app later. Redact before sharing. */
export function renderConfigReport(s: Snapshot, live?: LiveState, date = new Date(s.ts)): string {
  const md = (rows: string[][]) => [`| ${rows[0].join(' | ')} |`, `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map(r => `| ${r.map(c => c.replaceAll('|', '\\|')).join(' | ')} |`)].join('\n');
  return [`# Agent Spaghetti: machine configuration (${date.toISOString().slice(0, 10)})`, '',
    '## Environments', md([['Environment', 'State', 'Notes'], ...s.envs.map(e => [e.id, e.state, [e.why, ...(e.partial ?? [])].filter(Boolean).join('; ') || '-'])]), '',
    '## Tools', md(detectionRows(s)), '',
    '## Backends', s.backends.length ? md([['Backend', 'Model', 'Context', 'Reachable from'], ...s.backends.map(b => [b.integration, b.model, b.contextLength ? String(b.contextLength) : '-', b.reachableFrom.join(', ')])]) : 'none running', '',
    '## Agents', s.agents.length ? md([['Agent', 'Env', 'Model', 'Backend'], ...s.agents.map(a => [`${a.integration} · ${a.name}`, a.envId, a.model ?? '-', linkBackend(a, s.backends) ? 'linked' : 'not observed'])]) : 'none', '',
    ...(live && Object.keys(live.sessions).length ? ['## Running sessions', md([['Env', 'Agent', 'Kind', 'Status'], ...Object.values(live.sessions).map(x => [x.envId, x.agentId ?? '-', x.kind ?? '-', x.status ?? '-'])]), ''] : []),
  ].join('\n');
}

/** Tray icon state, by priority: problem > approval > working > idle. `null` snapshot with no daemon = problem. */
export type TrayState = 'idle' | 'working' | 'approval' | 'problem';
export function trayState(up: boolean, snap: Snapshot | null, live: LiveState, pending: ConsentRequest[]): TrayState {
  if (!up || snap?.envs.some(e => e.state === 'error')) return 'problem';
  if (pending.length) return 'approval';
  return Object.keys(live.sessions).length || Object.keys(live.runs).length ? 'working' : 'idle';
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Short status lines: tray tooltip, popover header and `agent-spaghetti status --short`. */
export function renderStats(up: boolean, snap: Snapshot | null, live: LiveState, pending: ConsentRequest[]): string[] {
  if (!up) return ['agent-spaghetti is not running'];
  const name = new Map(snap?.detections.map(d => [d.integration, d.name]) ?? []);
  const lines = [`agent-spaghetti running · ${snap ? plural(new Set(snap.detections.map(d => d.integration)).size, 'tool') : 'no scan yet'}`];
  const running = Object.values(live.backends).filter(b => b.up && b.models.length);
  const backends = running.length ? running.map(b => ({ integration: b.integration, model: b.models[0].model, ctx: b.models[0].contextLength ?? undefined }))
    : (snap?.backends ?? []).map(b => ({ integration: b.integration, model: b.model, ctx: b.contextLength }));
  const queue = (id: string) => { const q = live.queues[id]; return q?.waiting ? ` · queue ${q.waiting}` : ''; };
  for (const l of new Set(backends.map(b => `${name.get(b.integration) ?? b.integration} · ${b.model}${ctxLabel(b.ctx)}${queue(b.integration)}`))) lines.push(l);   // one line per server seen from several envs
  const sessions = Object.keys(live.sessions).length;
  if (sessions) lines.push(`${plural(sessions, 'session')} running`);
  const runs = Object.keys(live.runs).length;
  if (runs) lines.push(`${plural(runs, 'delegated task')} running`);
  if (pending.length) lines.push(`${plural(pending.length, 'approval')} waiting`);
  return lines;
}
