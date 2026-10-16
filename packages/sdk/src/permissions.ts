// The one permission model (ADR 0005). Pure: used by the daemon, the env bundle and (later) the app.
import type { Manifest, Platform } from './types.ts';
import { wildcard } from './match.ts';

/** The one list of actions. 1b uses exec/read/net; write/run/config/load arrive with their phases. */
export const ACTIONS = ['exec', 'read', 'net', 'write', 'run', 'config', 'load'] as const;
export type Action = (typeof ACTIONS)[number];
export type Mode = 'allow' | 'deny';
export interface Grant { subject: string; action: Action; resource: string; mode: Mode; by: 'user' | 'default'; ts: number }
export interface DeclaredAction { action: Action; resource: string; why: string }

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
  return out;
}
/** First matching grant wins; resources may use '*'. No grant → 'ask'. */
export function check(grants: Grant[], subject: string, action: Action, resource: string): 'allow' | 'deny' | 'ask' {
  const g = grants.find(g => g.subject === subject && g.action === action && wildcard(g.resource, resource));
  return g ? g.mode : 'ask';
}
export const platformsOf = (m: Manifest): Platform[] => m.platforms ?? ['windows', 'linux', 'macos'];
const same = (g: Pick<Grant, 'subject' | 'action' | 'resource'>, x: Pick<Grant, 'subject' | 'action' | 'resource'>) =>
  g.subject === x.subject && g.action === x.action && g.resource === x.resource;
/** Set (replace) grants; returns a new list. */
export const withGrants = (grants: Grant[], add: Grant[]) => [...grants.filter(g => !add.some(a => same(a, g))), ...add];
/** Remove a subject's grants, or only one action+resource. */
export const withoutGrants = (grants: Grant[], subject: string, action?: Action, resource?: string) =>
  grants.filter(g => !(g.subject === subject && (action === undefined || g.action === action) && (resource === undefined || g.resource === resource)));
