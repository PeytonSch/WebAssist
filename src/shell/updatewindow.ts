import { BrowserWindow, nativeTheme } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appIcon } from './appicon';
import { fileDiff, fetchNote, GIT_BRANCH, GIT_REMOTE, type GitRunner, type GitUpdateStatus, updateDetails } from './gitupdate';
import type { DiffAnswer, UpdateAction, UpdateView } from './updatemodel';

/**
 * The update window: Debug Hub's own window for "an update is available" (with its commits,
 * files and diffs), "up to date" and "could not update", in place of the system message box.
 * Both the shell (at start, over the splash) and the running app (src/desktop/app.ts) use it;
 * each bundle has its own copy of update.html and update-preload.cjs beside it (scripts/build.mjs).
 */

export type Theme = 'light' | 'dark';

export interface UpdateWindowOptions {
  /** Shown over this window, which it blocks until answered. */
  parent?: BrowserWindow | null;
  /** The app's theme; the system's when not given. */
  theme?: Theme | null;
  /** Reads diffs for an 'available' view. */
  git?: GitRunner;
}

const AVAILABLE_SIZE = { width: 920, height: 700 };
const MESSAGE_WIDTH = 460;

/** Resolves to the id of the action chosen, or null when the window was closed. */
export function showUpdateWindow(view: UpdateView, opts: UpdateWindowOptions = {}): Promise<string | null> {
  const theme: Theme = opts.theme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  const big = view.mode === 'available';
  const parent = opts.parent && !opts.parent.isDestroyed() ? opts.parent : undefined;
  const win = new BrowserWindow({
    ...(big ? { ...AVAILABLE_SIZE, minWidth: 640, minHeight: 460 } : { width: MESSAGE_WIDTH, height: 280, resizable: false, maximizable: false }),
    parent,
    modal: !!parent,
    frame: false,
    show: false,
    center: true,
    minimizable: false,
    fullscreenable: false,
    title: 'Debug Hub update',
    icon: appIcon(),
    backgroundColor: theme === 'dark' ? '#11141b' : '#ffffff',
    webPreferences: { preload: join(__dirname, 'update-preload.cjs'), contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Diffs only for the files and commits this window was shown.
  const files = new Set<string>();
  const shas = new Set<string>();
  if (view.mode === 'available' && view.details) {
    for (const f of view.details.files) files.add(f.path);
    for (const c of view.details.commits) {
      shas.add(c.sha);
      for (const f of c.files) files.add(f.path);
    }
  }
  const ipc = win.webContents.ipc;
  ipc.handle('update:view', () => view);
  ipc.handle('update:diff', async (_e, path: unknown, sha: unknown): Promise<DiffAnswer> => {
    if (view.mode !== 'available' || !opts.git || typeof path !== 'string' || !files.has(path)) return { text: '', truncated: false, error: 'Not part of this update' };
    if (sha !== null && (typeof sha !== 'string' || !shas.has(sha))) return { text: '', truncated: false, error: 'Not part of this update' };
    try {
      return await fileDiff(opts.git, path, sha ? { sha } : { head: view.head, target: view.target });
    } catch (err) {
      return { text: '', truncated: false, error: (err as Error).message };
    }
  });
  ipc.on('update:fit', (_e, height: unknown) => {
    // Message windows grow to their text, within reason.
    if (big || typeof height !== 'number' || !Number.isFinite(height)) return;
    win.setContentSize(MESSAGE_WIDTH, Math.round(Math.min(560, Math.max(200, height))));
    if (!parent) win.center();
  });

  return new Promise((resolve) => {
    let answer: string | null = null;
    ipc.on('update:choose', (_e, id: unknown) => {
      answer = typeof id === 'string' && view.actions.some((a) => a.id === id) ? id : null;
      if (!win.isDestroyed()) win.close();
    });
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.once('closed', () => resolve(answer));
    void win.loadFile(join(__dirname, 'update.html'), { query: { theme } });
  });
}

/** The view for an available update: the check's result, with commits and files when git can say. */
export async function availableView(
  git: GitRunner,
  status: Extract<GitUpdateStatus, { state: 'available' }>,
  laterLabel = 'Later',
): Promise<UpdateView> {
  let details = null;
  try {
    details = await updateDetails(git, status.head, status.target);
  } catch {
    /* the short list from the check still says what is new */
  }
  const actions: UpdateAction[] = status.blocked
    ? [{ id: 'ok', label: 'OK', primary: true }]
    : [{ id: 'later', label: laterLabel }, { id: 'update', label: 'Update and restart', primary: true }];
  return {
    mode: 'available',
    head: status.head,
    target: status.target,
    behind: status.behind,
    source: `${GIT_REMOTE}/${GIT_BRANCH}`,
    commits: status.commits,
    details,
    blocked: status.blocked,
    fetchNote: fetchNote(status),
    actions,
    cancel: status.blocked ? 'ok' : 'later',
  };
}

/**
 * The theme the main window shows (its <html data-theme>), so the update window matches it;
 * null when it cannot be read.
 */
export async function themeOf(win: BrowserWindow | null | undefined): Promise<Theme | null> {
  if (!win || win.isDestroyed()) return null;
  try {
    const t = await win.webContents.executeJavaScript('document.documentElement.dataset.theme || ""', true);
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}

const themeFile = (userData: string) => join(userData, 'window-theme');

/** Remembers the app's theme, so the update window at the next start (before the UI) matches it. */
export function saveTheme(userData: string, theme: Theme | null): void {
  if (!theme) return;
  try {
    writeFileSync(themeFile(userData), theme);
  } catch {
    /* only cosmetic */
  }
}

/** The app's theme as last saved, or null (then the system's is used). */
export function savedTheme(userData: string): Theme | null {
  try {
    const t = readFileSync(themeFile(userData), 'utf8').trim();
    return t === 'dark' || t === 'light' ? t : null;
  } catch {
    return null;
  }
}
