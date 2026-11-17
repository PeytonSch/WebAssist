// Suggestions for the JSON viewer's Path box, worked out from the document itself: the keys at
// the place being typed, and keys further down that match, so "price" typed at the top offers
// items[*].price and ..price. Also the fallback that finds a path typed from the wrong level.
// No DOM here, so it can be tested in node.

import { QueryError, runQuery, type Hit, type JNode } from './jsonmodel';

export type SuggestionKind = 'key' | 'index' | 'nested' | 'any-depth';

export interface Suggestion {
  /** The whole Path box text once accepted. */
  text: string;
  /** What the list shows, e.g. "price", "items[*].price", "..price". */
  label: string;
  /** e.g. "number · 12 values", "array · 3 items". */
  detail: string;
  kind: SuggestionKind;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const STAR = Symbol('any index');
type PSeg = string | typeof STAR;

/** Most suggestions shown; the list scrolls past a dozen anyway. */
const MAX_SUGGESTIONS = 40;
/** Context nodes looked at for direct keys; a query like ..* can return many. */
const MAX_CONTEXT = 500;
/** Nodes walked when indexing nested paths. */
const MAX_INDEX_NODES = 300_000;
const MAX_INDEX_DEPTH = 16;

// ── Splitting the text being typed ──────────────────────

export interface Split {
  /** The expression the new step goes after: "", "data", "data.items[*]". */
  context: string;
  /** What is typed of the new step so far. */
  partial: string;
  /** How the new step starts: a bare first name, ".", "..", or "[" (with a quote, if typed). */
  opener: '' | '.' | '..' | '[' | '["' | "['";
}

/**
 * Splits `expr` at the start of the step being typed. Null when the cursor is somewhere a name
 * cannot go: inside a filter, after a closing bracket, or in the middle of an operator.
 */
export function splitForCompletion(expr: string): Split | null {
  let depth = 0;
  let quote: string | null = null;
  let bracketAt = -1;
  let lastDot = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[') {
      if (depth === 0) bracketAt = i;
      depth++;
    } else if (c === ']') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) bracketAt = -1;
    } else if (c === '.' && depth === 0) lastDot = i;
  }

  // Inside an open bracket: items[  items["na  items['na
  if (depth > 0) {
    if (depth > 1 || bracketAt < 0) return null;
    const inner = expr.slice(bracketAt + 1);
    const context = expr.slice(0, bracketAt);
    if (/^\s*$/.test(inner)) return { context, partial: '', opener: '[' };
    const q = /^\s*(["'])((?:\\.|(?!\1).)*)$/.exec(inner);
    if (q) return { context, partial: q[2].replace(/\\(.)/g, '$1'), opener: q[1] === '"' ? '["' : "['" };
    return null; // an index, a slice or a filter
  }
  if (quote) return null;

  const tail = lastDot >= 0 ? expr.slice(lastDot + 1) : expr;
  // Only a plain name can be completed; "]", spaces and operators after the dot cannot.
  if (!/^[^.[\]\s()=!<>&|,'"]*$/.test(tail)) return null;
  if (lastDot < 0) {
    if (tail.startsWith('$')) return tail === '$' ? { context: '$', partial: '', opener: '.' } : null;
    return { context: '', partial: tail, opener: '' };
  }
  if (lastDot > 0 && expr[lastDot - 1] === '.') return { context: expr.slice(0, lastDot - 1), partial: tail, opener: '..' };
  return { context: expr.slice(0, lastDot), partial: tail, opener: '.' };
}

// ── Formatting paths ────────────────────────────────────

/** Appends a key to `context`, as .key, a bare first key, or ["key"] when it needs quotes. */
function appendKey(context: string, key: string): string {
  if (IDENT.test(key)) return context && context !== '$' ? `${context}.${key}` : context === '$' ? `$.${key}` : key;
  return `${context}[${JSON.stringify(key)}]`;
}

function appendSegs(context: string, segs: readonly PSeg[]): string {
  let out = context;
  for (const s of segs) out = s === STAR ? `${out}[*]` : appendKey(out, s);
  return out;
}

/** "..key" or ..["a-b"], after `context`. */
function anyDepth(context: string, key: string): string {
  return IDENT.test(key) ? `${context}..${key}` : `${context}..[${JSON.stringify(key)}]`;
}

// ── Ranking ─────────────────────────────────────────────

/** 0 best; -1 means no match. Exact, then prefix, then the start of a word, then anywhere. */
function score(key: string, partial: string): number {
  if (!partial) return 3;
  const k = key.toLowerCase();
  const p = partial.toLowerCase();
  if (k === p) return 0;
  if (k.startsWith(p)) return 1;
  const at = k.indexOf(p);
  if (at < 0) return -1;
  // Short text inside a word ("me" in "customer") is mostly noise; word starts still count.
  // Word starts: user_name, userName, user-name.
  const before = key[at - 1];
  if (before === '_' || before === '-' || before === '.' || (key[at] >= 'A' && key[at] <= 'Z')) return 2;
  return p.length >= 3 ? 3 : -1;
}

const typeName = (n: JNode) => (n.t === 'obj' ? 'object' : n.t === 'arr' ? 'array' : n.t === 'str' ? 'string' : n.t === 'num' ? 'number' : n.t === 'bool' ? 'boolean' : 'null');

function describeTypes(types: Map<string, number>, count: number): string {
  const names = [...types.keys()];
  const kind = names.length === 1 ? names[0] : names.length === 2 ? names.join(' or ') : 'mixed';
  return count === 1 ? kind : `${kind} · ${count.toLocaleString('en-US')} values`;
}

// ── Context ─────────────────────────────────────────────

/** The nodes `context` points at; null when it is invalid or empty. */
function resolve(root: JNode, context: string): JNode[] | null {
  if (!context || context === '$') return [root];
  try {
    const hits = runQuery(root, context);
    return hits.length ? hits.slice(0, MAX_CONTEXT).map((h) => h.node) : null;
  } catch (e) {
    if (e instanceof QueryError) return null;
    throw e;
  }
}

// ── Nested path index ───────────────────────────────────

interface IndexEntry {
  segs: PSeg[];
  key: string;
  count: number;
  types: Map<string, number>;
}

/** Every distinct path under `nodes`, with array indexes folded into [*]. */
function buildIndex(nodes: readonly JNode[]): IndexEntry[] {
  const byPath = new Map<string, IndexEntry>();
  let visited = 0;
  const visit = (node: JNode, segs: PSeg[], id: string, depth: number) => {
    if (++visited > MAX_INDEX_NODES || depth > MAX_INDEX_DEPTH) return;
    if (node.t === 'obj') {
      for (let i = 0; i < node.keys.length; i++) {
        const key = node.keys[i];
        const child = node.vals[i];
        const childSegs = [...segs, key];
        const childId = `${id}\u0000${key}`;
        let e = byPath.get(childId);
        if (!e) byPath.set(childId, (e = { segs: childSegs, key, count: 0, types: new Map() }));
        e.count++;
        e.types.set(typeName(child), (e.types.get(typeName(child)) ?? 0) + 1);
        visit(child, childSegs, childId, depth + 1);
      }
    } else if (node.t === 'arr') {
      for (const item of node.items) visit(item, [...segs, STAR], `${id}\u0000*`, depth + 1);
    }
  };
  for (const n of nodes) visit(n, [], '', 0);
  return [...byPath.values()];
}

// Indexes are kept per document and context, so typing in the box does not walk it again.
const indexCache = new WeakMap<JNode, Map<string, IndexEntry[]>>();

function indexFor(root: JNode, context: string, nodes: readonly JNode[]): IndexEntry[] {
  let perRoot = indexCache.get(root);
  if (!perRoot) indexCache.set(root, (perRoot = new Map()));
  let idx = perRoot.get(context);
  if (!idx) {
    idx = buildIndex(nodes);
    if (perRoot.size > 50) perRoot.clear();
    perRoot.set(context, idx);
  }
  return idx;
}

// ── Suggestions ─────────────────────────────────────────

/**
 * Suggestions for the Path box text `expr` against the document `root`. When the text is a
 * finished path ("data.customer"), what can follow it: its keys, or [*] and its items' keys.
 */
export function completions(root: JNode, expr: string): Suggestion[] {
  const here = completeStep(root, expr);
  if (here.length || !expr.trim() || /[.[]$/.test(expr)) return here;
  return completeStep(root, `${expr}.`);
}

function completeStep(root: JNode, expr: string): Suggestion[] {
  const split = splitForCompletion(expr);
  if (!split) return [];
  let { context } = split;
  const { partial, opener } = split;
  let nodes = resolve(root, context);
  // "order.to" typed at the top when order is further down: complete under ..order instead.
  if (!nodes && context && context !== '$' && !context.startsWith('.') && !context.startsWith('$') && opener !== '..') {
    const deeper = resolve(root, `..${context}`);
    if (deeper) {
      context = `..${context}`;
      nodes = deeper;
    }
  }
  if (!nodes) return [];

  const out: (Suggestion & { rank: number; order: number })[] = [];
  const seen = new Set<string>();
  const push = (s: Suggestion, rank: number) => {
    if (seen.has(s.text) || s.text === expr) return;
    seen.add(s.text);
    out.push({ ...s, rank, order: out.length });
  };
  const bracket = opener === '[' || opener === '["' || opener === "['";

  if (opener === '..') {
    for (const e of anyDepthKeys(indexFor(root, context, nodes))) {
      const r = score(e.key, partial);
      if (r >= 0) push({ text: anyDepth(context, e.key), label: anyDepth('', e.key), detail: describeTypes(e.types, e.count), kind: 'any-depth' }, r);
    }
    return finish(out);
  }

  // Keys right here, and [*] / [0] for arrays.
  const keys = new Map<string, { count: number; types: Map<string, number> }>();
  const itemKeys = new Map<string, { count: number; types: Map<string, number> }>();
  let arrays = 0;
  let items = 0;
  const tally = (into: typeof keys, key: string, n: JNode) => {
    let e = into.get(key);
    if (!e) into.set(key, (e = { count: 0, types: new Map() }));
    e.count++;
    e.types.set(typeName(n), (e.types.get(typeName(n)) ?? 0) + 1);
  };
  for (const n of nodes) {
    if (n.t === 'obj') n.keys.forEach((k, i) => tally(keys, k, n.vals[i]));
    else if (n.t === 'arr') {
      arrays++;
      items += n.items.length;
      for (const it of n.items.slice(0, 2000)) if (it.t === 'obj') it.keys.forEach((k, i) => tally(itemKeys, k, it.vals[i]));
    }
  }
  for (const [key, e] of keys) {
    const r = score(key, partial);
    if (r < 0) continue;
    const text = bracket ? `${context}[${JSON.stringify(key)}]` : appendKey(context, key);
    push({ text, label: key, detail: describeTypes(e.types, e.count), kind: 'key' }, r);
  }
  if (arrays && !partial && opener !== '["' && opener !== "['") {
    const n = items.toLocaleString('en-US');
    push({ text: `${context}[*]`, label: '[*]', detail: `every item · ${n} item${items === 1 ? '' : 's'}`, kind: 'index' }, 1);
    if (items) push({ text: `${context}[0]`, label: '[0]', detail: 'first item', kind: 'index' }, 2);
    if (items > 1) push({ text: `${context}[-1]`, label: '[-1]', detail: 'last item', kind: 'index' }, 2);
  }
  // An array of objects: its items' keys, as [*].key.
  if (!bracket) {
    for (const [key, e] of itemKeys) {
      const r = score(key, partial);
      if (r >= 0) push({ text: appendKey(`${context}[*]`, key), label: `[*].${key}`, detail: describeTypes(e.types, e.count), kind: 'key' }, r);
    }
  }

  // Further down: paths whose last key matches, and the key at any depth.
  if (partial && !bracket) {
    const idx = indexFor(root, context, nodes);
    const direct = new Set([...keys.keys()]);
    for (const e of idx) {
      if (e.segs.length < 2 || (e.segs.length === 2 && e.segs[0] === STAR)) continue; // listed above
      const r = score(e.key, partial);
      if (r < 0) continue;
      const rel = appendSegs('', e.segs);
      push({ text: appendSegs(context, e.segs), label: rel, detail: describeTypes(e.types, e.count), kind: 'nested' }, r + 0.5);
    }
    for (const e of anyDepthKeys(idx)) {
      const r = score(e.key, partial);
      // Worth offering when the key is not (only) right here.
      if (r >= 0 && (!direct.has(e.key) || e.count > (keys.get(e.key)?.count ?? 0))) {
        // After the concrete paths it covers: those say exactly where the value is.
        push({ text: anyDepth(context, e.key), label: anyDepth('', e.key), detail: describeTypes(e.types, e.count), kind: 'any-depth' }, r + 0.6);
      }
    }
  }
  return finish(out);
}

/** Every key in the index once, with its counts over all the places it appears. */
function anyDepthKeys(idx: readonly IndexEntry[]): IndexEntry[] {
  const byKey = new Map<string, IndexEntry>();
  for (const e of idx) {
    let k = byKey.get(e.key);
    if (!k) byKey.set(e.key, (k = { segs: [e.key], key: e.key, count: 0, types: new Map() }));
    k.count += e.count;
    for (const [t, n] of e.types) k.types.set(t, (k.types.get(t) ?? 0) + n);
  }
  return [...byKey.values()];
}

function finish(list: (Suggestion & { rank: number; order: number })[]): Suggestion[] {
  return list
    .sort((a, b) => a.rank - b.rank || a.label.length - b.label.length || a.order - b.order)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ rank: _r, order: _o, ...s }) => s);
}

// ── Nested fallback ─────────────────────────────────────

/**
 * When a path typed from the top finds nothing, the same path at any depth: "price" finds
 * items[*].price, "order.total" finds data.orders[*].order.total. Null when that finds nothing
 * either, or the path already says where it starts ($, ..) or is not valid.
 */
export function nestedFallback(root: JNode, expr: string): { expr: string; hits: Hit[] } | null {
  const e = expr.trim();
  if (!e || e.startsWith('$') || e.startsWith('.') || e.startsWith('[')) return null;
  try {
    const deeper = `..${e}`;
    const hits = runQuery(root, deeper);
    return hits.length ? { expr: deeper, hits } : null;
  } catch (err) {
    if (err instanceof QueryError) return null;
    throw err;
  }
}
