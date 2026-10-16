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
