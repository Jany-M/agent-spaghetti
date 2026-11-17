// Live state = a pure reduction of events (daemon `status`, tray, app all use this one reducer).
import type { StoredEvent } from './types.ts';

export interface LiveSession { key: string; envId: string; agentId?: string; kind?: string; status?: string; model?: string; modelProvider?: string; updatedAt?: number }
export interface LiveBackend { integration: string; envId: string; up: boolean; endpoint?: string; models: Array<{ model: string; contextLength: number | null }>; ts: number }
/** A tool seen running (a matching process, or its server answering) by the live observer of one environment. */
export interface LiveTool { integration: string; envId: string; running: boolean; endpoint?: string; ts: number }
export interface LiveRun { id: number; source: string; target: string; ts: number; kind?: string; next?: string }   // next: the chain's next hop, if any
/** A chain's result on its way back: who did the last step, who asked, and how it was delivered (`unread`: still waiting for the caller). */
export interface LiveResult { id: number; from: string; to: string; how: string; ts: number }
export interface LiveState {
  sessions: Record<string, LiveSession>; backends: Record<string, LiveBackend>; tools: Record<string, LiveTool>; switches: Record<string, { on: boolean; ts: number }>;
  runs: Record<string, LiveRun>; results: Record<string, LiveResult>; queues: Record<string, { waiting: number; running: number }>; lastEventId: number;
}
export const emptyLive = (): LiveState => ({ sessions: {}, backends: {}, tools: {}, switches: {}, runs: {}, results: {}, queues: {}, lastEventId: 0 });
const RESULTS = 20;                                         // results kept: the unread ones and the latest delivered

/** Keeps the results still waiting for their caller and the latest others. */
function prune(s: LiveState) { for (const x of Object.values(s.results).filter(x => x.how !== 'unread').sort((a, b) => b.ts - a.ts).slice(RESULTS)) delete s.results[x.id]; }
export function liveState(events: Iterable<StoredEvent>, from: LiveState = emptyLive()): LiveState {
  const s: LiveState = { sessions: { ...from.sessions }, backends: { ...from.backends }, tools: { ...from.tools }, switches: { ...from.switches }, runs: { ...from.runs }, results: { ...from.results }, queues: { ...from.queues }, lastEventId: from.lastEventId };
  for (const e of events) {
    if (e.id <= s.lastEventId) continue;
    s.lastEventId = e.id;
    const d = e.data as Record<string, any>;
    if (e.type === 'session.started' || e.type === 'session.updated') s.sessions[`${e.envId}|${d.key}`] = { ...d, envId: e.envId } as LiveSession;
    else if (e.type === 'session.ended') delete s.sessions[`${e.envId}|${d.key}`];
    else if (e.type === 'backend.changed') s.backends[`${e.envId}|${d.integration}`] = { integration: d.integration, envId: e.envId, up: !!d.up, endpoint: d.endpoint, models: d.models ?? [], ts: e.ts };
    else if (e.type === 'tool.changed') s.tools[`${e.envId}|${d.integration}`] = { integration: d.integration, envId: e.envId, running: !!d.running, endpoint: d.endpoint, ts: e.ts };
    else if (e.type === 'scan.completed') { s.sessions = {}; s.backends = {}; s.tools = {}; }   // the scan restarts the observers: they report again what runs now
    else if (e.type === 'switch.changed') s.switches[d.id] = { on: !!d.on, ts: e.ts };
    else if (e.type === 'run.started') s.runs[d.id] = { id: d.id, source: d.source, target: d.target, ts: e.ts, ...(d.kind ? { kind: d.kind } : {}), ...(d.next ? { next: d.next } : {}) };
    else if (e.type === 'run.finished') { const r = s.runs[d.id]; delete s.runs[d.id];
      if (r && d.chainId !== undefined) { s.results[d.chainId] = { id: d.chainId, from: r.target, to: s.results[d.chainId]?.to ?? r.source, how: 'pending', ts: e.ts }; prune(s); } }   // the chain's last worker so far
    else if (e.type === 'run.delivered' && s.results[d.id]) { s.results[d.id] = { ...s.results[d.id], to: d.to ?? s.results[d.id].to, how: d.how, ts: e.ts }; prune(s); }
    else if (e.type === 'backend.queue') s.queues[e.source] = { waiting: d.waiting, running: d.running };
    else if (e.type === 'env.status' && d.state === 'stopped') for (const k of Object.keys(s.sessions)) if (k.startsWith(`${e.envId}|`)) delete s.sessions[k];
  }
  return s;
}
