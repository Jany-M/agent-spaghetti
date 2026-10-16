// The one enforcement point for third-party integrations (ADR 0005): every primitive goes through check().
// Built-ins are trusted and run unguarded. A missing grant is 'ask': the call is refused and reported as pending;
// the daemon then asks the user (core/consent.ts). The same code runs in the daemon and inside WSL (env bundle).
import { basename } from 'node:path';
import type { Action, Ctx, Environment, Grant, Integration, Inventory, Pending } from '@agent-spaghetti/sdk';
import { check } from '@agent-spaghetti/sdk';

const execResource = (cmd: string, args: string[]) => `${basename(cmd).replace(/\.(exe|cmd|bat)$/i, '')} ${args.join(' ')}`.trim();
const netResource = (url: string, method = 'GET') => `${method} ${new URL(url).pathname}`;
async function* refused(action: Action, resource: string): AsyncIterable<string> { throw new Error(`not permitted: ${action} ${resource}`); }
export function guardEnvironment(env: Environment, subject: string, grants: Grant[], pending: Pending[]): Environment {
  const resolved = new Set<string>();                         // paths a granted glob returned may then be read
  const allowed = (action: Action, resource: string) => {
    const r = check(grants, subject, action, resource);
    if (r === 'ask' && !pending.some(p => p.subject === subject && p.action === action && p.resource === resource)) pending.push({ subject, action, resource });
    return r === 'allow';
  };
  return {
    ...env,
    exec: async (cmd, args, o) => allowed('exec', execResource(cmd, args)) ? env.exec(cmd, args, o) : { code: 126, stdout: '', stderr: 'not permitted' },
    execLines: (cmd, args, o) => (allowed('exec', execResource(cmd, args)) ? env.execLines(cmd, args, o) : refused('exec', execResource(cmd, args))),
    httpLines: req => (allowed('net', netResource(req.url, req.method)) ? env.httpLines(req) : refused('net', netResource(req.url, req.method))),
    http: async req => (allowed('net', netResource(req.url, req.method)) ? env.http(req) : null),
    which: async b => (allowed('read', `PATH:${b}`) ? env.which(b) : null),
    glob: async p => {
      if (!allowed('read', p)) return null;
      const r = await env.glob(p); if (r) resolved.add(r); return r;
    },
    readFile: async p => (resolved.has(p) || allowed('read', p) ? env.readFile(p) : null),
    writeFile: async (p, c) => { if (!allowed('write', p)) throw new Error(`not permitted: write ${p}`); return env.writeFile(p, c); },
    remove: async p => { if (!allowed('write', p)) throw new Error(`not permitted: write ${p}`); return env.remove(p); },
  };
}
/** Env values reach a third-party integration only when granted. */
export function guardCtx(ctx: Ctx, subject: string, declared: string[], grants: Grant[], pending: Pending[]): Ctx {
  const env: Inventory['env'] = {};
  for (const [k, v] of Object.entries(ctx.inventory.env).filter(([k]) => declared.includes(k))) {
    const r = check(grants, subject, 'read', `env:${k}`);
    if (r === 'allow') env[k] = v;
    else if (r === 'ask' && !pending.some(p => p.subject === subject && p.resource === `env:${k}`)) pending.push({ subject, action: 'read', resource: `env:${k}` });
  }
  return { ...ctx, inventory: { ...ctx.inventory, env } };
}
/** The env + ctx an integration may use: built-ins as is, third parties guarded. The one place that decides. */
export function asSubject(i: Integration, env: Environment, ctx: Ctx, grants: Grant[] = [], pending: Pending[] = []): { env: Environment; ctx: Ctx } {
  if (i.source === 'builtin') return { env, ctx };
  const id = i.manifest.id;
  return { env: guardEnvironment(env, id, grants, pending), ctx: guardCtx(ctx, id, i.manifest.detect?.env ?? [], grants, pending) };
}
