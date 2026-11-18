import type { KeepComparePreview } from '../shared/keepmerge';
import type { AppFolder, CommandRun, DeleteItem, LaunchWay, RestartState, ScriptKind, StartCommandInfo, StartStep, TomcatState, WarInfo, WebappAction, WebappInfo } from '../shared/tomcat';
import { $, fmtBytes, h, type Child } from './dom';
import { confirmStopOwnTomcat, hostedNote, onHubMachine, SELF_WHY } from './hosted';
import { packageNoticeCount, packageNotices, packagesCard, syncPackages } from './registry';
import { KeepFiles } from './keepfiles';
import { closeSettings, openSettings, settingsOpen } from './settings';
import { TomcatConsole } from './tomcatconsole';

/**
 * The Tomcat page: start and stop the server (with the user's scripts or Tomcat's own, along with
 * the start commands that bring up the rest of the dev setup), start, stop, disable and enable
 * webapps, and deploy WARs from the build folders. Also the new-WAR notifications, which
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
  /**
   * Actions in flight, by key ("app:shop", "script:start", "war:<file>", "cmd:<index>", "run:<id>"),
   * with what to show beside a spinner meanwhile ("Reloading…").
   */
  busy: new Map<string, string>(),
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
  // It opens a window on the hub's machine: no use from another computer (hub inside Tomcat).
  b.hidden = !onHubMachine();
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
  // Faster while something is under way; a Tomcat running in the foreground is not that (its output is in the console).
  const start = T.state?.scripts.start;
  const starting = !!start?.running && (!start.foreground || Date.now() - Date.parse(start.startedAt) < 60_000);
  const running = !!(starting || T.state?.scripts.stop?.running || T.state?.sequence?.running || T.state?.restart?.running);
  T.timer = window.setTimeout(async () => {
    if (!document.hidden) await refresh();
    schedule();
  }, running ? POLL_RUNNING_MS : POLL_MS);
}

/** Runs an action, shows its outcome in the banner and reloads the state. */
async function act(key: string, run: () => Promise<string | undefined>, doing = 'Working…'): Promise<void> {
  T.busy.set(key, doing);
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

const DOING: Record<WebappAction, string> = { start: 'Starting…', stop: 'Stopping…', reload: 'Reloading…', disable: 'Disabling…', enable: 'Enabling…' };

const webappAction = (app: WebappInfo, action: WebappAction) =>
  act(`app:${app.name}`, async () => (await api(`/api/tomcat/webapps/${encodeURIComponent(app.name)}/${action}`, {})).message, DOING[action]);

/** A spinner and what is happening, shown beside a row's buttons while its action runs. */
function busyNote(key: string): HTMLElement | null {
  const doing = T.busy.get(key);
  return doing ? h('span', { class: 'tm-busy', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), doing) : null;
}

const scriptAction = (kind: ScriptKind, only = false) =>
  act(`script:${kind}`, async () => {
    // Debug Hub running inside this Tomcat: stopping it stops this page too, so ask first.
    const self = kind === 'stop' && !!T.state?.hosted;
    if (self && !(await confirmStopOwnTomcat())) return undefined;
    // The output panel and the start steps show how it went.
    await api(`/api/tomcat/server/${kind}${self ? '?self=1' : ''}`, kind === 'start' ? { only } : {});
    return self ? 'Stopping Tomcat, and Debug Hub with it. Start Tomcat yourself to get this page back.' : undefined;
  });

const restartTomcat = () =>
  act('script:restart', async () => {
    await api('/api/tomcat/server/restart', {});
    return undefined;
  }, 'Restarting…');

const killTomcat = () => act('script:kill', async () => (await api('/api/tomcat/server/kill', {})).message, 'Ending Tomcat…');

const runCommand = (c: StartCommandInfo) =>
  act(`cmd:${c.index}`, async () => {
    await api(`/api/tomcat/commands/${c.index}/run`, { command: c.command });
    return undefined;
  });

const stopRun = (run: CommandRun) => act(`run:${run.id}`, async () => (await api(`/api/tomcat/runs/${run.id}/stop`, {})).message);

// ── Page ────────────────────────────────────────────────

// Sections can be folded away; which ones are remembered.
const COLLAPSED_KEY = 'dh.tomcat.collapsed';
const collapsed: Set<string> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set<string>();
  }
})();

function setCollapsed(id: string, fold: boolean): void {
  if (fold) collapsed.add(id);
  else collapsed.delete(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* private mode: not remembered */
  }
}

function chevron(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'card-chev');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M4 6l4 4 4-4');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.8');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

/**
 * A section of the page. Its title folds it away and back (remembered); `count`, when given,
 * shows beside the title so a folded section still says what is in it.
 */
function card(id: string, title: string, desc: Child, tools: Child, ...body: Child[]): HTMLElement {
  return foldCard(id, title, null, desc, tools, ...body);
}

function foldCard(id: string, title: string, count: number | null, desc: Child, tools: Child, ...body: Child[]): HTMLElement {
  const folded = collapsed.has(id);
  const bodyEl = h('div', { class: 'card-body', id: `tm-${id}-body` }, ...body);
  bodyEl.hidden = folded;
  const toggle = h(
    'button',
    { type: 'button', class: 'card-toggle', 'aria-expanded': String(!folded), 'aria-controls': `tm-${id}-body`, title: folded ? `Show ${title}` : `Hide ${title}` },
    chevron(),
    h('h2', {}, title),
    count != null ? h('span', { class: 'card-count' }, count.toLocaleString()) : null,
  );
  const section = h(
    'section',
    { class: `card card-fold${folded ? ' folded' : ''}`, id: `tm-${id}` },
    h('header', { class: 'card-head' }, h('div', {}, toggle, desc && !folded ? h('p', {}, desc) : null), h('div', { class: 'card-tools' }, tools)),
    bodyEl,
  );
  toggle.addEventListener('click', () => {
    setCollapsed(id, !collapsed.has(id));
    if (T.open) render();
    // The re-render replaced the button: keep the focus on the new one.
    document.querySelector<HTMLElement>(`#tm-${CSS.escape(id)} .card-toggle`)?.focus({ preventScroll: true });
  });
  return section;
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

const RESTART_PHASE: Record<RestartState['phase'], string> = {
  stopping: 'Stopping Tomcat…',
  waiting: 'Waiting for Tomcat to stop…',
  starting: 'Starting Tomcat…',
  done: 'Restarted Tomcat',
  failed: 'Restart failed',
};

/** How Restart is getting on, while it runs and for a little while after. */
function restartPanel(s: TomcatState): HTMLElement | null {
  const r = s.restart;
  if (!r) return null;
  const recent = r.endedAt && Date.now() - Date.parse(r.endedAt) < 20_000;
  if (!r.running && !recent && r.phase !== 'failed') return null;
  if (r.running) {
    return h('div', { class: 'tm-restart running', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('b', {}, RESTART_PHASE[r.phase]), h('span', { class: 'muted' }, `started ${time(r.startedAt)}`));
  }
  return h('div', { class: `tm-restart ${r.phase}`, role: 'status' }, h('b', {}, r.phase === 'done' ? `Restarted Tomcat at ${time(r.endedAt!)}` : r.message ?? RESTART_PHASE.failed));
}

let tconsole: TomcatConsole | null = null;
function theConsole(): TomcatConsole {
  tconsole ??= new TomcatConsole({ kill: () => killTomcat() });
  return tconsole;
}

/** Tomcat's output (and its shutdown's and the start commands'), like a terminal. */
function consoleCard(s: TomcatState): HTMLElement {
  const l = s.launch;
  const desc =
    l.start.how === 'tomcat'
      ? 'What Tomcat prints, running in the foreground with catalina run; the shutdown and start commands beside it.'
      : l.start.how === 'script'
        ? 'What your start script prints (all of Tomcat’s output, if it keeps Tomcat in the foreground), the stop script and start commands.'
        : 'Tomcat’s output once it is started from here.';
  return foldCard('console', 'Console', null, desc, null, theConsole().el);
}

/** Which way Start or Stop runs: the user's script, or Tomcat's own one in its bin folder. */
function launchLabel(s: TomcatState, way: LaunchWay): HTMLElement {
  if (way.how === 'script') return h('span', { class: 'tm-how' }, 'Your script ', h('code', { class: 'tm-dir', title: way.path ?? '' }, way.path ?? ''));
  if (way.how === 'tomcat') {
    const args = way.args?.length ? ` ${way.args.join(' ')}` : '';
    return h('span', { class: 'tm-how' }, `Tomcat’s bin/${fileName(way.path ?? '')}${args} in `, h('code', { class: 'tm-dir', title: s.launch.home ?? '' }, s.launch.home ?? ''));
  }
  return h('span', { class: 'muted' }, 'Not set up');
}

/** CATALINA_BASE and JAVA_HOME, when Tomcat's own scripts are used: what catalina.bat will be given. */
function launchDetails(s: TomcatState): HTMLElement | null {
  const l = s.launch;
  if (l.start.how !== 'tomcat' && l.stop.how !== 'tomcat') return null;
  const parts: Child[] = [];
  if (l.base && l.base !== l.home) parts.push(h('span', {}, 'CATALINA_BASE ', h('code', {}, l.base)));
  const javaFrom = { settings: 'from Settings', environment: 'from Debug Hub’s environment', setenv: 'set in Tomcat’s bin/setenv' };
  if (l.javaSource === 'setenv') parts.push(h('span', {}, `JAVA_HOME ${javaFrom.setenv}`));
  else if (l.javaHome) parts.push(h('span', {}, 'JAVA_HOME ', h('code', {}, l.javaHome), ` ${javaFrom[l.javaSource ?? 'environment']}`));
  if (l.homeSource === 'webapps') parts.push(h('span', {}, 'Tomcat folder found above webapps'));
  return parts.length ? h('div', { class: 'tm-launch muted' }, ...parts) : null;
}

function serverCard(s: TomcatState): HTMLElement {
  const seqRunning = !!s.sequence?.running;
  const hasExtras = s.commands.length > 0 || s.settings.startChrome;
  const row = (kind: ScriptKind) => {
    const way = s.launch[kind];
    const run = s.scripts[kind];
    // Debug Hub runs inside this Tomcat: it is running, so there is nothing to start.
    const ownRunning = kind === 'start' && !!s.hosted;
    const restarting = !!s.restart?.running || T.busy.has('script:restart');
    const busy = T.busy.has(`script:${kind}`) || !!run?.running || (kind === 'start' && seqRunning) || ownRunning || restarting;
    const label = kind === 'start' ? 'Start Tomcat' : 'Stop Tomcat';
    const what = way.how === 'script' ? way.path : way.how === 'tomcat' ? `Tomcat’s ${fileName(way.path ?? '')}` : '';
    const why = ownRunning
      ? 'This Tomcat is running: Debug Hub runs inside it'
      : restarting
      ? 'Tomcat is being restarted'
      : run?.running && run.foreground
      ? 'Tomcat is running. Restart starts it afresh.'
      : run?.running
      ? 'The last run has not finished yet'
      : kind === 'start' && seqRunning
        ? 'Tomcat is being started'
        : way.how === 'none'
          ? 'Set the Tomcat folder or a script in Settings › Tomcat server'
          : kind === 'start' && hasExtras
            ? `Runs the start commands, then ${what}${s.settings.startChrome ? ', then starts Chrome' : ''}`
            : `Runs ${what}`;
    const buttons: HTMLElement[] = [];
    if (kind === 'stop') {
      // Restart: stop, wait until Tomcat is gone, start Tomcat alone.
      const cannot = s.launch.start.how === 'none' || way.how === 'none';
      buttons.push(
        button(restarting ? 'Restarting…' : 'Restart', () => void restartTomcat(), {
          disabled: cannot || restarting || seqRunning || !!s.hosted || T.busy.has('script:stop'),
          title: s.hosted
            ? 'Debug Hub runs inside this Tomcat, so it cannot restart it'
            : cannot
              ? 'Set the Tomcat folder or scripts in Settings › Tomcat server'
              : 'Stop Tomcat, wait until it has stopped, and start it again (without the start commands or Chrome)',
        }),
      );
    }
    buttons.push(
      button(T.busy.has(`script:${kind}`) ? 'Running…' : label, () => void scriptAction(kind), { primary: kind === 'start', disabled: way.how === 'none' || busy, title: why }),
    );
    if (kind === 'start' && hasExtras) {
      buttons.push(button('Tomcat only', () => void scriptAction('start', true), { disabled: way.how === 'none' || busy, title: 'Start Tomcat without the start commands or Chrome' }));
    }
    return h(
      'div',
      { class: 'tm-script' },
      h('span', { class: 'tm-script-label' }, kind === 'start' ? 'Start' : 'Stop'),
      launchLabel(s, way),
      h('div', { class: 'tm-actions' }, ...buttons),
    );
  };
  const mgr = s.manager;
  const fg = s.scripts.start?.running && s.scripts.start.foreground ? s.scripts.start : null;
  const tools = h(
    'div',
    { class: 'card-status' },
    fg ? h('span', { class: 'collector connected', title: `Started from here at ${time(fg.startedAt)}` }, `Tomcat running${fg.pid ? ` · process ${fg.pid}` : ''}`) : null,
    mgr.configured
      ? h('span', { class: `collector ${mgr.ok ? 'connected' : 'off'}`, title: mgr.error ?? s.settings.managerUrl }, mgr.ok ? 'Manager connected' : 'Manager unreachable')
      : null,
  );
  const body: Child[] = [hostedNote(s), row('start'), row('stop'), launchDetails(s), ...problemNotes(['startScript', 'stopScript'])];
  const l = s.launch;
  if (l.start.how === 'none' && l.stop.how === 'none' && !l.home) {
    body.push(missing('Set the Tomcat folder (CATALINA_HOME) to start and stop Tomcat with its own startup and shutdown scripts, or add your own scripts, in ', settingsLink(), '.'));
  } else {
    for (const text of [...l.problems, ...l.warnings]) body.push(h('div', { class: 'tm-note warn' }, text, ' ', settingsLink('Fix in Settings')));
  }
  if (mgr.configured && !mgr.ok && mgr.error) body.push(h('div', { class: 'tm-note warn' }, mgr.error));
  body.push(restartPanel(s), sequencePanel(s), commandsPanel(s));
  return card('server', 'Server', 'Start and stop Tomcat, and the rest of your dev setup with it.', tools, ...body);
}

const STEP_LABEL: Record<StartStep['status'], string> = { waiting: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

/** The steps of the latest Start Tomcat, while it runs and after. Not shown for Tomcat alone. */
function sequencePanel(s: TomcatState): HTMLElement | null {
  const seq = s.sequence;
  if (!seq || seq.steps.length < 2) return null;
  const at = seq.steps.findIndex((x) => x.status === 'running');
  const head = seq.running
    ? h('span', { class: 'tm-run running' }, `Step ${at + 1} of ${seq.steps.length}: ${seq.steps[at]?.label ?? ''}`)
    : h('span', { class: `tm-run ${seq.outcome === 'ok' ? 'ok' : 'error'}` }, seq.message ?? '');
  return h(
    'div',
    { class: 'tm-seq' },
    h('div', { class: 'tm-run-head' }, h('b', {}, 'Start Tomcat'), h('span', { class: 'muted' }, `started ${time(seq.startedAt)}`), head),
    h(
      'ol',
      { class: 'tm-steps' },
      ...seq.steps.map((step) =>
        h(
          'li',
          { class: `tm-step ${step.status}` },
          h('span', { class: 'tm-step-state', title: STEP_LABEL[step.status] }, STEP_LABEL[step.status]),
          h('b', {}, step.label),
          step.detail ? h('span', { class: 'muted' }, step.detail) : null,
        ),
      ),
    ),
  );
}

function runStatus(run: CommandRun | null): HTMLElement {
  if (!run) return h('span', { class: 'tm-run muted' }, 'Not run yet');
  if (run.error) return h('span', { class: 'tm-run error', title: run.error }, 'Failed to start');
  if (run.running) return h('span', { class: 'tm-run running' }, `Running${run.pid ? ` (process ${run.pid})` : ''}`);
  const when = run.endedAt ? ` at ${time(run.endedAt)}` : '';
  if (run.stopped) return h('span', { class: 'tm-run muted' }, `Stopped${when}`);
  if (run.exitCode === 0) return h('span', { class: 'tm-run ok' }, `Finished${when}`);
  return h('span', { class: 'tm-run error' }, `${run.exitCode != null ? `Exited with code ${run.exitCode}` : `Ended by ${run.signal}`}${when}`);
}

/** The last few lines a command printed; the timeline has all of it. */
function lastLines(run: CommandRun | null, n = 6): HTMLElement | null {
  if (!run) return null;
  const text = run.error ? run.error : run.output.replace(/\s+$/, '');
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  return h('pre', { class: 'code tm-cmd-out', title: 'The end of its output. All of it is on the timeline.' }, (lines.length > n || run.outputTruncated ? '…\n' : '') + lines.slice(-n).join('\n'));
}

function commandRow(c: StartCommandInfo | null, run: CommandRun | null, n: number | null): HTMLElement {
  const actions: HTMLElement[] = [];
  if (run?.running) {
    actions.push(button(T.busy.has(`run:${run.id}`) ? 'Stopping…' : 'Stop', () => void stopRun(run), { disabled: T.busy.has(`run:${run.id}`), title: 'End it and everything it started' }));
  } else if (c) {
    actions.push(button('Run', () => void runCommand(c), { disabled: T.busy.has(`cmd:${c.index}`), title: 'Run just this command now' }));
  }
  const name = c ? c.name || c.command : run!.name;
  const command = c?.command ?? run!.command;
  const cwd = c?.cwd ?? run!.cwd;
  const tags = c ? [h('span', { class: 'tm-tag', title: c.wait ? 'Start Tomcat waits for it to finish, and stops if it fails' : 'Started and left running' }, c.wait ? 'waits' : 'keeps running')] : [h('span', { class: 'tm-tag' }, 'no longer in Settings')];
  return h(
    'div',
    { class: 'tm-cmd-row' },
    h('div', { class: 'tm-cmd-main' },
      h('div', { class: 'tm-name' }, n != null ? h('span', { class: 'muted' }, `${n}.`) : null, h('b', {}, name), ...tags),
      h('code', { class: 'tm-cmd', title: `In ${cwd}` }, command),
      h('span', { class: 'muted tm-folder', title: cwd }, `\u200E${cwd}\u200E`),
    ),
    h('div', {}, runStatus(run)),
    h('div', { class: 'tm-actions' }, ...actions),
    lastLines(run),
  );
}

function commandsPanel(s: TomcatState): HTMLElement | null {
  if (!s.commands.length && !s.otherRuns.length) {
    return s.settings.startChrome
      ? null
      : h('div', { class: 'tm-note' }, 'Start your database, dev servers and watchers along with Tomcat: add start commands in ', settingsLink(), '.');
  }
  const order = [s.commands.length ? 'the start commands in order' : '', 'Tomcat', s.settings.startChrome ? 'Chrome' : ''].filter(Boolean).join(', then ');
  return h(
    'div',
    { class: 'tm-cmds' },
    h('div', { class: 'tm-run-head' }, h('b', {}, 'Start commands'), h('span', { class: 'muted' }, `Start Tomcat runs ${order}.`), settingsLink('Edit')),
    ...s.commands.map((c, i) => commandRow(c, c.run, i + 1)),
    ...s.otherRuns.map((r) => commandRow(null, r, null)),
  );
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
  // Debug Hub's own webapp (when it runs inside this Tomcat) is guarded like the Manager's.
  const self = app.self === true && app.state !== 'disabled';
  const own = isManagerApp(s, app) || self;
  const ownWhy = self ? SELF_WHY : 'This is the Manager itself';
  if (mgr.configured && app.state !== 'disabled') {
    const why = !mgr.ok ? 'The Tomcat Manager cannot be reached' : undefined;
    if (app.state === 'running') {
      actions.push(button('Reload', () => void webappAction(app, 'reload'), { disabled: busy || !mgr.ok || self, title: self ? SELF_WHY : (why ?? 'Restart it, reloading classes and config') }));
      actions.push(button('Stop', () => void webappAction(app, 'stop'), { disabled: busy || !mgr.ok || own, title: own ? ownWhy : why }));
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
        title: own ? ownWhy : noDir ? 'Set a folder for disabled webapps in Settings › Tomcat' : 'Move it out of webapps so Tomcat forgets it',
      }),
    );
  }
  if (!app.external) {
    actions.push(
      button('Delete…', () => void openDelete(app), {
        danger: true,
        disabled: busy || (own && app.state !== 'disabled'),
        title: own && app.state !== 'disabled' ? ownWhy : `Delete its files from the ${app.state === 'disabled' ? 'disabled' : 'webapps'} folder for good`,
      }),
    );
  }
  const kinds = [app.hasWar && 'WAR', app.hasDir && 'folder', app.external && 'outside webapps'].filter(Boolean) as string[];
  // Inside this Tomcat, the page itself is served from where the webapps are.
  const origin = mgr.origin ?? (s.hosted ? location.origin : null);
  const linkable = origin && (app.state === 'running' || (!mgr.ok && app.state === 'deployed' && !!s.hosted));
  const path = linkable ? h('a', { href: origin + app.path, target: '_blank', rel: 'noopener', class: 'tm-path', title: `Open ${origin}${app.path}` }, app.path) : h('span', { class: 'tm-path' }, app.path);
  return h(
    'div',
    { class: `tm-row${busy ? ' busy' : ''}` },
    h('div', { class: 'tm-name' }, h('b', {}, app.name), ...kinds.map((k) => h('span', { class: 'tm-tag' }, k)), self ? h('span', { class: 'tm-tag self', title: SELF_WHY }, 'Debug Hub') : null),
    path,
    h('div', {}, stateBadge(app.state), app.sessions ? h('span', { class: 'muted tm-sessions' }, `${app.sessions} session${app.sessions === 1 ? '' : 's'}`) : null),
    // While an action runs, the spinner takes the place beside the buttons.
    busyNote(`app:${app.name}`) ?? h('span', { class: 'muted', title: app.modified ? new Date(app.modified).toLocaleString() : '' }, [ago(app.modified), fmtBytes(app.bytes)].filter(Boolean).join(' · ')),
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
  return foldCard('webapps', 'Webapps', s.settings.webappsDir ? s.webapps.length : null, dirLabel(s.settings.webappsDir), tools, ...body);
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
  return foldCard('disabled', 'Disabled webapps', s.settings.disabledDir ? s.disabled.length : null, dirLabel(s.settings.disabledDir), tools, ...body);
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
  return foldCard('wars', 'WAR builds', s.settings.warWatch.length ? s.wars.length : null, s.settings.warWatch.length ? dirLabel(s.settings.warWatch.join(' · ')) : 'From the watch folders in Settings.', null, ...body);
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
  // The console is kept across redraws: its output, and where it is scrolled to.
  const con = theConsole();
  const consoleFocused = con.el.contains(document.activeElement);
  const focusedInConsole = consoleFocused ? (document.activeElement as HTMLElement) : null;
  con.detach();
  const focusedLabel = !consoleFocused && (document.activeElement as HTMLElement | null)?.closest('.tomcat') ? document.activeElement?.textContent : null;
  content.replaceChildren(...[banner, serverCard(s), consoleCard(s), webappsCard(s), disabledCard(s), warsCard(s), packagesCard(!!s.settings.webappsDir)].filter((x): x is HTMLElement => !!x));
  con.update(s.consoles, T.open && !collapsed.has('console'));
  con.attached();
  // Moving the console out and back took the focus from it.
  if (consoleFocused && focusedInConsole?.isConnected) focusedInConsole.focus({ preventScroll: true });
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
    T.busy.set(key, 'Deleting…');
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

/**
 * Asks for the webapp name and explains what the deploy will replace. A disabled webapp of the
 * same name is brought back by the deploy; its old copy is deleted unless the box is unticked.
 * Local config files in the copy being replaced (Settings › Tomcat › Files to keep) can each be
 * kept, replaced by the build's, or merged with it: see keepfiles.ts.
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
  // What can be kept, for the name it was loaded for; reloaded as the name is edited.
  const keep = new KeepFiles({ api, war, changed: () => update() });
  let keepTimer = 0;
  let keepSeq = 0;
  const loadKeep = async (name: string): Promise<void> => {
    const seq = ++keepSeq;
    let preview: KeepComparePreview | null = null;
    try {
      preview = await api<KeepComparePreview>(`/api/tomcat/keep/compare?name=${encodeURIComponent(name)}&file=${encodeURIComponent(war.file)}`);
    } catch {
      /* no choice offered; the deploy works without it */
    }
    if (seq !== keepSeq) return;
    keep.set(name, preview);
    update();
  };
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
    }
    note.replaceChildren(...parts.filter((p): p is Node => !!p));
    keep.show(!blocked && keep.name === name);
    ok.disabled = blocked;
  };
  input.addEventListener('input', () => {
    update();
    clearTimeout(keepTimer);
    const name = input.value.trim();
    if (!nameProblem(name)) keepTimer = window.setTimeout(() => void loadKeep(name), 250);
  });
  removeOld.addEventListener('change', update);
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
    keep.el,
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
    T.busy.set(key, 'Deploying…');
    try {
      const name = input.value.trim();
      // The name was just edited: find out what there is to keep for it before deploying.
      if (keep.name !== name) {
        clearTimeout(keepTimer);
        await loadKeep(name);
        if (keep.hasChoices) {
          ok.textContent = 'Deploy';
          return void update();
        }
      }
      const tooLarge = keep.tooLarge();
      if (tooLarge) throw new Error(tooLarge);
      const body = { file: war.file, name, disabledCopy: removeOld.checked ? 'remove' : 'keep', ...keep.choices() };
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
  // New versions in the package registries (src/ui/registry.ts) are announced in the same stack.
  host.replaceChildren(...cards, ...packageNotices(Math.max(1, MAX_NOTICES - cards.length)));
  const badge = document.querySelector('#btn-tomcat .badge') as HTMLElement | null;
  const count = all.length + packageNoticeCount();
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
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
  void syncPackages();
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
  tconsole?.setActive(false);
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

// ── For the Packages card and its notices (src/ui/registry.ts) ──
// They are part of this page and look like the rest of it, so they are built from its parts.
export { ago, api, button, card, missing, openDeploy, renderNotices };
