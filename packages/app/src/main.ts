// Electron main process of the tray (Phase 2). Owns the one HubClient; renderers go through the preload bridge.
// The daemon is independent: the tray starts it when missing and can leave it running on quit.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { join } from 'node:path';
import { DaemonDown, HubClient, ensureDaemon, emptyLive, isTrace, renderStats, trayState } from '@agent-spaghetti/sdk';
import { spawnDaemon } from '@agent-spaghetti/core/launch';
import { CHANNEL, isBridgeOp, type BridgeEvent } from '@agent-spaghetti/ui/bridge';
import { ICON, newQuestions, placeNear, shortcutPaths, tooltip, trayMenu } from './logic.ts';

const DIR = __dirname;                                     // dist/app (bundle) — assets and the popover live next to it
const ROOT = join(DIR, '..', '..');
const asset = (f: string) => join(DIR, f);
const SIZE = { width: 420, height: 600 }, LIVE = { width: 420, height: 480 };
const APP_ID = 'com.agent-spaghetti.tray';

let tray: Tray | null = null, pop: BrowserWindow | null = null, liveWin: BrowserWindow | null = null, client: HubClient | null = null, up = false, quitting = false;
const seen = new Set<string>();

const connect = async () => { const c = HubClient.fromDiscovery(); await c.call('status'); return c; };
const startDaemon = () => void spawnDaemon(process.env, join(ROOT, 'packages', 'cli', 'src', 'index.ts'));
const to = (w: BrowserWindow | null, e: BridgeEvent) => { if (w && !w.isDestroyed()) w.webContents.send(CHANNEL.event, e); };
/** Hub events to the windows: live-only traces (negative id) only to the live pane, while it shows. */
const send = (e: BridgeEvent) => { if (!('id' in e) || !isTrace(e)) to(pop, e); if (liveWin?.isVisible()) to(liveWin, e); };

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
      for await (const e of client.stream()) { send(e); if (isTrace(e)) continue; refreshSoon(); if (e.type === 'run.delivered' && e.data.how === 'unread') notify(`Result of run ${e.data.id} is waiting`, 'Its caller was no longer waiting: see Runs.');
        if (e.type === 'dispatcher.action' && e.data.what === 'stuck') notify(`Run ${e.data.id} on ${e.data.target} is not progressing`, 'Cancel it in Runs, or let its deadline end it.'); }
    } catch (e) { if (!(e instanceof DaemonDown)) console.error(e); }
    if (up) { up = false; client = null; send({ type: 'hub.down' }); void refresh(); }
    await new Promise(r => setTimeout(r, wait));
  }
}

/** The live pane: small, on top, stays open when you click elsewhere; it opens bottom-right and remembers where you put it. */
function showLive(toggle = false) {
  if (liveWin && !liveWin.isDestroyed()) {
    if (toggle && liveWin.isVisible()) liveWin.hide(); else liveWin.show();
    return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  liveWin = new BrowserWindow({ ...LIVE, x: area.x + area.width - LIVE.width - 16, y: area.y + area.height - LIVE.height - 16, show: false, frame: false,
    resizable: true, minWidth: 300, minHeight: 200, alwaysOnTop: true, skipTaskbar: true, icon: asset('icon.png'), title: 'Agent Spaghetti: live',
    webPreferences: { preload: asset('preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  liveWin.on('close', e => { if (!quitting) { e.preventDefault(); liveWin?.hide(); } });   // its × hides it: it lives as long as the tray
  liveWin.on('show', () => { liveWin?.setAlwaysOnTop(true, 'floating'); liveWin?.moveTop(); setMenu(); });   // Windows keeps "on top" only when set on a shown window
  liveWin.on('hide', setMenu);
  liveWin.webContents.on('will-navigate', e => e.preventDefault());
  liveWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  void liveWin.loadFile(asset('popover.html'), { query: { window: 'live' } }).then(() => liveWin?.show());
}
function showPopover() {
  if (!pop || !tray) return;
  const b = tray.getBounds();
  pop.setBounds(placeNear(b, screen.getDisplayMatching(b).workArea, SIZE));
  pop.show(); pop.focus();
}
/** Windows: keep the desktop + Start menu launchers pointing at THIS install (self-heals moved/broken links; deleted ones are recreated on next run). */
function ensureShortcuts() {
  if (process.platform !== 'win32') return;
  const link = { target: process.execPath, args: `"${app.getAppPath()}"`, icon: asset('icon.ico'), iconIndex: 0, appUserModelId: APP_ID, description: 'Agent Spaghetti tray' };
  for (const p of shortcutPaths(app.getPath('desktop'), app.getPath('appData'), join)) shell.writeShortcutLink(p, 'replace', link);
}
function setMenu() {
  if (!tray) return;
  const act: Record<string, () => void> = {
    open: showPopover,
    scan: () => void client?.call('scan').catch(() => {}),
    start: () => void ensureDaemon({ connect, start: startDaemon }).catch(e => console.error(e)),
    live: () => showLive(true),
    autostart: () => app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin, args: [app.getAppPath()] }),
    quit: () => app.quit(),
    'quit-all': () => void client?.call('shutdown').catch(() => {}).finally(() => app.quit()),
  };
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu(up, app.getLoginItemSettings().openAtLogin, !!liveWin && !liveWin.isDestroyed() && liveWin.isVisible())
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
    pop.webContents.session.on('will-download', (_e, item) => {             // files a panel saves (the machine report) go to Downloads
      const path = join(app.getPath('downloads'), item.getFilename());
      item.setSavePath(path);
      item.once('done', (_d, state) => notify(state === 'completed' ? 'Saved' : 'Not saved', state === 'completed' ? path : item.getFilename()));
    });
    pop.on('close', e => { if (!quitting) { e.preventDefault(); pop?.hide(); } });   // Alt+F4 hides: the popover lives as long as the tray
    pop.webContents.on('will-navigate', e => e.preventDefault());
    pop.webContents.setWindowOpenHandler(({ url }) => { if (new URL(url).searchParams.get('window') === 'live') showLive(); return { action: 'deny' }; });   // its Live button
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
