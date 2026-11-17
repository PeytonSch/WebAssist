// Full-window JSON viewer: tree, table and raw views of a JSON body, with search, a path query
// box and the selected value's path. Opened from the detail panel (response and request bodies,
// the raw event, JSON inside log and console messages) and closed with Esc or Back. It is a
// screen like Settings and Tomcat (#json): the timeline is only hidden underneath, so its
// scroll position and selection are still there on the way back.
//
// Bodies can be several MB with hundreds of thousands of values, so the tree and the table only
// create DOM for the rows in view (fixed row heights, like the timeline), and a container's rows
// are only built when it is opened. Everything shown is captured, untrusted text and goes into
// the DOM through textContent (`h`), never HTML.

import { $, fmtBytes, h, type Child } from './dom';
import { highlight, paint } from './highlight';
import { completions, nestedFallback, type Suggestion } from './jsoncomplete';
import {
  canTable, cellOf, compareNodes, describe, findTable, isContainer, jsonPath, jsPath, lossyNumber, parseJson, plural, preview,
  QueryError, runQuery, search, sizeOf, stringify, stringifyCapped, tableOf, walk,
  type JContainer, type JNode, type Match, type ParseResult, type Seg, type Table,
} from './jsonmodel';

export interface JsonSource {
  /** What it is: "Response body", "Raw event"… */
  title: string;
  /** Shown after the title, e.g. ["GET /api/orders", "200", "12.4 kB"]. */
  meta: string[];
  text: string;
  /** Suggested name for Download. */
  fileName: string;
  /** Set when the capture cut the body off at its size limit (bytes). */
  truncated?: { captured: number; total: number } | null;
}

type Mode = 'tree' | 'table' | 'raw';

/** A root of the tree: the document, or one result of the path query. */
interface Top {
  node: JNode;
  path: Seg[];
  label: string | null;
}

/** One visible line of the tree. */
interface Row {
  node: JNode;
  seg: Seg | null;
  parent: Row | null;
  depth: number;
  top: number;
}

interface Doc {
  src: JsonSource;
  parsed: ParseResult;
  mode: Mode;
  expanded: WeakSet<JNode>;
  query: string;
  queryError: QueryError | null;
  /** Set when the query found nothing from the top and is shown at any depth instead: "..price". */
  queryNested: string | null;
  tops: Top[];
  sel: { node: JNode; path: Seg[] } | null;
  search: string;
  filter: boolean;
  /** The array shown as a table, when the user picked one; otherwise it is worked out. */
  table: { node: JNode; path: Seg[] } | null;
  /** Column sort: '#' (row label), '=' (value column) or 'k:<key>'. */
  sort: { col: string; dir: 1 | -1 } | null;
}

const TREE_ROW_H = 22;
const TABLE_ROW_H = 26;
/** Strings longer than this are cut short in the tree; the full text is in the side panel. */
const ROW_STRING_MAX = 300;
/** The side panel shows at most this much of a selected value. */
const SIDE_VALUE_MAX = 200_000;

const V = {
  open: false,
  stack: [] as Doc[],
  rows: [] as Row[],
  selIdx: -1,
  matches: [] as Match[],
  total: 0,
  cur: -1,
  needle: '',
  hits: new Set<JNode>(),
  ancestors: new Set<JNode>(),
  table: null as null | { node: JNode; path: Seg[]; rowPaths: Seg[][] | null; t: Table; order: number[] },
  tableSel: -1,
  returnFocus: null as Element | null,
  /** The hash to go back to on close, e.g. #api when opened from the API screen. */
  returnHash: '',
};

let onToggle: (open: boolean) => void = () => undefined;
const doc = () => V.stack[V.stack.length - 1];
const rootEl = () => $('json');

// Elements of the current screen, rebuilt by renderShell.
let U: {
  main: HTMLElement;
  side: HTMLElement;
  tree: VList;
  query: HTMLInputElement;
  queryStatus: HTMLElement;
  search: HTMLInputElement;
  searchStatus: HTMLElement;
  filter: HTMLInputElement;
  modes: Record<Mode, HTMLButtonElement>;
} | null = null;

// ── Virtual list ────────────────────────────────────────

/** A scrolling list that only creates the rows in view. Rows have a fixed height. */
class VList {
  readonly el: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;
  private count = 0;
  private frame = 0;

  constructor(cls: string, private readonly rowH: number, private readonly row: (i: number) => HTMLElement, private readonly head: HTMLElement | null = null) {
    this.layer = h('div', { class: 'jv-layer' });
    this.spacer = h('div', { class: 'jv-spacer' }, this.layer);
    this.el = h('div', { class: cls, tabindex: '0' }, head, this.spacer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  setCount(n: number): void {
    this.count = n;
    this.spacer.style.height = `${n * this.rowH}px`;
    this.render();
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render(): void {
    // A list from a screen that was just replaced still gets resize and frame callbacks.
    if (!this.el.isConnected) return;
    const top = this.el.scrollTop;
    const view = this.el.clientHeight - this.headH();
    const first = Math.max(0, Math.floor(top / this.rowH) - 10);
    const last = Math.min(this.count, Math.ceil((top + view) / this.rowH) + 10);
    this.layer.style.transform = `translateY(${first * this.rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(this.row(i));
    this.layer.replaceChildren(frag);
  }

  /** Scrolls row `i` into view; `center` puts it mid-list when it has to scroll. */
  reveal(i: number, center = false): void {
    if (i < 0) return;
    const y = i * this.rowH;
    const view = this.el.clientHeight - this.headH();
    const st = this.el.scrollTop;
    if (y >= st && y + this.rowH <= st + view) return this.render();
    if (center) this.el.scrollTop = y - (view - this.rowH) / 2;
    else this.el.scrollTop = y < st ? y : y + this.rowH - view;
    this.render();
  }

  pageRows(): number {
    return Math.max(1, Math.floor((this.el.clientHeight - this.headH()) / this.rowH) - 1);
  }

  private headH(): number {
    return this.head?.offsetHeight ?? 0;
  }
}

// ── Small helpers ───────────────────────────────────────

function button(label: Child, title: string, onclick: () => void, cls = 'btn btn-sm'): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button', title }, label) as HTMLButtonElement;
  b.onclick = onclick;
  return b;
}

async function copyText(btn: HTMLElement, text: string): Promise<void> {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = label), 1200);
}

function copyButton(label: string, title: string, text: () => string): HTMLButtonElement {
  const b = button(label, title, () => void copyText(b, text()));
  return b;
}

function download(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `text` with the search term wrapped in <mark>. */
function marked(text: string): (string | Node)[] {
  const q = V.needle;
  if (!q) return [text];
  const low = text.toLowerCase();
  // Lower-casing a few characters changes the length; then offsets would not line up.
  if (low.length !== text.length) return [text];
  const out: (string | Node)[] = [];
  let from = 0;
  for (let k = low.indexOf(q); k !== -1; k = low.indexOf(q, k + q.length)) {
    out.push(text.slice(from, k), h('mark', { class: 'jv-mark' }, text.slice(k, k + q.length)));
    from = k + q.length;
  }
  out.push(text.slice(from));
  return out;
}

const childAt = (n: JContainer, k: number): JNode => (n.t === 'obj' ? n.vals[k] : n.items[k]);
const segAt = (n: JContainer, k: number): Seg => (n.t === 'obj' ? n.keys[k] : k);
const countLabel = (n: JContainer) => (n.t === 'obj' ? plural(n.keys.length, 'key') : plural(n.items.length, 'item'));
const filtering = () => doc().filter && V.needle !== '';

function rowPath(r: Row): Seg[] {
  const segs: Seg[] = [];
  let x: Row | null = r;
  for (; x && x.parent; x = x.parent) segs.push(x.seg!);
  return [...doc().tops[r.top].path, ...segs.reverse()];
}

// ── Documents ───────────────────────────────────────────

function newDoc(src: JsonSource): Doc {
  const parsed = parseJson(src.text);
  const d: Doc = {
    src, parsed, mode: parsed.root ? 'tree' : 'raw', expanded: new WeakSet(), query: '', queryError: null, queryNested: null,
    tops: parsed.root ? [{ node: parsed.root, path: [], label: null }] : [], sel: null, search: '', filter: false, table: null, sort: null,
  };
  if (parsed.root) {
    autoExpand(d);
    d.sel = { node: parsed.root, path: [] };
  }
  return d;
}

/** Opens the first levels, as many as fit in a screenful or two. */
function autoExpand(d: Doc): void {
  if (d.tops.length !== 1) return;
  const node = d.tops[0].node;
  let depth = 1;
  for (let dep = 2; dep <= 3 && countTo(node, dep, 300) <= 300; dep++) depth = dep;
  expandTo(d, depth);
}

/** How many rows the tree would have with `depth` levels open (stops counting past `cap`). */
function countTo(node: JNode, depth: number, cap: number): number {
  let level: JNode[] = [node];
  let count = 1;
  for (let dep = 0; dep < depth && level.length && count <= cap; dep++) {
    const next: JNode[] = [];
    for (const n of level) {
      if (!isContainer(n)) continue;
      count += sizeOf(n);
      for (let k = 0; k < sizeOf(n); k++) next.push(childAt(n, k));
      if (count > cap) break;
    }
    level = next;
  }
  return count;
}

/** Opens every container above `depth` under each top (1 = the top's own children). */
function expandTo(d: Doc, depth: number): void {
  for (const t of d.tops) {
    let level: JNode[] = [t.node];
    for (let dep = 0; dep < depth && level.length; dep++) {
      const next: JNode[] = [];
      for (const n of level) {
        if (!isContainer(n)) continue;
        d.expanded.add(n);
        for (let k = 0; k < sizeOf(n); k++) {
          const c = childAt(n, k);
          if (isContainer(c)) next.push(c);
        }
      }
      level = next;
    }
  }
}

// ── Tree ────────────────────────────────────────────────

function flatten(): void {
  const d = doc();
  const rows: Row[] = [];
  const only = filtering();
  d.tops.forEach((t, ti) => {
    if (only && !V.hits.has(t.node) && !V.ancestors.has(t.node)) return;
    const row: Row = { node: t.node, seg: null, parent: null, depth: 0, top: ti };
    rows.push(row);
    if (isContainer(t.node) && d.expanded.has(t.node)) addChildren(row, rows);
  });
  V.rows = rows;
  V.selIdx = findSel();
}

function addChildren(row: Row, out: Row[]): void {
  const d = doc();
  const n = row.node as JContainer;
  // With "Only matching", a branch shows just the children that lead to a match, unless the
  // branch itself matched (by its key), in which case all of it is relevant.
  const only = filtering() && !V.hits.has(n);
  const size = sizeOf(n);
  for (let k = 0; k < size; k++) {
    const child = childAt(n, k);
    if (only && !V.hits.has(child) && !V.ancestors.has(child)) continue;
    const r: Row = { node: child, seg: segAt(n, k), parent: row, depth: row.depth + 1, top: row.top };
    out.push(r);
    if (isContainer(child) && d.expanded.has(child)) addChildren(r, out);
  }
}

function findSel(): number {
  const s = doc().sel;
  if (!s) return -1;
  // The same node can sit under several query results; prefer the one whose path matches.
  let first = -1;
  for (let i = 0; i < V.rows.length; i++) {
    if (V.rows[i].node !== s.node) continue;
    if (first < 0) first = i;
    if (jsPath(rowPath(V.rows[i])) === jsPath(s.path)) return i;
  }
  return first;
}

function treeRow(i: number): HTMLElement {
  const d = doc();
  const r = V.rows[i];
  const n = r.node;
  const el = h('div', { class: 'jv-row', 'data-i': String(i) });
  el.style.paddingLeft = `${6 + r.depth * 16}px`;
  if (i === V.selIdx) el.classList.add('sel');
  if (V.hits.has(n)) el.classList.add('hit');
  const m = V.matches[V.cur];
  if (m && m.node === n && m.top === r.top) el.classList.add('cur');

  const open = isContainer(n) && d.expanded.has(n);
  el.append(h('span', { class: `jv-tw${isContainer(n) && sizeOf(n) > 0 ? (open ? ' open' : ' closed') : ''}`, 'aria-hidden': 'true' }));
  if (r.parent) {
    if (typeof r.seg === 'number') el.append(h('span', { class: 'jv-idx' }, String(r.seg)));
    else el.append(h('span', { class: 'jv-key' }, ...marked(r.seg!)));
    el.append(h('span', { class: 'jv-colon' }, ':'));
  } else if (d.tops[r.top].label !== null) {
    el.append(h('span', { class: 'jv-key jv-toplabel' }, d.tops[r.top].label!), h('span', { class: 'jv-colon' }, ':'));
  }
  el.append(...valueParts(n, open));
  return el;
}

function valueParts(n: JNode, open: boolean): HTMLElement[] {
  const parts: HTMLElement[] = [];
  switch (n.t) {
    case 'obj':
    case 'arr': {
      const size = sizeOf(n);
      parts.push(h('span', { class: 'jv-brace' }, n.t === 'obj' ? (size ? '{' : '{}') : size ? '[' : '[]'));
      if (size) parts.push(h('span', { class: 'jv-count' }, countLabel(n)));
      // Before the preview, which is cut short to fit and would push the marker out of view.
      if (n.cut) parts.push(cutBadge());
      if (size && !open) parts.push(h('span', { class: 'jv-prev' }, preview(n, 120)));
      return parts;
    }
    case 'str': {
      const shown = n.v.length > ROW_STRING_MAX ? n.v.slice(0, ROW_STRING_MAX) : n.v;
      parts.push(h('span', { class: 'jv-val jv-str' }, ...marked(JSON.stringify(shown))));
      if (n.v.length > ROW_STRING_MAX) parts.push(h('span', { class: 'jv-more', title: 'Show the whole string in the side panel' }, `+${(n.v.length - ROW_STRING_MAX).toLocaleString('en-US')} chars`));
      break;
    }
    case 'num': {
      parts.push(h('span', { class: 'jv-val jv-num' }, ...marked(n.raw)));
      const lossy = lossyNumber(n.raw);
      if (lossy) parts.push(h('span', { class: 'jv-badge big', title: `Too big for a JavaScript number: JSON.parse would read it as ${lossy}. Shown as written.` }, 'big'));
      break;
    }
    case 'bool': parts.push(h('span', { class: 'jv-val jv-bool' }, ...marked(String(n.v)))); break;
    case 'null': parts.push(h('span', { class: 'jv-val jv-null' }, ...marked('null'))); break;
  }
  if ('cut' in n && n.cut) parts.push(cutBadge());
  return parts;
}

const cutBadge = () => h('span', { class: 'jv-badge cut', title: 'The captured text ends inside this value, so it is incomplete' }, 'cut off');

function selectRow(i: number, center = false): void {
  if (!V.rows.length) return;
  i = Math.max(0, Math.min(V.rows.length - 1, i));
  // Holding an arrow key at the first or last row should not redo the side panel each time.
  if (i === V.selIdx && doc().sel?.node === V.rows[i].node) {
    U?.tree.reveal(i, center);
    return;
  }
  V.selIdx = i;
  const r = V.rows[i];
  doc().sel = { node: r.node, path: rowPath(r) };
  U?.tree.reveal(i, center);
  U?.tree.render();
  scheduleSide();
}

/** Opens or closes the container on row `i`, splicing its rows in or out. */
function toggle(i: number, open?: boolean): void {
  const d = doc();
  const r = V.rows[i];
  if (!r || !isContainer(r.node) || sizeOf(r.node) === 0) return;
  const isOpen = d.expanded.has(r.node);
  const want = open ?? !isOpen;
  if (want === isOpen) return;
  if (want) d.expanded.add(r.node);
  else d.expanded.delete(r.node);
  if (d.tops.length > 1) {
    // Results can share nodes (..* returns parents and children), so rebuild every row.
    flatten();
  } else if (want) {
    const kids: Row[] = [];
    addChildren(r, kids);
    V.rows = V.rows.slice(0, i + 1).concat(kids, V.rows.slice(i + 1));
    if (V.selIdx > i) V.selIdx += kids.length;
  } else {
    let j = i + 1;
    while (j < V.rows.length && V.rows[j].depth > r.depth) j++;
    V.rows.splice(i + 1, j - i - 1);
    if (V.selIdx > i && V.selIdx < j) selectRow(i);
    else if (V.selIdx >= j) V.selIdx -= j - i - 1;
  }
  U?.tree.setCount(V.rows.length);
}

/** Opens everything under row `i` (the * key). */
function expandBelow(i: number): void {
  const r = V.rows[i];
  if (!r || !isContainer(r.node)) return;
  const d = doc();
  const stack: JNode[] = [r.node];
  while (stack.length) {
    const n = stack.pop()!;
    if (!isContainer(n)) continue;
    d.expanded.add(n);
    for (let k = 0; k < sizeOf(n); k++) stack.push(childAt(n, k));
  }
  flatten();
  U?.tree.setCount(V.rows.length);
}

function setDepth(depth: number): void {
  const d = doc();
  d.expanded = new WeakSet();
  expandTo(d, depth);
  flatten();
  if (d.mode !== 'tree') setMode('tree');
  else renderMain();
  U?.tree.reveal(V.selIdx);
}

/** Opens the containers above the selection so it has a row, e.g. after picking it in the table. */
function revealSel(): void {
  const d = doc();
  const s = d.sel;
  if (!s || findSel() >= 0) return;
  for (const t of d.tops) {
    if (t.path.length > s.path.length || t.path.some((seg, k) => seg !== s.path[k])) continue;
    const chain = walk(t.node, s.path.slice(t.path.length));
    if (!chain) continue;
    for (const n of chain.slice(0, -1)) d.expanded.add(n);
    break;
  }
  flatten();
}

function onTreeKey(e: KeyboardEvent): void {
  const i = V.selIdx;
  const r = V.rows[i];
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    if (String(getSelection() ?? '') === '' && doc().sel) {
      e.preventDefault();
      void navigator.clipboard.writeText(stringify(doc().sel!.node)).catch(() => undefined);
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const page = U?.tree.pageRows() ?? 10;
  switch (e.key) {
    case 'ArrowDown': selectRow(i < 0 ? 0 : i + 1); break;
    case 'ArrowUp': selectRow(i < 0 ? 0 : i - 1); break;
    case 'PageDown': selectRow(i + page); break;
    case 'PageUp': selectRow(i - page); break;
    case 'Home': selectRow(0); break;
    case 'End': selectRow(V.rows.length - 1); break;
    case 'ArrowRight':
      if (!r) selectRow(0);
      else if (isContainer(r.node) && sizeOf(r.node) && !doc().expanded.has(r.node)) toggle(i, true);
      else if (isContainer(r.node) && sizeOf(r.node)) selectRow(i + 1);
      break;
    case 'ArrowLeft':
      if (!r) break;
      if (isContainer(r.node) && doc().expanded.has(r.node) && sizeOf(r.node)) toggle(i, false);
      else if (r.parent) {
        let j = i - 1;
        while (j > 0 && V.rows[j] !== r.parent) j--;
        selectRow(j);
      }
      break;
    case 'Enter':
    case ' ':
      toggle(i);
      break;
    case '*':
      expandBelow(i);
      break;
    default:
      return;
  }
  e.preventDefault();
}

// ── Search ──────────────────────────────────────────────

/** Recomputes the matches for the current search text (does not move the selection). */
function computeMatches(): void {
  const d = doc();
  V.needle = d.search.toLowerCase();
  const { matches, total } = search(d.tops.map((t) => t.node), d.search);
  V.matches = matches;
  V.total = total;
  V.cur = -1;
  V.hits = new Set(matches.map((m) => m.node));
  V.ancestors = new Set();
  for (const m of matches) for (const a of m.ancestors) V.ancestors.add(a);
  if (filtering()) for (const a of V.ancestors) d.expanded.add(a);
}

function runSearch(): void {
  computeMatches();
  flatten();
  if (V.matches.length) {
    goMatch(0);
  } else {
    renderMain();
  }
  renderSearchStatus();
}

function goMatch(k: number): void {
  const n = V.matches.length;
  if (!n) return;
  const d = doc();
  V.cur = ((k % n) + n) % n;
  const m = V.matches[V.cur];
  d.expanded.add(d.tops[m.top].node);
  for (const a of m.ancestors) d.expanded.add(a);
  flatten();
  const i = V.rows.findIndex((r) => r.node === m.node && r.top === m.top);
  if (d.mode !== 'tree') {
    d.mode = 'tree';
    syncModeButtons();
  }
  renderMain();
  selectRow(i, true);
  renderSearchStatus();
}

function nextMatch(dir: 1 | -1): void {
  if (!V.matches.length) return;
  goMatch(V.cur < 0 ? (dir > 0 ? 0 : V.matches.length - 1) : V.cur + dir);
}

function renderSearchStatus(): void {
  if (!U) return;
  const d = doc();
  const el = U.searchStatus;
  el.classList.remove('error');
  if (!d.search) el.textContent = '';
  else if (!V.total) {
    el.textContent = 'No matches';
    el.classList.add('error');
  } else {
    const more = V.total > V.matches.length ? ` (first ${V.matches.length.toLocaleString('en-US')})` : '';
    el.textContent = `${V.cur >= 0 ? (V.cur + 1).toLocaleString('en-US') : '–'} of ${V.total.toLocaleString('en-US')}${more}`;
  }
}

// ── Query ───────────────────────────────────────────────

function applyQuery(expr: string): void {
  const d = doc();
  const root = d.parsed.root;
  if (!root) return;
  d.query = expr;
  try {
    let hits = expr.trim() ? runQuery(root, expr) : [{ node: root, path: [] as Seg[] }];
    d.queryNested = null;
    // "price" typed at the top when it is further down: show it wherever it is, and say so.
    if (!hits.length) {
      const nested = nestedFallback(root, expr);
      if (nested) {
        hits = nested.hits;
        d.queryNested = nested.expr;
      }
    }
    d.queryError = null;
    d.tops = hits.length === 1
      ? [{ node: hits[0].node, path: hits[0].path, label: hits[0].path.length ? jsPath(hits[0].path) : null }]
      : hits.map((hit) => ({ node: hit.node, path: hit.path, label: jsPath(hit.path) || '$' }));
  } catch (e) {
    if (!(e instanceof QueryError)) throw e;
    // Keep showing the last good result while the expression is being typed.
    d.queryError = e;
    renderQueryStatus();
    return;
  }
  d.table = null;
  d.sort = null;
  d.sel = d.tops.length ? { node: d.tops[0].node, path: d.tops[0].path } : null;
  autoExpand(d);
  computeMatches();
  flatten();
  renderMain();
  U?.tree.el.scrollTo(0, 0);
  renderSide();
  renderQueryStatus();
  renderSearchStatus();
}

function renderQueryStatus(): void {
  if (!U) return;
  const d = doc();
  const el = U.queryStatus;
  U.query.parentElement!.classList.toggle('invalid', !!d.queryError);
  el.className = 'jv-status';
  if (d.queryError) {
    el.classList.add('error');
    el.textContent = `${d.queryError.message} (col ${d.queryError.pos + 1})`;
    el.title = d.queryError.message;
  } else if (d.query.trim()) {
    const n = d.tops.length === 1 ? '1 result' : `${d.tops.length.toLocaleString('en-US')} results`;
    el.textContent = !d.tops.length ? 'No match' : d.queryNested ? `${n} further down (${d.queryNested})` : n;
    if (!d.tops.length) el.classList.add('error');
    else if (d.queryNested) el.classList.add('nested');
    el.title = d.queryNested ? `Nothing at ${d.query.trim()} from the top, so it is matched at any depth: ${d.queryNested}` : '';
  } else {
    el.textContent = '';
  }
}

/** Shows `path` on its own: the query is set to it, and arrays of objects open as a table. */
function drill(path: Seg[]): void {
  if (!U) return;
  const expr = jsonPath(path);
  U.query.value = expr;
  applyQuery(expr);
  const d = doc();
  setMode(d.tops.length === 1 && canTable(d.tops[0].node) ? 'table' : 'tree');
}

// ── Table ───────────────────────────────────────────────

/** The array the table shows: the user's pick, the selection, the result, or the first one found. */
function tableTarget(): { node: JNode; path: Seg[]; rowPaths: Seg[][] | null } | null {
  const d = doc();
  if (d.table) return { ...d.table, rowPaths: null };
  if (d.sel && canTable(d.sel.node)) return { ...d.sel, rowPaths: null };
  if (d.tops.length > 1) {
    // Several query results (items[*]) make one row each.
    return { node: { t: 'arr', items: d.tops.map((t) => t.node) }, path: [], rowPaths: d.tops.map((t) => t.path) };
  }
  const top = d.tops[0];
  if (!top) return null;
  if (canTable(top.node)) return { node: top.node, path: top.path, rowPaths: null };
  const found = findTable(top.node);
  return found ? { node: found.node, path: [...top.path, ...found.path], rowPaths: null } : null;
}

function cellText(n: JNode | undefined): string {
  if (!n) return '';
  switch (n.t) {
    case 'str': return n.v.length > 200 ? n.v.slice(0, 200) + '…' : n.v;
    case 'num': return n.raw;
    case 'bool': return String(n.v);
    case 'null': return 'null';
    case 'obj':
    case 'arr': return chipLabel(n);
  }
}

const chipLabel = (n: JContainer) => (n.t === 'obj' ? `{${countLabel(n)}}` : `[${countLabel(n)}]`);

function renderTable(): HTMLElement {
  const d = doc();
  const target = tableTarget();
  const t = target && tableOf(target.node);
  if (!target || !t) {
    V.table = null;
    return h('div', { class: 'jv-empty' },
      h('strong', {}, 'No array of objects here.'),
      h('div', {}, 'Select an array in the tree and choose Table, or put its path in the query box, e.g. data.items.'));
  }
  // Columns: the row label, each key, and a value column for rows that are not objects.
  const cols: { id: string; label: string; cell: (row: JNode) => JNode | undefined }[] = [
    { id: '#', label: target.rowPaths ? 'path' : target.node.t === 'obj' ? 'key' : '#', cell: () => undefined },
    ...t.columns.map((c) => ({ id: `k:${c}`, label: c, cell: (row: JNode) => cellOf(row, c) })),
  ];
  if (t.valueColumn) cols.push({ id: '=', label: '(value)', cell: (row: JNode) => (row.t === 'obj' ? undefined : row) });
  const labelOf = (k: number): string => (target.rowPaths ? jsPath(target.rowPaths[k]) || '$' : String(t.rows[k].seg));

  const order = t.rows.map((_, k) => k);
  if (d.sort) {
    const { col, dir } = d.sort;
    const c = cols.find((x) => x.id === col);
    if (col === '#') order.sort((a, b) => dir * (typeof t.rows[a].seg === 'number' ? (t.rows[a].seg as number) - (t.rows[b].seg as number) : labelOf(a).localeCompare(labelOf(b))));
    else if (c) order.sort((a, b) => {
      const x = c.cell(t.rows[a].node);
      const y = c.cell(t.rows[b].node);
      // Missing values stay last whichever way the column is sorted.
      if (!x || !y) return compareNodes(x, y);
      return dir * compareNodes(x, y);
    });
  }
  V.table = { node: target.node, path: target.path, rowPaths: target.rowPaths, t, order };
  // Keep this table while rows are selected and sorted; picking a row must not swap the table.
  if (!target.rowPaths) d.table = { node: target.node, path: target.path };
  V.tableSel = d.sel ? order.findIndex((k) => t.rows[k].node === d.sel!.node) : -1;

  // Fixed column widths from a sample of the content, so rows can be created on demand.
  const sample = order.slice(0, 300);
  const widths = cols.map((c, ci) => {
    let len = c.label.length + 2;
    for (const k of sample) len = Math.max(len, (ci === 0 ? labelOf(k) : cellText(c.cell(t.rows[k].node))).length);
    return Math.round(Math.min(Math.max(len, 3), 42) * 7.3 + 22);
  });
  const total = widths.reduce((a, b) => a + b, 0);

  const head = h('div', { class: 'jv-thead' });
  head.style.width = `${total}px`;
  cols.forEach((c, ci) => {
    const sorted = d.sort?.col === c.id ? d.sort.dir : 0;
    const th = button(h('span', {}, c.label, sorted ? (sorted > 0 ? ' ▲' : ' ▼') : ''), `Sort by ${c.label}`, () => {
      // Click cycles ascending, descending, unsorted.
      d.sort = sorted === 0 ? { col: c.id, dir: 1 } : sorted > 0 ? { col: c.id, dir: -1 } : null;
      renderMain();
    }, `jv-th${sorted ? ' sorted' : ''}`);
    th.style.width = `${widths[ci]}px`;
    head.append(th);
  });

  const rowPathOf = (k: number): Seg[] => (target.rowPaths ? target.rowPaths[k] : [...target.path, t.rows[k].seg]);
  const list = new VList('jv-list jv-table', TABLE_ROW_H, (i) => {
    const k = order[i];
    const row = t.rows[k].node;
    const tr = h('div', { class: `jv-tr${i === V.tableSel ? ' sel' : ''}`, 'data-i': String(i) });
    tr.style.width = `${total}px`;
    cols.forEach((c, ci) => {
      const td = h('div', { class: 'jv-td' });
      td.style.width = `${widths[ci]}px`;
      if (ci === 0) {
        td.classList.add('label');
        td.textContent = labelOf(k);
      } else {
        const n = c.cell(row);
        if (n && isContainer(n)) {
          const path = c.id === '=' ? rowPathOf(k) : [...rowPathOf(k), c.label];
          const chip = button(chipLabel(n), `Open ${jsPath(path) || '$'}`, () => drill(path), 'jv-chip');
          td.append(chip);
        } else if (n) {
          td.classList.add(`jv-${n.t}`);
          td.append(...marked(cellText(n)));
          td.title = n.t === 'str' && n.v.length > 40 ? n.v.slice(0, 2000) : '';
        }
        if (n && 'cut' in n && n.cut) td.append(cutBadge());
      }
      tr.append(td);
    });
    return tr;
  }, head);
  list.el.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('.jv-tr');
    if (tr && !(e.target as HTMLElement).closest('.jv-chip')) selectTableRow(Number(tr.dataset.i), list);
  });
  list.el.addEventListener('dblclick', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('.jv-tr');
    if (tr && !(e.target as HTMLElement).closest('.jv-chip')) drill(rowPathOf(order[Number(tr.dataset.i)]));
  });
  list.el.addEventListener('keydown', (e) => {
    const page = list.pageRows();
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (e.key in moves) selectTableRow(Math.max(0, V.tableSel) + moves[e.key], list);
    else if (e.key === 'Home') selectTableRow(0, list);
    else if (e.key === 'End') selectTableRow(order.length - 1, list);
    else if (e.key === 'Enter' && V.tableSel >= 0) drill(rowPathOf(order[V.tableSel]));
    else return;
    e.preventDefault();
  });

  const where = target.rowPaths ? `${plural(target.rowPaths.length, 'result')} of ${d.query}` : jsPath(target.path) || '$';
  const info = h('div', { class: 'jv-tinfo' },
    h('code', {}, where), ' · ', plural(t.rows.length, 'row'), ' · ', plural(cols.length - 1, 'column'),
    t.hiddenColumns ? h('span', { class: 'muted' }, ` (${t.hiddenColumns} more not shown)`) : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, 'Click a header to sort · double-click a row to open it'));
  const wrap = h('div', { class: 'jv-tablewrap' }, info, list.el);
  requestAnimationFrame(() => {
    list.setCount(order.length);
    list.reveal(V.tableSel, true);
  });
  return wrap;
}

function selectTableRow(i: number, list: VList): void {
  const tb = V.table;
  if (!tb || !tb.order.length) return;
  i = Math.max(0, Math.min(tb.order.length - 1, i));
  V.tableSel = i;
  const k = tb.order[i];
  doc().sel = { node: tb.t.rows[k].node, path: tb.rowPaths ? tb.rowPaths[k] : [...tb.path, tb.t.rows[k].seg] };
  list.reveal(i);
  list.render();
  scheduleSide();
}

// ── Raw ─────────────────────────────────────────────────

function renderRaw(): HTMLElement {
  const d = doc();
  const pre = h('pre', { class: 'code jv-raw', tabindex: '0' });
  const err = d.parsed.error;
  if (err || !d.parsed.root) {
    const text = d.src.text;
    const pos = err ? err.pos : text.length;
    paint(pre, highlight(text.slice(0, pos), 'json'));
    const mark = h('span', { class: 'jv-errmark', title: err ? err.message : 'No JSON value' }, pos < text.length ? (text[pos] === '\n' ? '⏎\n' : text[pos]) : '␃');
    pre.append(mark, text.slice(pos + 1));
    requestAnimationFrame(() => mark.scrollIntoView({ block: 'center' }));
    return pre;
  }
  const value: JNode = d.tops.length === 1 ? d.tops[0].node : { t: 'arr', items: d.tops.map((t) => t.node) };
  return paint(pre, highlight(stringify(value), 'json'));
}

// ── Side panel ──────────────────────────────────────────

let sideFrame = 0;
/** Moving through rows with the arrow keys should not wait for big values to be printed. */
function scheduleSide(): void {
  if (sideFrame) return;
  sideFrame = requestAnimationFrame(() => {
    sideFrame = 0;
    renderSide();
  });
}

function renderSide(): void {
  if (!U) return;
  const d = doc();
  const s = d.sel;
  if (!d.parsed.root) {
    U.side.replaceChildren(h('div', { class: 'jv-hint' }, 'Nothing to select: the text could not be read as JSON.'));
    return;
  }
  if (!s) {
    U.side.replaceChildren(h('div', { class: 'jv-hint' }, 'Select a value to see its path.'), keysHint());
    return;
  }
  const n = s.node;
  const js = jsPath(s.path);
  const jp = jsonPath(s.path);
  const pathRow = (label: string, text: string, title: string) =>
    [h('span', { class: 'jv-plabel' }, label), h('code', {}, text), copyButton('Copy', title, () => text)];

  const actions = h('div', { class: 'jv-actions' },
    copyButton('Copy value', 'Copy the value as JSON (Ctrl+C in the tree)', () => stringify(n)),
    s.path.length && !(d.tops.length === 1 && jsPath(d.tops[0].path) === js) ? button('Show only this', 'Put this path in the query box', () => drill(s.path)) : null,
    canTable(n) ? button('Table', 'Show this as a table', () => {
      d.table = { node: n, path: s.path };
      d.sort = null;
      setMode('table');
    }) : null,
    n.t === 'str' && looksLikeJson(n.v) ? button('Open as JSON', 'This string holds JSON: open it in its own view (Esc comes back)', () => pushDoc({
      title: `JSON in ${js || 'the string'}`,
      meta: [d.src.title],
      text: n.v,
      fileName: d.src.fileName.replace(/\.json$/, '') + `-${(js || 'string').replace(/[^\w.-]+/g, '_')}.json`,
    })) : null);

  const notes: HTMLElement[] = [];
  if ('cut' in n && n.cut) notes.push(h('div', { class: 'jv-note warn' }, 'Incomplete: the captured text ends inside this value.'));
  const lossy = n.t === 'num' && lossyNumber(n.raw);
  if (lossy) notes.push(h('div', { class: 'jv-note' }, `Shown as written. JavaScript's JSON.parse would read this as ${lossy}.`));

  U.side.replaceChildren(
    h('h4', {}, 'Selected'),
    h('div', { class: 'jv-type' }, describe(n)),
    h('div', { class: 'jv-paths' }, ...pathRow('Path', js || '(root)', 'Copy the JavaScript-style path'), ...pathRow('JSONPath', jp, 'Copy the JSONPath')),
    actions,
    ...notes,
    h('h4', {}, 'Value'),
    sideValue(n),
    keysHint());
}

const keysHint = () => h('div', { class: 'jv-hint jv-keys' },
  '↑ ↓ move · → ← open and close · * open all below · Ctrl+C copy value · / find · N next match · Esc back');

function sideValue(n: JNode): HTMLElement {
  const pre = h('pre', { class: 'code jv-value' });
  if (n.t === 'str') {
    pre.textContent = n.v.length > SIDE_VALUE_MAX ? n.v.slice(0, SIDE_VALUE_MAX) : n.v;
    if (n.v.length > SIDE_VALUE_MAX) return h('div', {}, pre, h('div', { class: 'jv-note' }, `Showing the first ${SIDE_VALUE_MAX.toLocaleString('en-US')} characters; Copy value copies all of it.`));
    return pre;
  }
  // Big values are only printed as far as the panel shows them.
  const { text, cut } = stringifyCapped(n, 2, SIDE_VALUE_MAX);
  paint(pre, highlight(text, 'json'));
  if (cut) return h('div', {}, pre, h('div', { class: 'jv-note' }, `Showing the start of it; Copy value copies all of it.`));
  return pre;
}

function looksLikeJson(s: string): boolean {
  const t = s.trimStart();
  if (!(t.startsWith('{') || t.startsWith('['))) return false;
  const r = parseJson(s);
  return !r.error && !!r.root && isContainer(r.root);
}

// ── Screen ──────────────────────────────────────────────

function setMode(mode: Mode): void {
  const d = doc();
  if (!d.parsed.root) mode = 'raw';
  if (mode === 'tree') revealSel();
  d.mode = mode;
  syncModeButtons();
  renderMain();
  renderSide();
}

function syncModeButtons(): void {
  if (!U) return;
  for (const [m, b] of Object.entries(U.modes)) {
    b.classList.toggle('on', m === doc().mode);
    b.setAttribute('aria-pressed', String(m === doc().mode));
  }
}

function renderMain(): void {
  if (!U) return;
  const d = doc();
  if (d.mode === 'raw' || !d.parsed.root) {
    U.main.replaceChildren(renderRaw());
    return;
  }
  if (d.mode === 'table') {
    U.main.replaceChildren(renderTable());
    return;
  }
  if (!d.tops.length) {
    U.main.replaceChildren(h('div', { class: 'jv-empty' }, h('strong', {}, 'Nothing at this path.'), h('div', {}, 'Change or clear the query to see the document again.')));
    return;
  }
  if (!V.rows.length && filtering()) {
    U.main.replaceChildren(h('div', { class: 'jv-empty' }, h('strong', {}, 'No matches.'), h('div', {}, 'Untick "Only matching" to see everything.')));
    return;
  }
  if (U.tree.el.parentElement !== U.main) U.main.replaceChildren(U.tree.el);
  U.tree.setCount(V.rows.length);
}

function bannerFor(d: Doc): HTMLElement[] {
  const out: HTMLElement[] = [];
  const t = d.src.truncated;
  const cutNote = d.parsed.partial && d.parsed.root ? ' Values marked "cut off" are incomplete.' : '';
  if (t) out.push(h('div', { class: 'jv-banner warn' }, `Body was cut off at ${fmtBytes(t.captured)} of ${fmtBytes(t.total)}; showing what was captured.${cutNote}`, h('span', { class: 'muted' }, ' Raise "Body size limit" in Settings to capture more.')));
  else if (d.parsed.partial && d.parsed.root) out.push(h('div', { class: 'jv-banner warn' }, `The JSON ends before it is complete; showing what is there.${cutNote}`));
  const e = d.parsed.error;
  if (e) out.push(h('div', { class: 'jv-banner error' }, `Not valid JSON: ${e.message} at line ${e.line}, column ${e.col}. Showing the text as captured, with the position marked.`));
  else if (!d.parsed.root) out.push(h('div', { class: 'jv-banner error' }, 'There is no JSON value in this text.'));
  return out;
}

/** Copy all and Download give the pretty-printed JSON when it parsed, else the text as captured. */
function exportText(d: Doc): string {
  return d.parsed.root && !d.parsed.partial && !d.parsed.error ? stringify(d.parsed.root) : d.src.text;
}

// ── Path suggestions ────────────────────────────────────

/** Closes the Path box's suggestion list; true if it was open. Set while the viewer is built. */
let closeSuggestions: () => boolean = () => false;

/** Long nested paths lose their middle, not their end: the end is the key that matched. */
function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}

const KIND_TAG: Record<Suggestion['kind'], string> = { key: '', index: '', nested: 'nested', 'any-depth': 'any depth' };

/**
 * The suggestion list under the Path box: keys at the place being typed and matching keys
 * further down (jsoncomplete.ts). ↑↓ choose, Tab or Enter take one, Esc closes it. Taking one
 * applies it straight away and offers what comes next.
 */
function suggestList(input: HTMLInputElement, root: () => JNode | null, apply: (text: string) => void) {
  const el = h('div', { class: 'jv-suggest', role: 'listbox', id: 'jv-suggest', hidden: '' });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'jv-suggest');
  input.setAttribute('aria-expanded', 'false');
  let items: Suggestion[] = [];
  let active = -1;
  let timer = 0;

  const close = (): boolean => {
    clearTimeout(timer);
    const was = !el.hidden;
    el.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
    return was;
  };
  const highlightActive = () => {
    el.querySelectorAll('.jv-sug').forEach((o, i) => o.classList.toggle('active', i === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `jv-sug-${active}`);
      el.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    const r = root();
    // Only when the caret is at the end: suggestions replace the text up to the step being typed.
    items = r && document.activeElement === input && input.selectionStart === input.value.length ? completions(r, input.value) : [];
    active = -1;
    if (!items.length) return void close();
    el.replaceChildren(...items.map((s, i) => {
      const tag = KIND_TAG[s.kind];
      const opt = h('div', { class: `jv-sug ${s.kind}`, role: 'option', id: `jv-sug-${i}`, title: s.text },
        h('span', { class: 'jv-sug-label' }, middleEllipsis(s.label, 56)),
        tag ? h('span', { class: 'jv-sug-tag' }, tag) : null,
        h('span', { class: 'jv-sug-detail' }, s.detail));
      // mousedown, not click: the input must keep focus.
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        take(i);
      });
      return opt;
    }));
    el.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlightActive();
  };
  const take = (i: number) => {
    const s = items[i];
    if (!s) return;
    input.value = s.text;
    input.setSelectionRange(s.text.length, s.text.length);
    apply(s.text);
    render();
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(render, 60);
  });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => close());
  input.addEventListener('keydown', (e) => {
    if (el.hidden) {
      if (e.key === 'ArrowDown' || (e.key === ' ' && e.ctrlKey)) {
        e.preventDefault();
        render();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
      highlightActive();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      take(active >= 0 ? active : 0);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      take(active);
    }
  });
  closeSuggestions = close;
  return { el, close };
}

function renderShell(): void {
  const d = doc();
  const parent = V.stack.length > 1 ? V.stack[V.stack.length - 2] : null;
  const ok = !!d.parsed.root;

  const back = button(h('span', {}, '← ', parent ? `Back to ${parent.src.title.toLowerCase()}` : 'Back to timeline'), 'Back (Esc)', () => back_(), 'btn');
  const meta = [...d.src.meta, ok ? plural(d.parsed.nodes, 'value') : ''].filter(Boolean);
  const title = h('div', { class: 'jv-title' }, h('h1', {}, d.src.title), ...meta.map((m) => h('span', { class: 'jv-meta' }, m)));
  const copyAll = copyButton('Copy all', d.parsed.partial || d.parsed.error ? 'Copy the text as captured' : 'Copy the whole document, pretty-printed', () => exportText(d));
  copyAll.className = 'btn';
  const save = button('Download', `Save as ${d.src.fileName}`, () => download(exportText(d), d.src.fileName), 'btn');
  const head = h('div', { class: 'jv-head' }, back, title, copyAll, save);

  const modes = {
    tree: button('Tree', 'Tree view', () => setMode('tree'), 'jv-mode'),
    table: button('Table', 'Table view for arrays of objects', () => {
      // Work the table out afresh from the current selection or result.
      doc().table = null;
      setMode('table');
    }, 'jv-mode'),
    raw: button('Raw', 'Pretty-printed text', () => setMode('raw'), 'jv-mode'),
  };
  if (!ok) modes.tree.disabled = modes.table.disabled = true;

  const query = h('input', {
    type: 'text', class: 'jv-input', placeholder: 'data.items[*].price   ..id   items[?(@.price > 10)]', spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'Path query', title: 'Show only part of the document. Names and [index], * for all, ..name at any depth, [?(@.key == "x")] to filter. Enter to apply.',
  }) as HTMLInputElement;
  query.value = d.query;
  let qTimer = 0;
  const suggest = suggestList(query, () => doc().parsed.root, (text) => {
    clearTimeout(qTimer);
    applyQuery(text);
  });
  query.addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = window.setTimeout(() => applyQuery(query.value), 250);
  });
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.defaultPrevented) {
      clearTimeout(qTimer);
      suggest.close();
      applyQuery(query.value);
    }
  });
  const queryStatus = h('span', { class: 'jv-status' });
  const clearQuery = button('✕', 'Clear the query', () => {
    query.value = '';
    applyQuery('');
  }, 'jv-clear');

  const searchIn = h('input', { type: 'text', class: 'jv-input', placeholder: 'Find in keys and values', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Find', title: 'Enter: next match · Shift+Enter: previous' }) as HTMLInputElement;
  searchIn.value = d.search;
  let sTimer = 0;
  searchIn.addEventListener('input', () => {
    clearTimeout(sTimer);
    sTimer = window.setTimeout(() => {
      doc().search = searchIn.value;
      runSearch();
    }, 150);
  });
  searchIn.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (searchIn.value !== doc().search) {
      clearTimeout(sTimer);
      doc().search = searchIn.value;
      runSearch();
    } else nextMatch(e.shiftKey ? -1 : 1);
  });
  const searchStatus = h('span', { class: 'jv-status' });
  const filter = h('input', { type: 'checkbox' }) as HTMLInputElement;
  filter.checked = d.filter;
  filter.onchange = () => {
    doc().filter = filter.checked;
    if (doc().mode !== 'tree') setMode('tree');
    computeMatches();
    flatten();
    renderMain();
    U?.tree.reveal(V.selIdx, true);
  };

  const depth = h('div', { class: 'jv-seg', role: 'group', 'aria-label': 'Open levels' },
    ...[1, 2, 3].map((n) => button(String(n), `Open ${n} level${n > 1 ? 's' : ''}`, () => setDepth(n), 'jv-mode')),
    button('All', 'Open everything', () => setDepth(Infinity), 'jv-mode'),
    button('None', 'Close everything', () => setDepth(0), 'jv-mode'));

  const tools = h('div', { class: 'jv-tools' },
    h('div', { class: 'jv-seg', role: 'group', 'aria-label': 'View' }, modes.tree, modes.table, modes.raw),
    h('div', { class: 'jv-field jv-query' }, h('span', { class: 'jv-label' }, 'Path'), query, clearQuery, suggest.el),
    queryStatus,
    h('div', { class: 'jv-field jv-search' }, searchIn,
      button('↑', 'Previous match (Shift+Enter)', () => nextMatch(-1), 'jv-clear'),
      button('↓', 'Next match (Enter)', () => nextMatch(1), 'jv-clear')),
    searchStatus,
    h('label', { class: 'check', title: 'Hide branches without a match' }, filter, ' Only matching'),
    h('div', { class: 'jv-depth' }, h('span', { class: 'jv-label' }, 'Open'), depth));
  if (!ok) for (const el of tools.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, .jv-depth button, .jv-clear')) el.disabled = true;

  const tree = new VList('jv-list jv-tree', TREE_ROW_H, treeRow);
  tree.el.setAttribute('role', 'tree');
  tree.el.setAttribute('aria-label', 'JSON tree');
  tree.el.addEventListener('keydown', onTreeKey);
  tree.el.addEventListener('mousedown', (e) => {
    if (e.detail > 1) e.preventDefault(); // no word selection on double-click
  });
  tree.el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const rowEl = t.closest<HTMLElement>('.jv-row');
    if (!rowEl) return;
    const i = Number(rowEl.dataset.i);
    if (t.closest('.jv-tw')) {
      toggle(i);
      selectRow(i);
    } else selectRow(i);
  });
  tree.el.addEventListener('dblclick', (e) => {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('.jv-row');
    if (rowEl && !(e.target as HTMLElement).closest('.jv-tw')) toggle(Number(rowEl.dataset.i));
  });

  const main = h('div', { class: 'jv-main' });
  const side = h('aside', { class: 'jv-side', 'aria-label': 'Selected value' });
  U = { main, side, tree, query, queryStatus, search: searchIn, searchStatus, filter, modes };
  rootEl().replaceChildren(head, ...bannerFor(d), tools, h('div', { class: 'jv-body' }, main, side));
  syncModeButtons();
}

function showDoc(): void {
  const d = doc();
  renderShell();
  if (d.parsed.root) {
    computeMatches();
    flatten();
  } else {
    V.rows = [];
    V.matches = [];
    V.hits = new Set();
    V.ancestors = new Set();
  }
  renderMain();
  renderSide();
  renderQueryStatus();
  renderSearchStatus();
  focusMain();
  if (d.mode === 'tree') requestAnimationFrame(() => U?.tree.reveal(V.selIdx, true));
}

function focusMain(): void {
  const el = U?.main.querySelector<HTMLElement>('.jv-list, .jv-raw');
  el?.focus({ preventScroll: true });
}

function pushDoc(src: JsonSource): void {
  V.stack.push(newDoc(src));
  showDoc();
}

/** Back: to the document this one was opened from, else to the timeline. */
function back_(): void {
  if (V.stack.length > 1) {
    V.stack.pop();
    showDoc();
  } else closeJsonViewer();
}

// ── Public ──────────────────────────────────────────────

export function jsonViewerOpen(): boolean {
  return V.open;
}

export function openJsonViewer(src: JsonSource): void {
  V.stack = [newDoc(src)];
  if (!V.open) {
    V.open = true;
    V.returnFocus = document.activeElement;
    V.returnHash = location.hash === '#json' ? '' : location.hash;
    rootEl().hidden = false;
    document.body.classList.add('json-open');
    if (location.hash !== '#json') history.replaceState(null, '', '#json');
    onToggle(true);
  }
  showDoc();
}

export function closeJsonViewer(): void {
  if (!V.open) return;
  V.open = false;
  V.stack = [];
  V.rows = [];
  V.matches = [];
  V.hits = new Set();
  V.ancestors = new Set();
  V.table = null;
  U = null;
  rootEl().hidden = true;
  rootEl().replaceChildren();
  document.body.classList.remove('json-open');
  if (location.hash === '#json') history.replaceState(null, '', location.pathname + location.search + V.returnHash);
  onToggle(false);
  if (V.returnFocus instanceof HTMLElement && V.returnFocus.isConnected) V.returnFocus.focus({ preventScroll: true });
}

export function initJsonViewer(opts: { onToggle: (open: boolean) => void }): void {
  onToggle = opts.onToggle;
  // The payload lives only in memory, so a reload or a typed #json cannot bring it back: drop it.
  const dropHash = () => history.replaceState(null, '', location.pathname + location.search);
  if (location.hash === '#json') dropHash();
  window.addEventListener('hashchange', () => {
    if (V.open && location.hash !== '#json') closeJsonViewer();
    else if (!V.open && location.hash === '#json') dropHash();
  });

  document.addEventListener('keydown', (e) => {
    if (!V.open || document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    const typing = t.matches('input, textarea, select');
    if (e.key === 'Escape') {
      e.preventDefault();
      // The timeline's own Escape (close the detail panel) must not also run once this closes.
      e.stopImmediatePropagation();
      if (closeSuggestions()) return;
      if (typing) {
        t.blur();
        focusMain();
      } else back_();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      U?.search.focus();
      U?.search.select();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      U?.search.focus();
      U?.search.select();
    } else if (e.key === 'n' || e.key === 'N') {
      nextMatch(e.key === 'n' ? 1 : -1);
    }
  }, true);
}
