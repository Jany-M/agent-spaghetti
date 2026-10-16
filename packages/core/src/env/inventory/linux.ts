// Linux / WSL inventory read straight from /proc and XDG application entries (no commands, no locale issues).
import { readdir, readFile, readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Inventory } from '@agent-spaghetti/sdk';
import type { Collector } from './index.ts';

/** /proc/net/tcp{,6} line → listening socket (state 0A). Address is little-endian hex. */
export function parseProcNetTcp(text: string, v6: boolean): Array<{ address: string; port: number; inode: string }> {
  const out: Array<{ address: string; port: number; inode: string }> = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const [hex, port] = f[1].split(':');
    const address = v6 ? (/^0+$/.test(hex) ? '::' : hex === '00000000000000000000000001000000' ? '::1' : hex)
      : [6, 4, 2, 0].map(i => parseInt(hex.slice(i, i + 2), 16)).join('.');
    out.push({ address, port: parseInt(port, 16), inode: f[9] });
  }
  return out;
}
/** [Desktop Entry] Name= and the directory of an absolute Exec= binary. */
export function parseDesktopEntry(text: string): { name?: string; location?: string } {
  const sect = text.split(/^\[/m).find(s => s.startsWith('Desktop Entry]')) ?? '';
  const name = /^Name=(.+)$/m.exec(sect)?.[1]?.trim();
  const exec = /^Exec=("?)(\/[^"\s]+)\1/m.exec(sect)?.[2];
  return { name, location: exec ? dirname(exec) : undefined };
}

export const linuxCollector: Collector = async (_env, envNames) => {
  const inv: Inventory = { installed: [], processes: [], listening: [], env: {}, partial: [] };
  const inodeToPid = new Map<string, number>();
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter(n => /^\d+$/.test(n));
  if (!pids.length) inv.partial.push('processes');
  for (const p of pids) {
    const name = (await readFile(`/proc/${p}/comm`, 'utf8').catch(() => '')).trim();
    if (!name) continue;
    inv.processes.push({ name, pid: Number(p), path: (await readlink(`/proc/${p}/exe`).catch(() => undefined)) });
    for (const fd of await readdir(`/proc/${p}/fd`).catch(() => [] as string[])) {
      const m = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${p}/fd/${fd}`).catch(() => ''));
      if (m) inodeToPid.set(m[1], Number(p));
    }
  }
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]] as const) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) { if (!v6) inv.partial.push(file); continue; }   // no tcp6 = IPv6 off, not a gap
    for (const s of parseProcNetTcp(text, v6)) inv.listening.push({ address: s.address, port: s.port, pid: inodeToPid.get(s.inode) });
  }
  const dataDirs = [process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), ...(process.env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':')];
  for (const d of dataDirs) {
    const dir = join(d, 'applications');
    for (const f of (await readdir(dir).catch(() => [] as string[])).filter(f => f.endsWith('.desktop'))) {
      const e = parseDesktopEntry(await readFile(join(dir, f), 'utf8').catch(() => ''));
      if (e.name) inv.installed.push({ name: e.name, location: e.location, source: 'desktop' });
    }
  }
  for (const n of envNames) if (process.env[n]) inv.env[n] = process.env[n]!;
  return inv;
};
