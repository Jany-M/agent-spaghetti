// The tray's decisions as pure functions (unit-tested); main.ts only wires them to Electron.
import type { HubClient, TrayState } from '@agent-spaghetti/sdk';

export interface MenuItem { id?: string; label?: string; type?: 'separator' | 'checkbox'; checked?: boolean; enabled?: boolean }
export function trayMenu(up: boolean, autostart: boolean): MenuItem[] {
  return [
    { id: 'open', label: 'Show status' },
    up ? { id: 'scan', label: 'Rescan' } : { id: 'start', label: 'Start daemon' },
    { type: 'separator' },
    { id: 'autostart', label: 'Start tray at login', type: 'checkbox', checked: autostart },
    { type: 'separator' },
    { id: 'quit', label: 'Quit tray' },
    { id: 'quit-all', label: 'Quit tray and stop daemon', enabled: up },
  ];
}
/** Windows caps tray tooltips at 127 characters. */
export const tooltip = (lines: string[]) => { const t = lines.join('\n'); return t.length <= 127 ? t : `${t.slice(0, 126)}…`; };
export const ICON: Record<TrayState, string> = { idle: 'tray-idle.png', working: 'tray-working.png', approval: 'tray-approval.png', problem: 'tray-problem.png' };

interface Rect { x: number; y: number; width: number; height: number }
/** Popover next to the tray icon, inside the work area (taskbar at any edge). */
export function placeNear(tray: Rect, work: Rect, size: { width: number; height: number }) {
  const cx = tray.x + tray.width / 2, cy = tray.y + tray.height / 2;
  let x = Math.round(cx - size.width / 2), y = cy > work.y + work.height / 2 ? tray.y - size.height - 6 : tray.y + tray.height + 6;
  if (cx > work.x + work.width || cx < work.x) x = cx > work.x ? work.x + work.width - size.width - 6 : work.x + 6;   // taskbar on the side
  x = Math.min(Math.max(x, work.x + 6), work.x + work.width - size.width - 6);
  y = Math.min(Math.max(y, work.y + 6), work.y + work.height - size.height - 6);
  return { x, y, ...size };
}
/** Ids of questions the user has not been notified about yet. */
export const newQuestions = (seen: Set<string>, ids: string[]) => ids.filter(id => !seen.has(id));

/** Reuse a running daemon, else start one and wait for it. */
export async function ensureDaemon(d: { connect(): Promise<HubClient>; start(): void; timeoutMs?: number; pollMs?: number }): Promise<HubClient> {
  try { return await d.connect(); } catch { /* not running */ }
  d.start();
  const until = Date.now() + (d.timeoutMs ?? 20000);
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, d.pollMs ?? 300));
    try { return await d.connect(); } catch { /* still starting */ }
  }
  throw new Error('the agent-spaghetti daemon did not start');
}

/** A Windows .ico holding one 256×256 PNG (ICO allows PNG entries since Vista): shortcuts need .ico, the repo keeps only PNGs. */
export function pngToIco(png: Uint8Array): Uint8Array {
  const ico = new Uint8Array(22 + png.length), v = new DataView(ico.buffer);
  v.setUint16(2, 1, true); v.setUint16(4, 1, true);                       // type icon, 1 image
  v.setUint16(10, 1, true); v.setUint16(12, 32, true);                     // width/height bytes 0 = 256; planes, bits
  v.setUint32(14, png.length, true); v.setUint32(18, 22, true);            // size, offset
  ico.set(png, 22);
  return ico;
}
/** Where the clickable launchers go on Windows (desktop + Start menu), from Electron's known folders. */
export const shortcutPaths = (desktop: string, appData: string, join: (...p: string[]) => string) =>
  [join(desktop, 'Agent Spaghetti.lnk'), join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Agent Spaghetti.lnk')];
