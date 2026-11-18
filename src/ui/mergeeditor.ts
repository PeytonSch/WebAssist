// One pane of the merge view (mergeview.ts): the lines of a text with line numbers, syntax
// colours, the coloured bands of changed blocks, collapsed stretches and, in the gutter, the
// buttons that act on a block. The result pane is also an editor.
//
// Editing uses a contenteditable element only for what browsers do well: the caret, selecting
// with mouse and keyboard, scrolling to the caret. Every change to the text is intercepted
// (beforeinput) and applied to the lines in memory instead, and the lines are drawn again. That
// keeps the text, the diff and the undo history in one place, lets a collapsed stretch stay out
// of the DOM, and means the page never has to read text back out of edited HTML (except after
// an input method composed a character, where the browser must be left alone meanwhile).
// Text only ever reaches the DOM through textContent.

import type { FileKind } from '../shared/configkeys';
import type { Splice } from '../shared/mergemodel';
import { h } from './dom';
import { tokenizeLine, type LineTokens, type Tok } from './mergesyntax';

/** Height of a line and of a collapsed stretch, in px. Matches --mv-lh in styles.css. */
export const LINE_HEIGHT = 20;

export interface Pos {
  line: number;
  col: number;
}

/** A selection: where it was started (a) and where the caret is (h). */
export interface Sel {
  a: Pos;
  h: Pos;
}

export type BandKind = 'add' | 'del' | 'mod';

/** A changed block: lines [from, to) coloured; from = to is a mark between two lines. */
export interface Band {
  from: number;
  to: number;
  kind: BandKind;
  /** Another kind on the side facing the new build, where the result differs from both versions. */
  kind2?: BandKind;
  /** Set aside: outlined instead of filled. */
  resolved?: boolean;
  current?: boolean;
}

export interface ActionButton {
  /** take, both, ignore, restore: which icon, and the class. */
  action: 'take' | 'both' | 'ignore' | 'restore';
  title: string;
  run: () => void;
}

/** Buttons in the gutter at a line. */
export interface Action {
  line: number;
  /** Position in the list of chunks, to give focus back to the same place after a redraw. */
  index: number;
  current: boolean;
  buttons: ActionButton[];
}

/** Lines [start, start + len) are collapsed. */
export interface PaneFold {
  start: number;
  len: number;
}

/** Characters [from, to) of a line that differ inside a changed block. */
export interface Mark {
  from: number;
  to: number;
}

export interface EditorHost {
  /** The user changed the text: apply it and draw again. `tag` joins quick edits of one kind into one undo step. */
  edit(splice: Splice, before: Sel, after: Sel, tag: string | null): void;
  /** A line inside a collapsed stretch must show. */
  expand(line: number): void;
  /** The caret moved (not by an edit). */
  caret(sel: Sel, byUser: boolean): void;
}

export interface PaneOptions {
  side: 'deployed' | 'result' | 'build';
  kind: FileKind;
  /** Which side of the text the line numbers and buttons are on. */
  gutter: 'left' | 'right';
  label: string;
  host: EditorHost;
  editable?: boolean;
  /** What Tab inserts. */
  indent?: string;
}

type Row = { fold: false; line: number; sig: string } | { fold: true; line: number; len: number; sig: string };

const ICONS: Record<ActionButton['action'], string> = {
  // Double chevrons pointing at the result, as in IntelliJ: « from the right, » from the left.
  take: 'M9.5 4 5.5 8l4 4M13 4 9 8l4 4',
  restore: 'M6.5 4l4 4-4 4M3 4l4 4-4 4',
  ignore: 'M4.5 4.5l7 7m0-7-7 7',
  both: 'M3 4.5h10M3 8h10M8 10.5v3.5m0 0-2-2m2 2 2-2',
};

function icon(path: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
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

const before = (x: Pos, y: Pos) => x.line < y.line || (x.line === y.line && x.col < y.col);
const samePos = (x: Pos, y: Pos) => x.line === y.line && x.col === y.col;
const wordChar = (c: string) => /[\p{L}\p{N}_$]/u.test(c);

export class Pane {
  /** The scrolling element. */
  readonly scroll: HTMLElement;
  readonly side: PaneOptions['side'];
  lines: string[] = [''];
  private opts: PaneOptions;
  private code: HTMLElement;
  private nums: HTMLElement;
  private bands: HTMLElement;
  private gbands: HTMLElement;
  private acts: HTMLElement;
  private gutter: HTMLElement;
  private caretRow: HTMLElement;
  private folds: PaneFold[] = [];
  private rows: Row[] = [];
  private rowEls: HTMLElement[] = [];
  private lineEls: (HTMLElement | undefined)[] = [];
  private tokens = new Map<string, LineTokens>();
  private numsText = '';
  private sel: Sel = { a: { line: 0, col: 0 }, h: { line: 0, col: 0 } };
  private composing = false;
  /** Set while this code moves the selection, so the change is not taken for the user's. */
  private settingSel = false;
  private onSelection = () => this.selectionChanged();

  constructor(opts: PaneOptions) {
    this.opts = opts;
    this.side = opts.side;
    this.code = h('div', { class: 'mv-code', spellcheck: 'false', translate: 'no' });
    this.nums = h('pre', { class: 'mv-nums', 'aria-hidden': 'true' });
    this.bands = h('div', { class: 'mv-bands', 'aria-hidden': 'true' });
    this.gbands = h('div', { class: 'mv-bands', 'aria-hidden': 'true' });
    this.acts = h('div', { class: 'mv-acts' });
    this.caretRow = h('div', { class: 'mv-caret-row' });
    this.caretRow.hidden = true;
    this.gutter = h('div', { class: `mv-gutter mv-gutter-${opts.gutter}` }, this.gbands, this.nums, this.acts);
    const body = h('div', { class: 'mv-body' }, this.bands, this.code);
    const sheet = h('div', { class: 'mv-sheet' }, ...(opts.gutter === 'left' ? [this.gutter, body] : [body, this.gutter]));
    this.scroll = h('div', { class: `mv-scroll mv-scroll-${opts.side}` }, sheet);

    if (opts.editable) {
      this.code.setAttribute('contenteditable', 'plaintext-only');
      // Firefox before 136 and older browsers: rich editing, which is intercepted all the same.
      if (this.code.contentEditable !== 'plaintext-only') this.code.setAttribute('contenteditable', 'true');
      this.code.setAttribute('role', 'textbox');
      this.code.setAttribute('aria-multiline', 'true');
      this.code.setAttribute('aria-label', opts.label);
      this.code.setAttribute('autocapitalize', 'off');
      this.code.setAttribute('autocorrect', 'off');
      this.bands.append(this.caretRow);
      this.code.addEventListener('beforeinput', (e) => this.beforeInput(e as InputEvent));
      this.code.addEventListener('keydown', (e) => this.keyDown(e));
      this.code.addEventListener('copy', (e) => this.copy(e, false));
      this.code.addEventListener('cut', (e) => this.copy(e, true));
      this.code.addEventListener('paste', (e) => this.paste(e));
      this.code.addEventListener('dragstart', (e) => e.preventDefault());
      this.code.addEventListener('drop', (e) => this.drop(e));
      this.code.addEventListener('compositionstart', () => (this.composing = true));
      this.code.addEventListener('compositionend', () => this.compositionEnd());
      this.code.addEventListener('focus', () => this.showCaretRow());
      this.code.addEventListener('blur', () => (this.caretRow.hidden = true));
      document.addEventListener('selectionchange', this.onSelection);
    } else {
      this.scroll.tabIndex = 0;
      this.scroll.setAttribute('role', 'group');
      this.scroll.setAttribute('aria-label', opts.label);
    }
    // A collapsed stretch opens on click; in the editor the click must not move the caret into it.
    this.code.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.mv-fold')) e.preventDefault();
    });
    this.code.addEventListener('click', (e) => {
      const fold = (e.target as HTMLElement).closest('.mv-fold') as HTMLElement | null;
      const row = fold ? this.rows[this.rowEls.indexOf(fold)] : null;
      if (row?.fold) opts.host.expand(row.line);
    });
  }

  destroy(): void {
    document.removeEventListener('selectionchange', this.onSelection);
  }

  // ── Geometry ──────────────────────────────────────────

  /** The row a line is drawn in; a collapsed line has the row of its stretch. */
  rowOf(line: number): number {
    let row = line;
    for (const f of this.folds) {
      if (line >= f.start + f.len) row -= f.len - 1;
      else {
        if (line > f.start) row -= line - f.start;
        break;
      }
    }
    return row;
  }

  /** Pixels from the top of the text to a line position (which may have a fraction). */
  top(pos: number): number {
    const line = Math.floor(pos);
    const hidden = this.folds.some((f) => line > f.start && line < f.start + f.len);
    return (this.rowOf(line) + (hidden ? 0 : pos - line)) * LINE_HEIGHT;
  }

  /** The line position at a number of pixels from the top of the text. */
  lineAt(y: number): number {
    const row = Math.max(0, y / LINE_HEIGHT);
    let line = row;
    for (const f of this.folds) {
      const fr = this.rowOf(f.start);
      if (row >= fr + 1) line += f.len - 1;
      else {
        if (row >= fr) line = f.start + (row - fr) * f.len;
        break;
      }
    }
    return Math.min(line, this.lines.length);
  }

  get height(): number {
    return this.rows.length * LINE_HEIGHT;
  }

  /** How many pixels of the view the gutter covers on its side. */
  get gutterWidth(): number {
    return this.gutter.offsetWidth;
  }

  // ── Drawing ───────────────────────────────────────────

  private tokensFor(text: string, state: string): LineTokens {
    const key = `${state}\u0001${text}`;
    let t = this.tokens.get(key);
    if (!t) {
      if (this.tokens.size > 50_000) this.tokens.clear();
      this.tokens.set(key, (t = tokenizeLine(this.opts.kind, text, state)));
    }
    return t;
  }

  /**
   * Draws the lines, with `folds` collapsed and `marks` (by line) highlighted. Rows that are the
   * same as before keep their elements, so typing redraws a line or two.
   */
  render(lines: string[], folds: PaneFold[], marks: Map<number, Mark[]>): void {
    this.lines = lines;
    this.folds = folds;
    const rows: Row[] = [];
    const toks: (Tok[] | undefined)[] = [];
    let state = '';
    let fi = 0;
    for (let i = 0; i < lines.length; i++) {
      const fold = folds[fi];
      const t = this.tokensFor(lines[i], state);
      if (fold && i >= fold.start) {
        if (i === fold.start) rows.push({ fold: true, line: i, len: fold.len, sig: `\u0002${fold.len}` });
        if (i === fold.start + fold.len - 1) fi++;
      } else {
        const m = marks.get(i);
        rows.push({ fold: false, line: i, sig: `${state}\u0001${lines[i]}${m ? `\u0001${m.map((x) => `${x.from}-${x.to}`).join(',')}` : ''}` });
        toks[i] = t.toks;
      }
      state = t.state;
    }
    // The rows that changed: everything between the unchanged start and the unchanged end.
    const old = this.rows;
    const max = Math.min(old.length, rows.length);
    let head = 0;
    while (head < max && old[head].sig === rows[head].sig) head++;
    let tail = 0;
    while (tail < max - head && old[old.length - 1 - tail].sig === rows[rows.length - 1 - tail].sig) tail++;
    const anchor = this.rowEls[old.length - tail] ?? null;
    for (let i = head; i < old.length - tail; i++) this.rowEls[i].remove();
    const fresh: HTMLElement[] = [];
    const frag = document.createDocumentFragment();
    for (let i = head; i < rows.length - tail; i++) {
      const row = rows[i];
      const el = row.fold ? this.foldEl(row.len) : this.lineEl(lines[row.line], toks[row.line] ?? [], marks.get(row.line));
      fresh.push(el);
      frag.append(el);
    }
    this.code.insertBefore(frag, anchor);
    this.rowEls = [...this.rowEls.slice(0, head), ...fresh, ...this.rowEls.slice(old.length - tail)];
    this.rows = rows;
    this.lineEls = [];
    const nums: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.fold) this.lineEls[row.line] = this.rowEls[i];
      nums.push(row.fold ? '' : String(row.line + 1));
    }
    const text = nums.join('\n');
    if (text !== this.numsText) {
      this.nums.textContent = this.numsText = text;
      this.nums.style.minWidth = `${Math.max(3, String(lines.length).length)}ch`;
    }
  }

  private lineEl(text: string, toks: Tok[], marks: Mark[] | undefined): HTMLElement {
    const el = document.createElement('div');
    el.className = 'mv-l';
    if (!text) {
      el.append(document.createElement('br'));
      return el;
    }
    let pos = 0;
    let ti = 0;
    let mi = 0;
    while (pos < text.length) {
      while (ti < toks.length && toks[ti].to <= pos) ti++;
      while (marks && mi < marks.length && marks[mi].to <= pos) mi++;
      const tok = ti < toks.length && toks[ti].from <= pos ? toks[ti] : null;
      const mark = marks && mi < marks.length && marks[mi].from <= pos ? marks[mi] : null;
      let end = text.length;
      if (tok) end = Math.min(end, tok.to);
      else if (ti < toks.length) end = Math.min(end, toks[ti].from);
      if (mark) end = Math.min(end, mark.to);
      else if (marks && mi < marks.length) end = Math.min(end, marks[mi].from);
      if (end <= pos) end = pos + 1;
      const piece = text.slice(pos, end);
      if (!tok && !mark) el.append(piece);
      else {
        const span = document.createElement('span');
        span.className = `${tok ? `hl-${tok.cls}` : ''}${mark ? ' mv-w' : ''}`;
        span.textContent = piece;
        el.append(span);
      }
      pos = end;
    }
    return el;
  }

  private foldEl(len: number): HTMLElement {
    const label = `${len.toLocaleString('en-US')} unchanged lines`;
    const b = h('button', { type: 'button', class: 'mv-fold-btn', title: 'Show these lines' }, label);
    // In the editor it must not take the focus (and with it the caret) from the text.
    if (this.opts.editable) b.tabIndex = -1;
    const el = h('div', { class: 'mv-fold' }, b);
    if (this.opts.editable) el.setAttribute('contenteditable', 'false');
    return el;
  }

  /** The coloured bands behind the changed blocks, in the text and in the gutter. */
  setBands(bands: Band[]): void {
    const make = () =>
      bands.map((b) => {
        const top = this.top(b.from);
        const height = this.top(b.to) - top;
        const el = document.createElement('div');
        el.className = `mv-band mv-${b.kind}${b.from === b.to || height === 0 ? ' mv-mark' : ''}${b.resolved ? ' mv-res' : ''}${b.current ? ' mv-cur' : ''}`;
        el.style.top = `${top}px`;
        if (height > 0) el.style.height = `${height}px`;
        if (b.kind2 && b.kind2 !== b.kind && height > 0 && !b.resolved) {
          el.style.background = `linear-gradient(90deg, var(--mv-${b.kind}) 20%, var(--mv-${b.kind2}) 80%)`;
        }
        return el;
      });
    this.bands.replaceChildren(...(this.opts.editable ? [this.caretRow] : []), ...make());
    this.gbands.replaceChildren(...make());
  }

  /** The buttons in the gutter. The one that had the focus gets it back, by action and position. */
  setActions(actions: Action[]): void {
    const active = document.activeElement as HTMLElement | null;
    const had = active && this.acts.contains(active) ? { action: active.dataset.action, index: Number(active.dataset.index) } : null;
    const els = actions.map((a) => {
      const group = h('div', { class: `mv-act${a.current ? ' mv-cur' : ''}` });
      group.style.top = `${this.top(a.line)}px`;
      for (const b of a.buttons) {
        const btn = h('button', { type: 'button', class: `mv-ab mv-ab-${b.action}`, title: b.title, 'aria-label': b.title, 'data-action': b.action, 'data-index': String(a.index) });
        btn.append(icon(ICONS[b.action]));
        btn.addEventListener('click', b.run);
        group.append(btn);
      }
      return group;
    });
    this.acts.replaceChildren(...els);
    if (had) {
      const same = [...this.acts.querySelectorAll<HTMLElement>(`[data-action="${had.action}"]`)];
      const next = same.find((b) => Number(b.dataset.index) >= had.index) ?? same[same.length - 1] ?? this.acts.querySelector<HTMLElement>('button');
      if (next) next.focus({ preventScroll: true });
      else if (this.opts.editable) this.code.focus({ preventScroll: true });
      else this.scroll.focus({ preventScroll: true });
    }
  }

  /** Draws the eye to a line for a moment. */
  flash(line: number): void {
    const el = h('div', { class: 'mv-flash' });
    el.style.top = `${this.top(line)}px`;
    this.bands.append(el);
    setTimeout(() => el.remove(), 1300);
  }

  /** Scrolls so that a line is `fraction` of the way down the view (0 top, 1 bottom). */
  scrollToLine(pos: number, fraction = 0.3): void {
    this.scroll.scrollTop = Math.max(0, this.top(pos) - this.scroll.clientHeight * fraction);
  }

  // ── Selection ─────────────────────────────────────────

  hasFocus(): boolean {
    return document.activeElement === this.code;
  }

  focus(): void {
    this.code.focus({ preventScroll: true });
  }

  /** Where a DOM position is in the text, or null when it is not in this pane's text. */
  private posOf(node: Node | null, offset: number): Pos | null {
    if (!node || !this.code.contains(node)) return null;
    let el: Node = node;
    if (node === this.code) {
      const child = this.code.childNodes[offset];
      if (!child) return this.end();
      el = child;
      offset = 0;
      node = child;
    } else {
      while (el.parentNode && el.parentNode !== this.code) el = el.parentNode;
    }
    const idx = this.rowEls.indexOf(el as HTMLElement);
    const row = this.rows[idx];
    if (!row) return this.end();
    if (row.fold) {
      // On a collapsed stretch: the start of the line after it, else the end of the line before it.
      const after = row.line + row.len;
      if (after < this.lines.length) return { line: after, col: 0 };
      return row.line > 0 ? { line: row.line - 1, col: this.lines[row.line - 1].length } : { line: 0, col: 0 };
    }
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(node, offset);
    return { line: row.line, col: Math.min(range.toString().length, this.lines[row.line].length) };
  }

  private end(): Pos {
    const line = this.lines.length - 1;
    return { line, col: this.lines[line].length };
  }

  private clamp(p: Pos): Pos {
    const line = Math.max(0, Math.min(p.line, this.lines.length - 1));
    return { line, col: Math.max(0, Math.min(p.col, this.lines[line].length)) };
  }

  /** The selection in the text; the last known one when the page's selection is elsewhere. */
  readSel(): Sel {
    const s = window.getSelection();
    if (s && s.rangeCount) {
      const a = this.posOf(s.anchorNode, s.anchorOffset);
      const hd = this.posOf(s.focusNode, s.focusOffset);
      if (a && hd) this.sel = { a, h: hd };
    }
    return (this.sel = { a: this.clamp(this.sel.a), h: this.clamp(this.sel.h) });
  }

  private domOf(p: Pos): [Node, number] {
    let el = this.lineEls[p.line];
    if (!el) {
      this.opts.host.expand(p.line);
      el = this.lineEls[p.line];
    }
    if (!el) return [this.code, 0];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let left = p.col;
    let last: Node | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.nodeValue!.length;
      if (left <= len) return [n, left];
      left -= len;
      last = n;
    }
    return last ? [last, last.nodeValue!.length] : [el, 0];
  }

  /** Puts the caret or selection in the text and scrolls the caret into view. */
  setSel(sel: Sel, reveal = true): void {
    this.sel = { a: this.clamp(sel.a), h: this.clamp(sel.h) };
    const s = window.getSelection();
    if (!s) return;
    this.settingSel = true;
    try {
      const [an, ao] = this.domOf(this.sel.a);
      const [hn, ho] = this.domOf(this.sel.h);
      s.setBaseAndExtent(an, ao, hn, ho);
    } finally {
      this.settingSel = false;
    }
    this.showCaretRow();
    if (reveal) this.revealCaret();
  }

  private showCaretRow(): void {
    this.caretRow.hidden = !this.hasFocus();
    this.caretRow.style.top = `${this.top(this.sel.h.line)}px`;
  }

  /** Scrolls so the caret is in view, clear of the line numbers and the scroll bar. */
  revealCaret(): void {
    const sc = this.scroll;
    const y = this.top(this.sel.h.line);
    const pad = LINE_HEIGHT * 2;
    if (y < sc.scrollTop + pad) sc.scrollTop = Math.max(0, y - pad);
    else if (y + LINE_HEIGHT > sc.scrollTop + sc.clientHeight - pad) sc.scrollTop = y + LINE_HEIGHT - sc.clientHeight + pad;
    const [node, offset] = this.domOf(this.sel.h);
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const rect = range.getClientRects()[0] ?? (node instanceof Element ? node : node.parentElement!).getBoundingClientRect();
    const box = sc.getBoundingClientRect();
    const left = box.left + (this.opts.gutter === 'left' ? this.gutterWidth : 0) + 8;
    const right = box.left + sc.clientWidth - (this.opts.gutter === 'right' ? this.gutterWidth : 0) - 24;
    if (rect.left < left) sc.scrollLeft = Math.max(0, sc.scrollLeft - (left - rect.left) - 40);
    else if (rect.left > right) sc.scrollLeft += rect.left - right + 40;
  }

  private selectionChanged(): void {
    if (this.settingSel || this.composing || !this.hasFocus()) return;
    const s = window.getSelection();
    if (!s || !s.rangeCount || !this.code.contains(s.focusNode)) return;
    const was = this.sel;
    const now = this.readSel();
    this.showCaretRow();
    if (!samePos(was.h, now.h) || !samePos(was.a, now.a)) this.opts.host.caret(now, true);
  }

  // ── Editing ───────────────────────────────────────────

  private ordered(sel: Sel): [Pos, Pos] {
    return before(sel.h, sel.a) ? [sel.h, sel.a] : [sel.a, sel.h];
  }

  /** The selected text, as in the file ("\n" between lines). */
  private textOf(sel: Sel): string {
    const [s, e] = this.ordered(sel);
    if (s.line === e.line) return this.lines[s.line].slice(s.col, e.col);
    return [this.lines[s.line].slice(s.col), ...this.lines.slice(s.line + 1, e.line), this.lines[e.line].slice(0, e.col)].join('\n');
  }

  /** Replaces the text between two positions and leaves the caret after what was put in. */
  private replace(sel: Sel, from: Pos, to: Pos, text: string, tag: string | null): void {
    const head = this.lines[from.line].slice(0, from.col);
    const tail = this.lines[to.line].slice(to.col);
    const insert = (head + text.replace(/\r\n?/g, '\n') + tail).split('\n');
    const line = from.line + insert.length - 1;
    const caret = { line, col: insert[insert.length - 1].length - tail.length };
    this.opts.host.edit({ at: from.line, remove: to.line - from.line + 1, insert }, sel, { a: caret, h: caret }, tag);
  }

  private insertText(text: string, tag: string | null): void {
    const sel = this.readSel();
    const [s, e] = this.ordered(sel);
    this.replace(sel, s, e, text, samePos(s, e) && !text.includes('\n') ? tag : null);
  }

  private newline(): void {
    const sel = this.readSel();
    const [s, e] = this.ordered(sel);
    const lead = this.lines[s.line].slice(0, s.col);
    let indent = /^[ \t]*/.exec(lead)![0];
    // After "key:" or an opening bracket the next line is one level deeper.
    if (/(?::|[[{(]|>-?|\|-?)\s*$/.test(lead) && this.opts.kind !== 'xml' && this.opts.kind !== 'properties' && lead.trim() && !/^\s*(?:#|\/\/)/.test(lead)) indent += this.unit();
    this.replace(sel, s, e, `\n${indent}`, null);
  }

  private unit(): string {
    return this.opts.indent ?? '  ';
  }

  /** The position a delete of this kind reaches from the caret. */
  private deleteTarget(p: Pos, type: string): Pos {
    const text = this.lines[p.line];
    const back = /Backward$/.test(type);
    if (back && p.col === 0) return p.line > 0 ? { line: p.line - 1, col: this.lines[p.line - 1].length } : p;
    if (!back && p.col === text.length) return p.line < this.lines.length - 1 ? { line: p.line + 1, col: 0 } : p;
    if (/Line/.test(type)) return { line: p.line, col: back ? 0 : text.length };
    let col = p.col;
    if (/Word/.test(type)) {
      const step = back ? -1 : 1;
      const at = () => text[back ? col - 1 : col];
      while (at() !== undefined && /\s/.test(at())) col += step;
      if (at() !== undefined) {
        const word = wordChar(at());
        while (at() !== undefined && !/\s/.test(at()) && wordChar(at()) === word) col += step;
      }
      return { line: p.line, col };
    }
    if (back) {
      // In the indentation, one press removes a whole level.
      const unit = this.unit();
      if (unit[0] === ' ' && col >= unit.length && !text.slice(0, col).trim() && col % unit.length === 0) return { line: p.line, col: col - unit.length };
      col -= col >= 2 && /[\uDC00-\uDFFF]/.test(text[col - 1]) ? 2 : 1;
    } else col += /[\uD800-\uDBFF]/.test(text[col]) && col + 1 < text.length ? 2 : 1;
    return { line: p.line, col };
  }

  private deleteText(type: string): void {
    const sel = this.readSel();
    let [s, e] = this.ordered(sel);
    let tag: string | null = null;
    if (samePos(s, e)) {
      if (type === 'deleteByCut' || type === 'deleteByDrag' || type === 'deleteContent') return;
      const t = this.deleteTarget(s, type);
      if (samePos(t, s)) return;
      if (before(t, s)) s = t;
      else e = t;
      tag = type === 'deleteContentBackward' || type === 'deleteContentForward' ? type : null;
      if (s.line !== e.line) tag = null;
    }
    this.replace(sel, s, e, '', tag);
  }

  private beforeInput(e: InputEvent): void {
    const type = e.inputType;
    // While an input method composes a character the browser owns the text; see compositionEnd.
    if (this.composing || type === 'insertCompositionText' || type === 'deleteCompositionText') return;
    e.preventDefault();
    if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromYank' || type === 'insertFromPaste' || type === 'insertFromDrop') {
      const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
      if (text) this.insertText(text, type === 'insertText' ? (/^\s+$/.test(text) ? 'space' : 'type') : null);
    } else if (type === 'insertLineBreak' || type === 'insertParagraph') this.newline();
    else if (type.startsWith('delete')) this.deleteText(type);
    // Anything else (formatting, the browser's own undo of nothing) does nothing.
  }

  private keyDown(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || this.composing) return;
    e.preventDefault();
    const sel = this.readSel();
    const [s, end] = this.ordered(sel);
    const unit = this.unit();
    if (s.line === end.line && !e.shiftKey) {
      // To the next indentation stop when indenting with spaces.
      const text = unit[0] === ' ' ? ' '.repeat(unit.length - (s.col % unit.length)) : unit;
      return this.replace(sel, s, end, text, null);
    }
    // Several lines, or Shift+Tab: move the whole lines in or out.
    const last = end.col === 0 && end.line > s.line ? end.line - 1 : end.line;
    const lines = this.lines.slice(s.line, last + 1);
    const moved = lines.map((l) => {
      if (!e.shiftKey) return l ? unit + l : l;
      if (l.startsWith('\t')) return l.slice(1);
      const lead = /^ */.exec(l)![0].length;
      return l.slice(Math.min(lead, unit[0] === ' ' ? unit.length : 4));
    });
    if (moved.every((l, i) => l === lines[i])) return;
    const shift = (p: Pos): Pos => (p.line < s.line || p.line > last ? p : { line: p.line, col: Math.max(0, p.col + moved[p.line - s.line].length - lines[p.line - s.line].length) });
    this.opts.host.edit({ at: s.line, remove: lines.length, insert: moved }, sel, { a: shift(sel.a), h: shift(sel.h) }, null);
  }

  private copy(e: ClipboardEvent, cut: boolean): void {
    const sel = this.readSel();
    if (samePos(sel.a, sel.h) || !e.clipboardData) return;
    e.preventDefault();
    // From the lines in memory, so a collapsed stretch inside the selection is copied too.
    e.clipboardData.setData('text/plain', this.textOf(sel));
    if (cut) {
      const [s, end] = this.ordered(sel);
      this.replace(sel, s, end, '', null);
    }
  }

  private paste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) this.insertText(text, null);
  }

  private drop(e: DragEvent): void {
    e.preventDefault();
    const text = e.dataTransfer?.getData('text/plain');
    if (!text) return;
    const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
    const at = range ? this.posOf(range.startContainer, range.startOffset) : null;
    if (at) this.sel = { a: at, h: at };
    this.code.focus({ preventScroll: true });
    const p = this.clamp(this.sel.h);
    this.replace({ a: p, h: p }, p, p, text, null);
  }

  /**
   * An input method finished composing: the browser changed the DOM itself. The text is read
   * back from the rows, applied as one edit, and drawn again from the lines.
   */
  private compositionEnd(): void {
    this.composing = false;
    const before_ = this.sel;
    const lines: string[] = [];
    let caret: Pos | null = null;
    const s = window.getSelection();
    for (const child of [...this.code.children] as HTMLElement[]) {
      const row = this.rows[this.rowEls.indexOf(child)];
      if (row?.fold) {
        for (let i = 0; i < row.len; i++) lines.push(this.lines[row.line + i]);
        continue;
      }
      if (s?.focusNode && child.contains(s.focusNode)) {
        const range = document.createRange();
        range.setStart(child, 0);
        range.setEnd(s.focusNode, s.focusOffset);
        caret = { line: lines.length, col: range.toString().length };
      }
      lines.push((child.textContent ?? '').replace(/\n$/, ''));
    }
    if (!lines.length) lines.push('');
    const old = this.lines;
    let head = 0;
    while (head < old.length && head < lines.length && old[head] === lines[head]) head++;
    let tail = 0;
    while (tail < old.length - head && tail < lines.length - head && old[old.length - 1 - tail] === lines[lines.length - 1 - tail]) tail++;
    // Forget the rows: the browser's edits made them unreliable, so everything is drawn again.
    this.rows = [];
    this.rowEls = [];
    this.code.replaceChildren();
    const end = caret ?? before_.h;
    this.opts.host.edit({ at: head, remove: old.length - head - tail, insert: lines.slice(head, lines.length - tail) }, before_, { a: end, h: end }, null);
  }
}
