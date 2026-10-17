#!/usr/bin/env node
// `agent-spaghetti` CLI: thin. Every command is an op through HubClient, rendered by sdk/format. No logic of its own.
import { writeFileSync } from 'node:fs';
import { DaemonDown, HubClient, OPS, SCOPE_LABEL, detectionRows, describeRun, eventLine, permissionRows, runLine, renderStats, renderTable, renderToolRows, renderTree, serveMcpStdio, switchRows, testLines,
  type Action, type ConsentRequest, type ConsentScope, type OpId, type TaskKind } from '@agent-spaghetti/sdk';
import { planHook } from './hook.ts';

export interface IO { out(s: string): void; err(s: string): void }
const DOWN = 'agent-spaghetti daemon is not running. Start it with: agent-spaghetti daemon';
export const usage = () => ['Usage: agent-spaghetti <command> [--json]', '',
  `  ${'help'.padEnd(44)}This list`,
  `  ${'daemon'.padEnd(44)}Start the daemon (foreground)`,
  `  ${'mcp --as <client>'.padEnd(44)}MCP server for a client (stdio; started by the client)`,
  ...Object.values(OPS).map(o => `  ${o.usage.padEnd(44)}${o.summary}`)].join('\n');
/** CLI verbs that are not op names (from the usage strings in OPS). */
const VERB: Record<string, OpId> = { on: 'switch', off: 'switch', allow: 'grant', deny: 'grant', set: 'setting', answer: 'consent', disconnect: 'connect' };
const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s; };
const consentLine = (c: ConsentRequest) => `? ${c.id}  ${c.labels?.title ?? `${c.subject} wants ${c.action} ${c.resource}`} (${c.why}) → answer ${c.id} allow|deny${c.scopes.length > 1 ? ` [${c.scopes.join('|')}]` : ''}`;
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
  if (cmd === 'help' || cmd === '--help') { io.out(usage()); return 0; }
  if (cmd === 'mcp') {          // stdio MCP server for a client; parent run id comes from a delegated agent's environment
    const as = flag([...args], '--as') ?? 'mcp';
    await serveMcpStdio(HubClient.fromDiscovery(env), { source: as, parentRunId: Number(env.AGENT_SPAGHETTI_PARENT_RUN) || undefined });
    return 0;
  }
  const op = cmd && (VERB[cmd] ?? (cmd in OPS ? cmd as OpId : undefined));
  if (!op) { io.err(usage()); return 1; }
  if (op === 'hook') {          // client hooks: always answer the client, even when the daemon is down
    const plan = planHook(JSON.parse((await readStdin()) || '{}'));
    const c = (() => { try { return HubClient.fromDiscovery(env); } catch { return null; } })();
    if ('delegate' in plan) {
      const r = await c?.call('delegate', { ...plan.delegate, source: args[1] ?? 'client', waitMs: 0 }).catch((e: Error) => e);
      io.out(JSON.stringify({ ...plan.reply, user_message: !r ? 'agent-spaghetti is not running: start it, then send again.'
        : r instanceof Error ? `agent-spaghetti: ${r.message}` : `Sent to ${plan.delegate.target} (run ${r.id}). The result will be in ${plan.delegate.resultDir ?? 'the agent-spaghetti results folder'}/${r.id}.md` }));
    } else {
      if (plan.report) await c?.call('hook', { client: args[1] ?? 'client', ...plan.report }).catch(() => {});
      io.out(JSON.stringify(plan.reply));
    }
    return 0;
  }
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
        print(r, () => [renderToolRows(r.rows), ...r.rejected.map(x => `rejected ${x.id}: ${x.why}`)].join('\n'));
        break;
      }
      case 'switches': {
        const r = await c.call('switches');
        print(r, () => [r.switches.length ? renderTable(switchRows(r.switches)) : 'No switches found.', ...r.errors.map(e => `${e.envId}: ${e.error}`)].join('\n'));
        break;
      }
      case 'switch': { const r = await c.call('switch', { id: a1, on: cmd === 'on', envId }); print(r, () => `${r.id} (${r.envId}) is ${r.on ? 'on' : 'off'}`); break; }
      case 'test': case 'setup': {
        const r = op === 'test' ? await c.call('test', { integration: a1, envId }) : await c.call('setup', { integration: a1, envId, check: args.includes('--check'), dryRun: args.includes('--dry-run') });
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
      case 'delegate': {
        const kind = flag(args, '--kind') as TaskKind | undefined, reason = flag(args, '--reason'), model = flag(args, '--model'), then = flag(args, '--then');
        const [, target, ...task] = args;
        if (!target || !task.length) { io.err(`usage: agent-spaghetti ${OPS.delegate.usage}`); return 1; }
        let v = await c.call('delegate', { target, task: task.join(' '), kind, reason, model, then: then?.split(',').filter(Boolean), source: 'cli', waitMs: 0 });
        while (v.run.outcome === 'running') { await new Promise(r => setTimeout(r, 1000)); v = (await c.call('runs', { id: v.id, watch: true })).final!; }
        const d = describeRun(v);
        print(v, () => d.content[0].text);
        return 'isError' in d ? 1 : 0;
      }
      case 'targets': { const r = await c.call('targets'); print(r, () => r.length ? renderTable([['Target', 'Name', 'Kind', 'Cost', 'Models / agents'], ...r.map(t => [t.id, t.name, t.kind, t.cost, t.models.join(', ') || '-'])]) : 'Nothing to delegate to yet (scan first; start a local model server or install an agent).'); break; }
      case 'runs': {
        const r = await c.call('runs', a1 ? { id: Number(a1) } : {});
        print(r, () => [...r.runs.map(runLine), ...(r.result ? ['', r.result] : [])].join('\n') || 'No runs yet.');
        break;
      }
      case 'handback': {
        const as = flag(args, '--as'), [, id, ...result] = args, failed = args.includes('--failed');
        if (!as || !id) { io.err(`usage: agent-spaghetti ${OPS.handback.usage}`); return 1; }
        const r = await c.call('handback', { run_id: Number(id), result: result.filter(x => x !== '--failed').join(' '), status: failed ? 'failed' : 'done', source: as });
        print(r, () => `run ${id}: result sent`); break;
      }
      case 'cancel': { const r = await c.call('cancel', { id: Number(a1) }); print(r, () => (r.cancelled ? `run ${a1} cancelled` : `run ${a1} is not running`)); break; }
      case 'verdict': { const r = await c.call('verdict', { id: Number(a1), value: a2 as 'up' }); print(r, () => `run ${a1}: ${a2}`); break; }
      case 'connect': {
        const r = await c.call('connect', { integration: a1, on: cmd !== 'disconnect', dryRun: args.includes('--dry-run') });
        print(r, () => [`${r.applied ? 'Done' : 'Would'}: ${r.description} (${r.envId})`, ...r.changes.map(x => `  ${x}`)].join('\n'));
        break;
      }
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
