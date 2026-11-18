// The JSON compare view: two payloads side by side, read-only, with what differs marked, line
// by line and word by word, and a list of the values that differ by path. Opened from the JSON
// viewer (Compare…) or a request's details, with that document on the left; the other side is
// pasted, or picked from recent bodies on the timeline and documents opened in the JSON viewer.
//
// Both documents are pretty-printed the same way (keys sorted, unless that is turned off), so
// formatting and key order do not show up as differences, and diffed as lines (shared/diff.ts).

import { chunkKind, diffInline, diffLines, type InlineRange } from '../shared/diff';
import { jsonChanges, parseJson, prettyJson, type JsonChange, type PrettyJson } from '../shared/jsondiff';
import { fmtBytes, h, type Child } from './dom';
import type { JsonSource } from './jsonviewer';

/** A document the other side can be filled from. */
export interface CompareCandidate {
  /** "Responses on the timeline". */
  group: string;
  label: string;
  src: JsonSource;
}

let timelineCandidates: () => CompareCandidate[] = () => [];
const recentlyViewed: JsonSource[] = [];

/** Where the timeline's recent JSON bodies come from (set by main.ts). */
export function setCompareCandidates(fn: () => CompareCandidate[]): void {
  timelineCandidates = fn;
}

/** A document opened in the JSON viewer, offered on either side later. */
export function noteViewed(src: JsonSource): void {
  const i = recentlyViewed.findIndex((s) => s.text === src.text);
  if (i >= 0) recentlyViewed.splice(i, 1);
  recentlyViewed.unshift(src);
  recentlyViewed.length = Math.min(recentlyViewed.length, 12);
}

function candidates(): CompareCandidate[] {
  return [...recentlyViewed.map((src) => ({ group: 'Opened in the JSON viewer', label: [src.title, ...src.meta.slice(0, 1)].join(' · '), src })), ...timelineCandidates()];
}

// ── Preferences ─────────────────────────────────────────

const PREF_SORT = 'dh.compare.sortKeys';
const PREF_ONLY = 'dh.compare.onlyChanges';
function pref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function savePref(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* private mode */
  }
}

// ── Lines ───────────────────────────────────────────────

/** Unchanged lines kept around a change when the rest is folded. */
const CONTEXT = 3;
/** Past this many rows, unchanged stretches stay folded. */
const MAX_UNFOLDED_ROWS = 40_000;

type RowKind = 'same' | 'del' | 'add' | 'mod';
interface Row {
  kind: RowKind;
  /** Line numbers (0-based) on each side; null where that side has no line here. */
  a: number | null;
  b: number | null;
  /** Which change this row belongs to. */
  block: number;
  ma?: InlineRange[];
  mb?: InlineRange[];
}

const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

/** A line's text with JSON colours and the changed words marked. */
function codeNodes(text: string, marks: InlineRange[] | undefined, json: boolean): Node[] {
  if (!text) return [];
  const cls: string[] = new Array(text.length).fill('');
  if (json) {
    for (const m of text.matchAll(TOKEN)) {
      const at = m.index!;
      const c = m[1] ? (m[2] ? 'jd-key' : 'jd-str') : m[3] ? 'jd-num' : m[4] ? 'jd-lit' : 'jd-punc';
      const len = m[1] ? m[1].length : m[0].length;
      for (let i = at; i < at + len; i++) cls[i] = c;
    }
  }
  const marked = new Uint8Array(text.length);
  for (const r of marks ?? []) for (let i = r.from; i < Math.min(r.to, text.length); i++) marked[i] = 1;
  const out: Node[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && cls[i] === cls[start] && marked[i] === marked[start]) continue;
    const piece = text.slice(start, i);
    let node: Node = cls[start] ? h('span', { class: cls[start] }, piece) : document.createTextNode(piece);
    if (marked[start]) node = h('mark', { class: 'jd-word' }, node);
    out.push(node);
    start = i;
  }
  return out;
}

// ── The view ────────────────────────────────────────────

interface Side {
  title: string;
  meta: string[];
  text: string;
}

interface Result {
  json: boolean;
  /** Why a side was compared as text. */
  notes: string[];
  a: string[];
  b: string[];
  rows: Row[];
  blocks: number;
  changes: JsonChange[];
  changesTruncated: boolean;
  pa: PrettyJson | null;
  pb: PrettyJson | null;
  /** Same values, but the text differs (key order with sorting off, or formatting). */
  sameValues: boolean;
}

const sideOf = (src: JsonSource | null | undefined): Side => ({ title: src?.title ?? '', meta: src?.meta ?? [], text: src?.text ?? '' });

function svgIcon(path: string, size = 14): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function btn(label: Child, title: string, onClick: () => void, cls = 'btn btn-sm'): HTMLButtonElement {
  const b = h('button', { type: 'button', class: cls, title }, label) as HTMLButtonElement;
  b.addEventListener('click', onClick);
  return b;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

class CompareView {
  private dialog: HTMLDialogElement;
  private sides: [Side, Side];
  private stage: 'input' | 'result' = 'input';
  private sortKeys = pref(PREF_SORT, true);
  private onlyChanges = pref(PREF_ONLY, true);
  private result: Result | null = null;
  /** Folded stretches opened by the user, by their first row. */
  private opened = new Set<number>();
  private current = -1;
  private diffEl: HTMLElement | null = null;
  private navLabel: HTMLElement | null = null;

  constructor(left: JsonSource | null, right: JsonSource | null) {
    this.sides = [sideOf(left), sideOf(right)];
    this.dialog = h('dialog', { class: 'dialog jd', 'aria-label': 'Compare JSON' }) as HTMLDialogElement;
    this.dialog.addEventListener('close', () => this.dialog.remove());
    this.dialog.addEventListener('keydown', (e) => this.onKey(e));
  }

  open(): void {
    document.body.append(this.dialog);
    // Both sides given: straight to the differences.
    if (this.sides[0].text.trim() && this.sides[1].text.trim()) this.compare();
    else this.renderInput();
    this.dialog.showModal();
    // The first side still empty gets the caret, ready for a paste.
    if (this.stage === 'input') [...this.dialog.querySelectorAll<HTMLTextAreaElement>('textarea')].find((t) => !t.value.trim())?.focus();
  }

  private close(): void {
    this.dialog.close();
  }

  private onKey(e: KeyboardEvent): void {
    // The page behind must not see these.
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const typing = t.matches('input, textarea, select');
    if (this.stage === 'input' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.compare();
      return;
    }
    if (this.stage !== 'result' || typing || e.ctrlKey || e.metaKey || e.altKey) return;
    // N or F7: next difference; P, Shift+N or Shift+F7: previous.
    const next = e.key === 'n' || (e.key === 'F7' && !e.shiftKey);
    const prev = e.key === 'p' || e.key === 'N' || (e.key === 'F7' && e.shiftKey);
    if (next || prev) {
      e.preventDefault();
      this.step(next ? 1 : -1);
    }
  }

  private head(...extra: Child[]): HTMLElement {
    return h(
      'header',
      { class: 'jd-head' },
      h('div', { class: 'jd-icon', 'aria-hidden': 'true' }, svgIcon('M5 3v10M11 3v10M2.5 5.5h5M8.5 10.5h5M8.5 5.5h5', 16)),
      h('h2', {}, 'Compare JSON'),
      ...extra,
      h('span', { class: 'spacer' }),
      btn('✕', 'Close (Esc)', () => this.close(), 'btn btn-ghost btn-icon'),
    );
  }

  // ── Input ─────────────────────────────────────────────

  private renderInput(): void {
    this.stage = 'input';
    const list = candidates();
    const compareBtn = btn('Compare', 'Compare the two (Ctrl+Enter)', () => this.compare(), 'btn btn-primary');
    const sideEls = this.sides.map((side, i) => {
      const ta = h('textarea', {
        class: 'jd-text',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': i === 0 ? 'Left document' : 'Right document',
        placeholder: list.length ? 'Paste JSON here, or pick a document above' : 'Paste JSON here',
      }) as HTMLTextAreaElement;
      ta.value = side.text;
      const status = h('div', { class: 'jd-status' });
      const titleEl = h('div', { class: 'jd-src', title: [side.title, ...side.meta].join(' · ') });
      const showTitle = () => {
        titleEl.replaceChildren(...(side.title ? [h('b', {}, side.title), ...side.meta.map((m) => h('span', {}, m))] : [h('span', { class: 'muted' }, 'Pasted or typed')]));
      };
      const check = () => {
        const t = ta.value;
        if (!t.trim()) {
          status.className = 'jd-status muted';
          status.textContent = 'Empty';
        } else {
          const p = parseJson(t);
          status.className = `jd-status ${p.ok ? 'ok' : 'warn'}`;
          status.textContent = p.ok ? `Valid JSON · ${fmtBytes(new Blob([t]).size)}` : `${p.error}. It is compared as text.`;
        }
        compareBtn.disabled = !this.sides.every((s) => s.text.trim());
      };
      ta.addEventListener('input', () => {
        side.text = ta.value;
        if (side.title) {
          side.title = '';
          side.meta = [];
          showTitle();
        }
        check();
      });
      let picker: HTMLElement | null = null;
      if (list.length) {
        const sel = h('select', { class: 'select jd-pick', 'aria-label': `Fill the ${i === 0 ? 'left' : 'right'} side from` }) as HTMLSelectElement;
        sel.append(h('option', { value: '' }, 'Load a document…'));
        const groups = new Map<string, HTMLElement>();
        list.forEach((c, n) => {
          let g = groups.get(c.group);
          if (!g) {
            g = h('optgroup', { label: c.group });
            groups.set(c.group, g);
            sel.append(g);
          }
          g.append(h('option', { value: String(n) }, c.label));
        });
        sel.addEventListener('change', () => {
          const c = list[Number(sel.value)];
          sel.value = '';
          if (!c) return;
          Object.assign(side, sideOf(c.src));
          ta.value = side.text;
          showTitle();
          check();
          ta.focus();
        });
        picker = sel;
      }
      const clear = btn('Clear', 'Empty this side', () => {
        Object.assign(side, sideOf(null));
        ta.value = '';
        showTitle();
        check();
        ta.focus();
      }, 'btn btn-sm btn-ghost');
      showTitle();
      check();
      return h(
        'section',
        { class: 'jd-side' },
        h('div', { class: 'jd-side-head' }, h('span', { class: `jd-badge ${i === 0 ? 'a' : 'b'}` }, i === 0 ? 'Left' : 'Right'), titleEl, picker, clear),
        ta,
        status,
      );
    });
    const swap = btn(svgIcon('M4 5.5h8.5m0 0L10 3m2.5 2.5L10 8M12 10.5H3.5m0 0L6 8m-2.5 2.5L6 13'), 'Swap the two sides', () => {
      this.sides.reverse();
      this.renderInput();
    }, 'btn btn-icon jd-swap');
    swap.setAttribute('aria-label', 'Swap the two sides');
    this.dialog.replaceChildren(
      this.head(),
      h('div', { class: 'jd-inputs' }, sideEls[0], swap, sideEls[1]),
      h('footer', { class: 'jd-foot' }, h('span', { class: 'muted' }, 'Read-only: nothing is changed. Keys are compared whatever their order.'), h('span', { class: 'spacer' }), btn('Cancel', 'Close', () => this.close(), 'btn'), compareBtn),
    );
    compareBtn.disabled = !this.sides.every((s) => s.text.trim());
  }

  // ── Compare ───────────────────────────────────────────

  private compare(): void {
    if (!this.sides.every((s) => s.text.trim())) return;
    const [A, B] = this.sides.map((s) => parseJson(s.text));
    const json = A.ok && B.ok;
    const notes: string[] = [];
    let pa: PrettyJson | null = null;
    let pb: PrettyJson | null = null;
    let a: string[];
    let b: string[];
    let changes: JsonChange[] = [];
    let changesTruncated = false;
    if (A.ok && B.ok) {
      pa = prettyJson(A.value, { sortKeys: this.sortKeys });
      pb = prettyJson(B.value, { sortKeys: this.sortKeys });
      a = pa.lines;
      b = pb.lines;
      ({ changes, truncated: changesTruncated } = jsonChanges(A.value, B.value));
    } else {
      if (!A.ok) notes.push(`The left side is not valid JSON (${A.error.replace(/^Not valid JSON: /, '')}), so the two are compared as text.`);
      if (!B.ok) notes.push(`The right side is not valid JSON (${B.error.replace(/^Not valid JSON: /, '')}), so the two are compared as text.`);
      a = this.sides[0].text.replace(/\r\n?/g, '\n').split('\n');
      b = this.sides[1].text.replace(/\r\n?/g, '\n').split('\n');
    }
    const rows: Row[] = [];
    let ia = 0;
    let ib = 0;
    let block = 0;
    const chunks = diffLines(a, b);
    for (const c of chunks) {
      while (ia < c.a0) rows.push({ kind: 'same', a: ia++, b: ib++, block: -1 });
      const la = c.a1 - c.a0;
      const lb = c.b1 - c.b0;
      const inl = chunkKind(c) === 'modify' ? diffInline(a.slice(c.a0, c.a1), b.slice(c.b0, c.b1)) : null;
      for (let i = 0; i < Math.max(la, lb); i++) {
        const ra = i < la ? c.a0 + i : null;
        const rb = i < lb ? c.b0 + i : null;
        rows.push({
          kind: ra !== null && rb !== null ? 'mod' : ra !== null ? 'del' : 'add',
          a: ra,
          b: rb,
          block,
          ma: inl?.a.filter((r) => r.line === i),
          mb: inl?.b.filter((r) => r.line === i),
        });
      }
      block++;
      ia = c.a1;
      ib = c.b1;
    }
    while (ia < a.length) rows.push({ kind: 'same', a: ia++, b: ib++, block: -1 });
    this.result = { json, notes, a, b, rows, blocks: block, changes, changesTruncated, pa, pb, sameValues: json && !changes.length && block > 0 };
    this.opened = new Set();
    this.current = -1;
    this.renderResult();
  }

  // ── Result ────────────────────────────────────────────

  private toggle(label: string, title: string, on: boolean, set: (on: boolean) => void): HTMLElement {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = on;
    box.addEventListener('change', () => set(box.checked));
    return h('label', { class: 'check jd-check', title }, box, ` ${label}`);
  }

  private renderResult(): void {
    this.stage = 'result';
    const r = this.result!;
    const counts = { added: 0, removed: 0, changed: 0 };
    for (const c of r.changes) counts[c.kind]++;
    const chips: HTMLElement[] = [];
    if (r.json) {
      if (counts.changed) chips.push(h('span', { class: 'jd-chip mod' }, `${counts.changed} changed`));
      if (counts.added) chips.push(h('span', { class: 'jd-chip add' }, `${counts.added} added`));
      if (counts.removed) chips.push(h('span', { class: 'jd-chip del' }, `${counts.removed} removed`));
    } else if (r.blocks) chips.push(h('span', { class: 'jd-chip mod' }, plural(r.blocks, 'difference')));
    if (!chips.length) chips.push(h('span', { class: 'jd-chip same' }, 'No differences'));

    const back = btn(h('span', {}, '← Edit'), 'Change what is compared', () => {
      this.renderInput();
      this.dialog.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }, 'btn btn-sm');
    this.navLabel = h('span', { class: 'jd-nav-label', 'aria-live': 'polite' });
    const prev = btn(svgIcon('M4 10l4-4 4 4'), 'Previous difference (P)', () => this.step(-1), 'btn btn-sm btn-icon');
    const next = btn(svgIcon('M4 6l4 4 4-4'), 'Next difference (N)', () => this.step(1), 'btn btn-sm btn-icon');
    prev.setAttribute('aria-label', 'Previous difference');
    next.setAttribute('aria-label', 'Next difference');
    prev.disabled = next.disabled = !r.blocks;
    const toolbar = h(
      'div',
      { class: 'jd-toolbar' },
      back,
      r.json ? this.toggle('Sort keys', 'Compare keys in alphabetical order, so a different order is not a difference', this.sortKeys, (on) => {
        this.sortKeys = on;
        savePref(PREF_SORT, on);
        this.compare();
      }) : null,
      this.toggle('Only changes', 'Fold away unchanged lines', this.onlyChanges, (on) => {
        this.onlyChanges = on;
        savePref(PREF_ONLY, on);
        this.opened = new Set();
        this.renderDiff();
      }),
      h('span', { class: 'spacer' }),
      h('div', { class: 'jd-nav' }, prev, this.navLabel, next),
    );

    const titles = this.sides.map((s, i) =>
      h('div', { class: 'jd-col-title', title: [s.title || 'Pasted', ...s.meta].join(' · ') }, h('span', { class: `jd-badge ${i === 0 ? 'a' : 'b'}` }, i === 0 ? 'Left' : 'Right'), h('b', {}, s.title || 'Pasted'), ...s.meta.slice(0, 2).map((m) => h('span', { class: 'muted' }, m))),
    );
    this.diffEl = h('div', { class: 'jd-diff', tabindex: '0', role: 'region', 'aria-label': 'Differences, side by side' });
    const notes = [...r.notes];
    if (r.sameValues) notes.push('The values are the same; only how they are written differs (the order of keys, with Sort keys off).');
    const main = h(
      'div',
      { class: 'jd-main' },
      ...notes.map((n) => h('div', { class: 'jd-note' }, n)),
      h('div', { class: 'jd-cols' }, titles[0], titles[1]),
      this.diffEl,
    );
    const body = r.json ? h('div', { class: 'jd-result' }, this.changeList(), main) : h('div', { class: 'jd-result text' }, main);
    this.dialog.replaceChildren(this.head(h('div', { class: 'jd-chips' }, ...chips)), toolbar, body);
    this.renderDiff();
    this.diffEl.focus({ preventScroll: true });
    if (r.blocks) this.step(1, false);
    else this.updateNav();
  }

  /** The values that differ, by path; a click shows where. */
  private changeList(): HTMLElement {
    const r = this.result!;
    const head = h('div', { class: 'jd-list-head' }, 'Differences', h('span', { class: 'muted' }, String(r.changes.length) + (r.changesTruncated ? '+' : '')));
    if (!r.changes.length) return h('aside', { class: 'jd-list' }, head, h('div', { class: 'jd-list-empty' }, 'None: the two hold the same values.'));
    const items = r.changes.map((c) => {
      const b = h(
        'button',
        { type: 'button', class: `jd-item ${c.kind}`, title: `${c.path}\n${c.kind === 'changed' ? `${c.before} → ${c.after}` : c.kind === 'added' ? `added: ${c.after}` : `removed: ${c.before}`}` },
        h('span', { class: 'jd-item-kind', 'aria-hidden': 'true' }, c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'),
        h('span', { class: 'jd-item-main' },
          h('code', { class: 'jd-path' }, c.path),
          h('span', { class: 'jd-vals' },
            c.kind !== 'added' ? h('span', { class: 'jd-before' }, c.before ?? '') : null,
            c.kind === 'changed' ? h('span', { class: 'jd-arrow' }, '→') : null,
            c.kind !== 'removed' ? h('span', { class: 'jd-after' }, c.after ?? '') : null)),
      );
      b.addEventListener('click', () => this.showPath(c));
      return b;
    });
    return h(
      'aside',
      { class: 'jd-list' },
      head,
      h('div', { class: 'jd-items' }, ...items),
      r.changesTruncated ? h('div', { class: 'jd-list-empty' }, 'Only the first 2,000 are listed.') : null,
    );
  }

  /** Rows to show, with unchanged stretches folded: [row index] or a fold [start, length]. */
  private layout(): (number | [number, number])[] {
    const r = this.result!;
    const fold = this.onlyChanges || r.rows.length > MAX_UNFOLDED_ROWS;
    const out: (number | [number, number])[] = [];
    let i = 0;
    while (i < r.rows.length) {
      if (r.rows[i].kind !== 'same') {
        out.push(i++);
        continue;
      }
      let j = i;
      while (j < r.rows.length && r.rows[j].kind === 'same') j++;
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === r.rows.length ? 0 : CONTEXT;
      if (fold && j - i > head + tail + 2 && !this.opened.has(i)) {
        for (let k = i; k < i + head; k++) out.push(k);
        out.push([i + head, j - i - head - tail]);
        for (let k = j - tail; k < j; k++) out.push(k);
      } else for (let k = i; k < j; k++) out.push(k);
      i = j;
    }
    return out;
  }

  private renderDiff(): void {
    const r = this.result!;
    const el = this.diffEl!;
    const nodes: HTMLElement[] = [];
    for (const item of this.layout()) {
      if (Array.isArray(item)) {
        const [start, len] = item;
        // The stretch begins where the layout first folded: opening it opens the whole run.
        let runStart = start;
        while (runStart > 0 && r.rows[runStart - 1].kind === 'same') runStart--;
        const f = h('button', { type: 'button', class: 'jd-fold', title: 'Show these lines' }, svgIcon('M4 6l4 4 4-4', 12), `${plural(len, 'unchanged line')}`);
        f.addEventListener('click', () => {
          this.opened.add(runStart);
          const top = el.scrollTop;
          this.renderDiff();
          el.scrollTop = top;
        });
        nodes.push(f);
        continue;
      }
      const row = r.rows[item];
      const cell = (side: 'a' | 'b') => {
        const n = row[side];
        const lines = side === 'a' ? r.a : r.b;
        if (n === null) return [h('span', { class: 'jd-n' }), h('div', { class: 'jd-c none' })];
        return [
          h('span', { class: 'jd-n' }, String(n + 1)),
          h('div', { class: 'jd-c' }, ...codeNodes(lines[n], side === 'a' ? row.ma : row.mb, r.json)),
        ];
      };
      const rowEl = h('div', { class: `jd-row ${row.kind}`, 'data-row': String(item), ...(row.block >= 0 ? { 'data-block': String(row.block) } : {}) }, ...cell('a'), ...cell('b'));
      if (row.block === this.current) rowEl.classList.add('current');
      nodes.push(rowEl);
    }
    if (!r.rows.length) nodes.push(h('div', { class: 'jd-note' }, 'Both are empty.'));
    el.replaceChildren(...nodes);
  }

  private updateNav(): void {
    const r = this.result!;
    if (!this.navLabel) return;
    this.navLabel.textContent = r.blocks ? (this.current >= 0 ? `${this.current + 1} of ${r.blocks}` : `${r.blocks}`) : 'Identical';
  }

  /** Moves to the next or previous changed block. */
  private step(dir: 1 | -1, smooth = true): void {
    const r = this.result;
    if (!r?.blocks) return;
    this.current = this.current < 0 ? (dir > 0 ? 0 : r.blocks - 1) : (this.current + dir + r.blocks) % r.blocks;
    this.reveal(this.current, null, smooth);
  }

  private reveal(block: number, rowIndex: number | null, smooth: boolean): void {
    const el = this.diffEl!;
    this.current = block;
    for (const x of el.querySelectorAll('.jd-row.current')) x.classList.remove('current');
    for (const x of el.querySelectorAll(`.jd-row[data-block="${block}"]`)) x.classList.add('current');
    const target = rowIndex !== null ? el.querySelector<HTMLElement>(`.jd-row[data-row="${rowIndex}"]`) : el.querySelector<HTMLElement>(`.jd-row[data-block="${block}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    }
    this.updateNav();
  }

  /** Scrolls to where a value that differs is, unfolding it if need be. */
  private showPath(c: JsonChange): void {
    const r = this.result!;
    const line = c.kind === 'removed' ? r.pa?.lineOf.get(c.path) : r.pb?.lineOf.get(c.path);
    if (line === undefined) return;
    const side = c.kind === 'removed' ? 'a' : 'b';
    const index = r.rows.findIndex((row) => row[side] === line);
    if (index < 0) return;
    // An unchanged line inside a folded stretch (a changed array, sorted differently): open it.
    if (r.rows[index].kind === 'same') {
      let start = index;
      while (start > 0 && r.rows[start - 1].kind === 'same') start--;
      this.opened.add(start);
      this.renderDiff();
    }
    this.reveal(r.rows[index].block, index, true);
  }
}

/** Opens the compare view; with both sides given it shows the differences at once. */
export function openJsonCompare(opts: { left?: JsonSource | null; right?: JsonSource | null } = {}): void {
  document.querySelector<HTMLDialogElement>('dialog.jd')?.close();
  new CompareView(opts.left ?? null, opts.right ?? null).open();
}
