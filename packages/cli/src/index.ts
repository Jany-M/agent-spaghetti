#!/usr/bin/env node
// `agent-spaghetti` CLI: thin. Every command is an op through HubClient, rendered by sdk/format. No logic of its own.
import { writeFileSync } from 'node:fs';
import { DaemonDown, HubClient, OPS, SCOPE_LABEL, detectionRows, permissionRows, renderStats, renderTable, renderTree, switchRows, testLines,
  type Action, type ConsentRequest, type ConsentScope, type OpId, type StoredEvent } from '@agent-spaghetti/sdk';

export interface IO { out(s: string): void; err(s: string): void }
const DOWN = 'agent-spaghetti daemon is not running. Start it with: agent-spaghetti daemon';
export const usage = () => ['Usage: agent-spaghetti <command> [--json]', '',
  `  ${'daemon'.padEnd(44)}Start the daemon (foreground)`,
  ...Object.values(OPS).map(o => `  ${o.usage.padEnd(44)}${o.summary}`)].join('\n');
const time = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
const eventLine = (e: StoredEvent) => `${time(e.ts)}  ${e.type}  ${e.source}  ${e.envId}`;
/** CLI verbs that are not op names (from the usage strings in OPS). */
const VERB: Record<string, OpId> = { on: 'switch', off: 'switch', allow: 'grant', deny: 'grant', set: 'setting', answer: 'consent' };
const consentLine = (c: ConsentRequest) => `? ${c.id}  ${c.subject} wants ${c.action} ${c.resource} (${c.why}) → answer ${c.id} allow|deny${c.scopes.length > 1 ? ` [${c.scopes.join('|')}]` : ''}`;
/** Reads "--name value" and removes it from args. */
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };

export async function run(argv: string[], io: IO, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const json = argv.includes('--json'), args = argv.filter(a => a !== '--json'), [cmd] = args;
  const print = (data: unknown, text: () => string) => io.out(json ? JSON.stringify(data, null, 2) : text());
  if (cmd === 'daemon') {
    const { runDaemon } = await import('@agent-spaghetti/core');
    const d = await runDaemon(env);
    io.out(`agent-spaghetti daemon listening on 127.0.0.1:${d.port} (data: ${d.dir})`);
    await new Promise<void>(r => { process.once('SIGINT', r); process.once('SIGTERM', r); });
    await d.close();
    return 0;
  }
  const op = cmd && (VERB[cmd] ?? (cmd in OPS ? cmd as OpId : undefined));
  if (!op) { io.err(usage()); return 1; }
  const envId = flag(args, '--env'), outFile = flag(args, '--out');
  const [, a1, a2, a3] = args;
  try {
    const c = HubClient.fromDiscovery(env);
    switch (op) {
      case 'status': {
        const r = await c.call('status');
        print(r, () => args.includes('--short') ? renderStats(true, r.snapshot, r.live, r.consents).join('\n')
          : [r.snapshot ? renderTree(r.snapshot, r.live) : 'No scan yet. Run: agent-spaghetti scan', ...r.consents.map(consentLine)].join('\n'));
        break;
      }
      case 'scan': {
        const { snapshot } = await c.call('scan');
        print({ snapshot }, () => [renderTree(snapshot), '', renderTable(detectionRows(snapshot)),
          ...snapshot.rejected.map(r => `rejected ${r.id}: ${r.why}`),
          ...(snapshot.pending?.length ? [`${snapshot.pending.length} permission request(s) pending: agent-spaghetti permissions`] : [])].join('\n'));
        break;
      }
      case 'events':
        if (args.includes('--follow')) { for await (const e of c.stream()) io.out(json ? JSON.stringify(e) : eventLine(e)); }
        else { const ev = await c.call('events', {}); print(ev, () => ev.map(eventLine).join('\n')); }
        break;
      case 'integrations': {
        const r = await c.call('integrations');
        print(r, () => [renderTable([['Id', 'Name', 'Source', 'Levels', 'State'], ...r.loaded.map(i => [i.id, i.name, i.source, i.levels.join(','), i.disabled ? 'disabled' : 'on'])]),
          ...r.rejected.map(x => `rejected ${x.id}: ${x.why}`)].join('\n'));
        break;
      }
      case 'switches': {
        const r = await c.call('switches');
        print(r, () => [r.switches.length ? renderTable(switchRows(r.switches)) : 'No switches found.', ...r.errors.map(e => `${e.envId}: ${e.error}`)].join('\n'));
        break;
      }
      case 'switch': { const r = await c.call('switch', { id: a1, on: cmd === 'on', envId }); print(r, () => `${r.id} (${r.envId}) is ${r.on ? 'on' : 'off'}`); break; }
      case 'test': {
        const r = await c.call('test', { integration: a1, envId });
        print(r, () => r.map(x => [`${a1} in ${x.envId}`, ...(x.result ? testLines(x.result) : [`FAIL  ${x.error}`])].join('\n')).join('\n\n'));
        return r.every(x => x.result?.ok) ? 0 : 1;
      }
      case 'permissions': {
        const r = await c.call('permissions');
        print(r, () => r.subjects.length ? r.subjects.map(s => [`${s.subject}:`, renderTable(permissionRows(s.subject, s.declared, r.grants, r.pending.filter(p => p.subject === s.subject)))].join('\n')).join('\n\n')
          : 'No third-party integrations installed.');
        break;
      }
      case 'grant': case 'revoke': {
        const input = { subject: a1, ...(a2 ? { action: a2 as Action, resource: a3 } : {}) };
        const r = op === 'grant' ? await c.call('grant', { ...input, mode: cmd === 'deny' ? 'deny' : 'allow' }) : await c.call('revoke', input);
        print(r, () => `${a1}: ${r.grants.length} grant(s)${r.grants.length ? '\n' + renderTable([['Action', 'Resource', 'Mode'], ...r.grants.map(g => [g.action, g.resource, g.mode])]) : ''}`);
        break;
      }
      case 'settings': case 'setting': {
        const r = op === 'setting' ? await c.call('setting', { key: a1, value: a2 ?? '' }) : await c.call('settings');
        print(r, () => renderTable([['Key', 'Value', 'Help'], ...Object.entries(r).map(([k, v]) => [k, Array.isArray(v.value) ? v.value.join(',') || '-' : String(v.value), v.help])]));
        break;
      }
      case 'disable': case 'enable': { const r = await c.call(op, { id: a1 }); print(r, () => `disabled: ${r.disabled.join(', ') || 'none'}`); break; }
      case 'consent': {
        const scope = a3 as ConsentScope | undefined;
        if (a2 !== 'allow' && a2 !== 'deny') { io.err(`usage: agent-spaghetti ${OPS.consent.usage}`); return 1; }
        if (scope && !(scope in SCOPE_LABEL)) { io.err(`scope must be one of ${Object.keys(SCOPE_LABEL).join(', ')}`); return 1; }
        const r = await c.call('consent', { id: a1, allow: a2 === 'allow', scope }); print(r, () => `answered: ${a2}${scope ? ` (${scope})` : ''}`); break;
      }
      case 'shutdown': { const r = await c.call('shutdown'); print(r, () => 'agent-spaghetti daemon is stopping'); break; }
      case 'report': {
        const r = await c.call('report');
        if (outFile) { writeFileSync(outFile, r.markdown); io.out(`report written to ${outFile} (review it before sharing)`); } else print(r, () => r.markdown);
        break;
      }
    }
    return 0;
  } catch (e) {
    if (e instanceof DaemonDown) { io.err(DOWN); return 2; }
    io.err((e as Error).message); return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), { out: s => console.log(s), err: s => console.error(s) });
