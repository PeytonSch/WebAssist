// The merge view: a kept config file's deployed copy and the new build's version side by side,
// with an editable result between them, modelled on IntelliJ IDEA's merge window.
//
//   deployed copy (yours)  |  result (what gets deployed)  |  new build
//
// The result starts as the deployed copy. It is diffed afresh against both sides after every
// change (see shared/mergemodel.ts): the left ribbons show what the deploy will change in the
// local file, the right ribbons what the build has that the result does not take. « on a right
// block takes it from the build, ✕ sets it aside, » on a left block puts the deployed lines back.
// "Add new settings from the build" takes every block that only adds lines, which is the usual
// job: pick up new options, keep local values.
//
// It is a modal <dialog> because it opens over the deploy dialog, which is one too.

import { compareKeys, countKeys, KIND_LABEL, readKeys, syntaxRegression, type KeyChange, type KeyEntry, type SyntaxProblem } from '../shared/configkeys';
import { chunkKind, diffInline, diffLines, lineCounts, type Chunk, type InlineDiff, type InlineRange } from '../shared/diff';
import type { MergeFile } from '../shared/keepmerge';
import {
  changes, computeFolds, ignoreKey, mapLine, MergeDoc, mergeOutcome, newSettingsSplices, restoreDeployed, shiftFolds, stepChange, takeBoth, takeFromBuild, validFolds,
  type Change, type Fold, type Splice,
} from '../shared/mergemodel';
import { describeFormat, splitLines } from '../shared/textformat';
import { h, type Child } from './dom';
import { Pane, type Action, type Band, type BandKind, type Mark, type PaneFold, type Sel } from './mergeeditor';

export interface MergeResult {
  /** The merged text, lines joined with "\n". */
  text: string;
  /** deployed / build: the result is exactly that version, so nothing needs merging. */
  outcome: 'deployed' | 'build' | 'merged';
  /** Lines added to and removed from the deployed copy. */
  added: number;
  removed: number;
  /** Settings the build adds that the result still lacks; null when the file has no readable structure. */
  missing: number | null;
  /** What is wrong with the result as its format, if the user applied it anyway. */
  problem: string | null;
}

export interface MergeOptions {
  file: MergeFile;
  /** File name of the new WAR, for the right pane's heading. */
  warName: string;
  /** A result applied earlier, to go on from. */
  initial?: string;
  onApply: (result: MergeResult) => void;
}

const KIND_OF: Record<ReturnType<typeof chunkKind>, BandKind> = { insert: 'add', delete: 'del', modify: 'mod' };
const PREF_COLLAPSE = 'dh.merge.collapse';
const PREF_WHITESPACE = 'dh.merge.ignoreWhitespace';

function pref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* private mode: not remembered */
  }
}

function svgIcon(path: string, size = 14): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function toolButton(label: string, title: string, iconPath: string | null, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { type: 'button', class: `btn btn-sm ${cls}`, title, 'aria-label': iconPath && !label ? title : null }) as HTMLButtonElement;
  if (iconPath) b.append(svgIcon(iconPath));
  if (label) b.append(h('span', {}, label));
  b.addEventListener('click', onClick);
  return b;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const fileName = (p: string) => p.split('/').pop() ?? p;

/** What Tab inserts in this file: a tab if it indents with tabs, else its smallest indentation. */
function indentOf(lines: readonly string[]): string {
  let min = 0;
  for (const l of lines) {
    if (l[0] === '\t') return '\t';
    const n = /^ */.exec(l)![0].length;
    if (n && n < l.length && (!min || n < min)) min = n;
  }
  return ' '.repeat(min >= 2 && min <= 8 ? min : 2);
}

/** A setting's path starts with a section's path. */
const under = (path: string, section: string) => path === section || (path.startsWith(section) && /[.[/@]/.test(path[section.length]));

class MergeView {
  private dialog: HTMLDialogElement;
  private deployed: string[];
  private build: string[];
  private doc: MergeDoc<Sel>;
  private initial: string[];
  private left: Chunk[] = [];
  private right: Chunk[] = [];
  private list: Change[] = [];
  private cur = -1;
  private folds: Fold[] = [];
  private collapse = pref(PREF_COLLAPSE, true);
  private ignoreWs = pref(PREF_WHITESPACE, false);
  private inline = new Map<string, InlineDiff | null>();
  private L: Pane;
  private M: Pane;
  private R: Pane;
  private panes: Pane[];
  /** The pane the user last scrolled, clicked or typed in: the one the others follow. */
  private master: Pane;
  private ribbonL = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private ribbonR = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private expected = new Map<Pane, { top: number; left: number }>();
  private drawQueued = false;
  private checkTimer = 0;
  private problem: SyntaxProblem | null = null;
  private missing: number | null = null;
  private closed = false;
  // Settings, read once for the two fixed versions.
  private deployedKeys: KeyEntry[] | null;
  private buildKeys: KeyEntry[] | null;
  private newKeys: KeyChange[] = [];
  private goneKeys: KeyChange[] = [];
  private ui: {
    counter: HTMLElement;
    prev: HTMLButtonElement;
    next: HTMLButtonElement;
    addNew: HTMLButtonElement;
    addCount: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    summary: HTMLElement;
    status: HTMLElement;
    warning: HTMLElement;
    resultNote: HTMLElement;
    useDeployed: HTMLButtonElement;
    useBuild: HTMLButtonElement;
    map: HTMLElement;
  };
  private resize: ResizeObserver;

  constructor(private opts: MergeOptions) {
    const { file } = opts;
    this.deployed = splitLines(file.deployed.text);
    this.build = splitLines(file.build.text);
    this.initial = opts.initial !== undefined ? splitLines(opts.initial) : this.deployed;
    this.doc = new MergeDoc<Sel>(this.initial);
    this.deployedKeys = readKeys(file.deployed.text, file.kind);
    this.buildKeys = readKeys(file.build.text, file.kind);
    if (this.deployedKeys && this.buildKeys) {
      const delta = compareKeys(this.deployedKeys, this.buildKeys, file.kind);
      this.newKeys = delta.added;
      this.goneKeys = delta.removed;
    }

    const host = (side: 'deployed' | 'result' | 'build') => ({
      edit: (splice: Splice, before: Sel, after: Sel, tag: string | null) => this.edit([splice], before, after, tag ?? undefined),
      expand: (line: number) => this.expand(side, line),
      caret: (sel: Sel, byUser: boolean) => this.caretMoved(sel, byUser),
    });
    const name = fileName(file.path);
    this.L = new Pane({ side: 'deployed', kind: file.kind, gutter: 'right', label: `Deployed copy of ${name}, read-only`, host: host('deployed') });
    this.M = new Pane({ side: 'result', kind: file.kind, gutter: 'left', label: `Result: ${name} as it will be deployed`, host: host('result'), editable: true, indent: indentOf(this.deployed) });
    this.R = new Pane({ side: 'build', kind: file.kind, gutter: 'left', label: `${name} in the new build, read-only`, host: host('build') });
    this.panes = [this.L, this.M, this.R];
    this.master = this.M;
    for (const p of this.panes) {
      const mine = () => (this.master = p);
      p.scroll.addEventListener('pointerdown', mine);
      p.scroll.addEventListener('focusin', mine);
    }

    // ── Head ──
    const close = h('button', { type: 'button', class: 'btn btn-icon btn-ghost mv-close', title: 'Close (Esc)', 'aria-label': 'Close' });
    close.append(svgIcon('M4 4l8 8m0-8-8 8', 15));
    close.addEventListener('click', () => this.requestClose());
    const head = h(
      'header',
      { class: 'mv-head' },
      h('h2', { id: 'mv-title' }, `Merge ${name}`),
      h('span', { class: 'mv-path', title: file.path }, file.path),
      h('span', { class: 'mv-kind' }, KIND_LABEL[file.kind]),
      h('span', { class: 'spacer' }),
      close,
    );

    // ── Toolbar ──
    const prev = toolButton('', 'Previous change (Shift+F7)', 'M8 12.5v-9m0 0L4.5 7M8 3.5 11.5 7', () => this.step(-1), 'btn-icon');
    const next = toolButton('', 'Next change (F7)', 'M8 3.5v9m0 0L4.5 9M8 12.5 11.5 9', () => this.step(1), 'btn-icon');
    const counter = h('span', { class: 'mv-counter', role: 'status' });
    const addCount = h('span', { class: 'mv-count' });
    const addNew = toolButton('Add new settings from the build', '', 'M8 3.5v9M3.5 8h9', () => this.addNew(), 'mv-addnew');
    addNew.append(addCount);
    const undo = toolButton('', 'Undo (Ctrl+Z)', 'M6 4 3 7l3 3M3.5 7H9a3.5 3.5 0 0 1 0 7H7', () => this.undo(), 'btn-icon');
    const redo = toolButton('', 'Redo (Ctrl+Y)', 'M10 4l3 3-3 3M12.5 7H7a3.5 3.5 0 0 0 0 7h2', () => this.redo(), 'btn-icon');
    const check = (label: string, title: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement => {
      const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = checked;
      box.addEventListener('change', () => onChange(box.checked));
      return h('label', { class: 'check mv-check', title }, box, ` ${label}`);
    };
    const tools = h(
      'div',
      { class: 'mv-tools', role: 'toolbar', 'aria-label': 'Merge' },
      h('div', { class: 'mv-group' }, prev, next),
      counter,
      h('span', { class: 'mv-sep' }),
      addNew,
      h('span', { class: 'mv-sep' }),
      h('div', { class: 'mv-group' }, undo, redo),
      h('span', { class: 'spacer' }),
      check('Ignore whitespace', 'Lines that differ only in spaces and tabs count as the same', this.ignoreWs, (v) => {
        this.ignoreWs = v;
        savePref(PREF_WHITESPACE, v);
        this.refresh({ refold: true });
      }),
      check('Collapse unchanged', 'Hide long stretches that are the same in all three', this.collapse, (v) => {
        this.collapse = v;
        savePref(PREF_COLLAPSE, v);
        this.refresh({ refold: true });
      }),
    );
    const summary = h('div', { class: 'mv-summary' });

    // ── Panes ──
    const useDeployed = toolButton('Use deployed', 'Make the result the deployed copy again, as it is now on the server', null, () => this.useWhole('deployed'), 'btn-ghost mv-whole');
    const useBuild = toolButton('Use new build', 'Make the result the new build’s file, dropping every local value', null, () => this.useWhole('build'), 'btn-ghost mv-whole');
    const resultNote = h('span', { class: 'mv-pane-note' });
    const paneHead = (title: string, note: Child, ...rest: Child[]) => h('div', { class: 'mv-pane-head' }, h('strong', {}, title), note, h('span', { class: 'spacer' }), ...rest);
    const lock = () => {
      const s = h('span', { class: 'mv-lock', title: 'Read-only' });
      s.append(svgIcon('M5 7.5V5.5a3 3 0 0 1 6 0v2M4 7.5h8v5.5H4z', 12));
      return s;
    };
    const gutter = (svg: SVGSVGElement) => {
      svg.setAttribute('class', 'mv-ribbons');
      svg.setAttribute('aria-hidden', 'true');
      const el = h('div', { class: 'mv-between' });
      el.append(svg);
      // The wheel over the ribbons scrolls the result.
      el.addEventListener('wheel', (e) => {
        this.M.scroll.scrollTop += e.deltaY;
        e.preventDefault();
      }, { passive: false });
      return el;
    };
    const map = h('div', { class: 'mv-map', title: 'Where the changes are. Click to go there.' });
    map.addEventListener('click', (e) => this.mapClick(e));
    const panes = h(
      'div',
      { class: 'mv-panes' },
      paneHead('Deployed copy', h('span', { class: 'mv-pane-note' }, 'yours, as it is on the server'), lock(), useDeployed),
      h('div', { class: 'mv-between-head' }),
      paneHead('Result', resultNote),
      h('div', { class: 'mv-between-head' }),
      paneHead('New build', h('span', { class: 'mv-pane-note', title: opts.warName }, opts.warName), lock(), useBuild),
      h('div', { class: 'mv-map-head' }),
      this.L.scroll,
      gutter(this.ribbonL),
      this.M.scroll,
      gutter(this.ribbonR),
      this.R.scroll,
      map,
    );

    // ── Foot ──
    const status = h('span', { class: 'mv-status' });
    const warning = h('button', { type: 'button', class: 'mv-warning' });
    warning.hidden = true;
    warning.addEventListener('click', () => this.goToProblem());
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    cancel.addEventListener('click', () => this.requestClose());
    const apply = h('button', { type: 'button', class: 'btn btn-primary', title: 'Use this result for the deploy (Ctrl+Enter)' }, 'Apply');
    apply.addEventListener('click', () => this.apply());
    const foot = h(
      'footer',
      { class: 'mv-foot' },
      status,
      warning,
      h('span', { class: 'spacer' }),
      h('span', { class: 'mv-keys' }, h('kbd', {}, 'F7'), ' next change ', h('kbd', {}, 'Shift'), h('kbd', {}, 'F7'), ' previous'),
      cancel,
      apply,
    );

    this.ui = { counter, prev, next, addNew, addCount, undo, redo, summary, status, warning, resultNote, useDeployed, useBuild, map };
    this.dialog = h('dialog', { class: 'mv', 'aria-labelledby': 'mv-title' }, head, tools, summary, panes, foot) as HTMLDialogElement;
    this.dialog.tabIndex = -1;

    for (const p of this.panes) p.scroll.addEventListener('scroll', () => this.scrolled(p), { passive: true });
    this.dialog.addEventListener('keydown', (e) => this.key(e));
    // Esc is handled in key(); this is any other way the browser asks to close a dialog.
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.requestClose();
    });
    this.dialog.addEventListener('close', () => {
      // Closed behind our back (a second Esc can skip the cancel event): do not lose the edits.
      if (!this.closed) this.dialog.showModal();
    });
    this.resize = new ResizeObserver(() => this.queueDraw());
    this.resize.observe(panes);
  }

  open(): void {
    document.body.append(this.dialog);
    this.dialog.showModal();
    this.refresh({ refold: true });
    this.dialog.focus({ preventScroll: true });
    // Start at the first change, so the first thing in view is a difference.
    if (this.list.length) this.go(0, false);
  }

  private close(): void {
    this.closed = true;
    clearTimeout(this.checkTimer);
    this.resize.disconnect();
    for (const p of this.panes) p.destroy();
    this.dialog.close();
    this.dialog.remove();
  }

  // ── The text ──────────────────────────────────────────

  private resultText(): string {
    return this.doc.lines.join('\n');
  }

  private dirty(): boolean {
    const now = this.doc.lines;
    return now.length !== this.initial.length || now.some((l, i) => l !== this.initial[i]);
  }

  private isIgnored = (c: Chunk): boolean => this.doc.ignored.has(ignoreKey(c, this.doc.lines));

  /** An edit of the result, by typing or by a button, as one undo step. */
  private edit(splices: Splice[], before: Sel | null, after: Sel | null, tag?: string, ignored?: Set<string>, refold = false): void {
    const sel = before ?? this.M.readSel();
    for (const s of [...splices].sort((x, y) => y.at - x.at)) this.folds = shiftFolds(this.folds, s);
    this.doc.edit(splices, { selBefore: sel, selAfter: after ?? sel, tag, ignored });
    this.refresh({ sel: after ?? undefined, refold });
  }

  private undo(): void {
    this.history(this.doc.undo());
  }

  private redo(): void {
    this.history(this.doc.redo());
  }

  private history(done: { splices: Splice[][]; sel: Sel } | null): void {
    if (!done) return;
    for (const set of done.splices) for (const s of [...set].sort((x, y) => y.at - x.at)) this.folds = shiftFolds(this.folds, s);
    this.refresh({ sel: done.sel, focus: true });
  }

  // ── Diffing and drawing ───────────────────────────────

  private inlineFor(a: readonly string[], b: readonly string[]): InlineDiff | null {
    const key = `${a.join('\n')}\u0000${b.join('\n')}`;
    let d = this.inline.get(key);
    if (d === undefined) {
      if (this.inline.size > 2000) this.inline.clear();
      this.inline.set(key, (d = diffInline(a, b)));
    }
    return d;
  }

  private refresh(o: { sel?: Sel; refold?: boolean; focus?: boolean } = {}): void {
    const result = this.doc.lines;
    const opts = { ignoreWhitespace: this.ignoreWs };
    this.left = diffLines(this.deployed, result, opts);
    this.right = diffLines(result, this.build, opts);
    if (!this.collapse) this.folds = [];
    else if (o.refold) this.folds = computeFolds(this.left, this.right, result.length);
    else this.folds = validFolds(this.folds, this.left, this.right);

    // The words that differ inside each changed block, by pane and line.
    const marksL = new Map<number, Mark[]>();
    const marksM = new Map<number, Mark[]>();
    const marksR = new Map<number, Mark[]>();
    const put = (map: Map<number, Mark[]>, base: number, ranges: InlineRange[]) => {
      for (const r of ranges) {
        const list = map.get(base + r.line);
        if (list) list.push({ from: r.from, to: r.to });
        else map.set(base + r.line, [{ from: r.from, to: r.to }]);
      }
    };
    for (const c of this.left) {
      if (chunkKind(c) !== 'modify') continue;
      const d = this.inlineFor(this.deployed.slice(c.a0, c.a1), result.slice(c.b0, c.b1));
      if (d) {
        put(marksL, c.a0, d.a);
        put(marksM, c.b0, d.b);
      }
    }
    for (const c of this.right) {
      if (chunkKind(c) !== 'modify') continue;
      const d = this.inlineFor(result.slice(c.a0, c.a1), this.build.slice(c.b0, c.b1));
      if (d) {
        put(marksM, c.a0, d.a);
        put(marksR, c.b0, d.b);
      }
    }
    // A result line can have marks from both sides: one sorted list without overlaps.
    for (const [line, list] of marksM) {
      list.sort((x, y) => x.from - y.from);
      const merged: Mark[] = [];
      for (const m of list) {
        const last = merged[merged.length - 1];
        if (last && m.from <= last.to) last.to = Math.max(last.to, m.to);
        else merged.push({ ...m });
      }
      marksM.set(line, merged);
    }

    const foldsOf = (side: 'deployed' | 'result' | 'build'): PaneFold[] => this.folds.map((f) => ({ start: f[side], len: f.len }));
    this.L.render(this.deployed, foldsOf('deployed'), marksL);
    this.M.render(result, foldsOf('result'), marksM);
    this.R.render(this.build, foldsOf('build'), marksR);

    // The current change stays the one at the same place in the result.
    const at = this.cur >= 0 && this.list[this.cur] ? this.list[this.cur].r0 : null;
    this.list = changes(this.left, this.right, this.isIgnored);
    if (at === null || !this.list.length) this.cur = -1;
    else {
      let best = 0;
      for (let i = 1; i < this.list.length; i++) if (Math.abs(this.list[i].r0 - at) < Math.abs(this.list[best].r0 - at)) best = i;
      this.cur = best;
    }
    this.decorate();
    if (o.sel && (o.focus || this.M.hasFocus())) {
      if (!this.M.hasFocus()) this.M.focus();
      this.M.setSel(o.sel);
      this.master = this.M;
    }
    // The pane the user is working in stays where it is; the other two line up with it again.
    this.syncFrom(this.master);
    this.queueCheck();
  }

  /** Bands, buttons, counter and button states: everything that follows from the two diffs. */
  private decorate(): void {
    const cur = this.list[this.cur];
    const curL = new Set(cur?.left ?? []);
    const curR = new Set(cur?.right ?? []);

    this.L.setBands(
      this.left.map((c, i): Band => {
        const kind = KIND_OF[chunkKind(c)];
        return { from: c.a0, to: c.a1, kind, current: curL.has(i) };
      }),
    );
    this.R.setBands(
      this.right.map((c, j): Band => {
        const kind = KIND_OF[chunkKind(c)];
        return { from: c.b0, to: c.b1, kind, resolved: this.isIgnored(c), current: curR.has(j) };
      }),
    );

    // The result wears both diffs. Where a line is in a block on each side and they differ in
    // kind, the band shades from one colour to the other.
    const bands: Band[] = [];
    const cuts = new Set<number>();
    this.left.forEach((c, i) => {
      if (c.b0 === c.b1) bands.push({ from: c.b0, to: c.b0, kind: 'del', current: curL.has(i) });
      else cuts.add(c.b0).add(c.b1);
    });
    this.right.forEach((c, j) => {
      if (c.a0 === c.a1) bands.push({ from: c.a0, to: c.a0, kind: 'add', resolved: this.isIgnored(c), current: curR.has(j) });
      else cuts.add(c.a0).add(c.a1);
    });
    const points = [...cuts].sort((x, y) => x - y);
    let li = 0;
    let ri = 0;
    for (let k = 0; k + 1 < points.length; k++) {
      const from = points[k];
      const to = points[k + 1];
      while (li < this.left.length && this.left[li].b1 <= from) li++;
      while (ri < this.right.length && this.right[ri].a1 <= from) ri++;
      const l = this.left[li] && this.left[li].b0 <= from && this.left[li].b1 > from ? this.left[li] : null;
      const r = this.right[ri] && this.right[ri].a0 <= from && this.right[ri].a1 > from ? this.right[ri] : null;
      if (!l && !r) continue;
      const lk = l ? KIND_OF[chunkKind(l)] : null;
      const rk = r ? KIND_OF[chunkKind(r)] : null;
      const rIgnored = r ? this.isIgnored(r) : false;
      bands.push({
        from,
        to,
        kind: lk ?? rk!,
        kind2: lk && rk && !rIgnored ? rk : undefined,
        resolved: !lk && rIgnored,
        current: (l !== null && curL.has(li)) || (r !== null && curR.has(ri)),
      });
    }
    this.M.setBands(bands);

    this.L.setActions(
      this.left.map((c, i): Action => ({
        line: c.a0,
        index: i,
        current: curL.has(i),
        buttons: [{ action: 'restore', title: chunkKind(c) === 'insert' ? 'Remove these lines from the result again (Alt+R)' : 'Put the deployed lines back in the result (Alt+R)', run: () => this.restore(i) }],
      })),
    );
    this.R.setActions(
      this.right.map((c, j): Action => {
        const kind = chunkKind(c);
        const ignored = this.isIgnored(c);
        const buttons: Action['buttons'] = [
          {
            action: 'take',
            title: kind === 'insert' ? 'Add these lines to the result (Alt+B)' : kind === 'delete' ? 'Remove the lines the build no longer has from the result (Alt+B)' : 'Use the build’s lines in the result (Alt+B)',
            run: () => this.take(j),
          },
        ];
        if (kind === 'modify') buttons.push({ action: 'both', title: 'Keep the result’s lines and add the build’s below them (Alt+A)', run: () => this.both(j) });
        if (!ignored) buttons.push({ action: 'ignore', title: 'Leave the result as it is here (Alt+K)', run: () => this.ignore(j) });
        return { line: c.b0, index: j, current: curR.has(j), buttons };
      }),
    );
    this.M.setActions([]);

    // Counter and buttons.
    const n = this.list.length;
    const open = this.list.filter((c) => c.unresolved).length;
    const { counter, prev, next, addNew, addCount, undo, redo, resultNote, useDeployed, useBuild } = this.ui;
    counter.textContent = !n
      ? this.left.length || this.right.length ? '' : 'No differences: all three are the same'
      : `${this.cur >= 0 ? `${this.cur + 1} of ${plural(n, 'change')}` : plural(n, 'change')} · ${open ? `${open} unresolved` : 'all resolved'}`;
    counter.classList.toggle('done', n > 0 && !open);
    prev.disabled = next.disabled = !n;
    const additions = newSettingsSplices(this.right, this.build, this.isIgnored).length;
    addNew.disabled = !additions;
    addCount.textContent = additions ? String(additions) : '';
    addCount.hidden = !additions;
    addNew.title = additions
      ? `Adds the ${plural(additions, 'block')} of lines that only the new build has to the result. Lines you have are not touched, so your values stay.`
      : 'The result has every block of lines the new build adds';
    undo.disabled = !this.doc.canUndo;
    redo.disabled = !this.doc.canRedo;
    const outcome = mergeOutcome(this.deployed, this.build, this.doc.lines);
    useDeployed.disabled = outcome === 'deployed';
    useBuild.disabled = outcome === 'build';
    const { added, removed } = lineCounts(this.left);
    resultNote.textContent =
      outcome === 'deployed' ? 'the same as the deployed copy · edit here'
      : outcome === 'build' ? 'the same as the new build'
      : `${added ? `+${added}` : ''}${added && removed ? ' ' : ''}${removed ? `−${removed}` : ''} ${added + removed === 1 ? 'line' : 'lines'} against the deployed copy`;
    resultNote.classList.toggle('changed', outcome !== 'deployed');
    // A button that was just used and is now disabled would swallow the keyboard (F7, Ctrl+Z).
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && active.disabled && this.dialog.contains(active)) this.dialog.focus({ preventScroll: true });
    this.drawMap();
  }

  // ── Ribbons and scrolling ─────────────────────────────

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      if (this.closed) return;
      const cur = this.list[this.cur];
      this.drawRibbons(this.ribbonL, this.L, this.M, this.left, new Set(cur?.left ?? []), () => false);
      this.drawRibbons(this.ribbonR, this.M, this.R, this.right, new Set(cur?.right ?? []), this.isIgnored);
    });
  }

  /** The shapes that join each block's lines in one pane to its lines in the next. */
  private drawRibbons(svg: SVGSVGElement, A: Pane, B: Pane, chunks: Chunk[], current: Set<number>, resolved: (c: Chunk) => boolean): void {
    const w = svg.clientWidth;
    const hgt = svg.clientHeight;
    const sa = A.scroll.scrollTop;
    const sb = B.scroll.scrollTop;
    const paths: SVGPathElement[] = [];
    const f = (n: number) => n.toFixed(1);
    chunks.forEach((c, i) => {
      let a0 = A.top(c.a0) - sa;
      let a1 = A.top(c.a1) - sa;
      let b0 = B.top(c.b0) - sb;
      let b1 = B.top(c.b1) - sb;
      if (Math.max(a1, b1) < -40 || Math.min(a0, b0) > hgt + 40) return;
      // A side without lines is a mark between two lines: as thick as the mark in the pane.
      if (a1 - a0 < 2) [a0, a1] = [a0 - 1, a0 + 1];
      if (b1 - b0 < 2) [b0, b1] = [b0 - 1, b0 + 1];
      const m = w / 2;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', `M0,${f(a0)} C${m},${f(a0)} ${m},${f(b0)} ${w},${f(b0)} L${w},${f(b1)} C${m},${f(b1)} ${m},${f(a1)} 0,${f(a1)} Z`);
      p.setAttribute('class', `mv-rib mv-${KIND_OF[chunkKind(c)]}${resolved(c) ? ' mv-res' : ''}${current.has(i) ? ' mv-cur' : ''}`);
      paths.push(p);
    });
    svg.replaceChildren(...paths);
  }

  /** Where the changes are in the whole file, beside the scroll bar. */
  private drawMap(): void {
    const total = Math.max(1, this.M.height);
    const cur = this.list[this.cur];
    this.ui.map.replaceChildren(
      ...this.list.map((c) => {
        const el = h('span', { class: `mv-map-mark${c.unresolved ? '' : ' mv-res'}${c === cur ? ' mv-cur' : ''}` });
        const top = this.M.top(c.r0);
        el.style.top = `${(top / total) * 100}%`;
        el.style.height = `max(3px, ${((this.M.top(c.r1) - top) / total) * 100}%)`;
        const r = c.right.map((j) => this.right[j]).find((x) => !this.isIgnored(x)) ?? this.right[c.right[0]];
        el.classList.add(`mv-${KIND_OF[chunkKind(r ?? this.left[c.left[0]])]}`);
        return el;
      }),
    );
  }

  private mapClick(e: MouseEvent): void {
    if (!this.list.length) return;
    const box = this.ui.map.getBoundingClientRect();
    const y = ((e.clientY - box.top) / box.height) * this.M.height;
    let best = 0;
    for (let i = 1; i < this.list.length; i++) if (Math.abs(this.M.top(this.list[i].r0) - y) < Math.abs(this.M.top(this.list[best].r0) - y)) best = i;
    this.go(best, false);
  }

  /** The line position in pane `to` that matches `pos` in pane `from`. */
  private mapPos(from: Pane, to: Pane, pos: number): number {
    const order = [this.L, this.M, this.R];
    let i = order.indexOf(from);
    const target = order.indexOf(to);
    while (i !== target) {
      if (i < target) {
        pos = mapLine(i === 0 ? this.left : this.right, pos, true);
        i++;
      } else {
        pos = mapLine(i === 2 ? this.right : this.left, pos, false);
        i--;
      }
    }
    return pos;
  }

  private scrolled(p: Pane): void {
    const exp = this.expected.get(p);
    if (exp && Math.abs(p.scroll.scrollTop - exp.top) < 2 && Math.abs(p.scroll.scrollLeft - exp.left) < 2) {
      // Our own doing, following another pane.
      this.queueDraw();
      return;
    }
    this.expected.delete(p);
    this.master = p;
    this.syncFrom(p);
  }

  /**
   * Scrolls the other two panes to match pane `p`. The line that is matched moves down the view
   * as `p` is scrolled down: the top lines when `p` is at its top, the bottom lines at its
   * bottom, so all three reach their ends together and a block in the middle of the view lines up.
   */
  private syncFrom(p: Pane): void {
    const sc = p.scroll;
    const max = sc.scrollHeight - sc.clientHeight;
    const offset = max > 0 ? sc.clientHeight * Math.min(1, sc.scrollTop / max) : 0;
    const pos = p.lineAt(sc.scrollTop + offset);
    for (const q of this.panes) {
      if (q === p) continue;
      const qs = q.scroll;
      const top = Math.max(0, Math.min(Math.round(q.top(this.mapPos(p, q, pos)) - offset), qs.scrollHeight - qs.clientHeight));
      const left = Math.min(sc.scrollLeft, qs.scrollWidth - qs.clientWidth);
      this.expected.set(q, { top, left });
      qs.scrollTop = top;
      qs.scrollLeft = left;
    }
    this.queueDraw();
  }

  // ── Stepping through the changes ──────────────────────

  private step(dir: 1 | -1): void {
    if (!this.list.length) return;
    this.go(stepChange(this.list, this.cur, dir), true);
  }

  private go(index: number, moveCaret: boolean): void {
    const c = this.list[index];
    if (!c) return;
    this.cur = index;
    this.doc.breakTyping();
    this.decorate();
    this.M.scrollToLine(c.r0);
    this.master = this.M;
    this.expected.delete(this.M);
    this.syncFrom(this.M);
    if (moveCaret && this.M.hasFocus()) {
      const line = Math.min(c.r0, this.doc.lines.length - 1);
      this.M.setSel({ a: { line, col: 0 }, h: { line, col: 0 } }, false);
    }
  }

  private caretMoved(sel: Sel, byUser: boolean): void {
    if (!byUser) return;
    this.doc.breakTyping();
    // The change the caret is in becomes the current one, so the shortcuts act where the user is.
    const line = sel.h.line;
    const at = this.list.findIndex((c) => (c.r0 === c.r1 ? c.r0 === line : c.r0 <= line && line < c.r1));
    if (at !== -1 && at !== this.cur) {
      this.cur = at;
      this.decorate();
      this.queueDraw();
    }
  }

  private expand(side: 'deployed' | 'result' | 'build', line: number): void {
    const before = this.folds.length;
    this.folds = this.folds.filter((f) => !(line >= f[side] && line < f[side] + f.len));
    if (this.folds.length !== before) this.refresh();
  }

  // ── Actions on a block ────────────────────────────────

  private caretAt(line: number): Sel {
    const l = Math.max(0, Math.min(line, this.doc.lines.length - 1));
    return { a: { line: l, col: 0 }, h: { line: l, col: 0 } };
  }

  private take(j: number): void {
    const c = this.right[j];
    if (!c) return;
    this.doc.breakTyping();
    this.edit([takeFromBuild(c, this.build)], null, this.caretAt(c.a0));
  }

  private both(j: number): void {
    const c = this.right[j];
    if (!c) return;
    const splice = takeBoth(c, this.build);
    // What still differs from the build there afterwards was chosen, not overlooked: set it aside.
    const lines = [...this.doc.lines.slice(0, splice.at), ...splice.insert, ...this.doc.lines.slice(splice.at)];
    const ignored = new Set(this.doc.ignored);
    for (const r of diffLines(lines, this.build, { ignoreWhitespace: this.ignoreWs })) {
      if (r.a0 <= c.a1 + splice.insert.length && r.a1 >= c.a0) ignored.add(ignoreKey(r, lines));
    }
    this.doc.breakTyping();
    this.edit([splice], null, this.caretAt(c.a1), undefined, ignored);
  }

  private ignore(j: number): void {
    const c = this.right[j];
    if (!c) return;
    const ignored = new Set(this.doc.ignored).add(ignoreKey(c, this.doc.lines));
    this.doc.breakTyping();
    this.edit([], null, null, undefined, ignored);
  }

  private restore(i: number): void {
    const c = this.left[i];
    if (!c) return;
    this.doc.breakTyping();
    this.edit([restoreDeployed(c, this.deployed)], null, this.caretAt(c.b0));
  }

  private addNew(): void {
    const splices = newSettingsSplices(this.right, this.build, this.isIgnored);
    if (!splices.length) return;
    this.doc.breakTyping();
    this.edit(splices, null, null);
    // Show the first of what was added.
    const first = Math.min(...splices.map((s) => s.at));
    const at = this.list.findIndex((c) => c.r0 >= first);
    if (at !== -1) this.go(at, false);
  }

  private useWhole(which: 'deployed' | 'build'): void {
    const lines = which === 'deployed' ? this.deployed : this.build;
    this.doc.breakTyping();
    this.edit([{ at: 0, remove: this.doc.lines.length, insert: [...lines] }], null, this.caretAt(0), undefined, new Set(), true);
    if (this.list.length) this.go(0, false);
  }

  /** The current change's block on the right (to take, add or set aside) or left (to put back). */
  private currentChunk(side: 'left' | 'right'): number {
    const c = this.list[this.cur];
    if (!c) return -1;
    if (side === 'left') return c.left[0] ?? -1;
    return c.right.find((j) => !this.isIgnored(this.right[j])) ?? c.right[0] ?? -1;
  }

  // ── Settings summary and syntax check ─────────────────

  private queueCheck(): void {
    clearTimeout(this.checkTimer);
    this.checkTimer = window.setTimeout(() => this.check(), 150);
  }

  private check(): void {
    if (this.closed) return;
    const { file } = this.opts;
    const text = this.resultText();
    this.problem = syntaxRegression(text, file.kind, [file.deployed.text, file.build.text]);
    const { warning, status } = this.ui;
    warning.hidden = !this.problem;
    if (this.problem) {
      warning.textContent = `The result is not valid ${KIND_LABEL[file.kind]}${this.problem.line !== undefined ? `, line ${this.problem.line + 1}` : ''}: ${this.problem.message}`;
      warning.title = 'Go to the line';
    }
    const f = file.deployed.format;
    status.textContent = `${KIND_LABEL[file.kind]} · ${describeFormat(f)}`;
    status.title =
      `The result is stored like the deployed copy: ${describeFormat(f)}${f.finalNewline ? '' : ', no line break at the end unless you add one'}.` +
      (f.mixedEol ? ' Its line endings are mixed; the result uses one kind.' : '') +
      (file.build.format.eol !== f.eol ? ` The build’s file uses ${describeFormat(file.build.format).split(' · ')[1]}.` : '');
    this.summarize(text);
  }

  /** The strip under the toolbar: which new settings the result has by now, and which it lacks. */
  private summarize(text: string): void {
    const { file } = this.opts;
    const { summary } = this.ui;
    const parts: Child[] = [];
    const resultKeys = this.deployedKeys && this.buildKeys ? readKeys(text, file.kind) : null;
    if (!this.deployedKeys || !this.buildKeys) {
      const { added, removed } = lineCounts(this.right);
      this.missing = null;
      parts.push(
        h('span', { class: 'mv-sum-label' }, added + removed ? `The result differs from the new build in ${plural(added + removed, 'line')}` : 'The result is the same as the new build'),
        added + removed ? h('span', { class: 'muted' }, `(the build has ${added} the result lacks; the result has ${removed} the build lacks)`) : null,
      );
    } else {
      const have = new Set((resultKeys ?? []).map((e) => e.path));
      const had = new Set(this.deployedKeys.map((e) => e.path));
      const fresh = this.buildKeys.filter((e) => !had.has(e.path));
      const stillMissing = fresh.filter((e) => !have.has(e.path));
      this.missing = resultKeys ? stillMissing.length : null;
      if (this.newKeys.length) {
        parts.push(h('span', { class: 'mv-sum-label' }, `New in this build (${countKeys(this.newKeys)})`));
        for (const k of this.newKeys) {
          const mine = fresh.filter((e) => under(e.path, k.path));
          const lacking = mine.filter((e) => !have.has(e.path)).length;
          const state = !resultKeys ? 'new' : lacking === 0 ? 'done' : lacking < mine.length ? 'part' : 'new';
          const chip = h(
            'button',
            { type: 'button', class: `mv-chip mv-chip-${state}`, title: `${k.path}${k.value !== undefined ? ` = ${k.value}` : ` (${k.count} settings)`}\n${state === 'done' ? 'In the result. Click to go there.' : state === 'part' ? `${mine.length - lacking} of ${mine.length} in the result. Click to see it in the new build.` : 'Not in the result yet. Click to see it in the new build.'}` },
            h('span', { class: 'mv-chip-mark', 'aria-hidden': 'true' }, state === 'done' ? '✓' : '+'),
            k.count > 1 ? `${k.path} (${state === 'part' ? `${mine.length - lacking}/` : ''}${k.count})` : k.path,
          );
          chip.addEventListener('click', () => {
            const inResult = state === 'done' ? resultKeys?.find((e) => under(e.path, k.path)) : null;
            if (inResult) this.reveal(this.M, inResult.line);
            else this.reveal(this.R, k.line);
          });
          parts.push(chip);
        }
      } else parts.push(h('span', { class: 'mv-sum-label muted' }, 'This build adds no settings'));
      if (this.goneKeys.length) {
        parts.push(h('span', { class: 'mv-sum-label mv-sum-gap' }, 'No longer in the build'));
        for (const k of this.goneKeys) {
          const kept = !resultKeys || resultKeys.some((e) => under(e.path, k.path));
          const chip = h(
            'button',
            { type: 'button', class: `mv-chip mv-chip-gone${kept ? '' : ' mv-chip-dropped'}`, title: `${k.path}${k.value !== undefined ? ` = ${k.value}` : ''}\n${kept ? 'The result still has it. Click to go there.' : 'Removed from the result. Click to see it in the deployed copy.'}` },
            k.count > 1 ? `${k.path} (${k.count})` : k.path,
          );
          chip.addEventListener('click', () => {
            const inResult = resultKeys?.find((e) => under(e.path, k.path));
            if (inResult) this.reveal(this.M, inResult.line);
            else this.reveal(this.L, k.line);
          });
          parts.push(chip);
        }
      }
      if (resultKeys) {
        const differ = compareKeys(resultKeys, this.buildKeys, file.kind).changed;
        if (differ.length) {
          const first = differ[0];
          const chip = h(
            'button',
            { type: 'button', class: 'mv-chip mv-chip-diff mv-sum-gap', title: `${differ.slice(0, 12).map((d) => `${d.path}: ${d.from} → ${d.to} in the build`).join('\n')}${differ.length > 12 ? `\n… and ${differ.length - 12} more` : ''}` },
            `${plural(differ.length, 'value')} ${differ.length === 1 ? 'differs' : 'differ'} from the build`,
          );
          chip.addEventListener('click', () => this.reveal(this.M, first.lineFrom));
          parts.push(chip);
        }
      }
    }
    summary.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  /** Scrolls a pane to a line, the others with it, and makes the change there the current one. */
  private reveal(pane: Pane, line: number): void {
    this.expand(pane.side, line);
    const resultLine = Math.floor(this.mapPos(pane, this.M, line));
    const at = this.list.findIndex((c) => (c.r0 === c.r1 ? c.r0 === resultLine : c.r0 <= resultLine && resultLine < c.r1));
    if (at !== -1) {
      this.cur = at;
      this.decorate();
    }
    pane.scrollToLine(line);
    this.master = pane;
    this.expected.delete(pane);
    this.syncFrom(pane);
    pane.flash(line);
  }

  private goToProblem(): void {
    if (this.problem?.line === undefined) return this.M.focus();
    const line = Math.min(this.problem.line, this.doc.lines.length - 1);
    this.M.focus();
    this.M.setSel({ a: { line, col: 0 }, h: { line, col: this.doc.lines[line].length } });
    this.syncFrom(this.M);
  }

  // ── Keys, applying and closing ────────────────────────

  private key(e: KeyboardEvent): void {
    // Nothing typed here is a shortcut of the page under the dialog.
    e.stopPropagation();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      // Out of the editor first, where Tab indents: on to the next pane, so that Tab reaches its
      // buttons from there and Shift+Tab comes back.
      if (this.M.hasFocus()) this.R.scroll.focus({ preventScroll: true });
      else this.requestClose();
    } else if (e.key === 'F7') {
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    } else if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
    } else if (mod && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
    } else if (mod && e.key === 'Enter') {
      e.preventDefault();
      this.apply();
    } else if (e.altKey && !mod && ['KeyB', 'KeyA', 'KeyK', 'KeyR'].includes(e.code)) {
      e.preventDefault();
      if (e.code === 'KeyR') this.restore(this.currentChunk('left'));
      else {
        const j = this.currentChunk('right');
        const c = this.right[j];
        if (!c) return;
        if (e.code === 'KeyB') this.take(j);
        else if (e.code === 'KeyA' && chunkKind(c) === 'modify') this.both(j);
        else if (e.code === 'KeyK' && !this.isIgnored(c)) this.ignore(j);
      }
    }
  }

  private apply(): void {
    const { file } = this.opts;
    const text = this.resultText();
    // The check runs a moment after typing: make sure it is about this text.
    this.problem = syntaxRegression(text, file.kind, [file.deployed.text, file.build.text]);
    this.summarize(text);
    const finish = () => {
      const { added, removed } = lineCounts(diffLines(this.deployed, this.doc.lines));
      const result: MergeResult = {
        text,
        outcome: mergeOutcome(this.deployed, this.build, this.doc.lines),
        added,
        removed,
        missing: this.missing,
        problem: this.problem ? this.problem.message : null,
      };
      this.close();
      this.opts.onApply(result);
    };
    if (!this.problem) return finish();
    // A warning, not a wall: the webapp may read it anyway, and the user may know better.
    const p = this.problem;
    this.ask(
      `The result is not valid ${KIND_LABEL[file.kind]}`,
      `${p.line !== undefined ? `Line ${p.line + 1}: ` : ''}${p.message} The webapp may not start with it.`,
      'Go to the line',
      'Apply anyway',
      (anyway) => (anyway ? finish() : this.goToProblem()),
    );
  }

  private requestClose(): void {
    if (!this.dirty()) return this.close();
    this.ask(`Discard your changes to ${fileName(this.opts.file.path)}?`, 'The result you edited here is not kept.', 'Keep editing', 'Discard changes', (discard) => {
      if (discard) this.close();
    });
  }

  /** A small question over the merge view. The safe answer has the focus and is what Esc gives. */
  private ask(title: string, text: string, safe: string, other: string, answer: (other: boolean) => void): void {
    const back = h('button', { type: 'button', class: 'btn btn-primary' }, safe);
    const go = h('button', { type: 'button', class: 'btn' }, other);
    const d = h('dialog', { class: 'dialog mv-ask' }, h('h2', {}, title), h('p', {}, text), h('div', { class: 'dialog-actions' }, go, back)) as HTMLDialogElement;
    let chosen = false;
    go.addEventListener('click', () => {
      chosen = true;
      d.close();
    });
    back.addEventListener('click', () => d.close());
    d.addEventListener('keydown', (e) => e.stopPropagation());
    d.addEventListener('close', () => {
      d.remove();
      answer(chosen);
    });
    this.dialog.append(d);
    d.showModal();
    back.focus();
  }
}

/** Opens the merge view over whatever is showing. */
export function openMergeView(opts: MergeOptions): void {
  new MergeView(opts).open();
}
