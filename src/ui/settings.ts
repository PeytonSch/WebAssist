import type { DesktopBridge } from '../desktop/preload';
import type { ChromeSetup } from '../server/chrome-launch';
import type { EditorKind, ProgramLocation } from '../server/source/editor';
import type { IndexStatus } from '../server/source/index';
import type { Config, FieldError, StartCommand } from '../server/config';
import { chromeArgs, chromeCommandLines, typicalChromePath } from '../shared/chrome-command';
import type { HubStatus } from '../shared/types';
import { CHROME_LAUNCH_EVENT, chromeButton, chromeLaunchNote } from './chrome';
import { $, fmtBytes, h, type Child } from './dom';
import { decorateSettings, type Detected } from './hosted';
import { registryFields } from './registrysettings';
import { guideOpen, openSetupGuide } from './setupguide';

/**
 * The settings screen. It edits a draft copy of the config file; Save sends the whole draft to
 * the hub, which checks it, applies it to the running collectors and writes the file. Errors
 * come back keyed by setting ("tomcat.appLogs.1") and are shown beside that control.
 */

interface Loaded {
  file: string;
  config: Config;
  defaults: Config;
  error: string | null;
  runningPort: number;
}

interface PatternResult {
  pattern: string;
  resolved: string;
  files: { path: string; bytes: number; modified: string }[];
  problem: string | null;
}

interface FolderScan {
  dir: string;
  app: PatternResult['files'];
  access: PatternResult['files'];
  skipped: number;
  problem: string | null;
}

/** Present in the desktop app only (src/desktop/preload.ts). */
const desktop = (window as unknown as { debugHubDesktop?: DesktopBridge }).debugHubDesktop;
const isWindows = /Windows/.test(navigator.userAgent);
const isMac = /Macintosh/.test(navigator.userAgent);

const S = {
  open: false,
  loaded: null as Loaded | null,
  draft: null as Config | null,
  savedJson: '',
  saving: false,
  restartNeeded: false,
  status: null as HubStatus | null,
  errorSlots: new Map<string, HTMLElement>(),
  /** Re-run after every change, for text that depends on other settings. */
  derived: [] as (() => void)[],
  statusSlots: [] as { el: HTMLElement; names: string[] }[],
};

let onToggle: (open: boolean) => void = () => undefined;
const root = () => $('settings');
let pendingSection: string | null = null;

function scrollToPending(): void {
  if (!pendingSection || !S.draft) return;
  if (pendingSection === 'setup') {
    pendingSection = null;
    launchGuide(true);
    return;
  }
  root().querySelector(`#set-${CSS.escape(pendingSection)}`)?.scrollIntoView({ block: 'start' });
  pendingSection = null;
}

// ── Draft access ────────────────────────────────────────

function getPath(path: string): any {
  return path.split('.').reduce<any>((o, k) => o?.[k], S.draft);
}
function setPath(path: string, value: unknown): void {
  const keys = path.split('.');
  let o: any = S.draft;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys[keys.length - 1]] = value;
}
const dirty = () => !!S.draft && JSON.stringify(S.draft) !== S.savedJson;

function change(path: string, value: unknown): void {
  setPath(path, value);
  clearError(path);
  S.derived.forEach((fn) => fn());
  renderFooter();
}

// ── Errors ──────────────────────────────────────────────

function clearError(path: string): void {
  const slot = S.errorSlots.get(path);
  if (!slot) return;
  slot.textContent = '';
  slot.closest('.field, .list-row, .gq')?.classList.remove('invalid');
}

function showErrors(errors: FieldError[]): void {
  for (const path of S.errorSlots.keys()) clearError(path);
  const unplaced: string[] = [];
  let first: HTMLElement | null = null;
  for (const e of errors) {
    // A list entry without its own slot falls back to the list's.
    let key = e.path;
    while (key && !S.errorSlots.has(key)) key = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : '';
    const slot = key ? S.errorSlots.get(key) : undefined;
    if (!slot) {
      unplaced.push(e.message);
      continue;
    }
    slot.textContent = e.message;
    const host = slot.closest<HTMLElement>('.field, .list-row, .gq');
    host?.classList.add('invalid');
    first ??= host ?? slot;
  }
  renderBanner(
    errors.length
      ? { kind: 'error', text: `${errors.length === 1 ? 'One setting needs' : `${errors.length} settings need`} fixing before saving.${unplaced.length ? ` ${unplaced.join(' ')}` : ''}` }
      : null,
  );
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  first?.querySelector<HTMLInputElement>('input, select')?.focus({ preventScroll: true });
}

// ── Controls ────────────────────────────────────────────

let uid = 0;
const nextId = () => `s-${++uid}`;

function field(path: string | null, label: string, control: HTMLElement, help?: Child, opts: { wide?: boolean } = {}): HTMLElement {
  const err = h('div', { class: 'field-error', role: 'alert' });
  const target = control.matches('input, select') ? control : control.querySelector<HTMLElement>('input:not([type=checkbox]), select');
  let labelEl: HTMLElement;
  if (target) {
    target.id ||= nextId();
    labelEl = h('label', { for: target.id }, label);
  } else {
    labelEl = h('span', {}, label);
    control.setAttribute('aria-label', label);
  }
  const el = h(
    'div',
    { class: `field${opts.wide ? ' wide' : ''}` },
    h('div', { class: 'field-label' }, labelEl, help ? h('div', { class: 'field-help' }, help) : null),
    h('div', { class: 'field-control' }, control, err),
  );
  if (path) S.errorSlots.set(path, err);
  return el;
}

function textInput(path: string, opts: { placeholder?: string; mono?: boolean } = {}): HTMLInputElement {
  const el = h('input', {
    type: 'text',
    class: `input${opts.mono ? ' mono' : ''}`,
    placeholder: opts.placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
  }) as HTMLInputElement;
  el.value = String(getPath(path) ?? '');
  el.addEventListener('input', () => change(path, el.value));
  return el;
}

/** `scale` converts between the stored unit and the shown one, e.g. 1024 to show bytes as kB. */
function numberInput(path: string, opts: { min: number; max: number; unit?: string; scale?: number }): HTMLElement {
  const scale = opts.scale ?? 1;
  const input = h('input', {
    type: 'number',
    class: 'input num',
    min: String(opts.min / scale),
    max: String(opts.max / scale),
    step: '1',
    inputmode: 'numeric',
  }) as HTMLInputElement;
  const v = getPath(path);
  input.value = typeof v === 'number' ? String(+(v / scale).toFixed(2)) : String(v ?? '');
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    change(path, raw === '' ? '' : Math.round(Number(raw) * scale));
  });
  return opts.unit ? h('div', { class: 'input-unit' }, input, h('span', {}, opts.unit)) : input;
}

function toggle(path: string, label: string, onChange?: (on: boolean) => void): HTMLElement {
  const cb = h('input', { type: 'checkbox', role: 'switch', 'aria-label': label }) as HTMLInputElement;
  cb.checked = getPath(path) === true;
  cb.addEventListener('change', () => {
    change(path, cb.checked);
    onChange?.(cb.checked);
  });
  return h('label', { class: 'switch', title: label }, cb, h('span', { class: 'switch-track', 'aria-hidden': 'true' }));
}

function select(path: string, options: [string, string][]): HTMLSelectElement {
  const el = h('select', { class: 'input' }, ...options.map(([v, label]) => h('option', { value: v }, label))) as HTMLSelectElement;
  el.value = String(getPath(path));
  el.addEventListener('change', () => change(path, el.value));
  return el;
}

function browseButton(kind: 'file' | 'folder', title: string, current: () => string, onPick: (p: string) => void): HTMLElement | null {
  if (!desktop) return null;
  const btn = h('button', { type: 'button', class: 'btn' }, 'Browse…');
  btn.addEventListener('click', async () => {
    const cur = current().trim();
    // Start in the folder of what is there now; a pattern's folder still exists even if the file does not.
    const start = kind === 'folder' ? cur : cur.replace(/[\\/][^\\/]*$/, '');
    const picked = await desktop.pickPath({ kind, title, defaultPath: start || undefined });
    if (picked) onPick(picked);
  });
  return btn;
}

function folderInput(path: string, title: string): HTMLElement {
  const input = textInput(path, { mono: true });
  const browse = browseButton('folder', title, () => input.value, (p) => {
    input.value = p;
    change(path, p);
  });
  return h('div', { class: 'input-row' }, input, browse);
}

/** The Tomcat logs folder, with what following it would pick up right now. */
function logsFolderInput(): HTMLElement {
  const note = h('div', { class: 'list-note' });
  let timer = 0;
  let seq = 0;
  let last = '';
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const run = async () => {
    const body = {
      dir: String(getPath('tomcat.logsDir') ?? '').trim(),
      appLogs: getPath('tomcat.appLogs') ?? [],
      accessLogs: getPath('tomcat.accessLogs') ?? [],
    };
    const key = JSON.stringify(body);
    if (key === last) return;
    last = key;
    const mine = ++seq;
    if (!body.dir) return note.replaceChildren();
    let r: FolderScan | null;
    try {
      r = await (await fetch('/api/config/logs-folder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: key,
      })).json();
    } catch {
      return;
    }
    if (mine !== seq || !r) return;
    const parts: Child[] = [];
    const all = [...r.app, ...r.access].sort((a, b) => (a.modified < b.modified ? 1 : -1));
    if (r.problem) parts.push(h('span', { class: 'pm warn' }, r.problem));
    else if (!all.length) parts.push(h('span', { class: 'pm warn' }, 'No log files in this folder yet. They are picked up when they appear.'));
    else {
      const names = (files: PatternResult['files']) => files.slice(0, 15).map((f) => f.path.split(/[\\/]/).pop()).join('\n');
      const newest = all[0];
      parts.push(
        h('span', { class: 'pm ok', title: `Application logs:\n${names(r.app) || '(none)'}\n\nAccess logs:\n${names(r.access) || '(none)'}` },
          `${plural(r.app.length, 'application log')} · ${plural(r.access.length, 'access log')} · newest ${newest.path.split(/[\\/]/).pop()} · ${ago(newest.modified)}`),
      );
      if (r.skipped) parts.push(h('span', { class: 'pm muted' }, `${plural(r.skipped, 'file')} left out: compressed, lock files, or listed below.`));
    }
    if (!/^([a-zA-Z]:)?[\\/]/.test(body.dir)) parts.push(h('span', { class: 'pm muted' }, `Full path: ${r.dir}`));
    note.replaceChildren(...parts.filter((p): p is Node | string => !!p));
  };
  S.derived.push(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 350);
  });
  void run();
  return h('div', {}, folderInput('tomcat.logsDir', 'Choose the Tomcat logs folder'), note);
}

function fileInput(path: string, title: string, placeholder?: string): HTMLElement {
  const input = textInput(path, { mono: true, placeholder });
  const browse = browseButton('file', title, () => input.value, (p) => {
    input.value = p;
    change(path, p);
  });
  return h('div', { class: 'input-row' }, input, browse);
}

/** Toggle chips for a list drawn from known values; unknown values already in the list are kept. */
function chipToggles(path: string, known: string[]): HTMLElement {
  const wrap = h('div', { class: 'chips', role: 'group' });
  const render = () => {
    const current: string[] = getPath(path) ?? [];
    const all = [...known, ...current.filter((v) => !known.includes(v))];
    wrap.replaceChildren(
      ...all.map((v) => {
        const on = current.includes(v);
        const chip = h('button', { type: 'button', class: `chip${on ? ' on' : ''}`, 'aria-pressed': String(on) }, v);
        chip.addEventListener('click', () => {
          const now: string[] = getPath(path) ?? [];
          change(path, now.includes(v) ? now.filter((x) => x !== v) : [...now, v]);
          render();
        });
        return chip;
      }),
    );
  };
  render();
  return wrap;
}

interface ListOptions {
  itemLabel: string;
  addLabel: string;
  placeholder: string;
  empty: string;
  browse?: { kind: 'file' | 'folder'; title: string };
  /** Show which files each pattern matches right now. */
  match?: boolean;
  /** Checked as you type; returns a problem or null. */
  check?: (value: string) => string | null;
}

/** An editable list of strings: log file patterns, header names, regexes. */
function listEditor(path: string, opts: ListOptions): HTMLElement {
  const rowsEl = h('div', { class: 'list-rows' });
  const add = h('button', { type: 'button', class: 'btn btn-ghost list-add' }, `+ ${opts.addLabel}`);
  let notes: HTMLElement[] = [];
  let matchTimer = 0;
  let matchSeq = 0;
  const values = (): string[] => [...(getPath(path) ?? [])];

  const runMatch = async () => {
    const seq = ++matchSeq;
    const mine = notes;
    let results: PatternResult[];
    try {
      results = await (await fetch('/api/config/match', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patterns: values() }),
      })).json();
    } catch {
      return;
    }
    if (seq !== matchSeq || mine !== notes) return;
    results.forEach((m, i) => mine[i] && renderMatch(mine[i], m, i));
  };
  const scheduleMatch = () => {
    if (!opts.match) return;
    clearTimeout(matchTimer);
    matchTimer = window.setTimeout(() => void runMatch(), 350);
  };

  const setAt = (i: number, value: string) => {
    const arr = values();
    arr[i] = value;
    change(path, arr);
    clearError(`${path}.${i}`);
  };

  const renderMatch = (note: HTMLElement, m: PatternResult, i: number) => {
    if (!m.pattern) return note.replaceChildren();
    const parts: Child[] = [];
    if (m.problem) parts.push(h('span', { class: 'pm warn' }, m.problem));
    else if (!m.files.length) {
      parts.push(h('span', { class: 'pm warn' }, 'No files match yet. They are picked up when they appear.'));
    } else {
      const newest = m.files[0];
      const name = newest.path.split(/[\\/]/).pop();
      parts.push(
        h(
          'span',
          { class: 'pm ok', title: m.files.slice(0, 15).map((f) => f.path).join('\n') },
          `${m.files.length} file${m.files.length === 1 ? '' : 's'} · newest ${name} · ${fmtBytes(newest.bytes)} · ${ago(newest.modified)}`,
        ),
      );
    }
    const rotated = rotationPattern(m.pattern);
    if (rotated) {
      const btn = h('button', { type: 'button', class: 'link' }, `Use ${rotated.split(/[\\/]/).pop()} to follow rotated files`);
      btn.addEventListener('click', () => {
        setAt(i, rotated);
        render();
      });
      parts.push(btn);
    }
    if (!/^([a-zA-Z]:)?[\\/]/.test(m.pattern) && m.resolved) parts.push(h('span', { class: 'pm muted' }, `Full path: ${m.resolved}`));
    note.replaceChildren(...parts.filter((p): p is Node | string => !!p));
  };

  const row = (value: string, i: number) => {
    const input = h('input', {
      type: 'text',
      class: 'input mono',
      placeholder: opts.placeholder,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': `${opts.itemLabel} ${i + 1}`,
    }) as HTMLInputElement;
    input.value = value;
    const err = h('div', { class: 'field-error', role: 'alert' });
    S.errorSlots.set(`${path}.${i}`, err);
    const localCheck = () => {
      const problem = input.value.trim() && opts.check ? opts.check(input.value.trim()) : null;
      err.textContent = problem ?? '';
      err.closest('.list-row')?.classList.toggle('invalid', !!problem);
    };
    input.addEventListener('input', () => {
      setAt(i, input.value);
      localCheck();
      scheduleMatch();
    });
    const browse = opts.browse
      ? browseButton(opts.browse.kind, opts.browse.title, () => input.value, (p) => {
          input.value = p;
          setAt(i, p);
          scheduleMatch();
        })
      : null;
    const remove = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', title: 'Remove', 'aria-label': `Remove ${opts.itemLabel.toLowerCase()} ${i + 1}` }, '×');
    remove.addEventListener('click', () => {
      const arr = values();
      arr.splice(i, 1);
      change(path, arr);
      render();
    });
    const note = h('div', { class: 'list-note' });
    notes.push(note);
    localCheck();
    return h('div', { class: 'list-row' }, h('div', { class: 'input-row' }, input, browse, remove), err, note);
  };

  function render(focusLast = false): void {
    for (const key of [...S.errorSlots.keys()]) if (key.startsWith(`${path}.`)) S.errorSlots.delete(key);
    notes = [];
    const vals = values();
    rowsEl.replaceChildren(...(vals.length ? vals.map(row) : [h('div', { class: 'list-empty' }, opts.empty)]));
    if (focusLast) rowsEl.querySelector<HTMLInputElement>('.list-row:last-child input')?.focus();
    scheduleMatch();
  }

  add.addEventListener('click', async () => {
    // In the desktop app, adding a file goes straight to the picker; typing is still possible after.
    if (opts.browse?.kind === 'file' && desktop) {
      const last = values().filter(Boolean).pop() ?? '';
      const picked = await desktop.pickPath({ kind: 'file', title: opts.browse.title, defaultPath: last.replace(/[\\/][^\\/]*$/, '') || undefined });
      if (!picked) return;
      change(path, [...values(), rotationPattern(picked) ?? picked]);
      render();
      return;
    }
    change(path, [...values(), '']);
    render(true);
  });

  render();
  const wrap = h('div', { class: 'list' }, rowsEl, add);
  return wrap;
}

/** For a date-stamped log file, the pattern that also matches the next days' files. */
function rotationPattern(pattern: string): string | null {
  const name = pattern.split(/[\\/]/).pop() ?? '';
  if (name.includes('*')) return null;
  const replaced = name.replace(/\d{4}-\d{2}-\d{2}|\d{8}(?:[-_]\d{4,6})?/, '*');
  if (replaced === name) return null;
  return pattern.slice(0, pattern.length - name.length) + replaced;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'written just now';
  if (s < 3600) return `written ${Math.round(s / 60)} min ago`;
  if (s < 86400) return `written ${Math.round(s / 3600)} h ago`;
  return `written ${Math.round(s / 86400)} d ago`;
}

function copyButton(getText: () => string): HTMLElement {
  const btn = h('button', { type: 'button', class: 'btn' }, 'Copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    } catch {
      /* clipboard blocked; the text can still be selected */
    }
  });
  return btn;
}

function copyable(getText: () => string): HTMLElement {
  const pre = h('code', { class: 'cmd' });
  const btn = copyButton(getText);
  const update = () => {
    pre.textContent = getText();
  };
  update();
  S.derived.push(update);
  return h('div', { class: 'cmd-row' }, pre, btn);
}

// ── Sections ────────────────────────────────────────────

interface SectionDef {
  id: string;
  nav: string;
  title: string;
  desc: string;
  /** The on/off setting for a collector section. */
  enable?: string;
  /** Collector names (from the hub status) shown in the header. */
  collectors?: string[];
  fields: () => HTMLElement[];
}

// ── Chrome ──────────────────────────────────────────────
// Which Chrome would start and with which profile folder is worked out by the hub (it knows the
// machine and the settings file's folder), so the command shown has real paths in it.

const C = {
  setup: null as ChromeSetup | null,
  /** The executable and profile folder the current setup was fetched for. */
  key: null as string | null,
  timer: 0,
  launch: null as HTMLElement | null,
  commands: null as HTMLElement | null,
  exeNote: null as HTMLElement | null,
  profileNote: null as HTMLElement | null,
};

const chromeKeys = ['port', 'host', 'executable', 'profileDir'] as const;
/** Start Chrome uses the running settings, so it waits for edits to these to be saved. */
const chromeUnsaved = () => chromeKeys.some((k) => getPath(`chrome.${k}`) !== S.loaded?.config.chrome[k]);

function watchChromeSetup(): void {
  const exe = String(getPath('chrome.executable') ?? '');
  const profile = String(getPath('chrome.profileDir') ?? '');
  const key = `${exe}\n${profile}`;
  renderChromeSetup();
  renderChromeLaunch();
  if (key === C.key) return;
  C.key = key;
  clearTimeout(C.timer);
  C.timer = window.setTimeout(async () => {
    try {
      const q = new URLSearchParams({ executable: exe, profileDir: profile });
      const setup: ChromeSetup = await (await fetch(`/api/chrome/setup?${q}`)).json();
      if (C.key !== key) return;
      C.setup = setup;
      renderChromeSetup();
    } catch {
      /* the hub is gone; the socket handler shows that */
    }
  }, C.setup ? 300 : 0);
}

function renderChromeSetup(): void {
  const setup = C.setup;
  if (!C.commands || !C.exeNote || !C.profileNote) return;
  if (!setup) {
    C.commands.replaceChildren(h('div', { class: 'list-empty' }, 'Finding Chrome…'));
    return;
  }
  const port = Number(getPath('chrome.port')) || 9222;
  const exe = setup.executable ?? typicalChromePath(setup.platform);
  const lines = chromeCommandLines(setup.platform, exe, chromeArgs(port, setup.profileDir));
  C.commands.replaceChildren(
    ...lines.map((l) =>
      h(
        'div',
        { class: 'cmd-block' },
        lines.length > 1 ? h('div', { class: 'cmd-label' }, l.label) : null,
        h('div', { class: 'cmd-row' }, h('code', { class: 'cmd' }, l.text), copyButton(() => l.text)),
      ),
    ),
  );
  C.exeNote.replaceChildren(
    setup.executable
      ? h('span', { class: 'pm ok' }, setup.source === 'settings' ? 'Found' : `Found ${setup.executable}`)
      : h('span', { class: 'pm warn' }, setup.problem ?? 'Chrome was not found'),
  );
  C.profileNote.replaceChildren(h('span', { class: 'pm muted' }, `Full path: ${setup.profileDir}`));
}

function renderChromeLaunch(): void {
  if (!C.launch) return;
  const connected = S.status?.collectors.find((c) => c.name === 'Chrome')?.state === 'connected';
  const unsaved = chromeUnsaved();
  const note = unsaved
    ? h('div', { class: 'launch-note' }, h('span', { class: 'pm warn' }, 'Save first: Start Chrome uses the saved settings.'))
    : connected
      ? h('div', { class: 'launch-note' }, h('span', { class: 'pm ok' }, 'Debug Hub is connected to Chrome.'))
      : chromeLaunchNote();
  C.launch.replaceChildren(chromeButton({ disabled: unsaved || connected }), ...(note ? [note] : []));
}

/** The live parts of the Chrome settings: what would start, and with which folders. */
function chromeParts(): { launch: HTMLElement; commands: HTMLElement; exeNote: HTMLElement; profileNote: HTMLElement } {
  C.launch = h('div', { class: 'launch' });
  C.commands = h('div', { class: 'cmd-list' });
  C.exeNote = h('div', { class: 'list-note' });
  C.profileNote = h('div', { class: 'list-note' });
  C.key = null;
  S.derived.push(watchChromeSetup);
  watchChromeSetup();
  return { launch: C.launch, commands: C.commands, exeNote: C.exeNote, profileNote: C.profileNote };
}

function chromeFields(): HTMLElement[] {
  const parts = chromeParts();
  const fields = [
    field('chrome.port', 'Debugging port', numberInput('chrome.port', { min: 1, max: 65535 }), 'Chrome’s --remote-debugging-port.'),
    field(
      null,
      'Start Chrome',
      parts.launch,
      'Opens Chrome with the debugging port, on the profile folder below, so it starts without your usual sign-ins. Close other Chrome windows that use that folder first.',
    ),
    field(
      null,
      'Or start it yourself',
      parts.commands,
      'For a terminal, a shortcut or IntelliJ. Close other Chrome windows that use this profile folder first: a Chrome already running on it takes over and drops the flags.',
    ),
    field(
      'chrome.profileDir',
      'Profile folder',
      h('div', {}, folderInput('chrome.profileDir', 'Choose Chrome’s profile folder'), parts.profileNote),
      'Chrome’s --user-data-dir. Chrome 136 and later only open the debugging port with a profile folder of its own. A relative path is relative to the settings file.',
    ),
    field(
      'chrome.executable',
      'Chrome program',
      h('div', {}, fileInput('chrome.executable', 'Choose the Chrome program', 'Found automatically'), parts.exeNote),
      'Leave empty to find Chrome automatically.',
    ),
  ];
  return fields;
}

const RESOURCE_TYPES = ['Document', 'XHR', 'Fetch', 'EventSource', 'Script', 'Stylesheet', 'Other'];

function sections(): SectionDef[] {
  const L = S.loaded!;
  const portNote = L.runningPort !== L.config.port && !S.restartNeeded ?` Running on ${L.runningPort} now because ${L.config.port} was in use.` : '';
  return [
    {
      id: 'general',
      nav: 'General',
      title: 'General',
      desc: 'Where Debug Hub listens and keeps its recordings.',
      fields: () => [
        field('port', 'Port', numberInput('port', { min: 1, max: 65535 }), `The hub’s own address, http://127.0.0.1:<port>. A change takes effect after a restart.${portNote}`),
        field('sessionsDir', 'Sessions folder', folderInput('sessionsDir', 'Choose where sessions are saved'), 'One file per recording. A relative path is relative to the settings file.'),
        field(
          null,
          'Settings file',
          h(
            'div',
            { class: 'input-row' },
            h('code', { class: 'path' }, L.file),
            desktop ? (() => {
              const b = h('button', { type: 'button', class: 'btn' }, 'Open');
              b.addEventListener('click', () => void desktop.reveal('config'));
              return b;
            })() : null,
          ),
          'Everything on this screen is saved here. Settings it doesn’t show are kept.',
        ),
      ],
    },
    {
      id: 'chrome',
      nav: 'Browser',
      title: 'Browser (Chrome)',
      desc: 'Console messages, errors and network requests from a Chrome started with remote debugging.',
      enable: 'chrome.enabled',
      collectors: ['Chrome'],
      fields: () => [
        ...chromeFields(),
        field('chrome.captureBodies', 'Capture response bodies', toggle('chrome.captureBodies', 'Capture response bodies'), 'Text and JSON bodies, up to the size limit under Privacy and limits.'),
        field('chrome.bodyResourceTypes', 'Capture bodies for', chipToggles('chrome.bodyResourceTypes', RESOURCE_TYPES), 'XHR and Fetch are API calls; Document is the page itself.'),
      ],
    },
    {
      id: 'tomcat',
      nav: 'Tomcat',
      title: 'Tomcat',
      desc: 'Application and access logs, followed as they are written. Usually in CATALINA_BASE/logs.',
      enable: 'tomcat.enabled',
      collectors: ['Tomcat logs', 'Tomcat access', 'Tomcat'],
      fields: () => [
        field(
          'tomcat.logsDir',
          'Logs folder',
          logsFolderInput(),
          h('span', {}, 'Follows every log in the folder, usually ', h('code', {}, 'CATALINA_BASE/logs'), ': access logs by name, the rest as application logs, and new files as they appear. Each event is labelled with its webapp, so you can filter by it on the timeline.'),
        ),
        field(
          'tomcat.appLogs',
          'Application logs',
          listEditor('tomcat.appLogs', {
            itemLabel: 'Application log',
            addLabel: 'Add log file',
            placeholder: 'C:/tomcat/logs/catalina.*.log',
            empty: 'No application logs yet.',
            browse: { kind: 'file', title: 'Choose a Tomcat application log' },
            match: true,
          }),
          h('span', {}, 'For logs outside the logs folder: catalina.out, localhost.<date>.log or your app’s own log. Use ', h('code', {}, '*'), ' in the file name to follow date-rotated files.'),
        ),
        field(
          'tomcat.accessLogs',
          'Access logs',
          listEditor('tomcat.accessLogs', {
            itemLabel: 'Access log',
            addLabel: 'Add access log',
            placeholder: 'C:/tomcat/logs/localhost_access_log.*.txt',
            empty: 'No access logs yet.',
            browse: { kind: 'file', title: 'Choose a Tomcat access log' },
            match: true,
          }),
          'For access logs outside the logs folder: localhost_access_log.<date>.txt. Gives each request’s status and server time.',
        ),
        field(
          'tomcat.accessDurationUnit',
          'Duration unit (%D)',
          select('tomcat.accessDurationUnit', [
            ['ms', 'Milliseconds: Tomcat 9 and earlier'],
            ['us', 'Microseconds: Tomcat 10 and later'],
            ['s', 'Seconds'],
          ]),
          'What the %D field in the access log pattern counts.',
        ),
      ],
    },
    {
      // Its own card, not part of Tomcat above: the Tomcat page works whether or not logs are recorded.
      id: 'tomcat-management',
      nav: 'Tomcat server',
      title: 'Tomcat server',
      desc: 'For the Tomcat page: starting and stopping Tomcat (with the rest of your dev setup) and its webapps, disabling webapps, and deploying the WARs you build.',
      fields: tomcatManagementFields,
    },
    {
      // Built in src/ui/registrysettings.ts.
      id: 'registries',
      nav: 'Package registries',
      title: 'Package registries',
      desc: 'For WARs that are not built on this machine: Debug Hub looks in Nexus, Artifactory, any Maven repository or at a fixed URL for new versions, and the Tomcat page downloads and deploys them.',
      fields: () => registryFields({ get: getPath, change, clearError, slots: S.errorSlots, field }),
    },
    {
      id: 'source',
      nav: 'Source code',
      title: 'Source code',
      desc: 'Go to source: Java classes in logs (stack frames, loggers, exceptions) open in your editor at the line. The sources are found above the WAR build folders and in any folders added here.',
      fields: sourceFields,
    },
    {
      id: 'postgres',
      nav: 'Postgres',
      title: 'Postgres',
      desc: 'Slow queries, auto_explain plans and errors from the Postgres server log.',
      enable: 'postgres.enabled',
      collectors: ['Postgres'],
      fields: () => [
        field(
          'postgres.logs',
          'Server logs',
          listEditor('postgres.logs', {
            itemLabel: 'Postgres log',
            addLabel: 'Add log file',
            placeholder: 'C:/Program Files/PostgreSQL/16/data/log/postgresql-*.log',
            empty: 'No Postgres logs yet.',
            browse: { kind: 'file', title: 'Choose a Postgres server log' },
            match: true,
          }),
          h('span', {}, 'Usually ', h('code', {}, 'data/log'), ' in the Postgres data folder. Slow queries appear only if ', h('code', {}, 'log_min_duration_statement'), ' is set.'),
        ),
      ],
    },
    {
      id: 'api',
      nav: 'API client',
      title: 'API client',
      desc: 'For the API screen: the OpenAPI or Swagger specs of your REST endpoints, and how requests are sent. Requests go from Debug Hub itself, so CORS does not apply.',
      fields: apiClientFields,
    },
    {
      id: 'correlation',
      nav: 'Request matching',
      title: 'Request matching',
      desc: 'How a browser request is linked to the log lines and queries it caused.',
      fields: () => [
        field('correlation.header', 'Request ID header', textInput('correlation.header', { mono: true, placeholder: 'X-Request-Id' }), 'The header that carries the ID from the browser to the server.'),
        field(
          'correlation.logPatterns',
          'ID patterns in logs',
          listEditor('correlation.logPatterns', {
            itemLabel: 'Pattern',
            addLabel: 'Add pattern',
            placeholder: 'requestId=([A-Za-z0-9-]+)',
            empty: 'No patterns: log lines are matched by time only.',
            check: (p) => {
              try {
                new RegExp(p);
                return null;
              } catch (err) {
                return (err as Error).message.replace(/^Invalid regular expression: /, '');
              }
            },
          }),
          'Regular expressions with one capture group for the ID. Case is ignored.',
        ),
        field(null, 'Try a log line', patternTester(), 'Paste a line from your logs to see which ID the patterns find.'),
        field('correlation.timeWindowMs', 'Time window', numberInput('correlation.timeWindowMs', { min: 0, max: 600_000, unit: 'ms' }), 'When a request has no ID, server events this close in time and with the same path are shown as possible matches.'),
      ],
    },
    {
      id: 'privacy',
      nav: 'Privacy and limits',
      title: 'Privacy and limits',
      desc: 'What is kept out of session files, and how much is kept.',
      fields: () => [
        field(
          'redact.headers',
          'Redacted headers',
          listEditor('redact.headers', { itemLabel: 'Header', addLabel: 'Add header', placeholder: 'x-api-key', empty: 'No headers are redacted.' }),
          'Values of these headers are replaced with [redacted] before anything is written.',
        ),
        field('maxBodyBytes', 'Body size limit', numberInput('maxBodyBytes', { min: 0, max: 64 * 1024 * 1024, unit: 'kB', scale: 1024 }), 'Longer bodies are cut off; the event still records the full size.'),
      ],
    },
    {
      id: 'advanced',
      nav: 'Advanced',
      title: 'Advanced',
      desc: 'Rarely needed.',
      fields: () => [
        field('tail.fromStart', 'Read whole logs at startup', toggle('tail.fromStart', 'Read whole logs at startup'), 'Off: only lines written after Debug Hub starts. On: existing content too, which can be a lot. From the Tomcat logs folder, only files written in the last day are read.'),
        field('chrome.host', 'Chrome host', textInput('chrome.host', { mono: true }), 'Where Chrome’s debugging port is. Leave at 127.0.0.1 unless Chrome runs elsewhere.'),
        field('tail.pollMs', 'Log poll interval', numberInput('tail.pollMs', { min: 50, max: 10_000, unit: 'ms' }), 'How often log files are checked for new lines.'),
        field('tail.flushMs', 'Multiline wait', numberInput('tail.flushMs', { min: 10, max: 10_000, unit: 'ms' }), 'How long to wait for the rest of a stack trace before showing it.'),
        field(
          'updates.fetchCommand',
          'Fetch updates with',
          textInput('updates.fetchCommand', { mono: true, placeholder: isWindows ? 'nu -l -c "git fetch origin main"' : 'bash -lc "git fetch origin main"' }),
          h('span', {}, 'Run from npm run app, Debug Hub checks origin/main for updates with ', h('code', {}, 'git fetch'), '. If that fails here but works in your terminal (a proxy or credentials only your shell sets up), give a command that fetches the way your terminal does. Run in the checkout, without a shell of ours; empty: git fetch. Without a working fetch, updates still come from whatever your terminal or IDE last fetched.'),
        ),
      ],
    },
  ];
}

/**
 * The start commands: rows of name, command, folder and "wait", in the order they run. Errors
 * come back as tomcat.startCommands.<i>.command and so on, and land beside that input.
 */
function startCommandsEditor(): HTMLElement {
  const path = 'tomcat.startCommands';
  const rowsEl = h('div', { class: 'list-rows' });
  const add = h('button', { type: 'button', class: 'btn btn-ghost list-add' }, '+ Add command');
  const values = (): StartCommand[] => structuredClone(getPath(path) ?? []);
  const setField = (i: number, key: keyof StartCommand, value: string | boolean) => {
    const arr = values();
    arr[i] = { ...arr[i], [key]: value };
    change(path, arr);
    clearError(`${path}.${i}.${key}`);
    clearError(`${path}.${i}`);
  };

  /** One input with its own error slot. */
  const part = (i: number, key: 'name' | 'command' | 'cwd', label: string, placeholder: string, mono: boolean): HTMLElement => {
    const input = h('input', { type: 'text', class: `input${mono ? ' mono' : ''}`, placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': `${label} of command ${i + 1}` }) as HTMLInputElement;
    input.value = String(values()[i]?.[key] ?? '');
    input.addEventListener('input', () => setField(i, key, input.value));
    const err = h('div', { class: 'field-error', role: 'alert' });
    S.errorSlots.set(`${path}.${i}.${key}`, err);
    const browse =
      key === 'cwd'
        ? browseButton('folder', 'Choose the folder to run the command in', () => input.value, (picked) => {
            input.value = picked;
            setField(i, key, picked);
          })
        : null;
    return h('div', { class: 'list-row' }, browse ? h('div', { class: 'input-row' }, input, browse) : input, err);
  };

  const row = (c: StartCommand, i: number, count: number): HTMLElement => {
    const tool = (label: string, title: string, disabled: boolean, fn: () => void) => {
      const b = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', title, 'aria-label': `${title} (command ${i + 1})` }, label) as HTMLButtonElement;
      b.disabled = disabled;
      b.addEventListener('click', () => {
        fn();
        render();
      });
      return b;
    };
    const move = (to: number) => {
      const arr = values();
      [arr[i], arr[to]] = [arr[to], arr[i]];
      change(path, arr);
    };
    const wait = h('input', { type: 'checkbox' }) as HTMLInputElement;
    wait.checked = c.wait === true;
    wait.addEventListener('change', () => setField(i, 'wait', wait.checked));
    const rowErr = h('div', { class: 'field-error', role: 'alert' });
    S.errorSlots.set(`${path}.${i}`, rowErr);
    return h(
      'div',
      { class: 'sc-row' },
      h('div', { class: 'sc-head' },
        h('span', { class: 'sc-num' }, `${i + 1}`),
        part(i, 'name', 'Name', 'Database', false),
        h('div', { class: 'sc-tools' },
          tool('↑', 'Move up', i === 0, () => move(i - 1)),
          tool('↓', 'Move down', i === count - 1, () => move(i + 1)),
          tool('×', 'Remove', false, () => {
            const arr = values();
            arr.splice(i, 1);
            change(path, arr);
          }),
        ),
      ),
      h('div', { class: 'sc-grid' },
        h('span', { class: 'sc-label' }, 'Command'),
        part(i, 'command', 'Command', isWindows ? 'net start postgresql-x64-16' : 'pg_ctl -D /usr/local/var/postgres start', true),
        h('span', { class: 'sc-label' }, 'Folder'),
        part(i, 'cwd', 'Folder', 'The settings file’s folder', true),
        h('span', {}),
        h('label', { class: 'check sc-wait' }, wait, ' Wait for it to finish, and stop if it fails'),
      ),
      rowErr,
    );
  };

  function render(focusLast = false): void {
    for (const key of [...S.errorSlots.keys()]) if (key.startsWith(`${path}.`)) S.errorSlots.delete(key);
    const vals = values();
    rowsEl.replaceChildren(...(vals.length ? vals.map((c, i) => row(c, i, vals.length)) : [h('div', { class: 'list-empty' }, 'No start commands: Start Tomcat starts just Tomcat.')]));
    if (focusLast) rowsEl.querySelector<HTMLInputElement>('.sc-row:last-child input')?.focus();
  }
  add.addEventListener('click', () => {
    change(path, [...values(), { name: '', command: '', cwd: '', wait: false }]);
    render(true);
  });
  render();
  return h('div', { class: 'list' }, rowsEl, add);
}

/** The Tomcat folder, with the folder it falls back to shown as the placeholder. */
function tomcatHomeInput(): HTMLElement {
  const el = folderInput('tomcat.home', 'Choose the folder Tomcat is installed in');
  const input = el.querySelector('input')!;
  const update = () => {
    const webapps = String(getPath('tomcat.webappsDir') ?? '').trim().replace(/[\\/]+$/, '');
    const above = webapps.replace(/[\\/][^\\/]*$/, '');
    input.placeholder = above && above !== webapps ? `The folder above webapps: ${above}` : '';
  };
  update();
  S.derived.push(update);
  return el;
}

/** Settings for the Tomcat page (src/ui/tomcat.ts). */
function tomcatManagementFields(): HTMLElement[] {
  const password = textInput('tomcat.manager.password', { mono: true });
  password.type = 'password';
  return [
    field('tomcat.webappsDir', 'Webapps folder', folderInput('tomcat.webappsDir', 'Choose Tomcat’s webapps folder'), h('span', {}, 'Where Tomcat deploys from, usually ', h('code', {}, 'CATALINA_BASE/webapps'), '.')),
    field(
      'tomcat.disabledDir',
      'Disabled webapps folder',
      folderInput('tomcat.disabledDir', 'Choose a folder for disabled webapps'),
      'Disable moves a webapp here so Tomcat forgets it; Enable moves it back. Must be outside the webapps folder.',
    ),
    field(
      'tomcat.home',
      'Tomcat folder (CATALINA_HOME)',
      tomcatHomeInput(),
      h(
        'span',
        {},
        `Without scripts below, Start Tomcat runs its bin/${isWindows ? 'startup.bat' : 'startup.sh'} and Stop its bin/${isWindows ? 'shutdown.bat' : 'shutdown.sh'}, the traditional way, with CATALINA_HOME set to this folder and CATALINA_BASE to the folder above webapps. Leave empty to use the folder above webapps. A start or stop script overrides this.`,
      ),
    ),
    field(
      'tomcat.javaHome',
      'Java folder (JAVA_HOME)',
      folderInput('tomcat.javaHome', 'Choose the Java folder (a JDK or JRE)'),
      h('span', {}, 'The JDK Tomcat runs on, e.g. ', h('code', {}, isWindows ? 'C:/Program Files/Java/jdk-17' : '/usr/lib/jvm/java-17'), '. Leave empty to use JAVA_HOME from Debug Hub’s environment. Used for Tomcat’s own scripts only; a start or stop script sets its own.'),
    ),
    field(
      'tomcat.startScript',
      'Start script',
      fileInput('tomcat.startScript', 'Choose the script that starts Tomcat', 'Tomcat’s own startup'),
      'Optional. Run by Start Tomcat instead of Tomcat’s startup, in its own folder. It may also keep Tomcat in the foreground.',
    ),
    field('tomcat.stopScript', 'Stop script', fileInput('tomcat.stopScript', 'Choose the script that stops Tomcat', 'Tomcat’s own shutdown'), 'Optional. Run by Stop Tomcat instead of Tomcat’s shutdown.'),
    field(
      'tomcat.startCommands',
      'Start commands',
      startCommandsEditor(),
      h(
        'span',
        {},
        'Bring up the whole dev setup with Start Tomcat: these run first, in this order, then Tomcat, then Chrome if it is on below. Each runs in the system shell and keeps running after Debug Hub closes; its output goes on the timeline. Tick “wait” for a step Tomcat needs finished first, e.g. ',
        h('code', {}, isWindows ? 'net start postgresql-x64-16' : 'pg_ctl start -D /usr/local/var/postgres'),
        ' (up to 5 minutes; if it fails, Tomcat is not started). Leave it off for what keeps running, e.g. ',
        h('code', {}, 'npm run dev'),
        ' in your web project’s folder. A command still running from an earlier Start is not started twice.',
      ),
      { wide: true },
    ),
    field(
      'tomcat.startChrome',
      'Also start Chrome',
      toggle('tomcat.startChrome', 'Also start Chrome'),
      'After Tomcat, start Chrome with its debugging port, like Start Chrome under Browser. Left alone if it is already running.',
    ),
    field(
      'tomcat.manager.url',
      'Manager URL',
      textInput('tomcat.manager.url', { mono: true, placeholder: 'http://localhost:8080/manager/text' }),
      'Optional. The Tomcat Manager’s text interface, for starting, stopping and reloading single webapps. Without it, Disable and Enable stop and start them.',
    ),
    field('tomcat.manager.username', 'Manager user', textInput('tomcat.manager.username', { mono: true }), h('span', {}, 'A user with the ', h('code', {}, 'manager-script'), ' role in ', h('code', {}, 'conf/tomcat-users.xml'), '.')),
    field('tomcat.manager.password', 'Manager password', password, 'Stored in the settings file as plain text.'),
    field(
      'tomcat.warWatch',
      'WAR build folders',
      listEditor('tomcat.warWatch', {
        itemLabel: 'WAR folder',
        addLabel: 'Add folder',
        placeholder: isWindows ? 'C:/dev/shop/target' : '/home/me/dev/shop/target',
        empty: 'No folders watched.',
        browse: { kind: 'folder', title: 'Choose a folder where WARs are built' },
      }),
      h('span', {}, 'When a new or rebuilt WAR appears here, Debug Hub offers to deploy it. Use ', h('code', {}, '*'), ' for several projects, e.g. ', h('code', {}, 'C:/dev/*/target'), '.'),
    ),
    field(
      'tomcat.preserveFiles',
      'Files to keep on deploy',
      listEditor('tomcat.preserveFiles', {
        itemLabel: 'File name',
        addLabel: 'Add file name',
        placeholder: 'application-local.properties',
        empty: 'None: a deploy always uses the files in the new WAR.',
        check: (n) => (/[\\/]/.test(n) ? 'A file name only, without a folder' : null),
      }),
      h(
        'span',
        {},
        'File names, ',
        h('code', {}, '*'),
        ' allowed. When deploying a WAR, Debug Hub offers to keep these files from the deployed copy (anywhere in the webapp) instead of the ones in the new build, e.g. local settings you edited there.',
      ),
    ),
  ];
}

// ── Source code ─────────────────────────────────────────
// The editor and terminal lists mirror src/server/source/editor.ts; the hub works out which
// program would run (it knows the machine) and which projects it found.

const EDITORS: [EditorKind, string][] = [
  ['', 'None'],
  ['vscode', 'VS Code'],
  ['idea', 'IntelliJ IDEA'],
  ['emacs', 'Emacs / Doom Emacs (emacsclient)'],
  ['nvim', 'Neovim'],
  ['custom', 'Custom command'],
];

/** Terminal presets for nvim in a new window; the same templates the hub knows. */
const TERMINALS: [string, string][] = [
  ['WezTerm', 'wezterm start --cwd {dir} -- {cmd}'],
  ...(isWindows ? ([['Windows Terminal', 'wt -d {dir} {cmd}']] as [string, string][]) : []),
  ...(!isWindows ? ([['kitty', 'kitty --directory {dir} {cmd}']] as [string, string][]) : []),
  ['Alacritty', 'alacritty --working-directory {dir} -e {cmd}'],
  ...(!isWindows && !isMac ? ([['GNOME Terminal', 'gnome-terminal --working-directory={dir} -- {cmd}'], ['Konsole', 'konsole --workdir {dir} -e {cmd}']] as [string, string][]) : []),
];

interface SourceStatus {
  index: IndexStatus;
  generation: number;
  sample: string | null;
}

const editorKeys = ['kind', 'program', 'nvimReuse', 'terminal', 'custom'] as const;
const editorUnsaved = () => editorKeys.some((k) => getPath(`editor.${k}`) !== S.loaded?.config.editor?.[k]);
const foldersUnsaved = () =>
  JSON.stringify(getPath('editor.sourceDirs') ?? []) !== JSON.stringify(S.loaded?.config.editor?.sourceDirs ?? []) ||
  JSON.stringify(getPath('tomcat.warWatch') ?? []) !== JSON.stringify(S.loaded?.config.tomcat.warWatch ?? []);

/** What the editor program box would run, looked up by the hub for the unsaved choice. */
function editorProgramInput(): HTMLElement {
  const note = h('div', { class: 'list-note' });
  let seq = 0;
  let timer = 0;
  const run = async () => {
    const kind = String(getPath('editor.kind') ?? '');
    const program = String(getPath('editor.program') ?? '');
    const mine = ++seq;
    if (!kind || kind === 'custom') return note.replaceChildren();
    let loc: { name: string; program: ProgramLocation | null; nvimServers?: number };
    try {
      loc = await (await fetch(`/api/source/editor?kind=${encodeURIComponent(kind)}&program=${encodeURIComponent(program)}`)).json();
    } catch {
      return;
    }
    if (mine !== seq) return;
    const p = loc.program;
    const parts: Child[] = [];
    if (p?.path) parts.push(h('span', { class: 'pm ok', title: p.tried.join('\n') }, `${p.source === 'found' ? 'Found' : 'Using'} ${p.path}`));
    else if (p?.problem) parts.push(h('span', { class: 'pm warn', title: p.tried.join('\n') }, p.problem));
    if (kind === 'nvim' && loc.nvimServers !== undefined) {
      parts.push(h('span', { class: 'pm muted' }, loc.nvimServers ? `${loc.nvimServers} running nvim${loc.nvimServers === 1 ? '' : 's'} found right now` : 'No running nvim found right now'));
    }
    note.replaceChildren(...parts.filter((x): x is Node | string => !!x));
  };
  S.derived.push(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void run(), 300);
  });
  void run();
  return h('div', {}, fileInput('editor.program', 'Choose the editor program', 'Found automatically'), note);
}

/** The terminal preset list and its command; editing the command by hand makes it "Custom". */
function terminalInput(): HTMLElement {
  const sel = h('select', { class: 'input', 'aria-label': 'Terminal' },
    ...TERMINALS.map(([label, t]) => h('option', { value: t }, label)),
    h('option', { value: '' }, 'Custom…'),
  ) as HTMLSelectElement;
  const input = textInput('editor.terminal', { mono: true, placeholder: TERMINALS[0][1] });
  const sync = () => {
    const v = String(getPath('editor.terminal') ?? '').trim();
    sel.value = TERMINALS.some(([, t]) => t === v) ? v : '';
  };
  sel.addEventListener('change', () => {
    if (!sel.value) return input.focus();
    input.value = sel.value;
    change('editor.terminal', sel.value);
  });
  input.addEventListener('input', sync);
  sync();
  return h('div', { class: 'src-terminal' }, sel, input);
}

/** The projects the hub indexed, with their class counts and where each came from. */
function projectsFound(): HTMLElement {
  const out = h('div', { class: 'src-projects' });
  const rescan = h('button', { type: 'button', class: 'btn' }, 'Rescan') as HTMLButtonElement;
  const note = h('span', { class: 'pm warn' }, 'Save to look in the changed folders.');
  let timer = 0;
  const show = (st: SourceStatus) => {
    const ix = st.index;
    const rows: Child[] = ix.projects.map((p) =>
      h('div', { class: 'src-project' },
        h('div', { class: 'src-project-head' },
          h('strong', {}, p.name),
          h('span', { class: 'pm muted' }, `${p.classes.toLocaleString('en-US')} class${p.classes === 1 ? '' : 'es'}${p.modules.some(Boolean) ? ` · modules: ${p.modules.map((m) => m || '(root)').join(', ')}` : ''}`),
        ),
        h('code', { class: 'path' }, p.root),
        h('span', { class: 'pm muted' }, `From ${p.from.join(', ')}`),
      ),
    );
    if (!ix.projects.length && ix.state !== 'building') rows.push(h('div', { class: 'list-empty' }, 'No projects found yet. Add a WAR build folder under Tomcat server, or a project folder above.'));
    for (const problem of ix.problems) rows.push(h('div', {}, h('span', { class: 'pm warn' }, problem)));
    const summary = ix.state === 'building'
      ? 'Indexing…'
      : ix.builtAt ? `${ix.classes.toLocaleString('en-US')} classes in ${ix.files.toLocaleString('en-US')} files, indexed in ${((ix.buildMs ?? 0) / 1000).toFixed(1)} s` : '';
    out.replaceChildren(h('div', { class: 'pm muted' }, summary), ...rows.filter((r): r is Node => !!r));
    clearTimeout(timer);
    if (ix.state === 'building' && S.open) timer = window.setTimeout(() => void load(), 1000);
  };
  const load = async () => {
    try {
      show(await (await fetch('/api/source/status')).json());
    } catch {
      /* the hub is gone */
    }
  };
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    out.prepend(h('div', { class: 'pm muted' }, 'Indexing…'));
    try {
      show(await (await fetch('/api/source/rescan', { method: 'POST' })).json());
    } catch {
      /* the hub is gone */
    } finally {
      rescan.disabled = false;
    }
  });
  const update = () => (note.hidden = !foldersUnsaved());
  S.derived.push(update);
  update();
  void load();
  return h('div', { class: 'src-found' }, h('div', { class: 'input-row' }, rescan, note), out);
}

/** Opens the first indexed class in the saved editor, to check the setup. */
function editorTest(): HTMLElement {
  const btn = h('button', { type: 'button', class: 'btn' }, 'Open a file') as HTMLButtonElement;
  const note = h('div', { class: 'list-note' });
  const unsaved = h('span', { class: 'pm warn' }, 'Save first: the test uses the saved settings.');
  const update = () => {
    unsaved.hidden = !editorUnsaved();
    btn.disabled = editorUnsaved() || !getPath('editor.kind');
  };
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    note.replaceChildren(h('span', { class: 'pm muted' }, 'Opening…'));
    try {
      const res = await fetch('/api/source/test', { method: 'POST' });
      const body = await res.json();
      note.replaceChildren(
        res.ok ? h('span', { class: 'pm ok' }, body.message) : h('span', { class: 'pm warn' }, [body.error, body.hint].filter(Boolean).join(' ')),
        ...(body.output ? [h('code', { class: 'path' }, body.output)] : []),
        ...(body.command ? [h('span', { class: 'pm muted', title: 'The command that was run' }, body.command)] : []),
      );
    } catch (err) {
      note.replaceChildren(h('span', { class: 'pm warn' }, (err as Error).message));
    } finally {
      update();
    }
  });
  S.derived.push(update);
  update();
  return h('div', {}, h('div', { class: 'input-row' }, btn, unsaved), note);
}

function sourceFields(): HTMLElement[] {
  const program = field('editor.program', 'Program', editorProgramInput(), 'Leave empty to find it on PATH and where it is usually installed. Give the full path if it is somewhere else.');
  const reuse = field(
    'editor.nvimReuse',
    'Use a running nvim',
    toggle('editor.nvimReuse', 'Use a running nvim'),
    'Opens the file in an nvim that is already running (Neovim 0.9 or later; found by the address every nvim listens on), preferring one whose working folder is in the project. It cannot bring that terminal window to the front.',
  );
  const terminal = field(
    'editor.terminal',
    'New window',
    terminalInput(),
    h('span', {}, 'Without a running nvim: the terminal that starts nvim in a new window. ', h('code', {}, '{cmd}'), ' is ', h('code', {}, 'nvim +<line> <file>'), ' as separate arguments, ', h('code', {}, '{dir}'), ' the project folder. To start it through a shell, e.g. nushell: ', h('code', {}, 'wezterm start -- nu -c "nvim +{line} {file}"'), '.'),
    { wide: true },
  );
  const custom = field(
    'editor.custom',
    'Command',
    textInput('editor.custom', { mono: true, placeholder: isWindows ? '"C:/Program Files/Sublime Text/subl.exe" {file}:{line}:{column}' : 'subl {file}:{line}:{column}' }),
    h('span', {}, 'Placeholders: ', h('code', {}, '{file}'), ' ', h('code', {}, '{line}'), ' ', h('code', {}, '{column}'), ' ', h('code', {}, '{dir}'), ' (the project folder). Run without a shell; put quotes around a program path with spaces. Inside a quoted argument with spaces (a command line for a shell, ', h('code', {}, 'nu -c "…"'), '), a value with spaces is quoted for that shell: ', isWindows ? 'forward slashes in double quotes.' : 'in single quotes.'),
    { wide: true },
  );
  const test = field(null, 'Test', editorTest(), 'Opens the first indexed class in your editor.');
  const show = () => {
    const kind = getPath('editor.kind');
    program.hidden = !kind || kind === 'custom';
    reuse.hidden = kind !== 'nvim';
    terminal.hidden = kind !== 'nvim';
    custom.hidden = kind !== 'custom';
    test.hidden = !kind;
  };
  S.derived.push(show);
  show();
  return [
    field(
      'editor.kind',
      'Editor',
      select('editor.kind', EDITORS),
      'Click a stack frame from your code, the logger or an exception class in an event (or press G) to open it there. Emacs needs its server running: M-x server-start.',
    ),
    program,
    reuse,
    terminal,
    custom,
    test,
    field(
      'editor.sourceDirs',
      'More project folders',
      listEditor('editor.sourceDirs', {
        itemLabel: 'Project folder',
        addLabel: 'Add folder',
        placeholder: isWindows ? 'C:/dev/common-lib' : '/home/me/dev/common-lib',
        empty: 'None: only the projects above the WAR build folders.',
        browse: { kind: 'folder', title: 'Choose a project folder' },
      }),
      h('span', {}, 'Projects without a WAR build folder, e.g. a shared library. Their ', h('code', {}, 'src/*/java'), ', ', h('code', {}, 'kotlin'), ', ', h('code', {}, 'groovy'), ' and ', h('code', {}, 'scala'), ' folders are indexed, in every module.'),
    ),
    field(null, 'Projects found', projectsFound(), 'Found by walking up from each WAR build folder (Tomcat server) to the folder with pom.xml, build.gradle or settings.gradle: the outermost within four levels, stopping at the repository root. Kept up to date as files are added.', { wide: true }),
  ];
}

// ── API client ──────────────────────────────────────────

interface SpecStatusRow {
  name: string;
  url: string;
  state: 'not-loaded' | 'loading' | 'loaded' | 'error';
  error: string | null;
  title: string | null;
  operations: number;
}

/**
 * Rows of a few text inputs each, e.g. a spec's name and URL. Errors come back as
 * <path>.<i>.<key> and land beside that input; blank rows are dropped on save.
 */
function rowsEditor(
  path: string,
  fields: { key: string; label: string; placeholder: string; mono?: boolean; width?: string; secret?: boolean }[],
  opts: { addLabel: string; empty: string; itemLabel: string; note?: (i: number) => HTMLElement | null },
): HTMLElement {
  const rowsEl = h('div', { class: 'list-rows' });
  const add = h('button', { type: 'button', class: 'btn btn-ghost list-add' }, `+ ${opts.addLabel}`);
  const values = (): Record<string, string>[] => structuredClone(getPath(path) ?? []);
  const render = (focusLast = false) => {
    for (const key of [...S.errorSlots.keys()]) if (key.startsWith(`${path}.`)) S.errorSlots.delete(key);
    const vals = values();
    rowsEl.replaceChildren(
      ...(vals.length
        ? vals.map((v, i) => {
            const parts = fields.map((f) => {
              const input = h('input', { type: 'text', class: `input${f.mono ? ' mono' : ''}`, placeholder: f.placeholder, spellcheck: 'false', autocomplete: 'off', 'aria-label': `${f.label} of ${opts.itemLabel.toLowerCase()} ${i + 1}` }) as HTMLInputElement;
              input.value = String(v[f.key] ?? '');
              input.addEventListener('input', () => {
                const arr = values();
                arr[i] = { ...arr[i], [f.key]: input.value };
                change(path, arr);
                clearError(`${path}.${i}.${f.key}`);
              });
              const err = h('div', { class: 'field-error', role: 'alert' });
              S.errorSlots.set(`${path}.${i}.${f.key}`, err);
              return h('div', { class: 'list-row', style: f.width ? `flex: ${f.width}` : 'flex: 1' }, input, err);
            });
            const remove = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', title: 'Remove', 'aria-label': `Remove ${opts.itemLabel.toLowerCase()} ${i + 1}` }, '×');
            remove.addEventListener('click', () => {
              const arr = values();
              arr.splice(i, 1);
              change(path, arr);
              render();
            });
            return h('div', { class: 'pair-row' }, h('div', { class: 'pair-inputs' }, ...parts, remove), opts.note?.(i) ?? null);
          })
        : [h('div', { class: 'list-empty' }, opts.empty)]),
    );
    if (focusLast) rowsEl.querySelector<HTMLInputElement>('.pair-row:last-child input')?.focus();
  };
  add.addEventListener('click', () => {
    change(path, [...values(), Object.fromEntries(fields.map((f) => [f.key, '']))]);
    render(true);
  });
  render();
  return h('div', { class: 'list' }, rowsEl, add);
}

/** The specs with whether each loads, for the saved settings (the API screen uses those). */
function specStatus(): HTMLElement {
  const box = h('div', { class: 'list-note' });
  const btn = h('button', { type: 'button', class: 'btn' }, 'Load specs') as HTMLButtonElement;
  const out = h('div', { class: 'spec-status' });
  const unsaved = () => JSON.stringify(getPath('api.specs') ?? []) !== JSON.stringify(S.loaded?.config.api?.specs ?? []);
  const show = (rows: SpecStatusRow[]) => {
    out.replaceChildren(
      ...rows.map((r) =>
        h('div', {}, r.state === 'loaded'
          ? h('span', { class: 'pm ok' }, `${r.name}: ${r.title ?? ''} · ${r.operations} operations`)
          : r.state === 'error'
            ? h('span', { class: 'pm warn' }, `${r.name}: ${r.error}`)
            : h('span', { class: 'pm muted' }, `${r.name}: not loaded yet`)),
      ),
    );
  };
  const run = async (load: boolean) => {
    btn.disabled = true;
    try {
      let info: { specs: SpecStatusRow[] } = await (await fetch('/api/client')).json();
      if (load) {
        await Promise.all(info.specs.map((s) => fetch(`/api/client/specs/${encodeURIComponent(s.name)}?reload=1`).catch(() => undefined)));
        info = await (await fetch('/api/client')).json();
      }
      show(info.specs);
    } catch {
      /* the hub is gone; the socket handler shows that */
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', () => void run(true));
  const note = h('span', { class: 'pm warn' }, 'Save first: specs are loaded from the saved settings.');
  const update = () => (note.hidden = !unsaved());
  S.derived.push(update);
  update();
  void run(false);
  box.append(out);
  return h('div', {}, h('div', { class: 'input-row' }, btn, note), box);
}

function apiClientFields(): HTMLElement[] {
  return [
    field(
      'api.specs',
      'Specs',
      rowsEditor('api.specs', [
        { key: 'name', label: 'Name', placeholder: 'Shop', width: '0 0 150px' },
        { key: 'url', label: 'URL or file', placeholder: 'http://localhost:8080/shop/v3/api-docs', mono: true },
      ], { addLabel: 'Add spec', empty: 'No specs: the API screen can still send requests typed by hand.', itemLabel: 'Spec' }),
      h('span', {}, 'OpenAPI 3 or Swagger 2, as JSON or YAML: a URL or a file. Spring’s springdoc serves it at ', h('code', {}, '/v3/api-docs'), ', springfox at ', h('code', {}, '/v2/api-docs'), '. A relative file path is relative to the settings file.'),
    ),
    field(null, 'Check', specStatus(), 'Fetches each saved spec and says whether it could be read.'),
    field(
      'api.baseUrl',
      'Base URL',
      textInput('api.baseUrl', { mono: true, placeholder: 'From the spec’s servers' }),
      h('span', {}, 'What ', h('code', {}, '{{baseUrl}}'), ' stands for, instead of the server the spec names, e.g. ', h('code', {}, 'http://localhost:8080/shop'), '. Leave empty to use the spec’s.'),
    ),
    field(
      'api.headers',
      'Default headers',
      rowsEditor('api.headers', [
        { key: 'name', label: 'Header', placeholder: 'Authorization', mono: true, width: '0 0 190px' },
        { key: 'value', label: 'Value', placeholder: 'Bearer eyJhbGciOi…', mono: true },
      ], { addLabel: 'Add header', empty: 'None.', itemLabel: 'Header' }),
      'Sent with every request unless a request turns one off or sets its own, e.g. a login token. Stored in the settings file as plain text; values of redacted headers (Privacy and limits) are not recorded on the timeline.',
    ),
    field('api.timeoutMs', 'Timeout', numberInput('api.timeoutMs', { min: 100, max: 600_000, unit: 'ms' }), 'How long to wait for a complete response.'),
    field('api.addRequestId', 'Add a request ID', toggle('api.addRequestId', 'Add a request ID'), 'Sends the request ID header (Request matching) with a fresh ID, unless the request sets it, so the Tomcat log lines and queries a request causes are linked to it on the timeline.'),
    field('api.insecureTls', 'Allow untrusted certificates', toggle('api.insecureTls', 'Allow untrusted certificates'), 'Accept self-signed or otherwise untrusted https certificates, as dev servers often have. Leave off for anything else.'),
  ];
}

function patternTester(): HTMLElement {
  const input = h('input', { type: 'text', class: 'input mono', placeholder: '2026-11-14 10:02:11 INFO [rid=7f3a9c21] Saved order', spellcheck: 'false' }) as HTMLInputElement;
  const out = h('div', { class: 'list-note' });
  const run = () => {
    const line = input.value;
    if (!line.trim()) return out.replaceChildren();
    const patterns: string[] = (getPath('correlation.logPatterns') ?? []).filter((p: string) => p.trim());
    for (const [i, p] of patterns.entries()) {
      let m: RegExpExecArray | null = null;
      try {
        // Case-insensitive, as the hub compiles them (compilePatterns in normalize.ts).
        m = new RegExp(p, 'i').exec(line);
      } catch {
        continue;
      }
      if (m?.[1]) return out.replaceChildren(h('span', { class: 'pm ok' }, `Found ID “${m[1]}” with pattern ${i + 1}`));
    }
    out.replaceChildren(h('span', { class: 'pm warn' }, patterns.length ? 'No ID found in this line.' : 'Add a pattern first.'));
  };
  input.addEventListener('input', run);
  S.derived.push(run);
  return h('div', {}, input, out);
}

// ── Page ────────────────────────────────────────────────

function renderBanner(b: { kind: 'error' | 'warn' | 'info'; text: string; action?: HTMLElement } | null): void {
  const host = root().querySelector('.settings-banner');
  if (!host) return;
  host.replaceChildren(...(b ? [h('div', { class: `banner ${b.kind}`, role: b.kind === 'error' ? 'alert' : 'status' }, h('span', {}, b.text), b.action ?? null)] : []));
}

function restartBanner(): void {
  if (!S.restartNeeded) return;
  let action: HTMLElement | undefined;
  if (desktop) {
    action = h('button', { type: 'button', class: 'btn btn-primary' }, 'Restart now');
    action.addEventListener('click', () => void desktop.restart());
  }
  const port = S.loaded?.config.port;
  renderBanner({
    kind: 'info',
    text: desktop
      ? 'Saved. The new port takes effect after a restart.'
      : `Saved. Restart debug-hub to use the new port, then open http://localhost:${port}.`,
    action,
  });
}

function renderFooter(): void {
  const foot = root().querySelector('.settings-footer');
  if (!foot) return;
  const isDirty = dirty();
  foot.classList.toggle('dirty', isDirty);
  (foot.querySelector('.footer-state') as HTMLElement).textContent = S.saving ? 'Saving…' : isDirty ? 'Unsaved changes' : 'All changes saved';
  (foot.querySelector('.btn-save') as HTMLButtonElement).disabled = !isDirty || S.saving;
  (foot.querySelector('.btn-discard') as HTMLButtonElement).disabled = !isDirty || S.saving;
}

function renderStatusSlots(): void {
  for (const { el, names } of S.statusSlots) {
    const list = (S.status?.collectors ?? []).filter((c) => names.includes(c.name));
    el.replaceChildren(
      ...list.map((c) => {
        const label = c.state === 'connected' ? 'Running' : c.state === 'waiting' ? 'Waiting' : 'Off';
        return h('span', { class: `collector ${c.state}`, title: c.detail }, names.length > 1 && list.length > 1 ? `${c.name}: ${label}` : label);
      }),
    );
  }
}

function render(): void {
  const L = S.loaded!;
  S.errorSlots.clear();
  S.derived = [];
  S.statusSlots = [];

  const defs = sections();
  const navLinks = defs.map((d) => {
    const a = h('a', { href: `#settings/${d.id}`, class: 'nav-link', 'data-id': d.id }, d.nav);
    a.addEventListener('click', (e) => {
      e.preventDefault();
      root().querySelector(`#set-${d.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return a;
  });

  const cards = defs.map((d) => {
    const statusEl = h('div', { class: 'card-status' });
    if (d.collectors) S.statusSlots.push({ el: statusEl, names: d.collectors });
    const body = h('div', { class: 'card-body' }, ...d.fields());
    const setOff = (on: boolean) => body.classList.toggle('disabled', !on);
    let enable: HTMLElement | null = null;
    if (d.enable) {
      enable = toggle(d.enable, `Record ${d.nav}`, setOff);
      setOff(getPath(d.enable) === true);
    }
    return h(
      'section',
      { class: 'card', id: `set-${d.id}`, 'data-id': d.id, 'aria-labelledby': `set-${d.id}-title` },
      h(
        'header',
        { class: 'card-head' },
        h('div', {}, h('h2', { id: `set-${d.id}-title` }, d.title), h('p', {}, d.desc)),
        h('div', { class: 'card-tools' }, statusEl, enable),
      ),
      body,
    );
  });

  const close = h('button', { type: 'button', class: 'btn', title: 'Back to the timeline (Esc)' }, '← Timeline');
  close.addEventListener('click', () => closeSettings());
  const discard = h('button', { type: 'button', class: 'btn btn-discard' }, 'Discard');
  discard.addEventListener('click', () => {
    S.draft = JSON.parse(S.savedJson);
    render();
  });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary btn-save', title: 'Save (Ctrl+S)' }, 'Save');
  saveBtn.addEventListener('click', () => void saveSettings());

  const scroller = h(
    'div',
    { class: 'settings-scroll' },
    guideCard(),
    h('div', { class: 'settings-banner' }),
    ...cards,
  );

  root().replaceChildren(
    h(
      'nav',
      { class: 'settings-nav', 'aria-label': 'Settings sections' },
      h('div', { class: 'settings-title' }, close, h('h1', {}, 'Settings')),
      ...navLinks,
    ),
    h(
      'div',
      { class: 'settings-main' },
      scroller,
      h(
        'footer',
        { class: 'settings-footer' },
        h('span', { class: 'footer-state', 'aria-live': 'polite' }),
        h('div', { class: 'spacer' }),
        discard,
        saveBtn,
      ),
    ),
  );

  // Highlight the section in view.
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = (e.target as HTMLElement).dataset.id;
        navLinks.forEach((a) => a.classList.toggle('active', a.dataset.id === id));
      }
    },
    { root: scroller, rootMargin: '0px 0px -75% 0px' },
  );
  cards.forEach((c) => io.observe(c));
  navLinks[0]?.classList.add('active');

  // Inside Tomcat: hints on the settings detected from it (src/ui/hosted.ts). Nothing otherwise.
  decorateSettings({ root: root(), detected: (L as Loaded & { detected?: Detected }).detected, slots: S.errorSlots, getValue: getPath, derived: S.derived });

  if (L.error) renderBanner({ kind: 'warn', text: `The settings file could not be read, so defaults are shown. Saving replaces it. ${L.error}` });
  restartBanner();
  renderStatusSlots();
  renderFooter();
}

async function load(): Promise<void> {
  root().replaceChildren(h('div', { class: 'settings-loading' }, 'Loading settings…'));
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.loaded = await res.json();
  } catch (err) {
    const retry = h('button', { type: 'button', class: 'btn' }, 'Try again');
    retry.addEventListener('click', () => void load());
    root().replaceChildren(h('div', { class: 'settings-loading' }, `Could not load settings: ${(err as Error).message}. `, retry));
    return;
  }
  S.draft = structuredClone(S.loaded!.config);
  S.savedJson = JSON.stringify(S.draft);
  render();
  scrollToPending();
}

type SaveOutcome = { ok: true; restartNeeded: boolean } | { ok: false; errors: FieldError[] } | { ok: false; message: string };

/** Sends the draft to the hub; on success it becomes the saved settings. Draws nothing. */
async function saveDraft(): Promise<SaveOutcome> {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(S.draft),
    });
    const body = await res.json();
    if (res.status === 400 && body.errors) return { ok: false, errors: body.errors };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    S.loaded = { ...S.loaded!, config: body.config, error: null };
    S.restartNeeded = body.restartNeeded;
    S.draft = structuredClone(body.config as Config);
    S.savedJson = JSON.stringify(S.draft);
    return { ok: true, restartNeeded: body.restartNeeded };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

async function saveSettings(): Promise<void> {
  if (!S.draft || S.saving || !dirty() || guideOpen()) return;
  S.saving = true;
  renderFooter();
  const sentPort = S.draft.port;
  try {
    const r = await saveDraft();
    if (!r.ok) {
      if ('errors' in r) showErrors(r.errors);
      else renderBanner({ kind: 'error', text: `Could not save: ${r.message}` });
      return;
    }
    // Re-render so trimmed values and dropped blank rows show as saved.
    render();
    if (!S.restartNeeded) toast(sentPort === S.loaded!.runningPort ? 'Saved and applied' : 'Saved');
  } finally {
    S.saving = false;
    renderFooter();
  }
}

function toast(text: string): void {
  const el = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 1600);
  setTimeout(() => el.remove(), 2000);
}

// ── Setup guide ─────────────────────────────────────────
// The guide (setupguide.ts) asks for the same settings one step at a time, with the controls
// above, on the same draft: what it fills in shows here too, and Save in the guide saves it.

/** Puts each error beside its control, if that control is showing; returns the rest. */
function placeErrors(errors: FieldError[]): FieldError[] {
  for (const path of S.errorSlots.keys()) clearError(path);
  const rest: FieldError[] = [];
  for (const e of errors) {
    let key = e.path;
    while (key && !S.errorSlots.has(key)) key = key.includes('.') ? key.slice(0, key.lastIndexOf('.')) : '';
    const slot = key ? S.errorSlots.get(key) : undefined;
    if (!slot) {
      rest.push(e);
      continue;
    }
    slot.textContent = e.message;
    slot.closest('.field, .list-row, .gq')?.classList.add('invalid');
  }
  return rest;
}

/** An error line for `path`, for a control the guide lays out itself. */
function errorSlot(path: string): HTMLElement {
  const err = h('div', { class: 'field-error', role: 'alert' });
  S.errorSlots.set(path, err);
  return err;
}

export const settingsKit = {
  isWindows,
  isMac,
  desktop: !!desktop,
  get: getPath,
  set: change,
  /** The settings as last saved. */
  saved: () => S.loaded?.config ?? null,
  settingsFile: () => S.loaded?.file ?? '',
  status: () => S.status,
  dirty,
  /** Starts a new page of controls: what the last one registered is dropped. */
  beginPage: () => {
    S.derived = [];
    S.errorSlots.clear();
    S.statusSlots = [];
  },
  errorSlot,
  placeErrors,
  save: saveDraft,
  textInput,
  numberInput,
  toggle,
  select,
  folderInput,
  fileInput,
  logsFolderInput,
  chipToggles,
  listEditor,
  rowsEditor,
  startCommandsEditor,
  tomcatHomeInput,
  chromeParts,
  editorProgramInput,
  terminalInput,
  patternTester,
  projectsFound,
  copyable,
  RESOURCE_TYPES,
  EDITORS,
  TERMINALS,
};
export type SettingsKit = typeof settingsKit;

/** `welcome`: opened by itself on the first start (#settings/setup), not from the button. */
function launchGuide(welcome = false): void {
  if (!S.draft || guideOpen()) return;
  openSetupGuide(settingsKit, {
    firstRun: welcome,
    onClose: () => {
      if (!S.open || !S.draft) return;
      // Back to the settings page, with what the guide filled in.
      render();
      if (dirty()) renderBanner({ kind: 'info', text: 'Your answers from the setup guide are filled in below but not saved yet. Press Save to keep them.' });
    },
  });
}

function guideCard(): HTMLElement {
  const btn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Start the setup guide');
  btn.addEventListener('click', () => launchGuide());
  return h(
    'section',
    { class: 'guide-card' },
    h('div', { class: 'guide-card-icon', 'aria-hidden': 'true' }, '✦'),
    h(
      'div',
      { class: 'guide-card-text' },
      h('h2', {}, 'New here, or not sure what to fill in?'),
      h('p', {}, 'The setup guide walks you through every setting one step at a time: what it does, what a value looks like, and whether you need it at all.'),
    ),
    btn,
  );
}

// ── Public ──────────────────────────────────────────────

export function settingsOpen(): boolean {
  return S.open;
}

/** `section` scrolls to that card, e.g. "tomcat" (also from a #settings/tomcat link). */
export function openSettings(section?: string): void {
  if (typeof section === 'string' && section) pendingSection = section;
  if (location.hash !== '#settings') history.replaceState(null, '', '#settings');
  if (S.open) {
    scrollToPending();
    return;
  }
  S.open = true;
  root().hidden = false;
  document.body.classList.add('settings-open');
  onToggle(true);
  void load();
}

export function closeSettings(): boolean {
  if (!S.open) return true;
  if (guideOpen()) return false;
  if (dirty() && !confirm('Discard unsaved changes to settings?')) return false;
  S.open = false;
  S.draft = null;
  root().hidden = true;
  root().replaceChildren();
  document.body.classList.remove('settings-open');
  // Leave another screen's hash (#tomcat) alone.
  if (location.hash.startsWith('#settings')) history.replaceState(null, '', location.pathname + location.search);
  onToggle(false);
  return true;
}

export function updateSettingsStatus(status: HubStatus): void {
  S.status = status;
  if (S.open) {
    renderStatusSlots();
    renderChromeLaunch();
  }
}

export function initSettings(opts: { onToggle: (open: boolean) => void }): void {
  onToggle = opts.onToggle;
  desktop?.onOpenSettings(() => openSettings());
  window.addEventListener(CHROME_LAUNCH_EVENT, () => S.open && renderChromeLaunch());
  const sync = () => (location.hash.startsWith('#settings') ? openSettings(location.hash.split('/')[1]) : closeSettings());
  window.addEventListener('hashchange', sync);
  sync();

  document.addEventListener('keydown', (e) => {
    if (!S.open) {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openSettings();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveSettings();
    } else if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
      const t = e.target as HTMLElement;
      if (t.matches('input, select, textarea')) t.blur();
      else closeSettings();
    }
  });
  // In a browser tab, warn before losing edits. Not in the desktop app, where this would silently
  // stop the window from closing.
  if (!desktop) {
    window.addEventListener('beforeunload', (e) => {
      if (S.open && dirty()) e.preventDefault();
    });
  }
}
