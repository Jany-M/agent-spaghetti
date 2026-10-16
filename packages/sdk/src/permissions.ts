// The one permission model (ADR 0005). Pure: used by the daemon, the env bundle and (later) the app.
import type { Cost, Manifest } from './types.ts';
import { wildcard } from './match.ts';

/** The one list of actions. 1b uses exec/read/net; write/run/config/load arrive with their phases. */
export const ACTIONS = ['exec', 'read', 'net', 'write', 'run', 'config', 'load'] as const;
export type Action = (typeof ACTIONS)[number];
/** How the UI words each action ("<subject> wants to …"). */
export const ACTION_LABEL: Record<Action, string> = { exec: 'run a program', read: 'read', net: 'contact a local server', write: 'change a file',
  run: 'hand a task to', config: 'change a setting', load: 'load its own code' };
export type Mode = 'allow' | 'deny';
export interface Grant {
  subject: string; action: Action; resource: string; mode: Mode; by: 'user' | 'default'; ts: number;
  jobId?: string; budgetUsd?: number;            // run grants only: valid for one job / until this much was spent
}
/** An action a third-party integration tried without a grant (recorded by the guard, asked by the daemon). */
export interface Pending { subject: string; action: Action; resource: string }
export interface DeclaredAction { action: Action; resource: string; why: string }

/** Where `connect` installs the agent-spaghetti plugin inside a client's plugin folder. */
export const pluginDir = (clientDir: string) => `${clientDir.replace(/[\\/]$/, '')}/agent-spaghetti`;
/** What a manifest WOULD make the hub do, in the exact resource format the guard checks (what · where · how · why). */
export function declaredActions(m: Manifest): DeclaredAction[] {
  const d = m.detect ?? {}, out: DeclaredAction[] = [];
  for (const b of d.bin ?? []) out.push({ action: 'read', resource: `PATH:${b}`, why: `look for the "${b}" program on PATH` });
  const paths = Array.isArray(d.paths) ? d.paths : Object.values(d.paths ?? {}).flat() as string[];
  for (const p of paths) out.push({ action: 'read', resource: p, why: 'check a default install location' });
  if (d.version && 'file' in d.version) out.push({ action: 'read', resource: d.version.file, why: 'read the version file' });
  if (d.version && 'args' in d.version)
    for (const b of d.bin ?? []) out.push({ action: 'exec', resource: `${b} ${d.version.args.join(' ')}`.trim(), why: 'ask the program for its version' });
  for (const n of d.env ?? []) out.push({ action: 'read', resource: `env:${n}`, why: 'read an endpoint override variable' });
  if (d.http) out.push({ action: 'net', resource: `GET ${d.http.path}`, why: 'probe the local server (localhost / WSL host only)' });
  if (m.models?.path) out.push({ action: 'net', resource: `GET ${m.models.path}`, why: 'list loaded models' });
  if (m.speaks?.mcpClient) out.push({ action: 'read', resource: m.speaks.mcpClient.config, why: 'check whether agent-spaghetti is connected' });
  if (m.speaks?.agentPlugins) out.push({ action: 'read', resource: `${pluginDir(m.speaks.agentPlugins.dir)}/mcp.json`, why: 'check whether the agent-spaghetti plugin is installed' });
  return out;
}
/** First matching grant wins; resources may use '*'. No grant → 'ask'. */
export function check(grants: Grant[], subject: string, action: Action, resource: string): 'allow' | 'deny' | 'ask' {
  const g = grants.find(g => g.subject === subject && g.action === action && wildcard(g.resource, resource));
  return g ? g.mode : 'ask';
}
const same = (g: Pick<Grant, 'subject' | 'action' | 'resource'>, x: Pick<Grant, 'subject' | 'action' | 'resource'>) =>
  g.subject === x.subject && g.action === x.action && g.resource === x.resource;
/** Set (replace) grants; returns a new list. */
export const withGrants = (grants: Grant[], add: Grant[]) => [...grants.filter(g => !add.some(a => same(a, g))), ...add];
/** Remove a subject's grants, or only one action+resource. */
export const withoutGrants = (grants: Grant[], subject: string, action?: Action, resource?: string) =>
  grants.filter(g => !(g.subject === subject && (action === undefined || g.action === action) && (resource === undefined || g.resource === resource)));

/** A question for the user (ADR 0005): third-party actions now, `run` requests from Phase 3. Answered in the tray or CLI. */
export type ConsentScope = 'once' | 'job' | 'always';
export interface ConsentRequest {
  id: string; ts: number; subject: string; action: Action; resource: string; why: string;
  scopes: ConsentScope[];                                   // what "allow" may mean here; deny is always offered
  cost?: Cost; task?: string; billing?: string; expiresAt?: number;   // run requests (task text is never stored)
  labels?: Partial<Record<ConsentScope | 'deny' | 'title', string>>;   // card words when the generic ones do not fit (connect preference)
}
export interface ConsentAnswer { answer: 'granted' | 'denied' | 'expired'; scope?: ConsentScope }
export const SCOPE_LABEL: Record<ConsentScope, string> = { once: 'Allow once', job: 'Allow for this job', always: 'Always allow' };

/** Delegation (ADR 0005 `run`): grants first (a job-bound grant only for its job, a budget only until spent),
 *  then the default: free targets run, anything that may cost money asks. */
export function runDecision(grants: Grant[], source: string, target: string, cost: Cost, o: { jobId?: string; spentUsd(g: Grant): number }):
  { mode: 'allow' | 'deny' | 'ask'; grant: Grant | null; why: string } {
  const g = grants.find(g => g.subject === source && g.action === 'run' && wildcard(g.resource, target) && (g.jobId === undefined || g.jobId === o.jobId));
  if (g?.mode === 'deny') return { mode: 'deny', grant: g, why: 'denied by your permissions' };
  if (g && g.budgetUsd !== undefined) {
    const spent = o.spentUsd(g);
    return spent < g.budgetUsd ? { mode: 'allow', grant: g, why: `budget: $${spent.toFixed(2)} of $${g.budgetUsd.toFixed(2)} used` }
      : { mode: 'ask', grant: g, why: `budget used: $${spent.toFixed(2)} of $${g.budgetUsd.toFixed(2)}` };
  }
  if (g) return { mode: 'allow', grant: g, why: g.jobId ? `allowed for job ${g.jobId}` : 'always allowed' };
  return cost === 'free' ? { mode: 'allow', grant: null, why: 'free target' } : { mode: 'ask', grant: null, why: 'may cost money' };
}
