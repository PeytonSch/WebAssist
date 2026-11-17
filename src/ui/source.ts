// Go to source in the detail panel: Java classes in logs (stack frames, logger names, exception
// classes) that are in the indexed sources become links that open the file in the editor set up
// under Settings › Source code.
//
// highlight.ts marks the spans that name a class (data-src, data-src-file, data-src-line) and
// calls back here for each one as it is painted, including the lazily painted tail of a long
// trace. The names are checked with the hub in batches; spans whose class is known get the
// src-link class, a tab stop and the link role. Their text is untouched, so the find bar and
// copying still see plain text (the "open" mark is CSS, not text).

import { h } from './dom';
import { onSourceRef, type SourceRef } from './highlight';
import { openSettings } from './settings';

interface Candidate {
  file: string;
  line: number;
  project: string;
  root: string;
  module: string;
}

interface OpenAnswer {
  message?: string;
  error?: string;
  hint?: string;
  settings?: boolean;
  candidates?: Candidate[];
  output?: string;
  command?: string;
}

/**
 * Known counts by "webapp|class": how many source files define it (0: not in the sources), and
 * when that was asked. A 0 is asked again after a while, since new files are indexed as they appear.
 */
const known = new Map<string, number>();
const askedAt = new Map<string, number>();
const RECHECK_MS = 30_000;
let generation = -1;
let webapp = '';
const pending = new Set<string>();
let timer = 0;
/** The resolve in flight, so Go to source can wait for it. */
let inFlight: Promise<void> | null = null;

const key = (name: string, app = webapp) => `${app}|${name}`;

/** The webapp of the event in the panel: it picks between projects that define the same class. */
export function setSourceContext(app: string | null | undefined): void {
  webapp = app ?? '';
}

function apply(el: HTMLElement, count: number): void {
  if (count <= 0 || el.classList.contains('src-link')) return;
  el.classList.add('src-link');
  el.tabIndex = 0;
  el.setAttribute('role', 'link');
  const where = el.dataset.srcFile ? `${el.dataset.srcFile}${el.dataset.srcLine ? `:${el.dataset.srcLine}` : ''}` : el.dataset.src!.split('.').pop();
  el.title = `Open ${where} in your editor${count > 1 ? ` (${count} files define it; you will be asked which)` : ''}`;
}

/** Called for each span naming a class: linked at once if known, else checked soon. */
function mark(el: HTMLElement): void {
  const name = el.dataset.src;
  if (!name) return;
  const k = key(name);
  if (known.has(k) && (known.get(k)! > 0 || Date.now() - askedAt.get(k)! < RECHECK_MS)) apply(el, known.get(k)!);
  else {
    pending.add(name);
    clearTimeout(timer);
    timer = window.setTimeout(() => void flush(), 30);
  }
}

/** Marks every class-naming element under `root`, e.g. after building facts by hand. */
export function linkSources(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-src]').forEach(mark);
}

async function flush(): Promise<void> {
  if (!pending.size) return;
  const names = [...pending];
  const app = webapp;
  pending.clear();
  const run = (async () => {
    let body: { generation: number; building: boolean; known: Record<string, number> };
    try {
      const res = await fetch('/api/source/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, webapp: app || undefined }),
      });
      if (!res.ok) return;
      body = await res.json();
    } catch {
      return;
    }
    // The index changed since the cache was filled (a rebuild, new files): start over.
    if (body.generation !== generation) {
      known.clear();
      askedAt.clear();
      generation = body.generation;
    }
    const now = Date.now();
    for (const n of names) {
      known.set(key(n, app), body.known[n] ?? 0);
      askedAt.set(key(n, app), now);
    }
    // Still building: ask again shortly for what was not found yet.
    if (body.building) {
      const missing = names.filter((n) => !body.known[n]);
      missing.forEach((n) => askedAt.set(key(n, app), 0));
      if (missing.length) setTimeout(() => linkSources(document), 2000);
    }
    document.querySelectorAll<HTMLElement>('[data-src]').forEach((el) => {
      const c = known.get(key(el.dataset.src!, app));
      if (c !== undefined && app === webapp) apply(el, c);
    });
  })();
  inFlight = run;
  await run;
  if (inFlight === run) inFlight = null;
}

/** Whether the panel's classes have been checked; for Go to source to wait on. */
async function settled(): Promise<void> {
  if (pending.size) await flush();
  while (inFlight) await inFlight;
}

/**
 * The class Go to source opens for an event: the first stack frame from the indexed sources (the
 * top of the trace that is your code), else the logger's class, else a linkable exception class.
 */
export async function firstOwnRef(root: ParentNode): Promise<SourceRef | null> {
  linkSources(root);
  await settled();
  const els = [...root.querySelectorAll<HTMLElement>('[data-src]')].filter((el) => (known.get(key(el.dataset.src!)) ?? 0) > 0);
  const pickBy = (test: (el: HTMLElement) => boolean) => els.find(test);
  const el = pickBy((e) => e.classList.contains('hl-fn')) ?? pickBy((e) => e.dataset.srcKind === 'logger' || e.classList.contains('hl-logger')) ?? els[0];
  return el ? refOf(el) : null;
}

function refOf(el: HTMLElement): SourceRef {
  return { cls: el.dataset.src!, file: el.dataset.srcFile, line: el.dataset.srcLine ? Number(el.dataset.srcLine) : undefined };
}

// ── Opening ─────────────────────────────────────────────

/** Opens a class in the editor; asks which file when several define it. */
export async function openSource(ref: SourceRef, pick?: string): Promise<void> {
  let res: Response;
  let body: OpenAnswer;
  try {
    res = await fetch('/api/source/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ className: ref.cls, file: ref.file, line: ref.line, webapp: webapp || undefined, pick }),
    });
    body = await res.json();
  } catch (err) {
    return showError({ error: `Could not reach Debug Hub: ${(err as Error).message}` });
  }
  if (res.ok) return showToast(body.message ?? 'Opened');
  if (res.status === 409 && body.candidates?.length) {
    const chosen = await choose(ref, body.candidates);
    if (chosen) return openSource(ref, chosen);
    return;
  }
  showError(body);
}

/** The chooser for a class several projects or modules define. Resolves to the file, or null. */
function choose(ref: SourceRef, candidates: Candidate[]): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = h('dialog', { class: 'dialog src-choose', 'aria-labelledby': 'src-choose-title' }) as HTMLDialogElement;
    let result: string | null = null;
    const simple = ref.cls.replace(/\$.*$/, '').split('.').pop();
    const list = h('div', { class: 'src-choices', role: 'list' });
    candidates.forEach((c) => {
      const rel = c.root && c.file.startsWith(c.root) ? c.file.slice(c.root.length + 1) : c.file;
      const btn = h(
        'button',
        { type: 'button', class: 'src-choice', role: 'listitem' },
        h('span', { class: 'src-choice-head' },
          h('strong', {}, c.project || 'Project'),
          c.module ? h('span', { class: 'src-choice-module' }, ` · ${c.module}`) : null,
          c.root ? h('span', { class: 'src-choice-root' }, ` · ${c.root}`) : null,
        ),
        h('code', {}, rel.replace(/\\/g, '/')),
      );
      btn.title = c.file;
      btn.addEventListener('click', () => {
        result = c.file;
        dialog.close();
      });
      list.append(btn);
    });
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    cancel.addEventListener('click', () => dialog.close());
    dialog.append(
      h('h2', { id: 'src-choose-title' }, `Which ${simple}?`),
      h('p', { class: 'src-choose-note' }, `${candidates.length} files define ${ref.cls.replace(/\$.*$/, '')}. Open:`),
      list,
      h('div', { class: 'dialog-actions' }, cancel),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    list.querySelector<HTMLElement>('button')?.focus();
  });
}

export function showToast(text: string): void {
  document.querySelectorAll('.src-toast').forEach((t) => t.remove());
  const el = h('div', { class: 'toast launch-toast src-toast', role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

/** A problem opening the source: the reason, what to do, and a way to Settings when that is where to fix it. */
export function showError(a: OpenAnswer): void {
  document.querySelectorAll('.src-error').forEach((t) => t.remove());
  const close = h('button', { type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': 'Dismiss' }, '✕');
  const el = h(
    'div',
    { class: 'banner error src-error', role: 'alert' },
    h(
      'div',
      { class: 'src-error-text' },
      h('strong', {}, a.error ?? 'Could not open the source.'),
      a.hint ? h('span', {}, a.hint) : null,
      a.output ? h('pre', {}, a.output) : null,
      a.command ? h('code', { title: 'The command that was run' }, a.command) : null,
    ),
  );
  if (a.settings) {
    const go = h('button', { type: 'button', class: 'btn' }, 'Open Settings');
    go.addEventListener('click', () => {
      el.remove();
      openSettings('source');
    });
    el.append(go);
  }
  close.addEventListener('click', () => el.remove());
  el.append(close);
  document.body.append(el);
  // Errors stay until dismissed or the next attempt, but not forever.
  setTimeout(() => el.remove(), 20_000);
}

// ── Links ───────────────────────────────────────────────

function linkFrom(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.src-link') : null;
}

export function initSource(): void {
  onSourceRef(mark);
  document.addEventListener('click', (e) => {
    const el = linkFrom(e.target);
    if (!el || e.button !== 0) return;
    // A drag that selected text is not a click on the link.
    if (String(getSelection() ?? '').length > 0) return;
    e.preventDefault();
    void openSource(refOf(el));
  });
  document.addEventListener('keydown', (e) => {
    const el = linkFrom(e.target);
    if (!el || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    e.stopPropagation();
    void openSource(refOf(el));
  }, true);
}
