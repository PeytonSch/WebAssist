import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
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
  if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify(STARTER_CONFIG, null, 2) + '\n');

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
    webPreferences: { contextIsolation: true, sandbox: true },
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

  const template: MenuItemConstructorOptions[] = [
    {
      label: process.platform === 'darwin' ? app.name : 'File',
      submenu: [
        { label: `Debug Hub ${ctx.payloadVersion}`, enabled: false },
        { type: 'separator' },
        { label: 'Open Config File', click: () => void shell.openPath(configFile) },
        { label: 'Open Sessions Folder', click: () => void shell.openPath(hub.sessionsDir) },
        { label: 'Run Environment Check…', click: () => void runEnvironmentCheck() },
        { type: 'separator' },
        { label: 'Restart to Apply Config', click: ctx.relaunch },
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
    void win.loadURL(hub.url);
  });

  if (hub.configError) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'The config file could not be read',
      detail: `${hub.configError}\n\nDebug Hub started with default settings.`,
      buttons: ['Open Config File', 'OK'],
      defaultId: 0,
    });
    if (response === 0) void shell.openPath(configFile);
  }
}
