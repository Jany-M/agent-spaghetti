// Electron main process of the tray (Phase 2). Owns the one HubClient; renderers go through the preload bridge.
// The daemon is independent: the tray starts it when missing and can leave it running on quit.
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, screen, Tray } from 'electron';
import { join } from 'node:path';
import { DaemonDown, HubClient, dataDir, emptyLive, renderStats, trayState } from '@agent-spaghetti/sdk';
import { spawnDetached } from '@agent-spaghetti/core/proc';
import { CHANNEL, isBridgeOp, type BridgeEvent } from '@agent-spaghetti/ui/bridge';
import { ICON, ensureDaemon, newQuestions, placeNear, tooltip, trayMenu } from './logic.ts';

const DIR = __dirname;                                     // dist/app (bundle) — assets and the popover live next to it
const ROOT = join(DIR, '..', '..');
const asset = (f: string) => join(DIR, f);
const SIZE = { width: 380, height: 520 };

let tray: Tray | null = null, pop: BrowserWindow | null = null, client: HubClient | null = null, up = false;
const seen = new Set<string>();

const connect = async () => { const c = HubClient.fromDiscovery(); await c.call('status'); return c; };
const startDaemon = () => spawnDetached('node', [join(ROOT, 'packages', 'cli', 'src', 'index.ts'), 'daemon'], { logFile: join(dataDir(), 'daemon.log') });
const send = (e: BridgeEvent) => pop?.webContents.send(CHANNEL.event, e);

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
    const n = new Notification({ title: `${names.get(c.subject) ?? c.subject} is asking`, body: `${c.action} ${c.resource}\n${c.why}`, icon: asset('icon.png') });
    n.on('click', showPopover); n.show();
  }
  setMenu();
}
let pending: NodeJS.Timeout | undefined;
const refreshSoon = () => { clearTimeout(pending); pending = setTimeout(() => void refresh(), 200); };

/** Follows the daemon's event stream; reconnects with backoff, never starts the daemon by itself. */
async function follow() {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 10000)) {
    try {
      client = await connect(); up = true; wait = 1000;
      send({ type: 'hub.up' }); refreshSoon();
      for await (const e of client.stream()) { send(e); refreshSoon(); }
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
  void app.whenReady().then(async () => {
    app.setAppUserModelId('com.agent-spaghetti.tray');
    tray = new Tray(nativeImage.createFromPath(asset(ICON.problem)));
    tray.on('click', () => (pop?.isVisible() ? pop.hide() : showPopover()));
    pop = new BrowserWindow({ ...SIZE, show: false, frame: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, icon: asset('icon.png'),
      webPreferences: { preload: asset('preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    pop.on('blur', () => pop?.hide());
    pop.webContents.on('will-navigate', e => e.preventDefault());
    pop.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await pop.loadFile(asset('popover.html'));
    ipcMain.handle(CHANNEL.call, (_e, op: unknown, input: Record<string, unknown>) => {
      if (!isBridgeOp(op)) throw new Error(`op not allowed: ${String(op)}`);
      if (!client) throw new Error('agent-spaghetti daemon is not running');
      return client.call(op, input as never);
    });
    setMenu();
    await ensureDaemon({ connect, start: startDaemon }).catch(e => console.error(e));
    void follow();
  });
}
