import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { environmentReport, startHub, type RunningHub } from '../server/embed';
import {
  checkEveryMs, checkForGitUpdate, dismiss, dismissedTarget, fetchCommandFrom, fetchDiagnostics, fetchNote, findRepo,
  gitRunner, gitUpdatesEnabled, proxyFromPac, remoteHttpUrl, startGitUpdate, type FetchOptions, type GitUpdateStatus,
} from '../shell/gitupdate';
import type { ShellContext } from '../shell/main';
import { availableView, saveTheme, showUpdateWindow, themeOf } from '../shell/updatewindow';

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
    // The UI's top bar is the title bar (src/ui/titlebar.ts). On macOS the native traffic lights
    // stay, inset into it; elsewhere the UI draws its own window buttons and menu button.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 19 } }
      : { frame: false }),
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
  ipcMain.handle('dh:window', (e, action: unknown) => {
    if (!fromUi(e)) return;
    if (action === 'minimize') win.minimize();
    else if (action === 'toggle-maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
  });
  ipcMain.handle('dh:is-maximized', (e) => fromUi(e) && win.isMaximized());
  // Without a native frame on Windows and Linux, the menu bar is gone; the UI's menu button pops
  // the same menu up under itself. x and y are CSS pixels in the page.
  ipcMain.handle('dh:popup-menu', (e, at: { x?: unknown; y?: unknown }) => {
    if (!fromUi(e)) return;
    const zoom = win.webContents.getZoomFactor();
    const px = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * zoom) : undefined);
    Menu.getApplicationMenu()?.popup({ window: win, x: px(at?.x), y: px(at?.y) });
  });
  // Includes Windows snap (dragging to the top edge) and the OS double-click on the top bar.
  const sendMaximized = () => win.webContents.send('dh:maximized', win.isMaximized());
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);
  const openSettings = () => win.webContents.send('dh:open-settings');

  // Run from a git checkout (npm run app): look for new commits on origin/main every few
  // minutes and offer to update. Installed copies update from releases when they start instead.
  const repo = !app.isPackaged && gitUpdatesEnabled() ? findRepo(__dirname) : null;
  const gitUpdates = repo ? watchGitUpdates(repo, win, ctx) : null;

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
        gitUpdates
          ? { label: 'Check for Updates…', click: () => void gitUpdates.checkNow() }
          : { label: 'Check for Updates and Restart', click: ctx.relaunch },
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
      void themeOf(win).then((t) => saveTheme(ctx.userData, t));
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`UI failed to load: ${desc} (${code})`)));
    // On the very first run, open Settings with the setup guide, to point the app at everything.
    void win.loadURL(firstRun ? `${hub.url}/#settings/setup` : hub.url);
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

/**
 * The background half of git updates (src/shell/gitupdate.ts; the splash does the check at
 * start). An update that was answered "Later" is not offered again until main moves on.
 */
function watchGitUpdates(repo: string, win: BrowserWindow, ctx: ShellContext) {
  const git = gitRunner(repo);
  let asking = false;
  let quitting = false;
  let lastLoggedError = '';

  // The user's fetch command (read each time, so Settings applies at once) and the system proxy.
  const fetchOptions = async (): Promise<FetchOptions> => {
    const url = await remoteHttpUrl(git);
    let proxy: string | null = null;
    try {
      if (url) proxy = proxyFromPac(await session.defaultSession.resolveProxy(url));
    } catch {
      /* no proxy information */
    }
    return { command: fetchCommandFrom(ctx.userData), proxy };
  };
  const checkOnce = async (): Promise<{ status: GitUpdateStatus; opts: FetchOptions }> => {
    const opts = await fetchOptions();
    const status = await checkForGitUpdate(git, { repo, fetchOptions: opts });
    const error = status.state === 'error' ? status.message : status.fetchError;
    // Logged once per different error, not every 5 minutes.
    if (error && error !== lastLoggedError) {
      ctx.log(`git update check: fetch failed: ${error}`);
      ctx.log(`git fetch details: ${await fetchDiagnostics(git, opts.proxy ?? null, opts.command ?? null)}`);
    }
    lastLoggedError = error ?? '';
    return { status, opts };
  };

  const offer = async (status: Extract<GitUpdateStatus, { state: 'available' }>, fromMenu: boolean, opts: FetchOptions): Promise<void> => {
    asking = true;
    try {
      const theme = await themeOf(win);
      saveTheme(ctx.userData, theme);
      const choice = await showUpdateWindow(await availableView(git, status), { parent: win, theme, git });
      if (status.blocked) {
        dismiss(ctx.userData, status.target);
        return;
      }
      if (choice !== 'update') {
        // Asked from the menu, Later only closes the question; from the timer it is remembered.
        if (!fromMenu) dismiss(ctx.userData, status.target);
        return;
      }
      ctx.log(`git update started: ${status.head.slice(0, 7)} → ${status.target.slice(0, 7)}`);
      quitting = true;
      startGitUpdate(repo, ctx.userData, opts);
      // Quitting stops the hub first, so the session file is complete (before-quit in run()).
      app.quit();
    } finally {
      asking = false;
    }
  };

  const check = async (): Promise<void> => {
    if (asking || quitting || win.isDestroyed()) return;
    // The update window at the next start shows in this theme too.
    saveTheme(ctx.userData, await themeOf(win));
    const { status, opts } = await checkOnce();
    if (status.state !== 'available' || status.target === dismissedTarget(ctx.userData) || asking || quitting) return;
    await offer(status, false, opts);
  };

  const timer = setInterval(() => void check(), checkEveryMs());
  timer.unref();
  win.on('closed', () => clearInterval(timer));

  return {
    /** From the menu: always answers, even "up to date". */
    checkNow: async (): Promise<void> => {
      if (asking || quitting) return;
      const { status, opts } = await checkOnce();
      if (status.state === 'available') return offer(status, true, opts);
      asking = true;
      try {
        const theme = await themeOf(win);
        saveTheme(ctx.userData, theme);
        const ok = [{ id: 'ok', label: 'OK', primary: true }];
        await showUpdateWindow(status.state === 'up-to-date'
          ? status.fetchError
            ? {
                mode: 'message', tone: 'warn', title: 'Could not reach GitHub to check for updates',
                detail: `${fetchNote(status)}\n\nAs of that fetch the checkout is up to date. Details are in shell.log.`,
                head: status.head, actions: ok, cancel: 'ok',
              }
            : {
                mode: 'message', tone: 'ok', title: 'You’re up to date',
                detail: 'Debug Hub is at the latest commit on origin/main.', head: status.head, actions: ok, cancel: 'ok',
              }
          : {
              mode: 'message', tone: 'warn', title: 'Could not check for updates',
              detail: `${status.message}\n\nIf your terminal can fetch, set Settings › Advanced › Fetch updates with to a command that does it the same way, e.g. nu -l -c "git fetch origin main". Details are in shell.log.`,
              actions: ok, cancel: 'ok',
            }, { parent: win, theme });
      } finally {
        asking = false;
      }
    },
  };
}
