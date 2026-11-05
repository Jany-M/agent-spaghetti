// The one place that turns data into text (CLI, tray tooltip, app). Names always come from manifests.
import type { AgentInfo, BackendInfo, Delivery, Level, Role, RunRow, Snapshot, StoredEvent, Switch, Target, TestResult, TraceStage } from './types.ts';
import { AUTO } from './types.ts';
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
  const nice = (id: string) => name.get(id) ?? id;
  // What the observers see now; the snapshot only for servers no observer has reported since the scan.
  const reported = new Set(Object.keys(live.backends));
  const backends = [...Object.values(live.backends).filter(b => b.up && b.models.length).map(b => ({ integration: b.integration, model: b.models[0].model, ctx: b.models[0].contextLength ?? undefined })),
    ...(snap?.backends ?? []).filter(b => !reported.has(`${b.envId}|${b.integration}`)).map(b => ({ integration: b.integration, model: b.model, ctx: b.contextLength }))];
  const queue = (id: string) => { const q = live.queues[id]; return q?.waiting ? ` · queue ${q.waiting}` : ''; };
  const stopped = Object.values(live.tools).filter(t => !t.running).map(t => t.integration);
  const serverDown = Object.values(live.backends).filter(b => !b.up && !stopped.includes(b.integration)).map(b => b.integration);
  for (const l of new Set([...backends.map(b => `${nice(b.integration)} · ${b.model}${ctxLabel(b.ctx)}${queue(b.integration)}`),   // one line per server seen from several envs
    ...stopped.map(i => `${nice(i)} stopped`), ...serverDown.map(i => `${nice(i)} · server stopped`)])) lines.push(l);
  const sessions = Object.keys(live.sessions).length;
  if (sessions) lines.push(`${plural(sessions, 'session')} running`);
  const runs = Object.keys(live.runs).length;
  if (runs) lines.push(`${plural(runs, 'delegated task')} running`);
  if (pending.length) lines.push(`${plural(pending.length, 'approval')} waiting`);
  return lines;
}

/** One run as a line (CLI `runs`, the Runs panel). */
/** A run's kind and difficulty and who set them, as people read it: "summarize · light (rules, 80% sure)". */
export const classification = (r: Pick<RunRow, 'kind' | 'difficulty' | 'classifiedBy' | 'confidence'>) => `${r.kind}${r.difficulty ? ` · ${r.difficulty}` : ''}`
  + (r.classifiedBy === 'caller' ? ' (set by the caller)' : r.classifiedBy ? ` (Agent Spaghetti's ${r.classifiedBy}, ${Math.round((r.confidence ?? 0) * 100)}% sure)` : '');
export const runLine = (r: RunRow) => `${String(r.id).padStart(4)}  ${new Date(r.ts).toLocaleString()}  ${r.source} → ${r.target}${r.model ? ` (${r.model})` : ''}  ${r.kind}${r.difficulty ? `·${r.difficulty}` : ''}  ${r.outcome}`
  + `${r.durationMs ? ` ${Math.round(r.durationMs / 1000)}s` : ''}${r.costUsd ? ` $${r.costUsd.toFixed(4)}` : ''}${r.verdict ? ` [${r.verdict}]` : ''}`
  + `${r.delivered ? `  ↩ ${DELIVERY_LABEL[r.delivered]}` : ''}${r.reason ? `  · ${r.reason}` : ''}`;
/** How a target takes tasks (ADR 0010 §2), as people read it. */
export const ENGINE_LABEL: Record<Target['engine'], string> = { openai: 'model API', acp: 'ACP', module: 'its CLI', chat: 'its chat' };
/** Where a chain's result went (ADR 0010), as people read it. */
/** A setting's value as text (CLI, Settings panel): lists comma separated, switches on/off. */
export const settingText = (v: unknown) => (Array.isArray(v) ? v.join(',') : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v ?? ''));
export const DELIVERY_LABEL: Record<Delivery, string> = { inline: 'returned', resumed: 'resumed in its session', injected: 'sent to its chat', unread: 'waiting to be read', read: 'read' };
/** One event as a line (CLI `events`, the Activity panel). */
export const eventLine = (e: StoredEvent) => `${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.type}  ${e.source}  ${e.envId}${eventFacts(e.data)}`;
/** How an event reads at a glance (Activity and the live pane color it): done, failed, in progress, or just information. */
export type Tone = 'ok' | 'fail' | 'run' | 'info';
export function eventTone(e: Pick<StoredEvent, 'type' | 'data'>): Tone {
  const d = e.data;
  if (e.type === 'run.finished') return d.outcome === 'done' ? 'ok' : d.outcome === 'cancelled' ? 'info' : 'fail';
  if (e.type === 'tool.checked') return d.ok ? 'ok' : 'fail';
  if (e.type === 'consent.answered') return d.answer === 'granted' ? 'ok' : 'fail';
  if (e.type === 'consent.expired' || e.type === 'scan.integration_error' || (e.type === 'dispatcher.action' && d.what === 'stuck')) return 'fail';
  if (e.type === 'run.started' || e.type === 'run.event' || e.type === 'consent.requested' || e.type === 'trace.detail') return 'run';
  if (e.type === 'run.delivered') return d.how === 'unread' ? 'info' : 'ok';
  return 'info';
}
/** What an event does, as one of a few colors (the live pane and Activity): sending work, an answer or result, a decision
 *  (Agent Spaghetti's or yours), a failure, or a plain note. Tools get other colors (ui), never these. */
export type Act = 'send' | 'answer' | 'decide' | 'fail' | 'note';
/** One event as parts: plain text, a tool's id (colored per tool), an action (colored per Act). */
export type Part = string | { tool: string } | { act: Act; text: string };
const TRACE_MAX = 160;
const cut = (t: unknown) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > TRACE_MAX ? `${s.slice(0, TRACE_MAX)}…` : s; };
const who = (d: Record<string, unknown>) => ({ tool: `${d.target}${d.model ? `:${d.model}` : ''}` });
const AS = { tool: 'agent-spaghetti' };
/** One event in words, as parts (null: no sentence for it, use eventLine). Traces carry text cut short: the pane opens the full text. */
export function storyParts(e: StoredEvent): Part[] | null {
  const d = e.data, run = d.id ?? d.runId, R = run ? [`run ${run}: `] : [];
  const a = (act: Act, text: string) => ({ act, text });
  switch (e.type) {
    case 'run.started': return [...R, { tool: String(d.source) }, ' → ', { tool: String(d.target) },
      d.kind ? ` (${[d.kind, d.difficulty].filter(Boolean).join(' · ')}${d.classifiedBy === 'rules' ? `, ${Math.round(Number(d.confidence ?? 0) * 100)}% sure` : ''})` : '',
      d.parentRunId ? `, next step of run ${d.parentRunId}` : '', d.reason ? ` · ${d.reason}` : ''];
    case 'run.event': return [...R, ...(e.source === 'runner' ? [] : [{ tool: e.source }, ' ']), a('note', 'uses'), ` ${d.tool}${d.summary ? `: ${String(d.summary).slice(0, 80)}` : ''}`];
    case 'run.finished': return [...R, { tool: String(d.target) }, ' ', a(d.outcome === 'done' ? 'answer' : d.outcome === 'cancelled' ? 'note' : 'fail', String(d.outcome)),
      d.error && d.error !== d.outcome ? ` (${String(d.error).slice(0, 120)})` : ''];
    case 'run.delivered': return [...R, a(d.how === 'unread' ? 'note' : 'answer', `result ${DELIVERY_LABEL[d.how as Delivery] ?? d.how}`), ...(d.to ? [' (', { tool: String(d.to) }, ')'] : [])];
    case 'dispatcher.action': return d.what === 'routed' ? [AS, ' ', a('decide', 'picks'), ' ', { tool: String(d.to) }, ` for ${d.kind ? `${d.kind} · ${d.difficulty}` : d.asked} (${d.why})`]
      : d.what === 'escalated' ? [...R, { tool: String(d.from) }, ' ', a('fail', 'failed'), ', ', AS, ' ', a('decide', 'escalates to'), ' ', { tool: String(d.to) }, ` (${d.why})`]
      : d.what === 'handed-over' ? [...R, a('fail', 'no progress'), ' on ', { tool: String(d.from) }, ', ', a('decide', 'handed to'), ' ', { tool: String(d.to) }]
      : d.what === 'stuck' ? [...R, a('fail', 'no progress'), ' on ', { tool: String(d.target) }] : null;
    case 'consent.requested': return [{ tool: e.source }, ' ', a('decide', `asks to ${d.action}`), ' ', d.action === 'run' ? { tool: String(d.resource) } : String(d.resource),
      d.cost && d.cost !== 'free' ? ` (${d.cost === 'metered' ? 'paid' : d.cost})` : '', ': waiting for you'];
    case 'consent.answered': return [{ tool: e.source }, ': ', a(d.answer === 'granted' ? 'decide' : 'fail', String(d.answer)), d.scope ? ` (${d.scope})` : ''];
    case 'consent.expired': return [{ tool: e.source }, ': ', a('fail', 'question expired (denied)')];
    case 'trace.detail': {
      const stage = d.stage as TraceStage, text = cut(d.text);
      return stage === 'request' ? [...R, { tool: String(d.source) }, ' ', a('send', 'asks'), ' ', who(d), ': ', text]
        : stage === 'relay' ? [...R, { tool: String(d.source) }, ' ', a('send', 'hands on to'), ' ', who(d), ': ', text]
        : stage === 'output' ? [...R, who(d), ' ', a('answer', 'answers'), ': ', text]
        : stage === 'return' ? [...R, a('answer', 'result back to'), ' ', { tool: String(d.target) }, ` (${DELIVERY_LABEL[d.how as Delivery] ?? d.how}): `, text]
        : [...R, AS, ' ', a('decide', stage === 'route-prompt' ? 'asks its dispatcher model' : 'dispatcher model'), ': ', text];
    }
    default: return null;
  }
}
/** The parts as plain text. */
export const partsText = (p: Part[]) => p.map(x => (typeof x === 'string' ? x : 'tool' in x ? toolLabel(x.tool) : x.text)).join('');
/** A tool's id as shown in a line (Agent Spaghetti itself by name). */
export const toolLabel = (id: string) => (id === 'agent-spaghetti' ? 'Agent Spaghetti' : id);
/** One event as a sentence (CLI-style plain text): the time, then its parts, else eventLine. */
export function storyLine(e: StoredEvent): string {
  const p = storyParts(e);
  return p ? `${new Date(e.ts).toTimeString().slice(0, 8)}  ${partsText(p)}` : eventLine(e);
}
/** An event's short facts (plain values only, each cut short): what makes a line in Activity readable. */
const eventFacts = (d: Record<string, unknown>) => {
  const kv = Object.entries(d).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 6).map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return kv.length ? `  ${kv.join(' ')}` : '';
};

/** Tool blocks in the Tools panel and `agent-spaghetti integrations`: first role in this order wins (no manifest field needed). */
export const TOOL_GROUPS = [
  { id: 'agents', role: 'agent', label: 'Agents' }, { id: 'models', role: 'backend', label: 'Model servers' },
  { id: 'apps', role: 'client', label: 'Editors & apps' }, { id: 'tools', role: 'tool', label: 'Other tools' },
] as const satisfies ReadonlyArray<{ id: string; role: Role; label: string }>;
export type ToolGroup = (typeof TOOL_GROUPS)[number]['id'];
export type ToolState = 'ready' | 'running' | 'stopped' | 'installed' | 'not found' | 'skipped';
export interface ToolRow {
  id: string; name: string; color?: string; group: ToolGroup; source: 'builtin' | 'user'; levels: Level[]; envs: string[]; version?: string;
  state: ToolState; why: string;
  connection?: 'connected' | 'not connected';               // clients only
  preference?: 'always' | 'never' | 'ask';                  // clients only (ADR 0009)
  asks: number;                                             // questions about this tool waiting for the user
  setup?: true;                                             // has tool-side setup (Set up / Check)
  receives?: Target['engine'];                              // can take tasks now, through this engine
  gateway?: { model: string; key: boolean };                // takes a custom model endpoint: its model through the gateway, whether it has a key
}
export interface ToolInput {
  loaded: Array<{ id: string; name: string; color?: string; source: 'builtin' | 'user'; roles: Role[]; levels: Level[]; disabled: boolean; setup?: boolean; needsEnv?: string[]; gatewayClient?: boolean }>;   // needsEnv: a hosted API's key variables
  snapshot: Snapshot | null; live: LiveState; targets: Target[]; prefs: { auto: string[]; never: string[] }; consents: Array<{ subject: string }>;
  gateway?: { routes: string[]; keyed: string[] };
}
/** The one row model behind the Tools panel and the CLI (ADR 0009). */
export function toolRows(x: ToolInput): ToolRow[] {
  return x.loaded.map((i): ToolRow => {
    const dets = x.snapshot?.detections.filter(d => d.integration === i.id) ?? [];
    const live = Object.values(x.live.tools).filter(t => t.integration === i.id);
    const client = dets.filter(d => d.connected !== undefined), target = x.targets.find(t => t.id === i.id);
    const state: ToolState = i.disabled ? 'skipped' : !dets.length ? 'not found' : target ? 'ready'
      : live.some(t => t.running) ? 'running' : live.length || dets.every(d => d.connectable === 'needs-setup') ? 'stopped'
      : dets.some(d => d.endpoint || d.installs.some(n => n.via === 'process')) ? 'running' : 'installed';   // its server answered, or its process runs
    return {
      id: i.id, name: i.name, ...(i.color ? { color: i.color } : {}), group: TOOL_GROUPS.find(g => i.roles.includes(g.role))?.id ?? 'tools', source: i.source, levels: i.levels,
      envs: [...new Set(dets.map(d => d.envId))], version: dets.find(d => d.version)?.version, state,
      why: i.disabled ? 'skipped in scans' : dets.find(d => d.unready)?.unready ?? (client[0] ?? dets[0])?.why ?? (i.needsEnv ? `set ${i.needsEnv.join(', ')} where Agent Spaghetti runs, then rescan` : 'not found on this machine'),
      ...(client.length ? { connection: client.some(d => d.connected) ? 'connected' as const : 'not connected' as const,
        preference: x.prefs.auto.includes(i.id) ? 'always' as const : x.prefs.never.includes(i.id) ? 'never' as const : 'ask' as const } : {}),
      asks: x.consents.filter(c => c.subject === i.id).length, ...(i.setup ? { setup: true as const } : {}),
      ...(target ? { receives: target.engine } : {}),
      ...(i.gatewayClient ? { gateway: { model: x.gateway?.routes.find(r => r.startsWith(`${i.id}=`))?.slice(i.id.length + 1) ?? AUTO, key: !!x.gateway?.keyed.includes(i.id) } } : {}),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));   // alphabetical: no tool comes first by design (ADR 0010)
}
/** The CLI's view of the same rows: one block per group, found tools first. */
export function renderToolRows(rows: ToolRow[]): string {
  return TOOL_GROUPS.map(g => {
    const r = rows.filter(x => x.group === g.id).sort((a, b) => Number(a.state === 'not found') - Number(b.state === 'not found'));
    return r.length ? [`${g.label}:`, renderTable([['Id', 'Name', 'State', 'Connection', 'Envs', 'Why'],
      ...r.map(x => [x.id, x.name, x.state, x.connection ? `${x.connection}${x.preference !== 'ask' ? ` (${x.preference})` : ''}` : '-', x.envs.join(',') || '-', x.why])])].join('\n') : '';
  }).filter(Boolean).join('\n\n');
}
