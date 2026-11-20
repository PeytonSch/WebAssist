// Full-window XML viewer, made for SOAP: a tree of elements with their attributes and text, a
// table for repeated elements and the pretty-printed text, with search, an XPath box and the
// selected node's XPath. It knows a SOAP envelope: it opens at the Body's payload, names the
// operation, and puts a Fault's code and reason on top. Opened from the same places as the JSON
// viewer when the body is XML, and built like it (#xml, the jv-* styles, viewerkit.ts): only
// the rows in view have DOM, and everything shown is captured, untrusted text that reaches the
// DOM through textContent (`h`), never HTML. The parser (xmlmodel.ts) loads nothing.

import { $, fmtBytes, h } from './dom';
import { highlight, paint } from './highlight';
import { plural, QueryError } from './jsonmodel';
import { button, copyButton, download, IS_MAC, markText, QUERY_KEY, suggestList, VList } from './viewerkit';
import {
  canFormat, canTable, cellOf, cellText, describe, faultSummary, findTable, isEl, isLeaf, namespacesInScope, nestedKind, nsDecls, parseXml, plainAttrs, preview, search,
  serialize, serializeCapped, serializeDocument, soapInfo, tableOf, tableOfRows, textOf, xpathOf,
  type Match, type SoapInfo, type XAttr, type XEl, type XmlParse, type XNode, type XTable,
} from './xmlmodel';
import { completions, nestedFallback, runXPath } from './xmlquery';

export interface XmlSource {
  /** What it is: "Response body", "Log message"… */
  title: string;
  /** Shown after the title, e.g. ["POST /ws/orders", "200", "12.4 kB"]. */
  meta: string[];
  text: string;
  /** Suggested name for Download. */
  fileName: string;
  /** Set when the capture cut the body off at its size limit (bytes). */
  truncated?: { captured: number; total: number } | null;
}

/** For a viewer opened on top of another screen's viewer. */
export interface OverOptions {
  /** What Back returns to, e.g. "Response body". */
  backTo?: string;
  onClose?: () => void;
}

type Mode = 'tree' | 'table' | 'raw';

/** One visible line of the tree. */
interface Row {
  node: XNode;
  parent: Row | null;
  depth: number;
  top: number;
}

interface Doc {
  src: XmlSource;
  parsed: XmlParse;
  soap: SoapInfo | null;
  mode: Mode;
  expanded: WeakSet<XEl>;
  query: string;
  queryError: QueryError | null;
  /** Set when the query found nothing from the top and is shown at any depth instead. */
  queryNested: string | null;
  /** The roots of the tree: the root element, or the results of the XPath. */
  tops: XNode[];
  sel: XNode | null;
  search: string;
  filter: boolean;
  /** The element shown as a table, when the user picked one; otherwise it is worked out. */
  table: XEl | null;
  sort: { col: string; dir: 1 | -1 } | null;
  /** Raw shows (and Copy all and Download give) the text as captured, not pretty-printed. */
  captured: boolean;
}

const TREE_ROW_H = 22;
const TABLE_ROW_H = 26;
/** Text longer than this is cut short in the tree; all of it is in the side panel. */
const ROW_TEXT_MAX = 300;
const ROW_ATTR_MAX = 80;
/** Attributes shown on a row; the rest are in the side panel. */
const ROW_ATTRS = 6;
/** The side panel shows at most this much of a selected node. */
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
  hits: new Set<XNode>(),
  ancestors: new Set<XNode>(),
  table: null as null | { t: XTable; order: number[]; where: string },
  tableSel: -1,
  returnFocus: null as Element | null,
  returnHash: '',
  over: {} as OverOptions,
};

let onToggle: (open: boolean) => void = () => undefined;
/** Opens JSON found in a text, on top of this viewer; set by whoever has the JSON viewer. */
let jsonOpener: ((src: XmlSource, opts: OverOptions) => void) | null = null;
const doc = () => V.stack[V.stack.length - 1];
const rootEl = () => $('xml');

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

let closeSuggestions: () => boolean = () => false;

// ── Small helpers ───────────────────────────────────────

const marked = (text: string) => markText(text, V.needle);
const filtering = () => doc().filter && V.needle !== '';
/** Whether a node has rows of its own under it: an element that holds more than text. */
const hasRows = (n: XNode): n is XEl => n.t === 'el' && !isLeaf(n);
const count = (n: number) => n.toLocaleString('en-US');
/** Line breaks would break the row; show where they are instead. */
const oneLine = (v: string) => v.replace(/\r?\n[ \t]*/g, '↵ ').replace(/\t/g, ' ');
const safeName = (v: string) => v.replace(/[^\w.-]+/g, '_');

const nestedCache = new WeakMap<XNode, 'xml' | 'json' | null>();
/** Whether a leaf's text (or an attribute or text node) is a whole XML or JSON document itself. */
function nestedOf(n: XNode): 'xml' | 'json' | null {
  if (n.t === 'comment' || n.t === 'pi' || (n.t === 'el' && (!isLeaf(n) || !n.kids.length))) return null;
  let kind = nestedCache.get(n);
  if (kind === undefined) {
    kind = nestedKind(textOf(n));
    nestedCache.set(n, kind);
  }
  return kind;
}

function nodeLabel(n: XNode): string {
  return n.t === 'el' ? n.name : n.t === 'attr' ? `@${n.name}` : n.t === 'text' ? 'the text' : n.t === 'comment' ? 'the comment' : n.target;
}

/** Opens what a text holds in its own view: XML here, JSON in the JSON viewer on top. */
function openNested(n: XNode): void {
  const d = doc();
  const kind = nestedOf(n);
  if (!kind) return;
  const src: XmlSource = {
    title: `${kind === 'xml' ? 'XML' : 'JSON'} in ${nodeLabel(n)}`,
    meta: [d.src.title],
    text: textOf(n).trim(),
    fileName: `${d.src.fileName.replace(/\.xml$/, '')}-${safeName(n.t === 'el' || n.t === 'attr' ? n.local : 'text')}.${kind}`,
  };
  if (kind === 'xml') return pushDoc(src);
  if (!jsonOpener || !canOpenJson()) return;
  // This screen stays as it is underneath, and comes back when the JSON viewer closes.
  rootEl().hidden = true;
  jsonOpener(src, {
    backTo: d.src.title,
    onClose: () => {
      if (!V.open) return;
      rootEl().hidden = false;
      focusMain();
    },
  });
}

// ── Documents ───────────────────────────────────────────

function newDoc(src: XmlSource): Doc {
  const parsed = parseXml(src.text);
  const d: Doc = {
    src, parsed, soap: soapInfo(parsed.root), mode: parsed.root ? 'tree' : 'raw', expanded: new WeakSet(), query: '', queryError: null, queryNested: null,
    tops: parsed.root ? [parsed.root] : [], sel: null, search: '', filter: false, table: null, sort: null, captured: false,
  };
  if (parsed.root) {
    autoExpand(d);
    // A SOAP message opens at what it carries: the operation's element, or the Fault.
    d.sel = d.soap?.payload ?? d.soap?.body ?? parsed.root;
  }
  return d;
}

/** How many rows `node` would add with `depth` levels open below it (stops counting past `cap`). */
function countTo(node: XEl, depth: number, cap: number): number {
  let level: XEl[] = [node];
  let total = 1;
  for (let dep = 0; dep < depth && level.length && total <= cap; dep++) {
    const next: XEl[] = [];
    for (const n of level) {
      if (!hasRows(n)) continue;
      total += n.kids.length;
      for (const k of n.kids) if (k.t === 'el') next.push(k);
      if (total > cap) break;
    }
    level = next;
  }
  return total;
}

/** Opens `depth` levels below `node` (1 = its own children). */
function openLevels(d: Doc, node: XNode, depth: number): void {
  let level: XNode[] = [node];
  for (let dep = 0; dep < depth && level.length; dep++) {
    const next: XNode[] = [];
    for (const n of level) {
      if (!hasRows(n)) continue;
      d.expanded.add(n);
      for (const k of n.kids) if (hasRows(k)) next.push(k);
    }
    level = next;
  }
}

/** As many levels of `node` as fit in a screenful or two. */
function openWhatFits(d: Doc, node: XNode, most: number): void {
  if (!hasRows(node)) return;
  let depth = 1;
  for (let dep = 2; dep <= most && countTo(node, dep, 300) <= 300; dep++) depth = dep;
  openLevels(d, node, depth);
}

/**
 * The first view. A SOAP envelope opens straight to its Body's payload, with the Header left
 * closed (it is usually security tokens and addressing); other documents open their first
 * levels, as the JSON viewer does.
 */
function autoExpand(d: Doc): void {
  if (d.tops.length !== 1) return;
  const top = d.tops[0];
  const s = d.soap;
  if (s && top === s.envelope && s.body) {
    d.expanded.add(s.envelope);
    d.expanded.add(s.body);
    if (s.payload) openWhatFits(d, s.payload, 4);
    return;
  }
  openWhatFits(d, top, 3);
}

// ── Tree ────────────────────────────────────────────────

function flatten(): void {
  const d = doc();
  const rows: Row[] = [];
  const only = filtering();
  d.tops.forEach((t, ti) => {
    if (only && !V.hits.has(t) && !V.ancestors.has(t)) return;
    const row: Row = { node: t, parent: null, depth: 0, top: ti };
    rows.push(row);
    if (hasRows(t) && d.expanded.has(t)) addChildren(row, rows);
  });
  V.rows = rows;
  V.selIdx = findSel();
}

function addChildren(row: Row, out: Row[]): void {
  const d = doc();
  const filter = filtering();
  // Rows in document order from a work list, not recursion: a document can nest deeper than the
  // call stack goes, and All opens every level.
  const work: Row[] = [row];
  while (work.length) {
    const r = work.pop()!;
    if (r !== row) out.push(r);
    if (r !== row && !(hasRows(r.node) && d.expanded.has(r.node))) continue;
    const n = r.node as XEl;
    // With "Only matching", a branch shows just the children that lead to a match, unless the
    // branch itself matched (by its name or an attribute), in which case all of it is relevant.
    const only = filter && !V.hits.has(n);
    const kids: Row[] = [];
    for (const child of n.kids) {
      if (only && !V.hits.has(child) && !V.ancestors.has(child)) continue;
      kids.push({ node: child, parent: r, depth: r.depth + 1, top: r.top });
    }
    for (let k = kids.length - 1; k >= 0; k--) work.push(kids[k]);
  }
}

function findSel(): number {
  const s = doc().sel;
  if (!s) return -1;
  for (let i = 0; i < V.rows.length; i++) if (V.rows[i].node === s) return i;
  return -1;
}

const cutBadge = () => h('span', { class: 'jv-badge cut', title: 'The captured text ends inside this, so it is incomplete' }, 'cut off');

/** A name with its prefix dimmed; the namespace is the tooltip. */
function nameParts(n: XEl | XAttr, cls: string): HTMLElement {
  const el = h('span', { class: cls, title: n.ns ? `${n.t === 'el' && !n.prefix ? 'Default namespace' : 'Namespace'}: ${n.ns}` : undefined });
  if (n.prefix) el.append(h('span', { class: 'xv-prefix' }, ...marked(`${n.prefix}:`)));
  el.append(...marked(n.local));
  return el;
}

function textSpan(v: string, cls: string): HTMLElement[] {
  const flat = oneLine(v.trim());
  const shown = flat.length > ROW_TEXT_MAX ? flat.slice(0, ROW_TEXT_MAX) : flat;
  const out = [h('span', { class: cls }, ...marked(shown))];
  if (flat.length > ROW_TEXT_MAX) out.push(h('span', { class: 'jv-more', title: 'The whole text is in the side panel' }, `+${count(flat.length - ROW_TEXT_MAX)} chars`));
  return out;
}

/** Not from a viewer that is itself on top of another: Back has one place to return to. */
const canOpenJson = () => !!jsonOpener && !V.over.onClose;

function nestedBadge(n: XNode): HTMLElement | null {
  const kind = nestedOf(n);
  if (!kind || (kind === 'json' && !canOpenJson())) return null;
  return h('button', { class: 'jv-chip xv-nested', type: 'button', title: `This text is ${kind === 'xml' ? 'an XML' : 'a JSON'} document: open it in its own view (Esc comes back)` }, kind === 'xml' ? 'XML ↗' : 'JSON ↗');
}

function treeRow(i: number): HTMLElement {
  const d = doc();
  const r = V.rows[i];
  const n = r.node;
  const el = h('div', { class: 'jv-row', 'data-i': String(i) });
  // Past 32 levels rows stop moving right, so their text stays in view; real payloads rarely nest that deep.
  el.style.paddingLeft = `${6 + Math.min(r.depth, 32) * 16}px`;
  if (i === V.selIdx) el.classList.add('sel');
  if (V.hits.has(n)) el.classList.add('hit');
  const m = V.matches[V.cur];
  if (m && m.node === n && m.top === r.top) el.classList.add('cur');

  const open = hasRows(n) && d.expanded.has(n);
  el.append(h('span', { class: `jv-tw${hasRows(n) ? (open ? ' open' : ' closed') : ''}`, 'aria-hidden': 'true' }));
  // Several results: numbered, with the path of each on hover.
  if (!r.parent && d.tops.length > 1) el.append(h('span', { class: 'jv-idx xv-result', title: xpathOf(n) }, String(r.top + 1)));

  switch (n.t) {
    case 'el': el.append(...elementParts(n, open, d)); break;
    case 'attr':
      el.append(nameParts(n, 'xv-attr'), h('span', { class: 'xv-eq' }, '='), ...textSpan(`"${n.value}"`, 'jv-val xv-aval'));
      break;
    case 'text':
      el.append(h('span', { class: 'xv-kind' }, n.cdata ? 'CDATA' : 'text'), ...textSpan(n.v, 'jv-val xv-text'));
      if (n.cut) el.append(cutBadge());
      break;
    case 'comment':
      el.append(...textSpan(`<!--${n.v}-->`, 'jv-val xv-comment'));
      if (n.cut) el.append(cutBadge());
      break;
    case 'pi':
      el.append(...textSpan(`<?${n.target}${n.v ? ' ' + n.v : ''}?>`, 'jv-val xv-comment'));
      break;
  }
  if (n.t !== 'el') {
    const badge = nestedBadge(n);
    if (badge) el.append(badge);
  }
  return el;
}

function elementParts(n: XEl, open: boolean, d: Doc): HTMLElement[] {
  const s = d.soap;
  const parts: HTMLElement[] = [];
  const isFault = !!s?.fault && s.fault.el === n;
  // The envelope's own elements are structure, not content: shown quieter.
  const frame = !!s && (n === s.envelope || n === s.header || n === s.body);
  parts.push(nameParts(n, `xv-name${frame ? ' frame' : ''}${isFault ? ' fault' : ''}`));

  const attrs = plainAttrs(n);
  for (const a of attrs.slice(0, ROW_ATTRS)) {
    const v = oneLine(a.value);
    parts.push(h('span', { class: 'xv-attrpair' },
      nameParts(a, 'xv-attr'), h('span', { class: 'xv-eq' }, '='),
      h('span', { class: 'xv-aval', title: v.length > ROW_ATTR_MAX ? a.value.slice(0, 2000) : undefined }, ...marked(`"${v.length > ROW_ATTR_MAX ? v.slice(0, ROW_ATTR_MAX) + '…' : v}"`))));
  }
  if (attrs.length > ROW_ATTRS) parts.push(h('span', { class: 'jv-more', title: 'All attributes are in the side panel' }, `+${attrs.length - ROW_ATTRS} attributes`));
  // Namespace declarations would bury the content: a count here, the list in the side panel.
  const decls = nsDecls(n);
  if (decls.length) {
    parts.push(h('span', { class: 'xv-ns', title: decls.map((a) => `${a.name}="${a.value}"`).join('\n') }, decls.length === 1 ? 'xmlns' : `xmlns ×${decls.length}`));
  }

  if (isFault) parts.push(h('span', { class: 'jv-badge xv-faultbadge' }, 'Fault'));
  else if (s && n === s.payload) parts.push(h('span', { class: 'jv-badge xv-op', title: 'The first element in the SOAP Body: the operation\'s request or response' }, 'operation'));

  if (!n.kids.length) {
    parts.push(h('span', { class: 'xv-empty' }, 'empty'));
  } else if (isLeaf(n)) {
    const text = textOf(n);
    if (n.kids.some((k) => k.t === 'text' && k.cdata)) parts.push(h('span', { class: 'xv-kind' }, 'CDATA'));
    if (text.trim() === '') parts.push(h('span', { class: 'xv-empty' }, 'white space'));
    else parts.push(...textSpan(text, 'jv-val xv-text'));
    const badge = nestedBadge(n);
    if (badge) parts.push(badge);
  } else {
    const kids = n.kids.length;
    parts.push(h('span', { class: 'jv-count' }, `${count(kids)} ${kids === 1 ? 'child' : 'children'}`));
    if (!open) parts.push(h('span', { class: 'jv-prev' }, preview(n, 120)));
  }
  if (n.cut) parts.push(cutBadge());
  return parts;
}

function selectRow(i: number, center = false): void {
  if (!V.rows.length) return;
  i = Math.max(0, Math.min(V.rows.length - 1, i));
  // Holding an arrow key at the first or last row should not redo the side panel each time.
  if (i === V.selIdx && doc().sel === V.rows[i].node) {
    U?.tree.reveal(i, center);
    return;
  }
  V.selIdx = i;
  doc().sel = V.rows[i].node;
  U?.tree.reveal(i, center);
  U?.tree.render();
  scheduleSide();
}

/** Opens or closes the element on row `i`, splicing its rows in or out. */
function toggle(i: number, open?: boolean): void {
  const d = doc();
  const r = V.rows[i];
  if (!r || !hasRows(r.node)) return;
  const isOpen = d.expanded.has(r.node);
  const want = open ?? !isOpen;
  if (want === isOpen) return;
  if (want) d.expanded.add(r.node);
  else d.expanded.delete(r.node);
  if (d.tops.length > 1) {
    // Results can hold each other (//* returns parents and children), so rebuild every row.
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
  if (!r || !hasRows(r.node)) return;
  openLevels(doc(), r.node, Infinity);
  flatten();
  U?.tree.setCount(V.rows.length);
}

function setDepth(depth: number): void {
  const d = doc();
  d.expanded = new WeakSet();
  for (const t of d.tops) openLevels(d, t, depth);
  flatten();
  if (d.mode !== 'tree') setMode('tree');
  else renderMain();
  U?.tree.reveal(V.selIdx);
}

/** Opens the elements above the selection so it has a row; an attribute shows as its element. */
function revealSel(): void {
  const d = doc();
  if (!d.sel || findSel() >= 0) return;
  const tops = new Set(d.tops);
  if (d.sel.t === 'attr' && !tops.has(d.sel)) d.sel = d.sel.parent;
  // A leaf's own text is on the leaf's row.
  if (d.sel.t === 'text' && d.sel.parent && isLeaf(d.sel.parent) && !tops.has(d.sel)) d.sel = d.sel.parent;
  const chain: XEl[] = [];
  let x: XNode | null = d.sel;
  for (; x && !tops.has(x); x = x.parent) if (x !== d.sel && x.t === 'el') chain.push(x);
  if (!x) return;
  if (x !== d.sel && x.t === 'el') chain.push(x);
  for (const el of chain) d.expanded.add(el);
  flatten();
}

/** Selects `node` in the tree, opening what is above it and `depth` levels below it. */
function goTo(node: XNode, depth = 0): void {
  const d = doc();
  // Outside the XPath's results: back to the whole document.
  let x: XNode | null = node;
  while (x && !d.tops.includes(x)) x = x.parent;
  if (!x && U) {
    U.query.value = '';
    applyQuery('');
  }
  d.sel = node;
  if (depth) openLevels(d, node, depth);
  if (d.mode !== 'tree') {
    d.mode = 'tree';
    syncModeButtons();
  }
  revealSel();
  flatten();
  renderMain();
  U?.tree.reveal(V.selIdx, true);
  renderSide();
  focusMain();
}

/** What Ctrl+C copies: the text of a value, the XML of an element that holds more. */
function copyValue(n: XNode): string {
  return hasRows(n) || n.t === 'comment' || n.t === 'pi' ? serialize(n) : textOf(n);
}

function onTreeKey(e: KeyboardEvent): void {
  const i = V.selIdx;
  const r = V.rows[i];
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    const s = doc().sel;
    if (String(getSelection() ?? '') === '' && s) {
      e.preventDefault();
      void navigator.clipboard.writeText(copyValue(s)).catch(() => undefined);
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const page = U?.tree.pageRows() ?? 10;
  const d = doc();
  switch (e.key) {
    case 'ArrowDown': selectRow(i < 0 ? 0 : i + 1); break;
    case 'ArrowUp': selectRow(i < 0 ? 0 : i - 1); break;
    case 'PageDown': selectRow(i + page); break;
    case 'PageUp': selectRow(i - page); break;
    case 'Home': selectRow(0); break;
    case 'End': selectRow(V.rows.length - 1); break;
    case 'ArrowRight':
      if (!r) selectRow(0);
      else if (hasRows(r.node) && !d.expanded.has(r.node)) toggle(i, true);
      else if (hasRows(r.node)) selectRow(i + 1);
      break;
    case 'ArrowLeft':
      if (!r) break;
      if (hasRows(r.node) && d.expanded.has(r.node)) toggle(i, false);
      else if (r.parent) {
        let j = i - 1;
        while (j > 0 && V.rows[j] !== r.parent) j--;
        selectRow(j);
      }
      break;
    case 'Enter':
    case ' ':
      if (r && !hasRows(r.node) && nestedOf(r.node)) openNested(r.node);
      else toggle(i);
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
  const { matches, total } = search(d.tops, d.search);
  V.matches = matches;
  V.total = total;
  V.cur = -1;
  V.hits = new Set(matches.map((m) => m.node));
  V.ancestors = new Set();
  for (const m of matches) for (const a of m.ancestors) V.ancestors.add(a);
  if (filtering()) for (const a of V.ancestors) d.expanded.add(a as XEl);
}

function runSearch(): void {
  computeMatches();
  flatten();
  if (V.matches.length) goMatch(0);
  else renderMain();
  renderSearchStatus();
}

function goMatch(k: number): void {
  const n = V.matches.length;
  if (!n) return;
  const d = doc();
  V.cur = ((k % n) + n) % n;
  const m = V.matches[V.cur];
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
    const more = V.total > V.matches.length ? ` (first ${count(V.matches.length)})` : '';
    el.textContent = `${V.cur >= 0 ? count(V.cur + 1) : '–'} of ${count(V.total)}${more}`;
  }
}

// ── Query ───────────────────────────────────────────────

function applyQuery(expr: string): void {
  const d = doc();
  const root = d.parsed.root;
  if (!root) return;
  d.query = expr;
  try {
    let hits: XNode[] = expr.trim() ? runXPath(d.parsed, expr) : [root];
    d.queryNested = null;
    // "Item/Price" typed at the top when it is further down: show it wherever it is, and say so.
    if (!hits.length) {
      const nested = nestedFallback(d.parsed, expr);
      if (nested) {
        hits = nested.hits;
        d.queryNested = nested.expr;
      }
    }
    d.queryError = null;
    d.tops = hits;
  } catch (e) {
    if (!(e instanceof QueryError)) throw e;
    // Keep showing the last good result while the expression is being typed.
    d.queryError = e;
    renderQueryStatus();
    return;
  }
  d.table = null;
  d.sort = null;
  d.expanded = new WeakSet();
  if (expr.trim()) {
    d.sel = d.tops[0] ?? null;
    if (d.tops.length === 1) openWhatFits(d, d.tops[0], 3);
  } else {
    autoExpand(d);
    d.sel = d.soap?.payload ?? d.soap?.body ?? root;
  }
  computeMatches();
  flatten();
  renderMain();
  if (expr.trim()) U?.tree.el.scrollTo(0, 0);
  else U?.tree.reveal(V.selIdx, true);
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
    const n = d.tops.length === 1 ? '1 result' : `${count(d.tops.length)} results`;
    el.textContent = !d.tops.length ? 'No match' : d.queryNested ? `${n} further down (${d.queryNested})` : n;
    if (!d.tops.length) el.classList.add('error');
    else if (d.queryNested) el.classList.add('nested');
    el.title = d.queryNested ? `Nothing at ${d.query.trim()} from the top, so it is matched at any depth: ${d.queryNested}` : '';
  } else {
    el.textContent = '';
  }
}

/** Shows `node` on its own: its XPath goes in the query box. */
function drill(node: XNode): void {
  if (!U) return;
  const expr = xpathOf(node);
  U.query.value = expr;
  applyQuery(expr);
  setMode('tree');
}

// ── Table ───────────────────────────────────────────────

/** The rows the table shows: the user's pick, the selection, the results, or the first list found. */
function tableTarget(): { t: XTable; where: string; el: XEl | null } | null {
  const d = doc();
  const of = (el: XEl | null) => {
    const t = el && tableOf(el);
    return el && t ? { t, where: xpathOf(el), el } : null;
  };
  if (d.table) return of(d.table);
  const sel = d.sel && d.sel.t === 'el' ? d.sel : null;
  if (d.tops.length > 1) {
    // Several results (//Item): one row each, unless something inside one was picked.
    if (sel && canTable(sel) && !d.tops.includes(sel)) return of(sel);
    const rows = d.tops.filter(isEl);
    return rows.length ? { t: tableOfRows(rows), where: `${plural(rows.length, 'result')} of ${d.query.trim()}`, el: null } : null;
  }
  const top = d.tops[0];
  if (!top || top.t !== 'el') return null;
  return of((sel && findTable(sel)) ?? findTable(top));
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function renderTable(): HTMLElement {
  const d = doc();
  const target = tableTarget();
  if (!target) {
    V.table = null;
    return h('div', { class: 'jv-empty' },
      h('strong', {}, 'Nothing to show as a table here.'),
      h('div', {}, 'Tables show elements that repeat, such as the Item elements of a list. Select their parent in the tree and choose Table, or put a path in the XPath box, e.g. //Item.'));
  }
  const { t, where } = target;
  // Keep this table while rows are selected and sorted; picking a row must not swap the table.
  if (target.el) d.table = target.el;
  const cols = ['#', ...t.columns];
  const order = t.rows.map((_, k) => k);
  if (d.sort && d.sort.col !== '#') {
    const { col, dir } = d.sort;
    const keys = t.rows.map((row) => cellText(cellOf(row, col)));
    order.sort((a, b) => {
      // Missing values stay last whichever way the column is sorted.
      if (!keys[a] || !keys[b]) return keys[a] ? -1 : keys[b] ? 1 : a - b;
      return dir * collator.compare(keys[a], keys[b]) || a - b;
    });
  } else if (d.sort && d.sort.dir < 0) order.reverse();
  V.table = { t, order, where };
  V.tableSel = d.sel ? order.findIndex((k) => t.rows[k] === d.sel) : -1;

  // Fixed column widths from a sample of the content, so rows can be created on demand.
  const sample = order.slice(0, 300);
  const widths = cols.map((c, ci) => {
    let len = c.length + 2;
    if (ci === 0) len = Math.max(len, String(t.rows.length).length);
    else for (const k of sample) len = Math.max(len, cellText(cellOf(t.rows[k], c)).length);
    return Math.round(Math.min(Math.max(len, 3), 48) * 7.3 + 22);
  });
  const total = widths.reduce((a, b) => a + b, 0);

  const head = h('div', { class: 'jv-thead' });
  head.style.width = `${total}px`;
  cols.forEach((c, ci) => {
    const sorted = d.sort?.col === c ? d.sort.dir : 0;
    const th = button(h('span', {}, c, sorted ? (sorted > 0 ? ' ▲' : ' ▼') : ''), `Sort by ${c}`, () => {
      // Click cycles ascending, descending, unsorted.
      d.sort = sorted === 0 ? { col: c, dir: 1 } : sorted > 0 ? { col: c, dir: -1 } : null;
      renderMain();
    }, `jv-th${sorted ? ' sorted' : ''}`);
    th.style.width = `${widths[ci]}px`;
    head.append(th);
  });

  const list = new VList('jv-list jv-table', TABLE_ROW_H, (i) => {
    const k = order[i];
    const row = t.rows[k];
    const tr = h('div', { class: `jv-tr${i === V.tableSel ? ' sel' : ''}`, 'data-i': String(i) });
    tr.style.width = `${total}px`;
    cols.forEach((c, ci) => {
      const td = h('div', { class: 'jv-td' });
      td.style.width = `${widths[ci]}px`;
      if (ci === 0) {
        td.classList.add('label');
        td.textContent = String(k + 1);
      } else {
        const n = cellOf(row, c);
        if (n && n.t === 'el' && !isLeaf(n) && n !== row) {
          // What is inside, on one line; the XML on hover; a click opens it.
          const pretty = serializeCapped(n, 2, 1500);
          td.classList.add('nested');
          td.append(button(cellText(n), `${xpathOf(n)} (click to open)\n\n${pretty.text}${pretty.cut ? '\n…' : ''}`, () => drill(n), 'jv-cellpreview'));
        } else if (n) {
          const text = cellText(n);
          td.classList.add(c[0] === '@' ? 'xv-aval' : 'xv-text');
          td.append(...marked(text));
          td.title = text.length > 40 ? textOf(n, 2000) : '';
        }
        if (n && n.t === 'el' && n.cut) td.append(cutBadge());
      }
      tr.append(td);
    });
    return tr;
  }, head);
  list.el.addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('.jv-tr');
    if (tr && !(e.target as HTMLElement).closest('.jv-cellpreview')) selectTableRow(Number(tr.dataset.i), list);
  });
  list.el.addEventListener('dblclick', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('.jv-tr');
    if (tr && !(e.target as HTMLElement).closest('.jv-cellpreview')) drill(t.rows[order[Number(tr.dataset.i)]]);
  });
  list.el.addEventListener('keydown', (e) => {
    const page = list.pageRows();
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    if (e.key in moves) selectTableRow(Math.max(0, V.tableSel) + moves[e.key], list);
    else if (e.key === 'Home') selectTableRow(0, list);
    else if (e.key === 'End') selectTableRow(order.length - 1, list);
    else if (e.key === 'Enter' && V.tableSel >= 0) drill(t.rows[order[V.tableSel]]);
    else return;
    e.preventDefault();
  });

  const info = h('div', { class: 'jv-tinfo' },
    h('code', {}, where), ' · ', plural(t.rows.length, 'row'), ' · ', plural(t.columns.length, 'column'),
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
  doc().sel = tb.t.rows[tb.order[i]];
  list.reveal(i);
  list.render();
  scheduleSide();
}

// ── Raw ─────────────────────────────────────────────────

/** Whether the document can be pretty-printed without changing what it says. */
const clean = (d: Doc) => !!d.parsed.root && !d.parsed.partial && !d.parsed.error;

/** Past this many characters Raw draws only the lines in view, each on one line. */
const RAW_PRE_MAX = 300_000;
const RAW_LINE_H = 20;
/** A longer line is cut short: a body sent on one line can be megabytes wide. */
const RAW_LINE_MAX = 4_000;

/** The text as highlighted XML; `mark` is where it stopped being XML. */
function rawText(text: string, mark: { pos: number; line: number; col: number; message: string } | null): HTMLElement {
  if (text.length > RAW_PRE_MAX) return rawLines(text, mark);
  const pre = h('pre', { class: 'code jv-raw', tabindex: '0' });
  if (!mark) return paint(pre, highlight(text, 'xml'));
  paint(pre, highlight(text.slice(0, mark.pos), 'xml'));
  const el = h('span', { class: 'jv-errmark', title: mark.message }, mark.pos < text.length ? (text[mark.pos] === '\n' ? '⏎\n' : text[mark.pos]) : '␃');
  pre.append(el, text.slice(mark.pos + 1));
  requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
  return pre;
}

/**
 * A large text, one row per line and only the rows in view: a multi-MB <pre> takes seconds to
 * lay out. Lines do not wrap, and one that is very long shows its start (or the part around
 * the mark).
 */
function rawLines(text: string, mark: { line: number; col: number; message: string } | null): HTMLElement {
  const lines = text.split('\n');
  const digits = String(lines.length).length;
  const list = new VList('jv-list jv-raw xv-lines', RAW_LINE_H, (i) => {
    const line = lines[i];
    const row = h('div', { class: 'xv-line' }, h('span', { class: 'xv-ln' }, String(i + 1).padStart(digits)));
    const marked = mark && mark.line === i + 1 ? mark.col - 1 : -1;
    const from = line.length > RAW_LINE_MAX && marked > RAW_LINE_MAX / 2 ? marked - RAW_LINE_MAX / 2 : 0;
    const shown = line.slice(from, from + RAW_LINE_MAX);
    const code = h('span', {});
    if (from) code.append(h('span', { class: 'jv-more' }, `${count(from)} chars… `));
    if (marked < 0) paint(code, highlight(shown, 'xml'));
    else {
      const at = marked - from;
      paint(code, highlight(shown.slice(0, at), 'xml'));
      code.append(h('span', { class: 'jv-errmark', title: mark!.message }, at < shown.length ? shown[at] : '␃'), shown.slice(at + 1));
    }
    row.append(code);
    const rest = line.length - from - shown.length;
    if (rest > 0) row.append(h('span', { class: 'jv-more', title: 'Copy all and Download give the whole text' }, `+${count(rest)} chars`));
    return row;
  });
  requestAnimationFrame(() => {
    list.setCount(lines.length);
    if (mark) list.reveal(mark.line - 1, true);
  });
  return list.el;
}

function renderRaw(): HTMLElement {
  const d = doc();
  const err = d.parsed.error;
  if (err || !d.parsed.root) {
    const text = d.src.text;
    return rawText(text, err ?? { pos: text.length, line: text.split('\n').length, col: text.length - text.lastIndexOf('\n'), message: 'No XML element' });
  }
  // A cut-off document is shown as captured: printing it would add closing tags that never came.
  if (!clean(d)) return rawText(d.src.text, null);
  const whole = d.tops.length === 1 && d.tops[0] === d.parsed.root;
  const pick = (captured: boolean) => button(captured ? 'As captured' : 'Formatted', captured ? 'The text exactly as it was captured' : 'Indented, one element per line', () => {
    d.captured = captured;
    renderMain();
    focusMain();
  }, `jv-mode${d.captured === captured ? ' on' : ''}`);
  // Nested deeper than any real payload: indenting it would only make a huge text.
  const formattable = canFormat(d.parsed);
  const info = h('div', { class: 'jv-tinfo' },
    whole
      ? !formattable ? `The text as captured: it nests ${d.parsed.depth.toLocaleString()} deep, too deep to indent` : d.captured ? 'The text as captured' : 'Pretty-printed'
      : h('code', {}, `${plural(d.tops.length, 'result')} of ${d.query.trim()}`),
    h('span', { class: 'spacer' }),
    whole && formattable ? h('div', { class: 'jv-seg xv-rawpick', role: 'group', 'aria-label': 'Text' }, pick(false), pick(true)) : null);
  const text = !whole ? resultsText(d.tops) : d.captured || !canFormat(d.parsed) ? d.src.text : serializeDocument(d.parsed).replace(/\n$/, '');
  return h('div', { class: 'jv-tablewrap' }, info, rawText(text, null));
}

/** Past this many characters the Raw view of query results stops: results can overlap (//a in nested a's). */
const RESULTS_TEXT_MAX = 5_000_000;

function resultsText(tops: readonly XNode[]): string {
  const parts: string[] = [];
  let left = RESULTS_TEXT_MAX;
  for (let i = 0; i < tops.length; i++) {
    const { text, cut } = serializeCapped(tops[i], 2, left);
    parts.push(text);
    left -= text.length;
    if (cut || left <= 0) {
      parts.push(`… cut off here: the results go on (${tops.length - i - 1} more). Narrow the XPath to see them.`);
      break;
    }
  }
  return parts.join('\n');
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

const keysHint = () => h('div', { class: 'jv-hint jv-keys' },
  '↑ ↓ move · → ← open and close · * open all below · Ctrl+C copy · / find · P XPath · N next match · Esc back');

function renderSide(): void {
  if (!U) return;
  const d = doc();
  const n = d.sel;
  if (!d.parsed.root) {
    U.side.replaceChildren(h('div', { class: 'jv-hint' }, 'Nothing to select: the text could not be read as XML.'));
    return;
  }
  if (!n) {
    U.side.replaceChildren(h('div', { class: 'jv-hint' }, 'Select an element to see its path.'), keysHint());
    return;
  }
  const path = xpathOf(n);
  const loose = xpathOf(n, true);
  const pathRow = (label: string, text: string, title: string, labelTitle?: string) =>
    [h('span', { class: 'jv-plabel', title: labelTitle }, label), h('code', {}, text), copyButton('Copy', title, () => text)];

  const el = n.t === 'el' ? n : null;
  const text = n.t === 'el' ? (n.kids.some((k) => k.t === 'text') ? textOf(n) : '') : n.t === 'attr' ? n.value : n.v;
  const nested = nestedOf(n);
  const only = d.tops.length === 1 && d.tops[0] === n;
  const actions = h('div', { class: 'jv-actions' },
    n.t !== 'attr' ? copyButton('Copy XML', 'Copy this as XML, indented', () => serialize(n)) : null,
    text ? copyButton(n.t === 'attr' ? 'Copy value' : 'Copy text', 'Copy the text, with entities such as &lt; decoded (Ctrl+C in the tree)', () => text) : null,
    !only ? button('Show only this', 'Put its XPath in the query box', () => drill(n)) : null,
    el && canTable(el) ? button('Table', 'Show its repeated elements as a table', () => {
      d.table = el;
      d.sort = null;
      setMode('table');
    }) : null,
    nested && (nested === 'xml' || canOpenJson()) ? button(nested === 'xml' ? 'Open as XML' : 'Open as JSON',
      `This text is ${nested === 'xml' ? 'an XML' : 'a JSON'} document: open it in its own view (Esc comes back)`, () => openNested(n), 'btn btn-sm btn-primary') : null);

  const parts: (HTMLElement | null)[] = [
    h('h4', {}, 'Selected'),
    h('div', { class: 'jv-type' }, describe(n)),
    h('div', { class: 'jv-paths' },
      ...pathRow('XPath', path, 'Copy the XPath'),
      ...(loose !== path ? pathRow('Any prefix', loose, 'Copy the XPath that matches by local name', 'The same path without namespace prefixes, for tools where they are not registered') : [])),
    actions,
  ];
  if (n.t !== 'attr' && n.t !== 'el' && n.cut) parts.push(h('div', { class: 'jv-note warn' }, 'Incomplete: the captured text ends inside this.'));
  if (el?.cut) parts.push(h('div', { class: 'jv-note warn' }, 'Incomplete: the captured text ends before this element is closed.'));

  // The namespace of the node, then what the element declares.
  const named = n.t === 'el' || n.t === 'attr' ? n : null;
  if (named && (named.ns || (el && nsDecls(el).length))) {
    parts.push(h('h4', {}, 'Namespace'));
    if (named.ns) parts.push(h('div', { class: 'jv-paths' }, h('span', { class: 'jv-plabel' }, named.prefix || 'default'), h('code', {}, named.ns), copyButton('Copy', 'Copy the namespace', () => named.ns!)));
    if (el) {
      const declared = namespacesInScope(el).filter((x) => x.own);
      if (declared.length) {
        parts.push(h('div', { class: 'jv-note' }, 'Declared on this element:'),
          h('dl', { class: 'xv-attrs' }, ...declared.flatMap((x) => [h('dt', { class: 'xv-prefix' }, x.prefix ? `xmlns:${x.prefix}` : 'xmlns'), h('dd', {}, x.uri)])));
      }
    }
  }
  if (el) {
    const attrs = plainAttrs(el);
    if (attrs.length) {
      parts.push(h('h4', {}, attrs.length === 1 ? 'Attribute' : `${attrs.length} attributes`),
        h('dl', { class: 'xv-attrs' }, ...attrs.flatMap((a) => [h('dt', { class: 'xv-attr', title: a.ns ? `Namespace: ${a.ns}` : undefined }, a.name), h('dd', {}, a.value)])));
    }
  }
  if (text && n.t === 'el') parts.push(h('h4', {}, 'Text'), sideText(text));
  parts.push(h('h4', {}, n.t === 'el' ? 'XML' : 'Value'), n.t === 'el' ? sideXml(n) : sideText(n.t === 'attr' ? n.value : n.v), keysHint());
  U.side.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
}

function sideText(v: string): HTMLElement {
  const pre = h('pre', { class: 'code jv-value' }, v.length > SIDE_VALUE_MAX ? v.slice(0, SIDE_VALUE_MAX) : v);
  if (v.length > SIDE_VALUE_MAX) return h('div', {}, pre, h('div', { class: 'jv-note' }, `Showing the first ${count(SIDE_VALUE_MAX)} characters; Copy text copies all of it.`));
  return pre;
}

function sideXml(n: XEl): HTMLElement {
  // Big elements are only printed as far as the panel shows them.
  const { text, cut } = serializeCapped(n, 2, SIDE_VALUE_MAX);
  const pre = paint(h('pre', { class: 'code jv-value' }), highlight(text, 'xml'));
  if (cut) return h('div', {}, pre, h('div', { class: 'jv-note' }, 'Showing the start of it; Copy XML copies all of it.'));
  return pre;
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
  if (!d.tops.length) {
    U.main.replaceChildren(h('div', { class: 'jv-empty' }, h('strong', {}, 'Nothing at this path.'), h('div', {}, 'Change or clear the XPath to see the document again.')));
    return;
  }
  if (d.mode === 'table') {
    U.main.replaceChildren(renderTable());
    return;
  }
  if (!V.rows.length && filtering()) {
    U.main.replaceChildren(h('div', { class: 'jv-empty' }, h('strong', {}, 'No matches.'), h('div', {}, 'Untick "Only matching" to see everything.')));
    return;
  }
  if (U.tree.el.parentElement !== U.main) U.main.replaceChildren(U.tree.el);
  U.tree.setCount(V.rows.length);
}

function faultBanner(d: Doc): HTMLElement | null {
  const f = d.soap?.fault;
  if (!f) return null;
  const facts: HTMLElement[] = [];
  const fact = (label: string, value: string) => {
    if (value) facts.push(h('span', { class: 'xv-fact' }, h('span', { class: 'xv-factlabel' }, label), value));
  };
  fact(d.soap!.version === '1.2' ? 'Role' : 'Actor', f.actor);
  fact('Node', f.node);
  return h('div', { class: 'jv-banner error xv-fault', role: 'alert' },
    h('div', { class: 'xv-faulthead' },
      h('strong', {}, 'SOAP Fault'),
      ...[f.code, ...f.subcodes].filter(Boolean).map((c, k) => h('code', { class: `xv-code${k ? ' sub' : ''}`, title: k ? 'Subcode' : d.soap!.version === '1.2' ? 'Code' : 'faultcode' }, c)),
      h('span', { class: 'spacer' }),
      f.detail ? button('Show detail', 'Select the fault\'s detail element in the tree', () => goTo(f.detail!, 4)) : null,
      button('Show fault', 'Select the Fault element in the tree', () => goTo(f.el))),
    h('div', { class: 'xv-reason' }, f.reason || 'No reason given.'),
    facts.length ? h('div', { class: 'xv-facts' }, ...facts) : null);
}

function bannerFor(d: Doc): HTMLElement[] {
  const out: HTMLElement[] = [];
  const t = d.src.truncated;
  const cutNote = d.parsed.partial && d.parsed.root ? ' Elements marked "cut off" never closed.' : '';
  if (t) out.push(h('div', { class: 'jv-banner warn' }, `Body was cut off at ${fmtBytes(t.captured)} of ${fmtBytes(t.total)}; showing what was captured.${cutNote}`, h('span', { class: 'muted' }, ' Raise "Body size limit" in Settings to capture more.')));
  else if (d.parsed.partial && d.parsed.root) out.push(h('div', { class: 'jv-banner warn' }, `The XML ends before it is complete; showing what is there.${cutNote}`));
  const e = d.parsed.error;
  if (e) out.push(h('div', { class: 'jv-banner error' }, `Not well-formed XML: ${e.message}, at line ${e.line}, column ${e.col}. Showing the text as captured, with the position marked.`));
  else if (!d.parsed.root) out.push(h('div', { class: 'jv-banner error' }, 'There is no XML element in this text.'));
  const fault = faultBanner(d);
  if (fault) out.push(fault);
  if (d.parsed.root && (d.parsed.doctype || d.parsed.unknownEntities)) {
    out.push(h('div', { class: 'jv-banner info' }, d.parsed.doctype
      ? 'This document has a DOCTYPE. It is not read and nothing it names is loaded, so entities it defines are shown as written (&name;).'
      : 'Entities that XML does not define, such as &nbsp;, are shown as written.'));
  }
  return out;
}

/** Copy all and Download give the pretty-printed XML when it parsed, else the text as captured. */
function exportText(d: Doc): string {
  return clean(d) && !d.captured ? serializeDocument(d.parsed) : d.src.text;
}

/** The chips after the title: the SOAP version and the operation (or Fault). */
function soapChips(d: Doc): HTMLElement[] {
  const s = d.soap;
  if (!s) return [];
  const out = [h('span', { class: 'xv-chip', title: s.version ? `The envelope's namespace is ${s.envelope.ns}` : 'An Envelope with a Header or Body, in a namespace that is not SOAP 1.1 or 1.2' }, s.version ? `SOAP ${s.version}` : 'SOAP')];
  const p = s.payload;
  if (s.fault) {
    out.push(button('Fault', 'The Body holds a SOAP Fault: select it', () => goTo(s.fault!.el), 'xv-chip fault'));
  } else if (p) {
    out.push(button(h('span', {}, p.prefix ? h('span', { class: 'xv-prefix' }, `${p.prefix}:`) : null, p.local),
      `The operation: the first element in the Body${p.ns ? `\nNamespace: ${p.ns}` : ''}\nClick to select it`, () => goTo(p), 'xv-chip op'));
  }
  return out;
}

function renderShell(): void {
  const d = doc();
  const parent = V.stack.length > 1 ? V.stack[V.stack.length - 2] : null;
  const ok = !!d.parsed.root;

  const backTo = parent ? parent.src.title : V.over.backTo;
  const back = button(h('span', {}, '← ', backTo ? `Back to ${backTo.toLowerCase()}` : 'Back to timeline'), 'Back (Esc)', () => back_(), 'btn');
  const meta = [...d.src.meta, ok ? plural(d.parsed.elements, 'element') : ''].filter(Boolean);
  const title = h('div', { class: 'jv-title' }, h('h1', {}, d.src.title), ...soapChips(d), ...meta.map((m) => h('span', { class: 'jv-meta' }, m)));
  const how = clean(d) ? 'pretty-printed (as captured when Raw is set to show it that way)' : 'as captured';
  const copyAll = copyButton('Copy all', `Copy the whole document, ${how}`, () => exportText(d));
  copyAll.className = 'btn';
  const save = button('Download', `Save as ${d.src.fileName}, ${how}`, () => download(exportText(d), d.src.fileName, 'application/xml'), 'btn');
  const head = h('div', { class: 'jv-head' }, back, title, copyAll, save);

  const modes = {
    tree: button('Tree', 'Tree view', () => setMode('tree'), 'jv-mode'),
    table: button('Table', 'Table view for elements that repeat', () => {
      // Work the table out afresh from the current selection or result.
      doc().table = null;
      setMode('table');
    }, 'jv-mode'),
    raw: button('Raw', 'Pretty-printed text', () => setMode('raw'), 'jv-mode'),
  };
  if (!ok) modes.tree.disabled = modes.table.disabled = true;

  const query = h('input', {
    type: 'text', class: 'jv-input', placeholder: "//Item   Body/*   //Item[@id='7']   //Item[Price > 10]/Name", spellcheck: 'false', autocomplete: 'off',
    'aria-label': 'XPath query', 'aria-keyshortcuts': `${IS_MAC ? 'Meta' : 'Control'}+L P`,
    title: `Show only part of the document, with XPath: /a/b, //name at any depth, * for any element, @attr, text(), [2], [last()], [@id='x'], [Price > 10 and Status = 'OPEN'], contains(), starts-with(), not(). A name without a prefix matches in any namespace. Enter to apply.\nShortcut: ${QUERY_KEY} or P`,
  }) as HTMLInputElement;
  query.value = d.query;
  let qTimer = 0;
  const suggest = suggestList(query, 'xv', (text) => completions(doc().parsed, text), (text) => {
    clearTimeout(qTimer);
    applyQuery(text);
  });
  closeSuggestions = suggest.close;
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

  const searchIn = h('input', { type: 'text', class: 'jv-input', placeholder: 'Find in names, attributes and text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Find', title: 'Enter: next match · Shift+Enter: previous' }) as HTMLInputElement;
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

  // The parts of a SOAP message, one click away.
  const s = d.soap;
  const jump = s && ok ? h('div', { class: 'jv-seg', role: 'group', 'aria-label': 'SOAP parts' },
    s.header ? button('Header', s.headers.length ? `Go to the SOAP Header: ${s.headers.map((x) => x.name).join(', ')}` : 'Go to the SOAP Header, which is empty', () => goTo(s.header!, 2), 'jv-mode') : null,
    s.body ? button('Body', 'Go to what the SOAP Body carries', () => goTo(s.payload ?? s.body!), 'jv-mode') : null) : null;

  const tools = h('div', { class: 'jv-tools' },
    h('div', { class: 'jv-seg', role: 'group', 'aria-label': 'View' }, modes.tree, modes.table, modes.raw),
    jump,
    h('div', { class: 'jv-field jv-query' }, h('span', { class: 'jv-label' }, 'XPath'), query, h('kbd', { class: 'jv-key', 'aria-hidden': 'true', title: `${QUERY_KEY} or P` }, QUERY_KEY), clearQuery, suggest.el),
    queryStatus,
    h('div', { class: 'jv-field jv-search' }, searchIn,
      button('↑', 'Previous match (Shift+Enter)', () => nextMatch(-1), 'jv-clear'),
      button('↓', 'Next match (Enter)', () => nextMatch(1), 'jv-clear')),
    searchStatus,
    h('label', { class: 'check', title: 'Hide branches without a match' }, filter, ' Only matching'),
    h('div', { class: 'jv-depth' }, h('span', { class: 'jv-label' }, 'Open'), depth));
  if (!ok) for (const el of tools.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, .jv-depth button, .jv-clear')) el.disabled = true;

  const tree = new VList('jv-list jv-tree xv-tree', TREE_ROW_H, treeRow);
  tree.el.setAttribute('role', 'tree');
  tree.el.setAttribute('aria-label', 'XML tree');
  tree.el.addEventListener('keydown', onTreeKey);
  tree.el.addEventListener('mousedown', (e) => {
    if (e.detail > 1) e.preventDefault(); // no word selection on double-click
  });
  tree.el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const rowEl = t.closest<HTMLElement>('.jv-row');
    if (!rowEl) return;
    const i = Number(rowEl.dataset.i);
    if (t.closest('.jv-tw')) toggle(i);
    selectRow(i);
    if (t.closest('.xv-nested')) openNested(V.rows[i].node);
  });
  tree.el.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    const rowEl = t.closest<HTMLElement>('.jv-row');
    if (rowEl && !t.closest('.jv-tw') && !t.closest('.xv-nested')) toggle(Number(rowEl.dataset.i));
  });

  const main = h('div', { class: 'jv-main' });
  const side = h('aside', { class: 'jv-side', 'aria-label': 'Selected node' });
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

/** Puts the caret in the XPath box, its text selected so typing replaces it. */
function focusQuery(): void {
  if (!U || U.query.disabled) return;
  U.query.focus();
  U.query.select();
}

function focusMain(): void {
  const el = U?.main.querySelector<HTMLElement>('.jv-list, .jv-raw');
  el?.focus({ preventScroll: true });
}

function pushDoc(src: XmlSource): void {
  V.stack.push(newDoc(src));
  showDoc();
}

/** Back: to the document this one was opened from, else to where the viewer was opened. */
function back_(): void {
  if (V.stack.length > 1) {
    V.stack.pop();
    showDoc();
  } else closeXmlViewer();
}

// ── Public ──────────────────────────────────────────────

export function xmlViewerOpen(): boolean {
  return V.open;
}

/** Connects "Open as JSON" for JSON found in a text; without it the button is not shown. */
export function setXmlJsonOpener(fn: ((src: XmlSource, opts: OverOptions) => void) | null): void {
  jsonOpener = fn;
}

export function openXmlViewer(src: XmlSource, over: OverOptions = {}): void {
  V.stack = [newDoc(src)];
  V.over = over;
  if (!V.open) {
    V.open = true;
    V.returnFocus = document.activeElement;
    V.returnHash = location.hash === '#xml' ? '' : location.hash;
    document.body.classList.add('xml-open');
    if (location.hash !== '#xml') history.replaceState(null, '', '#xml');
    onToggle(true);
  }
  rootEl().hidden = false;
  showDoc();
}

export function closeXmlViewer(): void {
  if (!V.open) return;
  const over = V.over;
  V.open = false;
  V.stack = [];
  V.rows = [];
  V.matches = [];
  V.hits = new Set();
  V.ancestors = new Set();
  V.table = null;
  V.over = {};
  U = null;
  rootEl().hidden = true;
  rootEl().replaceChildren();
  document.body.classList.remove('xml-open');
  if (location.hash === '#xml') history.replaceState(null, '', location.pathname + location.search + V.returnHash);
  onToggle(false);
  if (V.returnFocus instanceof HTMLElement && V.returnFocus.isConnected) V.returnFocus.focus({ preventScroll: true });
  over.onClose?.();
}

export function initXmlViewer(opts: { onToggle: (open: boolean) => void }): void {
  onToggle = opts.onToggle;
  // The payload lives only in memory, so a reload or a typed #xml cannot bring it back: drop it.
  const dropHash = () => history.replaceState(null, '', location.pathname + location.search);
  if (location.hash === '#xml') dropHash();
  window.addEventListener('hashchange', () => {
    if (V.open && location.hash !== '#xml') closeXmlViewer();
    else if (!V.open && location.hash === '#xml') dropHash();
  });

  document.addEventListener('keydown', (e) => {
    // Hidden while the JSON viewer, opened from a text in here, is on top with its own keys.
    if (!V.open || rootEl().hidden || document.querySelector('dialog[open]')) return;
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
    // Ctrl+L (⌘L), like a browser's address bar: the XPath box.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      focusQuery();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') {
      e.preventDefault();
      U?.search.focus();
      U?.search.select();
    } else if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      focusQuery();
    } else if (e.key === 'n' || e.key === 'N') {
      nextMatch(e.key === 'n' ? 1 : -1);
    }
  }, true);
}
