import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environmentReport, startHub, type RunningHub } from '../server/embed';
import type { ShellContext } from '../shell/main';

/**
 * Entry point of the payload: the part of the desktop app that updates. The shell calls `run`
 * once the payload is up to date, and closes the splash screen when the returned promise
 * resolves, so resolve only when the main window is ready to be seen.
 */

const STARTER_CONFIG = {
  port: 4000,
  sessionsDir: 'sessions',
  chrome: { enabled: true, port: 9222 },
  tomcat: { enabled: false, appLogs: [], accessLogs: [], accessDurationUnit: 'ms' },
  postgres: { enabled: false, logs: [] },
};

export async function run(ctx: ShellContext): Promise<void> {
  const configFile = join(ctx.userData, 'debug-hub.config.json');
  mkdirSync(ctx.userData, { recursive: true });
  const firstRun = !existsSync(configFile);
  if (firstRun) writeFileSync(configFile, JSON.stringify(STARTER_CONFIG, null, 2) + '\n');

  const hub: RunningHub = await startHub(configFile, join(ctx.payloadDir, 'ui'));
  ctx.log(`hub ${ctx.payloadVersion} listening on ${hub.url}`);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Debug Hub',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f6f7f9',
    webPreferences: { preload: join(ctx.payloadDir, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // The UI is a plain web page; anything that tries to leave it opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(hub.url)) e.preventDefault();
  });

  const runEnvironmentCheck = async () => {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Choose your app’s project folder (optional)',
      message: 'Choose your app’s project folder to detect its logging framework and Vite proxy. Cancel to skip.',
      properties: ['openDirectory'],
    });
    const out = join(ctx.userData, 'environment.md');
    writeFileSync(out, await environmentReport(configFile, pick.canceled ? null : pick.filePaths[0]));
    void shell.openPath(out);
  };

  // Only the hub's own page in this window may use the native helpers in preload.ts.
  const fromUi = (e: IpcMainInvokeEvent) => e.sender === win.webContents && !!e.senderFrame?.url.startsWith(hub.url);
  ipcMain.handle('dh:pick-path', async (e, opts: { kind?: unknown; title?: unknown; defaultPath?: unknown }) => {
    if (!fromUi(e)) return null;
    const pick = await dialog.showOpenDialog(win, {
      title: typeof opts?.title === 'string' ? opts.title.slice(0, 200) : undefined,
      defaultPath: typeof opts?.defaultPath === 'string' && opts.defaultPath ? opts.defaultPath : undefined,
      properties: opts?.kind === 'folder' ? ['openDirectory', 'createDirectory'] : ['openFile'],
    });
    return pick.canceled ? null : (pick.filePaths[0] ?? null);
  });
  ipcMain.handle('dh:reveal', (e, what: unknown) => {
    if (!fromUi(e)) return;
    if (what === 'config') void shell.openPath(configFile);
    else if (what === 'sessions') void shell.openPath(hub.sessionsDir());
  });
  ipcMain.handle('dh:restart', (e) => {
    if (fromUi(e)) ctx.relaunch();
  });
  const openSettings = () => win.webContents.send('dh:open-settings');

  const template: MenuItemConstructorOptions[] = [
    {
      label: process.platform === 'darwin' ? app.name : 'File',
      submenu: [
        { label: `Debug Hub ${ctx.payloadVersion}`, enabled: false },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { label: 'Open Sessions Folder', click: () => void shell.openPath(hub.sessionsDir()) },
        { label: 'Open Config File', click: () => void shell.openPath(configFile) },
        { label: 'Run Environment Check…', click: () => void runEnvironmentCheck() },
        { type: 'separator' },
        { label: 'Check for Updates and Restart', click: ctx.relaunch },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // It is a single-window tool: closing the window ends the session on every platform.
  app.on('window-all-closed', () => app.quit());
  let stopped = false;
  app.on('before-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    stopped = true;
    // Flush the session file before the process goes away.
    void hub.stop().finally(() => app.quit());
  });

  await new Promise<void>((resolve, reject) => {
    win.once('ready-to-show', () => {
      win.show();
      resolve();
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`UI failed to load: ${desc} (${code})`)));
    // On the very first run, open straight into Settings so the app can be pointed at the logs.
    void win.loadURL(firstRun ? `${hub.url}/#settings` : hub.url);
  });

  if (hub.configError) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'The config file could not be read',
      detail: `${hub.configError}\n\nDebug Hub started with default settings. Saving in Settings replaces the file.`,
      buttons: ['Open Settings', 'Open Config File', 'OK'],
      defaultId: 0,
    });
    if (response === 0) openSettings();
    else if (response === 1) void shell.openPath(configFile);
  }
}
