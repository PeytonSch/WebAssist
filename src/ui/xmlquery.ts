// The XML viewer's XPath box: a subset of XPath 1.0, parsed and walked here (nothing is ever
// passed to document.evaluate, eval or new Function), and the suggestions for it. No DOM.
//
//   /soap:Envelope/soap:Body/m:Order      Body/*           //Item            //Item[2]/@id
//   //Item[last()]        //Item[@id='7']       //Item[Price > 10 and Status = 'OPEN']
//   //Item[contains(Name, 'bolt')]        //*[local-name()='Item']        //text()      ..      .
//
// Two things are friendlier than strict XPath, because SOAP documents are full of namespaces
// and no prefixes can be registered here:
//   - a name without a prefix matches that local name in any namespace (`Body` finds soap:Body);
//   - a prefix is the one written in the document; it also finds the same namespace under
//     another prefix.
// Not supported: axes (ancestor::, following-sibling::…), unions (|) and arithmetic.

import { QueryError } from './jsonmodel';
import { isEl, isLeaf, textOf, type XAttr, type XChild, type XEl, type XmlParse, type XNode } from './xmlmodel';

export { QueryError };

/** The document node: what a path starts from, above the root element. */
interface XDoc {
  t: 'doc';
  kids: XChild[];
}
type Ctx = XNode | XDoc;

type Test =
  | { k: 'name'; prefix: string | null; local: string }
  | { k: 'text' | 'node' | 'comment' | 'pi' };

interface Step {
  axis: 'child' | 'attr' | 'self' | 'parent';
  /** Reached through "//": looked for at any depth below the context. */
  deep: boolean;
  test: Test;
  preds: Expr[];
}

type Expr =
  | { k: 'path'; abs: boolean; steps: Step[]; pos: number }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'fn'; name: string; args: Expr[]; pos: number }
  | { k: 'cmp'; op: string; a: Expr; b: Expr }
  | { k: 'and' | 'or'; a: Expr; b: Expr };

type Value = Ctx[] | string | number | boolean;

// ── Reading the expression ──────────────────────────────

interface Tok {
  k: 'name' | 'num' | 'str' | 'op' | 'end';
  v: string;
  pos: number;
}

const T_NAME = /[A-Za-z_][\w.-]*(?::(?:[A-Za-z_][\w.-]*|\*))?/y;
const T_NUM = /\d+(?:\.\d+)?|\.\d+/y;
const T_OP = /\/\/|\.\.|::|!=|<=|>=|[/[\]()@,.*=<>|+]/y;

function tokens(expr: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const close = expr.indexOf(c, i + 1);
      if (close === -1) throw new QueryError('The quote is not closed', i);
      out.push({ k: 'str', v: expr.slice(i + 1, close), pos: i });
      i = close + 1;
      continue;
    }
    let m: RegExpExecArray | null;
    T_NUM.lastIndex = i;
    // ".5" is a number, but "." followed by anything else is the context node.
    if ((m = T_NUM.exec(expr)) && (c !== '.' || /\d/.test(expr[i + 1] ?? ''))) {
      out.push({ k: 'num', v: m[0], pos: i });
      i = T_NUM.lastIndex;
      continue;
    }
    T_NAME.lastIndex = i;
    if ((m = T_NAME.exec(expr))) {
      out.push({ k: 'name', v: m[0], pos: i });
      i = T_NAME.lastIndex;
      continue;
    }
    T_OP.lastIndex = i;
    if ((m = T_OP.exec(expr))) {
      out.push({ k: 'op', v: m[0], pos: i });
      i = T_OP.lastIndex;
      continue;
    }
    throw new QueryError(`Unexpected ${JSON.stringify(c)}`, i);
  }
  out.push({ k: 'end', v: '', pos: expr.length });
  return out;
}

const NODE_TESTS: Record<string, 'text' | 'node' | 'comment' | 'pi'> = { text: 'text', node: 'node', comment: 'comment', 'processing-instruction': 'pi' };
const FUNCTIONS = new Set([
  'position', 'last', 'count', 'not', 'true', 'false', 'contains', 'starts-with', 'ends-with', 'local-name', 'name', 'namespace-uri',
  'string', 'number', 'string-length', 'normalize-space', 'lower-case', 'upper-case',
]);

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private get t(): Tok {
    return this.toks[this.i];
  }
  private isOp(v: string): boolean {
    return this.t.k === 'op' && this.t.v === v;
  }
  private take(v: string): boolean {
    if (!this.isOp(v)) return false;
    this.i++;
    return true;
  }
  private expect(v: string, what: string): void {
    if (!this.take(v)) throw new QueryError(`Expected ${what}`, this.t.pos);
  }
  private next(): Tok {
    return this.toks[this.i + 1];
  }

  whole(): Expr {
    const e = this.or();
    if (this.isOp('|')) throw new QueryError('Unions with | are not supported', this.t.pos);
    if (this.isOp('+')) throw new QueryError('Arithmetic is not supported', this.t.pos);
    if (this.t.k !== 'end') throw new QueryError(`Unexpected ${JSON.stringify(this.t.v)}`, this.t.pos);
    return e;
  }

  private or(): Expr {
    let a = this.and();
    while (this.t.k === 'name' && this.t.v === 'or') {
      this.i++;
      a = { k: 'or', a, b: this.and() };
    }
    return a;
  }

  private and(): Expr {
    let a = this.cmp();
    while (this.t.k === 'name' && this.t.v === 'and') {
      this.i++;
      a = { k: 'and', a, b: this.cmp() };
    }
    return a;
  }

  private cmp(): Expr {
    const a = this.value();
    if (this.t.k === 'op' && ['=', '!=', '<', '<=', '>', '>='].includes(this.t.v)) {
      const op = this.t.v;
      this.i++;
      return { k: 'cmp', op, a, b: this.value() };
    }
    return a;
  }

  private value(): Expr {
    const t = this.t;
    if (t.k === 'num') {
      this.i++;
      return { k: 'num', v: Number(t.v) };
    }
    if (t.k === 'str') {
      this.i++;
      return { k: 'str', v: t.v };
    }
    if (this.take('(')) {
      const e = this.or();
      this.expect(')', '")"');
      return e;
    }
    if (t.k === 'name' && this.next().k === 'op' && this.next().v === '(' && !(t.v in NODE_TESTS)) {
      if (!FUNCTIONS.has(t.v)) throw new QueryError(`The function ${t.v}() is not supported`, t.pos);
      this.i += 2;
      const args: Expr[] = [];
      if (!this.isOp(')')) {
        do args.push(this.or());
        while (this.take(','));
      }
      this.expect(')', '")"');
      return { k: 'fn', name: t.v, args, pos: t.pos };
    }
    return this.path();
  }

  private path(): Expr {
    const pos = this.t.pos;
    const steps: Step[] = [];
    let abs = false;
    let deep = false;
    if (this.take('/')) abs = true;
    else if (this.take('//')) abs = deep = true;
    // "/" alone is the document.
    if (abs && !deep && !this.startsStep()) return { k: 'path', abs, steps, pos };
    for (;;) {
      steps.push(this.step(deep));
      if (this.take('/')) deep = false;
      else if (this.take('//')) deep = true;
      else break;
    }
    return { k: 'path', abs, steps, pos };
  }

  private startsStep(): boolean {
    const t = this.t;
    return t.k === 'name' || (t.k === 'op' && ['.', '..', '@', '*'].includes(t.v));
  }

  private step(deep: boolean): Step {
    if (this.take('.')) return { axis: 'self', deep, test: { k: 'node' }, preds: this.preds() };
    if (this.take('..')) return { axis: 'parent', deep, test: { k: 'node' }, preds: this.preds() };
    const axis = this.take('@') ? 'attr' : 'child';
    const n = this.t;
    let test: Test;
    if (this.take('*')) test = { k: 'name', prefix: null, local: '*' };
    else if (n.k === 'name') {
      this.i++;
      if (this.isOp('::')) throw new QueryError(`Axes such as ${n.v}:: are not supported: use /, //, .. and @`, n.pos);
      if (this.isOp('(')) {
        const kind = NODE_TESTS[n.v];
        if (!kind || axis === 'attr') throw new QueryError(`${n.v}() cannot be a step of a path`, n.pos);
        this.i++;
        // processing-instruction('target') is read; the target is not tested.
        if (this.t.k === 'str') this.i++;
        this.expect(')', '")"');
        test = { k: kind };
      } else {
        const colon = n.v.indexOf(':');
        test = { k: 'name', prefix: colon > 0 ? n.v.slice(0, colon) : null, local: colon > 0 ? n.v.slice(colon + 1) : n.v };
      }
    } else {
      throw new QueryError(n.k === 'end' ? 'Expected a name' : `Expected a name, not ${JSON.stringify(n.v)}`, n.pos);
    }
    return { axis, deep, test, preds: this.preds() };
  }

  private preds(): Expr[] {
    const out: Expr[] = [];
    while (this.take('[')) {
      if (this.isOp(']')) throw new QueryError('The [ ] is empty', this.t.pos);
      out.push(this.or());
      this.expect(']', '"]"');
    }
    return out;
  }
}

// ── Walking the document ────────────────────────────────

interface Env {
  doc: XDoc;
  prefixes: Map<string, string>;
}

const kidsOf = (n: Ctx): XChild[] => (n.t === 'doc' || n.t === 'el' ? n.kids : []);

function matches(test: Test, n: XNode, env: Env): boolean {
  switch (test.k) {
    case 'node': return true;
    case 'text': return n.t === 'text';
    case 'comment': return n.t === 'comment';
    case 'pi': return n.t === 'pi';
    case 'name': {
      if (n.t !== 'el' && n.t !== 'attr') return false;
      if (test.local !== '*' && n.local !== test.local) return false;
      if (test.prefix === null) return true;
      if (n.prefix === test.prefix) return true;
      // The same namespace under another prefix (or as the default namespace).
      const uri = env.prefixes.get(test.prefix);
      return uri !== undefined && n.ns === uri;
    }
  }
}

function stringOf(v: Value): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (typeof v === 'boolean') return String(v);
  const n = v[0];
  return !n ? '' : n.t === 'doc' ? n.kids.map((k) => textOf(k)).join('') : textOf(n);
}

function numberOf(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return Number(v);
  const s = stringOf(v).trim();
  return s === '' ? NaN : Number(s);
}

const truthy = (v: Value): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : v.length > 0);

function compare(op: string, a: Value, b: Value): boolean {
  // A set of nodes compares true when any of its nodes does.
  if (Array.isArray(a)) return a.some((n) => compare(op, n.t === 'doc' ? stringOf([n]) : textOf(n), b));
  if (Array.isArray(b)) return b.some((n) => compare(op, a, n.t === 'doc' ? stringOf([n]) : textOf(n)));
  if (op === '=' || op === '!=') {
    let eq: boolean;
    if (typeof a === 'boolean' || typeof b === 'boolean') eq = truthy(a) === truthy(b);
    else if (typeof a === 'number' || typeof b === 'number') eq = numberOf(a) === numberOf(b);
    // Text in documents is often padded with white space; that should not hide a match.
    else eq = a === b || a.trim() === b.trim();
    return op === '=' ? eq : !eq;
  }
  const x = numberOf(a);
  const y = numberOf(b);
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
}

interface Focus {
  node: Ctx;
  pos: number;
  size: number;
}

function evaluate(e: Expr, f: Focus, env: Env): Value {
  switch (e.k) {
    case 'num': return e.v;
    case 'str': return e.v;
    case 'and': return truthy(evaluate(e.a, f, env)) && truthy(evaluate(e.b, f, env));
    case 'or': return truthy(evaluate(e.a, f, env)) || truthy(evaluate(e.b, f, env));
    case 'cmp': return compare(e.op, evaluate(e.a, f, env), evaluate(e.b, f, env));
    case 'path': return walkPath(e, f.node, env);
    case 'fn': return callFn(e, f, env);
  }
}

function callFn(e: Extract<Expr, { k: 'fn' }>, f: Focus, env: Env): Value {
  const arg = (k: number): Value => {
    if (k >= e.args.length) throw new QueryError(`${e.name}() needs ${k + 1} argument${k ? 's' : ''}`, e.pos);
    return evaluate(e.args[k], f, env);
  };
  /** The node a name function is about: its argument's first node, or the context node. */
  const subject = (): Ctx | undefined => {
    if (!e.args.length) return f.node;
    const v = arg(0);
    if (!Array.isArray(v)) throw new QueryError(`${e.name}() takes a path`, e.pos);
    return v[0];
  };
  const text = (k: number): string => (k < e.args.length ? stringOf(arg(k)) : stringOf([f.node]));
  switch (e.name) {
    case 'position': return f.pos;
    case 'last': return f.size;
    case 'true': return true;
    case 'false': return false;
    case 'not': return !truthy(arg(0));
    case 'count': {
      const v = arg(0);
      if (!Array.isArray(v)) throw new QueryError('count() takes a path', e.pos);
      return v.length;
    }
    case 'contains': return stringOf(arg(0)).includes(stringOf(arg(1)));
    case 'starts-with': return stringOf(arg(0)).startsWith(stringOf(arg(1)));
    case 'ends-with': return stringOf(arg(0)).endsWith(stringOf(arg(1)));
    case 'local-name': {
      const n = subject();
      return n && (n.t === 'el' || n.t === 'attr') ? n.local : n && n.t === 'pi' ? n.target : '';
    }
    case 'name': {
      const n = subject();
      return n && (n.t === 'el' || n.t === 'attr') ? n.name : n && n.t === 'pi' ? n.target : '';
    }
    case 'namespace-uri': {
      const n = subject();
      return n && (n.t === 'el' || n.t === 'attr') ? n.ns ?? '' : '';
    }
    case 'string': return text(0);
    case 'number': return numberOf(text(0));
    case 'string-length': return text(0).length;
    case 'normalize-space': return text(0).trim().replace(/\s+/g, ' ');
    case 'lower-case': return text(0).toLowerCase();
    case 'upper-case': return text(0).toUpperCase();
  }
  throw new QueryError(`The function ${e.name}() is not supported`, e.pos);
}

function candidates(step: Step, ctx: Ctx, env: Env): Ctx[] {
  if (step.axis === 'self') return [ctx];
  if (step.axis === 'parent') return ctx.t === 'doc' ? [] : [ctx.parent ?? env.doc];
  if (step.axis === 'attr') return ctx.t === 'el' ? ctx.attrs.filter((a) => !a.decl && matches(step.test, a, env)) : [];
  return kidsOf(ctx).filter((k) => matches(step.test, k, env));
}

function filter(nodes: Ctx[], preds: Expr[], env: Env): Ctx[] {
  for (const p of preds) {
    if (!nodes.length) break;
    const size = nodes.length;
    nodes = nodes.filter((node, k) => {
      const v = evaluate(p, { node, pos: k + 1, size }, env);
      // [2] is short for [position() = 2].
      return typeof v === 'number' ? v === k + 1 : truthy(v);
    });
  }
  return nodes;
}

function walkPath(e: Extract<Expr, { k: 'path' }>, from: Ctx, env: Env): Ctx[] {
  let cur: Ctx[] = [e.abs ? env.doc : from];
  for (const step of e.steps) {
    const out: Ctx[] = [];
    for (const ctx of cur) {
      if (!step.deep) {
        for (const n of filter(candidates(step, ctx, env), step.preds, env)) out.push(n);
        continue;
      }
      // "//": the step from the context and from everything below it.
      const stack: Ctx[] = [ctx];
      while (stack.length) {
        const x = stack.pop()!;
        for (const n of filter(candidates(step, x, env), step.preds, env)) out.push(n);
        const kids = kidsOf(x);
        for (let k = kids.length - 1; k >= 0; k--) if (kids[k].t === 'el') stack.push(kids[k]);
      }
    }
    cur = cur.length > 1 || step.deep || step.axis === 'parent' ? inOrder(out) : out;
    if (!cur.length) break;
  }
  return cur;
}

/** Document order, each node once. */
function inOrder(nodes: Ctx[]): Ctx[] {
  const seen = new Set<Ctx>();
  const out: Ctx[] = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  const ord = (n: Ctx) => (n.t === 'doc' ? -1 : n.ord);
  return out.sort((a, b) => ord(a) - ord(b));
}

const docOf = (p: XmlParse): XDoc => ({ t: 'doc', kids: p.root ? [...p.before, p.root, ...p.after] : [] });

/**
 * Runs an XPath against a parsed document and returns the nodes it selects, in document order.
 * A path that does not start with "/" starts at the document too, so `Envelope/Body` works.
 * Throws QueryError (with the column) when the expression cannot be read.
 */
export function runXPath(p: XmlParse, expr: string): XNode[] {
  const e = new Parser(tokens(expr)).whole();
  if (e.k !== 'path') throw new QueryError('This gives a value, not nodes: write a path such as //Item[Price > 10]', 0);
  const env: Env = { doc: docOf(p), prefixes: p.prefixes };
  const found = walkPath(e, env.doc, env);
  // The document itself (from "/" or "..") is shown as its root element.
  const nodes: XNode[] = [];
  for (const n of found) {
    if (n.t !== 'doc') nodes.push(n);
    else if (p.root) nodes.push(p.root);
  }
  return inOrder(nodes) as XNode[];
}

/**
 * When `expr` finds nothing from the top, the same path at any depth: "Item/Price" typed at the
 * top of a SOAP document means //Item/Price. Null when that finds nothing either.
 */
export function nestedFallback(p: XmlParse, expr: string): { expr: string; hits: XNode[] } | null {
  const t = expr.trim();
  if (!t || t.startsWith('//') || t.startsWith('.')) return null;
  const deep = `//${t.replace(/^\//, '')}`;
  try {
    const hits = runXPath(p, deep);
    return hits.length ? { expr: deep, hits } : null;
  } catch {
    return null;
  }
}

// ── Suggestions ─────────────────────────────────────────

export interface Suggestion {
  /** The whole box text once accepted. */
  text: string;
  label: string;
  /** e.g. "3 elements", "attribute". */
  detail: string;
  kind: 'key' | 'index' | 'nested' | 'any-depth';
}

const MAX_SUGGESTIONS = 40;
const MAX_CONTEXT = 2_000;
const MAX_WALK = 200_000;

/** Splits at the step being typed: "/a/b/It" gives context "/a/b", separator "/", partial "It". */
export function splitXPath(expr: string): { context: string; sep: string; partial: string } | null {
  let depth = 0;
  let quote = '';
  let cut = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === '/' && depth === 0) cut = i;
  }
  // Inside a predicate or a string nothing is suggested.
  if (quote || depth !== 0) return null;
  const partial = expr.slice(cut + 1);
  if (/[\])\s]/.test(partial)) return null;
  const deep = cut > 0 && expr[cut - 1] === '/';
  return { context: expr.slice(0, deep ? cut - 1 : Math.max(cut, 0)), sep: cut === -1 ? '' : deep ? '//' : '/', partial };
}

function rank(name: string, local: string, partial: string): number {
  const p = partial.toLowerCase();
  if (!p) return 0;
  const n = name.toLowerCase();
  const l = local.toLowerCase();
  // The local name first: prefixes are rarely what is being looked for.
  if (l.startsWith(p)) return 0;
  if (n.startsWith(p)) return 1;
  if (n.includes(p)) return 2;
  return -1;
}

/**
 * Suggestions for the XPath box: the child elements and attributes at the step being typed,
 * and, at the top, matching element names anywhere in the document as //name.
 */
export function completions(p: XmlParse, expr: string): Suggestion[] {
  const here = completeStep(p, expr);
  // A finished path ("/a/b"): what can follow it.
  if (here.length || !expr.trim() || expr.endsWith('/')) return here;
  return completeStep(p, `${expr}/`);
}

function completeStep(p: XmlParse, expr: string): Suggestion[] {
  if (!p.root) return [];
  const split = splitXPath(expr);
  if (!split) return [];
  const { context, sep, partial } = split;
  let ctx: Ctx[];
  if (!context) ctx = sep === '//' ? [] : [docOf(p)];
  else {
    try {
      ctx = runXPath(p, context).slice(0, MAX_CONTEXT);
    } catch {
      return [];
    }
  }
  const wantAttr = partial.startsWith('@');
  const typed = wantAttr ? partial.slice(1) : partial;
  const base = `${context}${sep}`;
  interface Entry { name: string; local: string; count: number; leaf: number; attr: boolean; order: number }
  const found = new Map<string, Entry>();
  const note = (name: string, local: string, attr: boolean, leaf: boolean) => {
    const key = (attr ? '@' : '') + name;
    let e = found.get(key);
    if (!e) found.set(key, (e = { name, local, count: 0, leaf: 0, attr, order: found.size }));
    e.count++;
    if (leaf) e.leaf++;
  };
  const describe = (e: Entry) => (e.attr
    ? `attribute${e.count > 1 ? ` · ${e.count.toLocaleString('en-US')}` : ''}`
    : `${e.count.toLocaleString('en-US')} element${e.count === 1 ? '' : 's'}${e.leaf === e.count ? ' · text' : ''}`);

  if (sep === '//' || (!context && !sep && typed)) {
    // Any depth: every element (and attribute) name in the document, or below the context.
    const starts: XChild[] = context ? ctx.filter((n): n is XEl => n.t === 'el') : [p.root];
    let walked = 0;
    const stack = starts.slice().reverse();
    while (stack.length && walked++ < MAX_WALK) {
      const n = stack.pop()!;
      if (n.t !== 'el') continue;
      if (!(context && starts.includes(n))) note(n.name, n.local, false, isLeaf(n));
      if (wantAttr || !typed) for (const a of n.attrs) if (!a.decl) note(a.name, a.local, true, false);
      for (let k = n.kids.length - 1; k >= 0; k--) stack.push(n.kids[k]);
    }
  }
  const direct = new Map<string, Entry>();
  if (sep !== '//') {
    for (const c of ctx) {
      for (const k of kidsOf(c)) if (isEl(k)) {
        const e = direct.get(k.name) ?? { name: k.name, local: k.local, count: 0, leaf: 0, attr: false, order: direct.size };
        e.count++;
        if (isLeaf(k)) e.leaf++;
        direct.set(k.name, e);
      }
      if (c.t === 'el') for (const a of c.attrs as XAttr[]) if (!a.decl) {
        const e = direct.get(`@${a.name}`) ?? { name: a.name, local: a.local, count: 0, leaf: 0, attr: true, order: direct.size + 1000 };
        e.count++;
        direct.set(`@${a.name}`, e);
      }
    }
  }

  const list: (Suggestion & { rank: number; order: number })[] = [];
  for (const e of direct.values()) {
    if (e.attr !== wantAttr && (wantAttr || typed)) continue;
    const r = rank(e.name, e.local, typed);
    if (r < 0) continue;
    const label = (e.attr ? '@' : '') + e.name;
    list.push({ text: base + label, label, detail: describe(e), kind: 'key', rank: r, order: e.order });
  }
  for (const e of found.values()) {
    if (e.attr !== wantAttr) continue;
    const r = rank(e.name, e.local, typed);
    if (r < 0) continue;
    const label = (e.attr ? '@' : '') + e.name;
    const text = `${context}//${label}`;
    if (list.some((s) => s.text === text) || (!sep && direct.has(label))) continue;
    list.push({ text, label: sep === '//' ? label : `//${label}`, detail: describe(e), kind: sep === '//' ? 'key' : 'any-depth', rank: r + (sep === '//' ? 0 : 3), order: e.order });
  }
  // A finished step that is already the whole text is not worth offering again.
  return list
    .filter((s) => s.text !== expr)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ text, label, detail, kind }) => ({ text, label, detail, kind }));
}
