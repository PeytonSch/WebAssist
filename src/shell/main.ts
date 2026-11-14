import { app, BrowserWindow, dialog, nativeTheme, net, shell as electronShell } from 'electron';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Updater, type PayloadInfo, type UpdateResult } from './updater';

/**
 * The shell: the part that is installed once and does not update itself. It shows the splash
 * screen, brings the payload up to date, then hands control to the payload's app.cjs, which
 * owns the hub, the main window and the menus. Keep this file small: anything here can only
 * change by reinstalling.
 */

/** Bump when the contract between shell and payload changes (see ShellContext). */
const SHELL_API = 1;
const REPO = 'PeytonSch/WebAssist';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
/** Long enough that the splash does not flash by unreadably when there is nothing to do. */
const MIN_SPLASH_MS = 900;

/** What the shell passes to a payload's `run`. */
export interface ShellContext {
  shellApi: number;
  payloadVersion: string;
  payloadDir: string;
  userData: string;
  /** Quit and start again, which re-runs the update check. */
  relaunch: () => void;
  log: (msg: string) => void;
}

if (process.env.DEBUG_HUB_USER_DATA) app.setPath('userData', process.env.DEBUG_HUB_USER_DATA);
const userData = app.getPath('userData');
mkdirSync(userData, { recursive: true });

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    appendFileSync(join(userData, 'shell.log'), line);
  } catch {
    /* logging must never stop the app from starting */
  }
  if (!app.isPackaged) process.stdout.write(line);
}

let splash: BrowserWindow | null = null;
let lastStatus: Record<string, unknown> = { text: 'Starting…' };

function setStatus(status: { text: string; percent?: number | null; version?: string }): void {
  lastStatus = status;
  if (splash && !splash.isDestroyed()) splash.webContents.send('splash:status', status);
}

function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 320,
    height: 360,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    title: 'Debug Hub',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#11141b' : '#ffffff',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  // Resend on load: status changes can arrive before the page is listening.
  win.webContents.on('did-finish-load', () => win.webContents.send('splash:status', lastStatus));
  void win.loadFile(join(__dirname, 'splash.html'));
  return win;
}

function relaunch(): void {
  app.relaunch();
  app.quit();
}

async function startPayload(payload: PayloadInfo): Promise<void> {
  const ctx: ShellContext = {
    shellApi: SHELL_API,
    payloadVersion: payload.version,
    payloadDir: payload.dir,
    userData,
    relaunch,
    log,
  };
  // The payload is CommonJS outside the app bundle; load it with a plain require.
  const mod = createRequire(__filename)(join(payload.dir, 'app.cjs'));
  if (typeof mod.run !== 'function') throw new Error('Payload has no run() export');
  await mod.run(ctx);
}

async function main(): Promise<void> {
  splash = createSplash();
  const shownAt = Date.now();

  const feed = process.env.DEBUG_HUB_UPDATE_URL ?? (app.isPackaged ? MANIFEST_URL : null);
  const bundledDir = app.isPackaged ? join(process.resourcesPath, 'payload') : join(__dirname, '..', 'payload');
  const updater = new Updater({
    root: join(userData, 'payload'),
    bundledDir: existsSync(bundledDir) ? bundledDir : null,
    manifestUrl: feed,
    shellApi: SHELL_API,
    // Electron's fetch honours the system proxy settings; Node's does not.
    fetch: ((input: any, init?: any) => net.fetch(input, init)) as typeof fetch,
    log,
    onProgress: (p) => {
      if (p.phase === 'checking') setStatus({ text: 'Checking for updates…' });
      else if (p.phase === 'downloading') setStatus({ text: `Downloading update ${p.version}`, percent: p.percent ?? 0, version: p.version });
      else setStatus({ text: `Installing update ${p.version}`, version: p.version });
    },
  });

  const before = updater.current()?.version ?? 'none';
  const outcome: UpdateResult = await updater.update();
  log(`update check: ${JSON.stringify(outcome)} (was ${before})`);

  let started: PayloadInfo | null = null;
  let lastError: unknown = null;
  for (const candidate of updater.candidates()) {
    setStatus({ text: 'Starting…', version: candidate.version });
    try {
      // Hold the splash briefly so its last message can be read.
      const wait = MIN_SPLASH_MS - (Date.now() - shownAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await startPayload(candidate);
      started = candidate;
      break;
    } catch (err) {
      lastError = err;
      log(`payload ${candidate.version} failed to start: ${(err as Error).stack ?? err}`);
      // A downloaded version that cannot start is abandoned; the next candidate is the rollback.
      if (candidate.source === 'downloaded') updater.markBad(candidate.version);
    }
  }

  splash.destroy();
  splash = null;

  if (!started) {
    dialog.showErrorBox(
      'Debug Hub could not start',
      `${(lastError as Error)?.message ?? 'No runnable version is installed.'}\n\nReinstall from ${RELEASES_PAGE}\nLog: ${join(userData, 'shell.log')}`,
    );
    app.exit(1);
    return;
  }

  if (outcome.result === 'shell-outdated') {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Debug Hub ${outcome.version} needs a newer installer`,
      detail: 'This update changes the app itself, so it cannot be applied in place. Download and install the latest version to get it. Your settings and sessions are kept.',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void electronShell.openExternal(RELEASES_PAGE);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => w !== splash) ?? splash;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(main).catch((err) => {
    log(`fatal: ${err?.stack ?? err}`);
    dialog.showErrorBox('Debug Hub could not start', String(err?.message ?? err));
    app.exit(1);
  });
}
