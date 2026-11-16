import type { AppFolder, DeleteItem, KeepPreview, ScriptKind, ScriptRun, TomcatState, WarInfo, WebappAction, WebappInfo } from '../shared/tomcat';
import { $, fmtBytes, h, type Child } from './dom';
import { closeSettings, openSettings, settingsOpen } from './settings';

/**
 * The Tomcat page: start and stop the server with the user's scripts, start, stop, disable and
 * enable webapps, and deploy WARs from the build folders. Also the new-WAR notifications, which
 * show on every screen. Everything shown comes from GET /api/tomcat, refreshed while the page is
 * open; actions are POSTs that answer with a sentence for the banner.
 */

const POLL_MS = 3000;
/** Faster while a script runs, so its output appears as it is printed. */
const POLL_RUNNING_MS = 1000;
const MAX_NOTICES = 3;

const T = {
  open: false,
  state: null as TomcatState | null,
  stateJson: '',
  loadError: null as string | null,
  /** Keys of actions in flight: "app:shop", "script:start", "war:<file>". */
  busy: new Set<string>(),
  banner: null as { kind: 'error' | 'info'; text: string } | null,
  timer: 0,
  /** New WARs announced and not yet deployed or dismissed, by file. */
  notices: new Map<string, WarInfo>(),
};

let onToggle: (open: boolean) => void = () => undefined;
const root = () => $('tomcat');

// ── Helpers ─────────────────────────────────────────────

async function api<R = any>(path: string, body?: unknown): Promise<R> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as R;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const folderOf = (p: string) => p.slice(0, Math.max(0, p.length - fileName(p).length - 1));
const time = (iso: string) => new Date(iso).toLocaleTimeString();

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function button(label: string, onClick: () => void, opts: { primary?: boolean; danger?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  const cls = `btn btn-sm${opts.primary ? ' btn-primary' : ''}${opts.danger ? ' btn-danger-quiet' : ''}`;
  const b = h('button', { type: 'button', class: cls, title: opts.title }, label) as HTMLButtonElement;
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

function settingsLink(text = 'Settings › Tomcat'): HTMLElement {
  const a = h('a', { href: '#settings/tomcat-management', class: 'link' }, text);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openSettings('tomcat-management');
  });
  return a;
}

/** Mirrors checkName in src/server/tomcat/webapps.ts, for feedback while typing. The hub checks again. */
function nameProblem(name: string): string | null {
  if (!name) return 'Enter a name.';
  if (/[\\/]/.test(name) || name.includes('..')) return 'The name cannot contain /, \\ or ..';
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}._#~+@()\- ]*$/u.test(name) || /[. ]$/.test(name)) {
    return 'Use letters, digits and . _ - # ~ + @ ( ) only, starting with a letter or digit.';
  }
  return null;
}

/** The file manager's name, for "Show in Explorer" and the like. */
const FILE_MANAGER = /Windows/.test(navigator.userAgent) ? 'Explorer' : /Mac/.test(navigator.userAgent) ? 'Finder' : null;

/** Opens the file manager on a watched WAR, a webapp or one of the two folders (the hub checks which). */
function revealButton(target: { file: string } | { from: AppFolder; name?: string }, title?: string): HTMLButtonElement {
  const label = FILE_MANAGER ? `${'file' in target ? 'Show' : 'Open'} in ${FILE_MANAGER}` : 'Open folder';
  const b = button(label, () => {
    void api('/api/tomcat/reveal', target).catch((err) => {
      T.banner = { kind: 'error', text: (err as Error).message };
      if (T.open) render();
    });
  }, { title });
  b.classList.add('btn-ghost');
  return b;
}

const contextPath = (name: string) => {
  const base = name.replace(/##.*$/, '');
  return base === 'ROOT' ? '/' : `/${base.replace(/#/g, '/')}`;
};

// ── Data ────────────────────────────────────────────────

async function refresh(): Promise<void> {
  try {
    const state = await api<TomcatState>('/api/tomcat');
    T.loadError = null;
    const json = JSON.stringify(state);
    if (json !== T.stateJson || !T.state) {
      T.state = state;
      T.stateJson = json;
      syncNoticesFrom(state.wars);
      if (T.open) render();
    }
  } catch (err) {
    T.loadError = (err as Error).message;
    if (T.open) render();
  }
}

function schedule(): void {
  clearTimeout(T.timer);
  if (!T.open) return;
  const running = !!(T.state?.scripts.start?.running || T.state?.scripts.stop?.running);
  T.timer = window.setTimeout(async () => {
    if (!document.hidden) await refresh();
    schedule();
  }, running ? POLL_RUNNING_MS : POLL_MS);
}

/** Runs an action, shows its outcome in the banner and reloads the state. */
async function act(key: string, run: () => Promise<string | undefined>): Promise<void> {
  T.busy.add(key);
  if (T.open) render();
  try {
    const message = await run();
    T.banner = message ? { kind: 'info', text: message } : null;
  } catch (err) {
    T.banner = { kind: 'error', text: (err as Error).message };
  } finally {
    T.busy.delete(key);
    await refresh();
    if (T.open) render();
  }
}

const webappAction = (app: WebappInfo, action: WebappAction) =>
  act(`app:${app.name}`, async () => (await api(`/api/tomcat/webapps/${encodeURIComponent(app.name)}/${action}`, {})).message);

const scriptAction = (kind: ScriptKind) =>
  act(`script:${kind}`, async () => {
    // The output panel shows how it went.
    await api<{ run: ScriptRun }>(`/api/tomcat/server/${kind}`, {});
    return undefined;
  });

// ── Page ────────────────────────────────────────────────

function card(id: string, title: string, desc: Child, tools: Child, ...body: Child[]): HTMLElement {
  return h(
    'section',
    { class: 'card', id: `tm-${id}` },
    h('header', { class: 'card-head' }, h('div', {}, h('h2', {}, title), desc ? h('p', {}, desc) : null), h('div', { class: 'card-tools' }, tools)),
    h('div', { class: 'card-body' }, ...body),
  );
}

const dirLabel = (dir: string) => (dir ? h('span', { class: 'tm-dir' }, dir) : null);

function missing(...text: Child[]): HTMLElement {
  return h('div', { class: 'tm-missing' }, ...text);
}

function problemNotes(keys: TomcatState['problems'][number]['key'][]): HTMLElement[] {
  return (T.state?.problems ?? []).filter((p) => keys.includes(p.key)).map((p) => h('div', { class: 'tm-note warn' }, p.message, ' ', settingsLink('Fix in Settings')));
}

const STATE_LABEL: Record<WebappInfo['state'], string> = {
  running: 'Running',
  stopped: 'Stopped',
  'not-loaded': 'Not loaded',
  deployed: 'Deployed',
  disabled: 'Disabled',
};
const STATE_HELP: Record<WebappInfo['state'], string> = {
  running: 'Tomcat is serving it.',
  stopped: 'Deployed but stopped. Start brings it back.',
  'not-loaded': 'In the webapps folder, but Tomcat has not loaded it: it is still deploying, it failed to start (see the Tomcat log), or Tomcat is not running.',
  deployed: 'In the webapps folder. Set up the Tomcat Manager in Settings to see whether it is running.',
  disabled: 'Moved out of webapps, so Tomcat does not see it.',
};

function stateBadge(state: WebappInfo['state']): HTMLElement {
  return h('span', { class: `tm-state ${state}`, title: STATE_HELP[state] }, STATE_LABEL[state]);
}

function scriptPanel(s: TomcatState): HTMLElement | null {
  const runs = [s.scripts.start, s.scripts.stop].filter((r): r is ScriptRun => !!r);
  if (!runs.length) return null;
  const run = runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
  let status: Child;
  if (run.error) status = h('span', { class: 'tm-run error' }, `Could not run: ${run.error}`);
  else if (run.running) {
    const secs = (Date.now() - Date.parse(run.startedAt)) / 1000;
    status = h(
      'span',
      { class: 'tm-run running' },
      `Running${run.pid ? ` (process ${run.pid})` : ''}`,
      secs > 10 ? ' · probably Tomcat itself, in the foreground. Closing Debug Hub leaves it running.' : '',
    );
  } else {
    const ok = run.exitCode === 0;
    status = h('span', { class: `tm-run ${ok ? 'ok' : 'error'}` }, `Finished ${run.endedAt ? `at ${time(run.endedAt)} ` : ''}with ${run.exitCode != null ? `exit code ${run.exitCode}` : `signal ${run.signal}`}`);
  }
  const out = h('pre', { class: 'code tm-output' }, (run.outputTruncated ? '…\n' : '') + (run.output || '(no output yet)'));
  return h(
    'div',
    { class: 'tm-script-run' },
    h('div', { class: 'tm-run-head' }, h('b', {}, `${run.kind === 'start' ? 'Start' : 'Stop'} script`), h('span', { class: 'muted' }, `started ${time(run.startedAt)}`), status),
    h('code', { class: 'tm-cmd', title: 'The command that was run' }, run.command),
    out,
  );
}

function serverCard(s: TomcatState): HTMLElement {
  const row = (kind: ScriptKind) => {
    const script = kind === 'start' ? s.settings.startScript : s.settings.stopScript;
    const run = s.scripts[kind];
    const busy = T.busy.has(`script:${kind}`) || !!run?.running;
    const label = kind === 'start' ? 'Start Tomcat' : 'Stop Tomcat';
    return h(
      'div',
      { class: 'tm-script' },
      h('span', { class: 'tm-script-label' }, kind === 'start' ? 'Start script' : 'Stop script'),
      script ? h('code', { class: 'path', title: script }, script) : h('span', { class: 'muted' }, 'Not set'),
      button(T.busy.has(`script:${kind}`) ? 'Running…' : label, () => void scriptAction(kind), {
        primary: kind === 'start',
        disabled: !script || busy,
        title: run?.running ? 'The last run has not finished yet' : script ? `Runs ${script}` : 'Set a script in Settings › Tomcat',
      }),
    );
  };
  const mgr = s.manager;
  const tools = mgr.configured
    ? h('span', { class: `collector ${mgr.ok ? 'connected' : 'off'}`, title: mgr.error ?? s.settings.managerUrl }, mgr.ok ? 'Manager connected' : 'Manager unreachable')
    : null;
  const body: Child[] = [row('start'), row('stop'), ...problemNotes(['startScript', 'stopScript'])];
  if (!s.settings.startScript && !s.settings.stopScript) {
    body.push(missing('Add the scripts you use to start and stop Tomcat (startup.bat, a custom script…) in ', settingsLink(), '.'));
  }
  if (mgr.configured && !mgr.ok && mgr.error) body.push(h('div', { class: 'tm-note warn' }, mgr.error));
  body.push(scriptPanel(s));
  return card('server', 'Server', 'Start and stop Tomcat with your own scripts.', tools, ...body);
}

/** The Manager's own webapp: stopping or disabling it would cut off this page's control. */
function isManagerApp(s: TomcatState, app: WebappInfo): boolean {
  try {
    const first = new URL(s.settings.managerUrl).pathname.split('/')[1];
    return !!first && app.path === `/${first}`;
  } catch {
    return false;
  }
}

function webappRow(s: TomcatState, app: WebappInfo): HTMLElement {
  const busy = T.busy.has(`app:${app.name}`);
  const mgr = s.manager;
  const actions: HTMLElement[] = [];
  const own = isManagerApp(s, app);
  if (mgr.configured && app.state !== 'disabled') {
    const why = !mgr.ok ? 'The Tomcat Manager cannot be reached' : undefined;
    if (app.state === 'running') {
      actions.push(button('Reload', () => void webappAction(app, 'reload'), { disabled: busy || !mgr.ok, title: why ?? 'Restart it, reloading classes and config' }));
      actions.push(button('Stop', () => void webappAction(app, 'stop'), { disabled: busy || !mgr.ok || own, title: own ? 'This is the Manager itself' : why }));
    } else if (app.state === 'stopped') {
      actions.push(button('Start', () => void webappAction(app, 'start'), { disabled: busy || !mgr.ok, title: why }));
    }
  }
  if (app.state === 'disabled') {
    actions.push(button('Enable', () => void webappAction(app, 'enable'), { primary: true, disabled: busy, title: 'Move it back into webapps; Tomcat deploys it' }));
  } else if (!app.external) {
    const noDir = !s.settings.disabledDir || s.problems.some((p) => p.key === 'disabledDir');
    actions.push(
      button('Disable', () => void webappAction(app, 'disable'), {
        disabled: busy || noDir || own,
        title: own ? 'This is the Manager itself' : noDir ? 'Set a folder for disabled webapps in Settings › Tomcat' : 'Move it out of webapps so Tomcat forgets it',
      }),
    );
  }
  if (!app.external) {
    actions.push(
      button('Delete…', () => void openDelete(app), {
        danger: true,
        disabled: busy || (own && app.state !== 'disabled'),
        title: own && app.state !== 'disabled' ? 'This is the Manager itself' : `Delete its files from the ${app.state === 'disabled' ? 'disabled' : 'webapps'} folder for good`,
      }),
    );
  }
  const kinds = [app.hasWar && 'WAR', app.hasDir && 'folder', app.external && 'outside webapps'].filter(Boolean) as string[];
  const linkable = mgr.origin && app.state === 'running';
  const path = linkable ? h('a', { href: mgr.origin + app.path, target: '_blank', rel: 'noopener', class: 'tm-path', title: `Open ${mgr.origin}${app.path}` }, app.path) : h('span', { class: 'tm-path' }, app.path);
  return h(
    'div',
    { class: `tm-row${busy ? ' busy' : ''}` },
    h('div', { class: 'tm-name' }, h('b', {}, app.name), ...kinds.map((k) => h('span', { class: 'tm-tag' }, k))),
    path,
    h('div', {}, stateBadge(app.state), app.sessions ? h('span', { class: 'muted tm-sessions' }, `${app.sessions} session${app.sessions === 1 ? '' : 's'}`) : null),
    h('span', { class: 'muted', title: app.modified ? new Date(app.modified).toLocaleString() : '' }, [ago(app.modified), fmtBytes(app.bytes)].filter(Boolean).join(' · ')),
    h('div', { class: 'tm-actions' }, ...actions),
  );
}

function webappsCard(s: TomcatState): HTMLElement {
  const body: Child[] = [...problemNotes(['webappsDir'])];
  if (!s.settings.webappsDir) {
    body.push(missing('Set Tomcat’s webapps folder (CATALINA_BASE/webapps) in ', settingsLink(), ' to list, disable and deploy webapps.'));
  }
  if (s.webapps.length) body.push(...s.webapps.map((a) => webappRow(s, a)));
  else if (s.settings.webappsDir && !s.problems.some((p) => p.key === 'webappsDir')) body.push(missing('No webapps in this folder.'));
  if (!s.manager.configured && s.webapps.length) {
    body.push(h('div', { class: 'tm-note' }, 'Without the Tomcat Manager, Disable and Enable are how a webapp is stopped and started. Set up the Manager in ', settingsLink(), ' to start, stop and reload webapps in place.'));
  }
  const tools = s.settings.webappsDir && !s.problems.some((p) => p.key === 'webappsDir') ? revealButton({ from: 'webapps' }, s.settings.webappsDir) : null;
  return card('webapps', 'Webapps', dirLabel(s.settings.webappsDir), tools, ...body);
}

function disabledCard(s: TomcatState): HTMLElement {
  const body: Child[] = [...problemNotes(['disabledDir'])];
  if (!s.settings.disabledDir) {
    body.push(missing('Choose a folder outside webapps for disabled webapps in ', settingsLink(), '. Disable moves a webapp there so Tomcat forgets it; Enable moves it back.'));
  } else if (!s.disabled.length && !s.problems.some((p) => p.key === 'disabledDir')) {
    body.push(missing('Nothing is disabled. Disable a webapp above to move it here.'));
  }
  body.push(...s.disabled.map((a) => webappRow(s, a)));
  // The folder is created by the first Disable, so there is something to open once something is in it.
  const tools = s.disabled.length ? revealButton({ from: 'disabled' }, s.settings.disabledDir) : null;
  return card('disabled', 'Disabled webapps', dirLabel(s.settings.disabledDir), tools, ...body);
}

function warsCard(s: TomcatState): HTMLElement {
  const body: Child[] = [...problemNotes(['warWatch'])];
  if (!s.settings.warWatch.length) {
    body.push(missing('Add the folders where your WARs are built (e.g. a project’s target folder) in ', settingsLink(), '. New builds are announced here and wherever you are in Debug Hub.'));
  } else if (!s.wars.length) {
    body.push(missing('No WARs in the watch folders yet. Builds appear here as they finish.'));
  }
  for (const war of s.wars) {
    const busy = T.busy.has(`war:${war.file}`);
    body.push(
      h(
        'div',
        { class: `tm-row tm-war${war.fresh ? ' fresh' : ''}` },
        h('div', { class: 'tm-name', title: war.file }, h('b', {}, war.name), war.fresh ? h('span', { class: 'tm-tag new' }, 'New') : null),
        // Clipped from the left (the end of a path says most); the marks keep the slashes in place.
        h('span', { class: 'muted tm-folder', title: folderOf(war.file) }, `\u200E${folderOf(war.file)}\u200E`),
        h('span', { class: 'muted', title: `Deploys as ${war.target}.war` }, `→ ${war.target}`),
        h('span', { class: 'muted', title: new Date(war.modified).toLocaleString() }, `built ${ago(war.modified)} · ${fmtBytes(war.bytes)}`),
        h(
          'div',
          { class: 'tm-actions' },
          revealButton({ file: war.file }, war.file),
          button('Deploy…', () => void openDeploy(war), { primary: war.fresh, disabled: busy || !s.settings.webappsDir, title: s.settings.webappsDir ? undefined : 'Set the webapps folder in Settings › Tomcat' }),
        ),
      ),
    );
  }
  return card('wars', 'WAR builds', s.settings.warWatch.length ? dirLabel(s.settings.warWatch.join(' · ')) : 'From the watch folders in Settings.', null, ...body);
}

function render(): void {
  const content = root().querySelector('.tm-content');
  const updated = root().querySelector('.tm-updated');
  if (!content || !updated) return;
  const s = T.state;
  updated.textContent = T.loadError ? `Could not refresh: ${T.loadError}` : s ? `Updated ${new Date().toLocaleTimeString()}` : 'Loading…';
  updated.classList.toggle('error', !!T.loadError);
  const banner = T.banner ? h('div', { class: `banner ${T.banner.kind}`, role: T.banner.kind === 'error' ? 'alert' : 'status' }, h('span', {}, T.banner.text)) : null;
  if (banner) {
    const close = h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Dismiss' }, '×');
    close.addEventListener('click', () => {
      T.banner = null;
      render();
    });
    banner.append(close);
  }
  if (!s) {
    content.replaceChildren(...[banner, h('div', { class: 'settings-loading' }, T.loadError ? `Could not load: ${T.loadError}` : 'Loading…')].filter((x): x is HTMLElement => !!x));
    return;
  }
  // Keep the script output scrolled to its end, unless the user scrolled up to read.
  const oldOut = content.querySelector<HTMLElement>('.tm-output');
  const stick = !oldOut || oldOut.scrollTop + oldOut.clientHeight >= oldOut.scrollHeight - 8;
  const focusedLabel = (document.activeElement as HTMLElement | null)?.closest('.tomcat') ? document.activeElement?.textContent : null;
  content.replaceChildren(...[banner, serverCard(s), webappsCard(s), disabledCard(s), warsCard(s)].filter((x): x is HTMLElement => !!x));
  const out = content.querySelector<HTMLElement>('.tm-output');
  if (out) out.scrollTop = stick ? out.scrollHeight : (oldOut?.scrollTop ?? 0);
  // A re-render replaces the buttons; keep keyboard focus roughly where it was.
  if (focusedLabel) [...content.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === focusedLabel)?.focus({ preventScroll: true });
}

function renderShell(): void {
  const back = h('button', { type: 'button', class: 'btn', title: 'Back to the timeline (Esc)' }, '← Timeline');
  back.addEventListener('click', () => closeTomcat());
  const refreshBtn = h('button', { type: 'button', class: 'btn' }, 'Refresh');
  refreshBtn.addEventListener('click', () => void refresh().then(render));
  const settingsBtn = h('button', { type: 'button', class: 'btn' }, 'Tomcat settings');
  settingsBtn.addEventListener('click', () => openSettings('tomcat-management'));
  root().replaceChildren(
    h('div', { class: 'tm-head' }, back, h('h1', {}, 'Tomcat'), h('span', { class: 'tm-updated', 'aria-live': 'polite' }), h('div', { class: 'spacer' }), refreshBtn, settingsBtn),
    h('div', { class: 'settings-scroll tm-scroll' }, h('div', { class: 'tm-content' })),
  );
  render();
}

// ── Delete dialog ───────────────────────────────────────

function deleteItemLine(item: DeleteItem): HTMLElement {
  let what: string;
  if (item.kind === 'war') what = `WAR · ${fmtBytes(item.bytes)}`;
  else if (item.kind === 'link') what = 'Link: only the link is removed, not what it points to';
  else what = `Unpacked folder · ${item.partial ? 'at least ' : ''}${item.files.toLocaleString()} file${item.files === 1 ? '' : 's'} · ${fmtBytes(item.bytes)}`;
  return h('li', {}, h('code', { title: item.path }, item.path), h('span', { class: 'muted' }, what));
}

/**
 * Confirms a delete, listing exactly what goes. The hub deletes only what was listed: if the
 * folder changed meanwhile, it refuses, and the list is loaded again.
 */
async function openDelete(app: WebappInfo): Promise<void> {
  document.querySelector('dialog.tm-delete')?.remove();
  const from: AppFolder = app.state === 'disabled' ? 'disabled' : 'webapps';
  const load = () => api<{ items: DeleteItem[] }>(`/api/tomcat/delete?name=${encodeURIComponent(app.name)}&from=${from}`).then((r) => r.items);
  let items: DeleteItem[];
  try {
    items = await load();
  } catch (err) {
    T.banner = { kind: 'error', text: (err as Error).message };
    if (T.open) render();
    return;
  }

  const list = h('ul', { class: 'tm-delete-list' });
  const error = h('div', { class: 'field-error', role: 'alert' });
  const ok = h('button', { type: 'submit', class: 'btn btn-danger' }, 'Delete') as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const show = () => {
    list.replaceChildren(...items.map(deleteItemLine));
    ok.disabled = !items.length;
    if (!items.length) list.append(h('li', { class: 'muted' }, 'Nothing left to delete.'));
  };
  show();

  const notes: Child[] = [];
  const mgr = T.state?.manager;
  if (from === 'webapps' && app.state === 'running' && mgr?.ok) notes.push(h('p', {}, 'It is running; it is stopped through the Tomcat Manager first.'));
  else if (from === 'webapps' && !mgr?.ok) {
    notes.push(h('p', { class: 'muted' }, 'If Tomcat is running, it undeploys the webapp once the WAR is gone. Files it still holds open are retried for a few seconds.'));
  }

  const form = h(
    'form',
    { method: 'dialog' },
    h('h2', {}, `Delete ${app.name}?`),
    h('p', {}, `These are deleted from the ${from === 'disabled' ? 'disabled webapps' : 'webapps'} folder:`),
    list,
    ...notes,
    h('p', { class: 'tm-danger-note' }, 'This cannot be undone: the files do not go to the Recycle Bin or Trash.'),
    error,
    h('div', { class: 'dialog-actions' }, cancel, ok),
  );
  const dialog = h('dialog', { class: 'dialog tm-delete' }, form) as HTMLDialogElement;
  document.body.append(dialog);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    ok.disabled = true;
    ok.textContent = 'Deleting…';
    error.textContent = '';
    const key = `app:${app.name}`;
    T.busy.add(key);
    if (T.open) render();
    try {
      const { message } = await api('/api/tomcat/delete', { name: app.name, from, items: items.map((i) => i.name) });
      T.banner = { kind: 'info', text: message };
      dialog.close();
    } catch (err) {
      error.textContent = (err as Error).message;
      ok.textContent = 'Delete';
      // Part of it may be gone now: show what is left, which is what Delete removes next time.
      items = await load().catch(() => items);
      show();
    } finally {
      T.busy.delete(key);
      await refresh();
      if (T.open) render();
    }
  });
  dialog.showModal();
  // The safe choice has the focus, so Enter does not delete.
  cancel.focus();
}

// ── Deploy dialog ───────────────────────────────────────

/** "config.yaml and config.js", "a, b and c". */
function andList(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : (items[0] ?? '');
}

/**
 * The "Keep config.yaml and config.js" choice: which files the deploy would carry over from the
 * copy it replaces, and whether each replaces the build's own or is added.
 */
function keepSection(preview: KeepPreview, box: HTMLInputElement): Child[] {
  const names = andList(preview.patterns);
  const from = preview.source?.where === 'disabled' ? 'disabled copy' : 'deployed copy';
  if (!preview.files.length) {
    return preview.source ? [h('p', { class: 'muted' }, `No ${names.replace(/ and /, ' or ')} in the ${from} to keep.`)] : [];
  }
  if (preview.problem) {
    box.checked = false;
    box.disabled = true;
  }
  const out: Child[] = [h('label', { class: 'check tm-check' }, box, ` Keep ${names} from the ${from}`)];
  if (preview.problem) out.push(h('p', { class: 'warn' }, preview.problem));
  out.push(
    h(
      'ul',
      { class: `tm-keep-list${box.checked ? '' : ' off'}` },
      ...preview.files.map((f) =>
        h('li', {}, h('code', {}, f.path), h('span', { class: 'muted' }, f.inWar === true ? 'replaces the build’s' : f.inWar === false ? 'added' : '')),
      ),
    ),
  );
  if (preview.truncated) out.push(h('p', { class: 'muted' }, 'The search stopped early; there may be more.'));
  if (box.checked) out.push(h('p', { class: 'muted' }, 'Written into the WAR before Tomcat sees it, so the webapp starts with them.'));
  return out;
}

/**
 * Asks for the webapp name and explains what the deploy will replace. A disabled webapp of the
 * same name is brought back by the deploy; its old copy is deleted unless the box is unticked.
 * Local config files in the copy being replaced can be kept (Settings › Tomcat › Files to keep).
 */
async function openDeploy(war: WarInfo): Promise<void> {
  document.querySelector('dialog.tm-deploy')?.remove();
  let state = T.state;
  try {
    state = await api<TomcatState>('/api/tomcat');
  } catch {
    /* use what is known */
  }
  const input = h('input', { type: 'text', class: 'input mono', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Deploy as' }) as HTMLInputElement;
  input.value = war.target;
  const removeOld = h('input', { type: 'checkbox' }) as HTMLInputElement;
  removeOld.checked = true;
  const keepBox = h('input', { type: 'checkbox' }) as HTMLInputElement;
  keepBox.checked = true;
  // What can be kept, for the name it was loaded for; reloaded as the name is edited.
  let keep: { name: string; preview: KeepPreview } | null = null;
  let keepTimer = 0;
  let keepSeq = 0;
  const loadKeep = async (name: string): Promise<void> => {
    const seq = ++keepSeq;
    let preview: KeepPreview | null = null;
    try {
      preview = await api<KeepPreview>(`/api/tomcat/keep?name=${encodeURIComponent(name)}&file=${encodeURIComponent(war.file)}`);
    } catch {
      /* no choice offered; the deploy works without it */
    }
    if (seq !== keepSeq) return;
    keep = preview ? { name, preview } : null;
    update();
  };
  const keepPaths = () => (keep && keepBox.checked && !keep.preview.problem ? keep.preview.files.map((f) => f.path) : []);
  const note = h('div', { class: 'tm-deploy-note' });
  const error = h('div', { class: 'field-error', role: 'alert' });
  const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Deploy') as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');

  const update = () => {
    error.textContent = '';
    const name = input.value.trim();
    const problem = nameProblem(name);
    const deployed = state?.webapps.find((a) => a.name === name && !a.external);
    const disabled = state?.disabled.find((a) => a.name === name);
    const parts: Child[] = [];
    let blocked = !!problem;
    if (problem) parts.push(h('p', { class: 'warn' }, problem));
    else if (!state?.settings.webappsDir) {
      blocked = true;
      parts.push(h('p', { class: 'warn' }, 'Set the webapps folder in ', settingsLink(), ' first.'));
    } else {
      parts.push(h('p', {}, `Copies it to webapps as `, h('code', {}, `${name}.war`), ` → ${contextPath(name)}`));
      if (deployed?.hasDir && !deployed.hasWar) {
        blocked = true;
        parts.push(h('p', { class: 'warn' }, `${name} is deployed as a folder without a WAR, and Tomcat would keep serving the folder. Disable ${name} first, then deploy.`));
      } else if (deployed) {
        parts.push(h('p', {}, `Replaces the deployed ${name}.war. Tomcat redeploys it within a few seconds (with autoDeploy on, its default).`));
      } else if (!disabled) {
        parts.push(h('p', {}, 'A new webapp. Tomcat deploys it within a few seconds.'));
      }
      if (disabled) {
        parts.push(
          h('p', { class: 'warn' }, `${name} is disabled. Deploying puts it back in webapps with this build.`),
          h('label', { class: 'check tm-check' }, removeOld, ` Delete the old disabled copy`),
          h('p', { class: 'muted' }, removeOld.checked ? 'It is an older build of the same webapp.' : `It stays in the disabled folder, but cannot be enabled while ${name} is deployed.`),
        );
      }
      const kept = !blocked && keep?.name === name ? keepSection(keep.preview, keepBox) : [];
      if (kept.length) parts.push(h('div', { class: 'tm-keep' }, ...kept));
    }
    note.replaceChildren(...parts.filter((p): p is Node => !!p));
    ok.disabled = blocked;
  };
  input.addEventListener('input', () => {
    update();
    clearTimeout(keepTimer);
    const name = input.value.trim();
    if (!nameProblem(name)) keepTimer = window.setTimeout(() => void loadKeep(name), 250);
  });
  removeOld.addEventListener('change', update);
  keepBox.addEventListener('change', update);
  update();
  void loadKeep(war.target);

  const form = h(
    'form',
    { method: 'dialog' },
    h('h2', {}, `Deploy ${war.name}`),
    h('p', { class: 'muted tm-deploy-meta', title: war.file }, `Built ${ago(war.modified)} · ${fmtBytes(war.bytes)} · ${folderOf(war.file)}`),
    h('label', { class: 'tm-deploy-label', for: 'tm-deploy-name' }, 'Deploy as'),
    input,
    note,
    error,
    h('div', { class: 'dialog-actions' }, cancel, ok),
  );
  input.id = 'tm-deploy-name';
  const dialog = h('dialog', { class: 'dialog tm-deploy' }, form) as HTMLDialogElement;
  document.body.append(dialog);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ok.disabled) return;
    ok.disabled = true;
    ok.textContent = 'Deploying…';
    const key = `war:${war.file}`;
    T.busy.add(key);
    try {
      const name = input.value.trim();
      // The name was just edited: find out what there is to keep for it before deploying.
      if (keep?.name !== name) {
        clearTimeout(keepTimer);
        await loadKeep(name);
        if (keep?.preview.files.length && keepBox.checked) {
          ok.textContent = 'Deploy';
          return void update();
        }
      }
      const body = { file: war.file, name, disabledCopy: removeOld.checked ? 'remove' : 'keep', keep: keepPaths() };
      const { message } = await api('/api/tomcat/deploy', body);
      T.banner = { kind: 'info', text: message };
      dropNotice(war.file);
      dialog.close();
      if (!T.open) toast(message);
    } catch (err) {
      error.textContent = (err as Error).message;
      ok.textContent = 'Deploy';
      update();
    } finally {
      T.busy.delete(key);
      await refresh();
      if (T.open) render();
    }
  });
  dialog.showModal();
  input.focus();
  input.select();
}

function toast(text: string): void {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 4000);
  setTimeout(() => el.remove(), 4400);
}

// ── New-WAR notifications ───────────────────────────────

function noticesHost(): HTMLElement {
  let host = document.getElementById('war-notices');
  if (!host) {
    host = h('div', { id: 'war-notices', class: 'war-notices', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

const ASKED_KEY = 'dh.notifyAsked';
function askedForNotifications(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === '1';
  } catch {
    return true;
  }
}

function renderNotices(): void {
  const host = noticesHost();
  const all = [...T.notices.values()].sort((a, b) => (a.modified < b.modified ? 1 : -1));
  const canAsk = 'Notification' in window && Notification.permission === 'default' && !askedForNotifications();
  const cards = all.slice(0, MAX_NOTICES).map((war, i) => {
    const deploy = button('Deploy…', () => void openDeploy(war), { primary: true });
    const dismiss = button('Dismiss', () => {
      dropNotice(war.file);
      void api('/api/tomcat/dismiss', { file: war.file }).catch(() => undefined).then(() => (T.open ? refresh() : undefined));
    });
    let ask: HTMLElement | null = null;
    if (canAsk && i === 0) {
      ask = h('button', { type: 'button', class: 'link tm-ask' }, 'Also notify me when Debug Hub is in the background');
      ask.addEventListener('click', async () => {
        try {
          localStorage.setItem(ASKED_KEY, '1');
        } catch {
          /* private mode: asked again next time */
        }
        await Notification.requestPermission().catch(() => undefined);
        renderNotices();
      });
    }
    return h(
      'div',
      { class: 'war-notice', role: 'status' },
      h('div', { class: 'war-notice-title' }, 'New WAR built'),
      h('div', { class: 'war-notice-name', title: war.file }, war.name),
      h('div', { class: 'muted' }, `${fmtBytes(war.bytes)} · deploys as ${war.target}`),
      h('div', { class: 'war-notice-actions' }, dismiss, deploy),
      ask,
    );
  });
  if (all.length > MAX_NOTICES) {
    const more = h('button', { type: 'button', class: 'link' }, `${all.length - MAX_NOTICES} more on the Tomcat page`);
    more.addEventListener('click', () => openTomcat());
    cards.push(h('div', { class: 'war-notice more' }, more));
  }
  host.replaceChildren(...cards);
  const badge = document.querySelector('#btn-tomcat .badge') as HTMLElement | null;
  if (badge) {
    badge.textContent = String(all.length);
    badge.hidden = all.length === 0;
  }
}

function dropNotice(file: string): void {
  if (T.notices.delete(file)) renderNotices();
}

/** Notices follow the hub: a build deployed or dismissed in another window goes away here too. */
function syncNoticesFrom(wars: WarInfo[]): void {
  const fresh = new Map(wars.filter((w) => w.fresh).map((w) => [w.file, w]));
  let changed = false;
  for (const file of T.notices.keys()) {
    if (!fresh.has(file)) {
      T.notices.delete(file);
      changed = true;
    }
  }
  for (const [file, w] of fresh) {
    if (T.notices.get(file)?.sig !== w.sig) {
      T.notices.set(file, w);
      changed = true;
    }
  }
  if (changed) renderNotices();
}

function systemNotify(war: WarInfo): void {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  try {
    const n = new Notification('New WAR ready to deploy', { body: `${war.name}\nDeploys as ${war.target}`, tag: war.file });
    n.onclick = () => {
      window.focus();
      n.close();
      void openDeploy(war);
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

/** A WAR finished building (pushed over the WebSocket). */
export function onWarNotice(war: WarInfo): void {
  T.notices.set(war.file, war);
  renderNotices();
  systemNotify(war);
  if (T.open) void refresh();
}

/** Picks up builds announced while this page was closed or disconnected. */
export async function syncWarNotices(): Promise<void> {
  try {
    syncNoticesFrom(await api<WarInfo[]>('/api/tomcat/wars'));
  } catch {
    /* offline; the socket reconnects and calls this again */
  }
}

// ── Public ──────────────────────────────────────────────

export function tomcatOpen(): boolean {
  return T.open;
}

export function openTomcat(): void {
  if (!closeSettings()) return;
  if (location.hash !== '#tomcat') history.replaceState(null, '', '#tomcat');
  if (T.open) return;
  T.open = true;
  T.banner = null;
  root().hidden = false;
  document.body.classList.add('tomcat-open');
  onToggle(true);
  renderShell();
  void refresh().then(() => {
    render();
    schedule();
  });
}

export function closeTomcat(): void {
  if (!T.open) return;
  T.open = false;
  clearTimeout(T.timer);
  document.querySelector<HTMLDialogElement>('dialog.tm-deploy')?.close();
  document.querySelector<HTMLDialogElement>('dialog.tm-delete')?.close();
  root().hidden = true;
  root().replaceChildren();
  document.body.classList.remove('tomcat-open');
  if (location.hash === '#tomcat') history.replaceState(null, '', location.pathname + location.search);
  onToggle(false);
}

/** Call after initSettings: the settings screen handles a hash change first. */
export function initTomcat(opts: { onToggle: (open: boolean) => void }): void {
  onToggle = opts.onToggle;
  const sync = () => {
    if (location.hash === '#tomcat') {
      // Settings stayed open because the user kept unsaved changes.
      if (settingsOpen()) history.replaceState(null, '', '#settings');
      else openTomcat();
    } else if (T.open) closeTomcat();
  };
  window.addEventListener('hashchange', sync);
  sync();

  document.addEventListener('keydown', (e) => {
    if (!T.open || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    if (t.matches('input, select, textarea')) t.blur();
    else closeTomcat();
  });
  renderNotices();
  void syncWarNotices();
}
