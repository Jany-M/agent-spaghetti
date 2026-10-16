#!/usr/bin/env node
// `agent-spaghetti` CLI: thin. Every command is an op through HubClient, rendered by sdk/format. No logic of its own.
import { DaemonDown, HubClient, OPS, detectionRows, renderTable, renderTree, type StoredEvent } from '@agent-spaghetti/sdk';

export interface IO { out(s: string): void; err(s: string): void }
const DOWN = 'agent-spaghetti daemon is not running. Start it with: agent-spaghetti daemon';
export const usage = () => ['Usage: agent-spaghetti <command> [--json]', '',
  `  ${'daemon'.padEnd(20)}Start the daemon (foreground)`,
  ...Object.values(OPS).map(o => `  ${o.usage.padEnd(20)}${o.summary}`)].join('\n');
const time = (ts: number) => new Date(ts).toTimeString().slice(0, 8);
const eventLine = (e: StoredEvent) => `${time(e.ts)}  ${e.type}  ${e.source}  ${e.envId}`;

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
  if (!cmd || !(cmd in OPS)) { io.err(usage()); return 1; }
  try {
    const c = HubClient.fromDiscovery(env);
    if (cmd === 'status') {
      const { snapshot } = await c.call('status');
      print({ snapshot }, () => (snapshot ? renderTree(snapshot) : 'No scan yet. Run: agent-spaghetti scan'));
    } else if (cmd === 'scan') {
      const { snapshot } = await c.call('scan');
      print({ snapshot }, () => [renderTree(snapshot), '', renderTable(detectionRows(snapshot)),
        ...snapshot.rejected.map(r => `rejected ${r.id}: ${r.why}`)].join('\n'));
    } else if (cmd === 'events') {
      if (args.includes('--follow')) { for await (const e of c.stream()) io.out(json ? JSON.stringify(e) : eventLine(e)); }
      else { const ev = await c.call('events', {}); print(ev, () => ev.map(eventLine).join('\n')); }
    } else if (cmd === 'integrations') {
      const r = await c.call('integrations');
      print(r, () => [renderTable([['Id', 'Name', 'Source', 'Levels'], ...r.loaded.map(i => [i.id, i.name, i.source, i.levels.join(',')])]),
        ...r.rejected.map(x => `rejected ${x.id}: ${x.why}`)].join('\n'));
    }
    return 0;
  } catch (e) {
    if (e instanceof DaemonDown) { io.err(DOWN); return 2; }
    io.err((e as Error).message); return 1;
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2), { out: s => console.log(s), err: s => console.error(s) });
