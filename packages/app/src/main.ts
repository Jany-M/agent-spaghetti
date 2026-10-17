// Electron main process of the tray (Phase 2). Owns the one HubClient; renderers go through the preload bridge.
// The daemon is independent: the tray starts it when missing and can leave it running on quit.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonDown, HubClient, dataDir, emptyLive, renderStats, trayState } from '@agent-spaghetti/sdk';
import { spawnDetached } from '@agent-spaghetti/core/proc';
import { CHANNEL, isBridgeOp, type BridgeEvent } from '@agent-spaghetti/ui/bridge';
import { ICON, ensureDaemon, newQuestions, placeNear, shortcutPaths, tooltip, trayMenu } from './logic.ts';

const DIR = __dirname;                                     // dist/app (bundle) — assets and the popover live next to it
const ROOT = join(DIR, '..', '..');
const asset = (f: string) => join(DIR, f);
const SIZE = { width: 420, height: 600 };
const APP_ID = 'com.agent-spaghetti.tray';

let tray: Tray | null = null, pop: BrowserWindow | null = null, client: HubClient | null = null, up = false, quitting = false;
const seen = new Set<string>();

const connect = async () => { const c = HubClient.fromDiscovery(); await c.call('status'); return c; };
const startDaemon = () => spawnDetached('node', [join(ROOT, 'packages', 'cli', 'src', 'index.ts'), 'daemon'], { logFile: join(dataDir(), 'daemon.log') });
const send = (e: BridgeEvent) => { if (pop && !pop.isDestroyed()) pop.webContents.send(CHANNEL.event, e); };

async function refresh() {
  if (!tray) return;
  const s = up && client ? await client.call('status').catch(() => null) : null;
  const consents = s?.consents ?? [];
  const live = s?.live ?? emptyLive();
  tray.setImage(asset(ICON[trayState(!!s, s?.snapshot ?? null, live, consents)]));
  tray.setToolTip(tooltip(renderStats(!!s, s?.snapshot ?? null, live, consents)));
  const names = new Map(s?.snapshot?.detections.map(d => [d.integration, d.name]) ?? []);
  for (const id of newQuestions(seen, consents.map(c => c.id))) {
    seen.add(id);
    const c = consents.find(x => x.id === id)!;
    notify(`${names.get(c.subject) ?? c.subject} is asking`, `${c.action} ${c.resource}\n${c.why}`);
  }
  setMenu();
}
function notify(title: string, body: string) { const n = new Notification({ title, body, icon: asset('icon.png') }); n.on('click', showPopover); n.show(); }
let pending: NodeJS.Timeout | undefined;
const refreshSoon = () => { clearTimeout(pending); pending = setTimeout(() => void refresh(), 200); };

/** Follows the daemon's event stream; reconnects with backoff, never starts the daemon by itself. */
async function follow() {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 10000)) {
    try {
      client = await connect(); up = true; wait = 1000;
      send({ type: 'hub.up' }); refreshSoon();
      for await (const e of client.stream()) { send(e); refreshSoon(); if (e.type === 'run.delivered' && e.data.how === 'unread') notify(`Result of run ${e.data.id} is waiting`, 'Its caller was no longer waiting: see Runs.');
        if (e.type === 'dispatcher.action' && e.data.what === 'stuck') notify(`Run ${e.data.id} on ${e.data.target} is not progressing`, 'Cancel it in Runs, or let its deadline end it.'); }
    } catch (e) { if (!(e instanceof DaemonDown)) console.error(e); }
    if (up) { up = false; client = null; send({ type: 'hub.down' }); void refresh(); }
    await new Promise(r => setTimeout(r, wait));
  }
}

function showPopover() {
  if (!pop || !tray) return;
  const b = tray.getBounds();
  pop.setBounds(placeNear(b, screen.getDisplayMatching(b).workArea, SIZE));
  pop.show(); pop.focus();
}
/** First run on Windows: a clickable launcher on the desktop and in the Start menu (deleted ones are not recreated). */
function ensureShortcuts() {
  const flag = join(app.getPath('userData'), 'shortcuts-created');
  if (process.platform !== 'win32' || existsSync(flag)) return;
  const link = { target: process.execPath, args: `"${app.getAppPath()}"`, icon: asset('icon.ico'), iconIndex: 0, appUserModelId: APP_ID, description: 'Agent Spaghetti tray' };
  for (const p of shortcutPaths(app.getPath('desktop'), app.getPath('appData'), join)) shell.writeShortcutLink(p, 'create', link);
  writeFileSync(flag, '');
}
function setMenu() {
  if (!tray) return;
  const act: Record<string, () => void> = {
    open: showPopover,
    scan: () => void client?.call('scan').catch(() => {}),
    start: () => void ensureDaemon({ connect, start: startDaemon }).catch(e => console.error(e)),
    autostart: () => app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin, args: [app.getAppPath()] }),
    quit: () => app.quit(),
    'quit-all': () => void client?.call('shutdown').catch(() => {}).finally(() => app.quit()),
  };
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu(up, app.getLoginItemSettings().openAtLogin)
    .map(i => ({ ...i, click: i.id ? act[i.id] : undefined }))));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showPopover);
  app.on('window-all-closed', () => { /* tray app: stay alive */ });
  app.on('before-quit', () => { quitting = true; });
  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    ensureShortcuts();
    tray = new Tray(nativeImage.createFromPath(asset(ICON.problem)));
    tray.on('click', () => (pop?.isVisible() ? pop.hide() : showPopover()));
    client = await ensureDaemon({ connect, start: startDaemon }).catch(e => { console.error(e); return null; });   // before the page asks for status
    pop = new BrowserWindow({ ...SIZE, show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, icon: asset('icon.png'),
      webPreferences: { preload: asset('preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    pop.on('blur', () => pop?.hide());
    pop.on('close', e => { if (!quitting) { e.preventDefault(); pop?.hide(); } });   // Alt+F4 hides: the popover lives as long as the tray
    pop.webContents.on('will-navigate', e => e.preventDefault());
    pop.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    ipcMain.handle(CHANNEL.call, (_e, op: unknown, input: Record<string, unknown>) => {   // before the page loads: it calls at once
      if (!isBridgeOp(op)) throw new Error(`op not allowed: ${String(op)}`);
      if (!client) throw new Error('agent-spaghetti daemon is not running');
      return client.call(op, input as never);
    });
    await pop.loadFile(asset('popover.html'));
    setMenu();
    void follow();
  });
}
