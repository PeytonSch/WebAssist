// The data side of the JSON viewer: a tolerant parser, paths, a small query language, search
// and table extraction. Pure functions over strings and plain objects (no DOM), so all of it is
// unit tested in node.
//
// Why not JSON.parse: captured bodies are often cut off at the capture limit, and JSON.parse
// gives nothing for those. It also rounds 64-bit IDs. This parser keeps every number's source
// text, and when the text ends early it keeps everything read so far and marks the values that
// were left open as `cut`. It is iterative (an explicit stack), so deeply nested input cannot
// overflow the call stack, and it walks the text once with charCodeAt, which keeps multi-MB
// bodies quick.

export type Seg = string | number;

export interface JObj { t: 'obj'; keys: string[]; vals: JNode[]; cut?: boolean }
export interface JArr { t: 'arr'; items: JNode[]; cut?: boolean }
export interface JStr { t: 'str'; v: string; cut?: boolean }
/** `raw` is the number exactly as written; JS numbers would lose digits of big IDs. */
export interface JNum { t: 'num'; raw: string; cut?: boolean }
export interface JBool { t: 'bool'; v: boolean }
export interface JNull { t: 'null' }
export type JNode = JObj | JArr | JStr | JNum | JBool | JNull;
export type JContainer = JObj | JArr;

export interface ParseError {
  message: string;
  /** Offset into the text. */
  pos: number;
  /** 1-based. */
  line: number;
  col: number;
}

export interface ParseResult {
  /** Null when nothing could be read, or on a syntax error. */
  root: JNode | null;
  /** The text ended inside the value. Open objects, arrays and strings are kept, marked `cut`. */
  partial: boolean;
  error: ParseError | null;
  /** Where the value ended (with `trailing`), or where parsing stopped. */
  end: number;
  /** How many values were read. */
  nodes: number;
}

export const isContainer = (n: JNode): n is JContainer => n.t === 'obj' || n.t === 'arr';
export const sizeOf = (n: JContainer): number => (n.t === 'obj' ? n.keys.length : n.items.length);

// ── Parser ──────────────────────────────────────────────

// Frame states. In an object: expecting the first key or '}', a key after ',', the ':', the value.
// In an array: the first value or ']', a value after ','. Both: ',' or the closing bracket.
const FIRST = 0;
const NEXT = 1;
const COLON = 2;
const VALUE = 3;
const AFTER = 4;

interface Frame {
  node: JContainer;
  key: string;
  st: number;
}

const NUM_RUN = /[-+\d.eE]+/y;
const NUM_OK = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX_PART = /^[0-9a-fA-F]*$/;

/**
 * Parses `text` as JSON. With `from`, starts there; with `trailing`, stops after the first value
 * instead of treating what follows as an error (used to find JSON inside log messages).
 * Never throws.
 */
export function parseJson(text: string, opts: { from?: number; trailing?: boolean } = {}): ParseResult {
  const s = text;
  const n = s.length;
  let i = opts.from ?? 0;
  if (i === 0) {
    if (s.charCodeAt(0) === 0xfeff) i = 1;
    // Some APIs prefix JSON with )]}' against JSON hijacking; browsers' code strips that line.
    if (s.startsWith(")]}'", i)) {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
    }
  }
  const stack: Frame[] = [];
  let root: JNode | null = null;
  let nodes = 0;
  let end = i;

  const fail = (message: string, pos: number): ParseResult => ({ root: null, partial: false, error: errorAt(s, message, pos), end: pos, nodes });
  // The text ended inside a value: everything still open is incomplete.
  const early = (): ParseResult => {
    for (const f of stack) f.node.cut = true;
    return { root, partial: true, error: null, end: n, nodes };
  };
  const attach = (v: JNode): void => {
    nodes++;
    const f = stack[stack.length - 1];
    if (!f) {
      root = v;
      return;
    }
    if (f.node.t === 'arr') f.node.items.push(v);
    else {
      f.node.keys.push(f.key);
      f.node.vals.push(v);
    }
    f.st = AFTER;
  };

  for (;;) {
    const before = i;
    i = skipWs(s, i);
    const f = stack[stack.length - 1];
    if (!f && root) {
      end = before;
      if (i >= n || opts.trailing) break;
      return fail(`Unexpected ${describeAt(s, i)} after the end of the JSON`, i);
    }
    if (i >= n) return early();
    const c = s.charCodeAt(i);

    if (f && f.st === AFTER) {
      if (c === 44 /* , */) {
        f.st = NEXT;
        i++;
      } else if (c === (f.node.t === 'arr' ? 93 /* ] */ : 125 /* } */)) {
        stack.pop();
        i++;
      } else {
        return fail(`Expected ',' or '${f.node.t === 'arr' ? ']' : '}'}' but found ${describeAt(s, i)}`, i);
      }
      continue;
    }
    if (f && f.node.t === 'obj' && f.st !== VALUE) {
      if (f.st === COLON) {
        if (c !== 58 /* : */) return fail(`Expected ':' after the key but found ${describeAt(s, i)}`, i);
        f.st = VALUE;
        i++;
        continue;
      }
      if (c === 125 && f.st === FIRST) {
        stack.pop();
        i++;
        continue;
      }
      if (c !== 34) return fail(`Expected a key in double quotes but found ${describeAt(s, i)}`, i);
      const r = readString(s, i);
      if (r.error) return fail(r.error, r.end);
      // A key cut off before its value is dropped: there is nothing to show for it.
      if (r.cut) return early();
      f.key = r.v;
      f.st = COLON;
      i = r.end;
      continue;
    }
    if (f && f.st === FIRST && c === 93) {
      stack.pop();
      i++;
      continue;
    }

    // A value starts here.
    if (c === 123 /* { */ || c === 91 /* [ */) {
      const node: JContainer = c === 123 ? { t: 'obj', keys: [], vals: [] } : { t: 'arr', items: [] };
      // Attached when opened, so a cut-off container still shows what it holds.
      attach(node);
      stack.push({ node, key: '', st: FIRST });
      i++;
    } else if (c === 34 /* " */) {
      const r = readString(s, i);
      if (r.error) return fail(r.error, r.end);
      const v: JStr = { t: 'str', v: r.v };
      if (r.cut) v.cut = true;
      attach(v);
      if (r.cut) return early();
      i = r.end;
    } else if (c === 45 /* - */ || (c >= 48 && c <= 57)) {
      NUM_RUN.lastIndex = i;
      NUM_RUN.exec(s);
      const stop = NUM_RUN.lastIndex;
      const raw = s.slice(i, stop);
      const ok = NUM_OK.test(raw);
      if (stop >= n && stack.length) {
        // The number runs into the end of the text, so it may have been longer.
        if (ok) attach({ t: 'num', raw, cut: true });
        return early();
      }
      if (!ok) {
        if (stop >= n) return early();
        return fail(`Invalid number ${JSON.stringify(raw)}`, i);
      }
      attach({ t: 'num', raw });
      i = stop;
    } else if (c === 116 /* t */ || c === 102 /* f */ || c === 110 /* n */) {
      const word = c === 116 ? 'true' : c === 102 ? 'false' : 'null';
      const got = s.slice(i, i + word.length);
      if (got === word) {
        attach(word === 'null' ? { t: 'null' } : { t: 'bool', v: word === 'true' });
        i += word.length;
      } else if (i + got.length >= n && word.startsWith(got)) {
        return early();
      } else {
        return fail(`Unexpected ${describeAt(s, i)}`, i);
      }
    } else {
      return fail(`Unexpected ${describeAt(s, i)}`, i);
    }
  }
  return { root, partial: false, error: null, end, nodes };
}

function skipWs(s: string, i: number): number {
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 10 || c === 13 || c === 9) i++;
    else return i;
  }
}

const ESCAPES: Record<number, string> = { 34: '"', 92: '\\', 47: '/', 98: '\b', 102: '\f', 110: '\n', 114: '\r', 116: '\t' };

/** Reads the string starting at the quote at `i`. `cut` when the text ends inside it. */
function readString(s: string, i: number): { v: string; end: number; cut?: boolean; error?: string } {
  const n = s.length;
  let out = '';
  let from = i + 1;
  let j = from;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 34) return { v: out + s.slice(from, j), end: j + 1 };
    if (c !== 92) {
      j++;
      continue;
    }
    out += s.slice(from, j);
    if (j + 1 >= n) return { v: out, end: n, cut: true };
    const e = s.charCodeAt(j + 1);
    if (e === 117 /* u */) {
      const hex = s.slice(j + 2, j + 6);
      if (!HEX4.test(hex)) {
        if (j + 2 + hex.length >= n && HEX_PART.test(hex)) return { v: out, end: n, cut: true };
        return { v: out, end: j, error: 'Invalid \\u escape in a string' };
      }
      out += String.fromCharCode(parseInt(hex, 16));
      j += 6;
    } else {
      const ch = ESCAPES[e];
      if (ch === undefined) return { v: out, end: j, error: `Invalid escape \\${s[j + 1]} in a string` };
      out += ch;
      j += 2;
    }
    from = j;
  }
  return { v: out + s.slice(from, n), end: n, cut: true };
}

function describeAt(s: string, i: number): string {
  if (i >= s.length) return 'end of text';
  const ch = s[i];
  return ch === '\n' ? 'line break' : JSON.stringify(ch).replace(/^"|"$/g, "'");
}

function errorAt(s: string, message: string, pos: number): ParseError {
  let line = 1;
  let lineStart = 0;
  for (let k = s.indexOf('\n'); k !== -1 && k < pos; k = s.indexOf('\n', k + 1)) {
    line++;
    lineStart = k + 1;
  }
  return { message, pos, line, col: pos - lineStart + 1 };
}

// ── Values ──────────────────────────────────────────────

/** Serializes back to JSON text, numbers as written. `indent` 0 gives compact output. */
export function stringify(node: JNode, indent = 2): string {
  return stringifyCapped(node, indent, Infinity).text;
}

/**
 * Like stringify, but stops at about `limit` characters, for showing the start of a big value
 * without printing all of it. `cut` says the text stops early (and is then not valid JSON).
 */
export function stringifyCapped(node: JNode, indent: number, limit: number): { text: string; cut: boolean } {
  const out = new Writer(limit);
  write(node, '', indent, out);
  return { text: out.parts.join(''), cut: out.left <= 0 };
}

/** Collects output, counting down what is left of the limit. */
class Writer {
  parts: string[] = [];
  constructor(public left: number) {}
  push(text: string): void {
    if (this.left <= 0) return;
    if (text.length > this.left) text = text.slice(0, this.left);
    this.parts.push(text);
    this.left -= text.length;
  }
}

function write(node: JNode, pad: string, indent: number, out: Writer): void {
  switch (node.t) {
    case 'str': out.push(JSON.stringify(node.v)); return;
    case 'num': out.push(node.raw); return;
    case 'bool': out.push(node.v ? 'true' : 'false'); return;
    case 'null': out.push('null'); return;
  }
  const size = sizeOf(node);
  const [open, close] = node.t === 'obj' ? ['{', '}'] : ['[', ']'];
  if (size === 0) {
    out.push(open + close);
    return;
  }
  const inner = indent ? pad + ' '.repeat(indent) : '';
  const nl = indent ? '\n' : '';
  out.push(open);
  for (let k = 0; k < size && out.left > 0; k++) {
    out.push(k ? ',' + nl + inner : nl + inner);
    if (node.t === 'obj') {
      out.push(JSON.stringify(node.keys[k]));
      out.push(indent ? ': ' : ':');
      write(node.vals[k], inner, indent, out);
    } else {
      write(node.items[k], inner, indent, out);
    }
  }
  out.push(nl + pad + close);
}

/** Whether tableOf would give a table, without building it. */
export function canTable(node: JNode): boolean {
  if (node.t === 'arr') return node.items.some((v) => v.t === 'obj');
  return node.t === 'obj' && isRecordMap(node);
}

/** Plain JS value (numbers via Number, so big ones lose precision). For tests and comparisons. */
export function toPlain(node: JNode): unknown {
  switch (node.t) {
    case 'str':
    case 'bool': return node.v;
    case 'num': return Number(node.raw);
    case 'null': return null;
    case 'arr': return node.items.map(toPlain);
    case 'obj': {
      const o: Record<string, unknown> = {};
      node.keys.forEach((k, i) => (o[k] = toPlain(node.vals[i])));
      return o;
    }
  }
}

/**
 * For an integer JavaScript cannot hold exactly, what JSON.parse would have made of it;
 * otherwise null. The viewer always shows the number as written and says so for these.
 */
export function lossyNumber(raw: string): string | null {
  if (!/^-?\d{16,}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? null : String(n);
}

/** "object · 3 keys", "array · 25 items", "string · 12 chars"… */
export function describe(node: JNode): string {
  switch (node.t) {
    case 'obj': return `object · ${plural(node.keys.length, 'key')}`;
    case 'arr': return `array · ${plural(node.items.length, 'item')}`;
    case 'str': return `string · ${plural(node.v.length, 'char')}`;
    case 'num': return 'number';
    case 'bool': return 'boolean';
    case 'null': return 'null';
  }
}

export const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** A one-line preview of a value, at most about `max` characters: {id: 1, name: "Ada", …} */
export function preview(node: JNode, max = 80): string {
  switch (node.t) {
    case 'str': {
      const s = JSON.stringify(node.v.length > max ? node.v.slice(0, max) : node.v);
      return node.v.length > max ? s.slice(0, -1) + '…"' : s;
    }
    case 'num': return node.raw;
    case 'bool': return String(node.v);
    case 'null': return 'null';
  }
  const size = sizeOf(node);
  const [open, close] = node.t === 'obj' ? ['{', '}'] : ['[', ']'];
  let out = open;
  for (let k = 0; k < size; k++) {
    const v = node.t === 'obj' ? node.vals[k] : node.items[k];
    const inner = isContainer(v) ? (v.t === 'obj' ? (v.keys.length ? '{…}' : '{}') : v.items.length ? '[…]' : '[]') : preview(v, 24);
    const part = (k ? ', ' : '') + (node.t === 'obj' ? `${keyText(node.keys[k])}: ` : '') + inner;
    if (out.length + part.length > max) return out + (k ? ', …' : '…') + close;
    out += part;
  }
  return out + close;
}

const keyText = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

// ── Paths ───────────────────────────────────────────────

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** JavaScript-style path: data.items[3].price, ["a-b"].c; '' for the root. */
export function jsPath(path: readonly Seg[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg)) out += out ? `.${seg}` : seg;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** JSONPath: $.data.items[3].price, $["a-b"]. */
export function jsonPath(path: readonly Seg[]): string {
  let out = '$';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

/** The node at `path` under `root` and the nodes on the way, or null when it is not there. */
export function walk(root: JNode, path: readonly Seg[]): JNode[] | null {
  const chain = [root];
  let node = root;
  for (const seg of path) {
    let next: JNode | undefined;
    if (node.t === 'arr' && typeof seg === 'number') next = node.items[seg];
    else if (node.t === 'obj') {
      const k = node.keys.indexOf(String(seg));
      next = k < 0 ? undefined : node.vals[k];
    }
    if (!next) return null;
    chain.push(next);
    node = next;
  }
  return chain;
}

// ── Query ───────────────────────────────────────────────
//
// A small path language, close to JSONPath and to the JS paths the viewer shows, so a copied
// path can be pasted back in:
//   data.items        $.data.items       items[0].name      items[-1]       items[1:3]
//   items[*].price    ..id (any depth)   ["a-b"]            ['x','y']
//   items[?(@.price > 10 && @.status == "open")]            items[?(@.tags)]
// It is parsed and walked here; nothing is ever passed to eval or new Function.

export class QueryError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

type Step =
  | { k: 'names'; names: Seg[] }
  | { k: 'wild' }
  | { k: 'slice'; start: number | null; end: number | null }
  | { k: 'filter'; pred: Pred }
  | { k: 'desc' };

type Operand = { k: 'path'; steps: Step[] } | { k: 'lit'; v: string | number | boolean | null };
type Pred =
  | { k: 'or' | 'and'; a: Pred; b: Pred }
  | { k: 'not'; a: Pred }
  | { k: 'cmp'; op: string; a: Operand; b: Operand }
  | { k: 'test'; a: Operand };

const NAME = /[^.[\]\s()=!<>&|,'"]+/y;
const NAME_START = /[^.[\]\s()=!<>&|,'"]/;
const INT = /-?\d+/y;
const NUMBER_LIT = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const OPS = ['==', '!=', '<=', '>=', '<', '>'];

class QueryParser {
  i = 0;
  constructor(readonly s: string) {}

  fail(message: string, at = this.i): never {
    throw new QueryError(message, at);
  }
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  eat(text: string): boolean {
    if (!this.s.startsWith(text, this.i)) return false;
    this.i += text.length;
    return true;
  }
  sticky(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.s);
    if (!m) return null;
    this.i = re.lastIndex;
    return m[0];
  }

  /** Steps until something that cannot continue a path. `bare`: a leading name needs no dot. */
  steps(bare: boolean): Step[] {
    const steps: Step[] = [];
    for (;;) {
      const c = this.s[this.i];
      if (c === '.' && this.s[this.i + 1] === '.') {
        this.i += 2;
        steps.push({ k: 'desc' });
        if (this.s[this.i] !== '[') steps.push(this.name(true));
      } else if (c === '.') {
        this.i++;
        steps.push(this.name(false));
      } else if (c === '[') {
        steps.push(this.bracket());
      } else if (bare && steps.length === 0 && c !== undefined && NAME_START.test(c)) {
        steps.push(this.name(false));
      } else {
        return steps;
      }
    }
  }

  name(afterDesc: boolean): Step {
    if (this.eat('*')) return { k: 'wild' };
    const at = this.i;
    const name = this.sticky(NAME);
    if (name === null) this.fail(afterDesc ? "Expected a name, * or [ after '..'" : "Expected a name or * after '.'", at);
    return { k: 'names', names: [name] };
  }

  bracket(): Step {
    const open = this.i;
    this.i++;
    this.ws();
    let step: Step;
    const c = this.s[this.i];
    if (c === '*') {
      this.i++;
      step = { k: 'wild' };
    } else if (c === '?') {
      this.i++;
      this.ws();
      const paren = this.eat('(');
      const pred = this.or();
      this.ws();
      if (paren && !this.eat(')')) this.fail("Expected ')' to close the filter");
      step = { k: 'filter', pred };
    } else if (c === '"' || c === "'") {
      const names: Seg[] = [this.quoted()];
      for (this.ws(); this.eat(','); this.ws()) names.push(this.quoted());
      step = { k: 'names', names };
    } else if (c === ':' || c === '-' || (c >= '0' && c <= '9')) {
      const start = this.int();
      this.ws();
      if (this.eat(':')) {
        this.ws();
        step = { k: 'slice', start, end: this.int() };
      } else {
        if (start === null) this.fail('Expected an index');
        const names: Seg[] = [start];
        for (this.ws(); this.eat(','); this.ws()) {
          const k = this.int();
          if (k === null) this.fail('Expected an index after ,');
          names.push(k);
        }
        step = { k: 'names', names };
      }
    } else {
      this.fail('Expected an index, a quoted key, * or ?(…) inside [ ]');
    }
    this.ws();
    if (!this.eat(']')) this.fail(`Missing ']' for the '[' at col ${open + 1}`);
    return step;
  }

  int(): number | null {
    const m = this.sticky(INT);
    return m === null ? null : Number(m);
  }

  quoted(): string {
    const q = this.s[this.i];
    if (q === '"') {
      const r = readString(this.s, this.i);
      if (r.error || r.cut) this.fail(r.error ?? 'Unclosed string');
      this.i = r.end;
      return r.v;
    }
    if (q !== "'") this.fail('Expected a quoted key');
    let out = '';
    for (let j = this.i + 1; j < this.s.length; j++) {
      const ch = this.s[j];
      if (ch === '\\' && j + 1 < this.s.length) out += this.s[++j];
      else if (ch === "'") {
        this.i = j + 1;
        return out;
      } else out += ch;
    }
    return this.fail('Unclosed string');
  }

  or(): Pred {
    let a = this.and();
    for (this.ws(); this.eat('||'); this.ws()) a = { k: 'or', a, b: this.and() };
    return a;
  }
  and(): Pred {
    let a = this.term();
    for (this.ws(); this.eat('&&'); this.ws()) a = { k: 'and', a, b: this.term() };
    return a;
  }
  term(): Pred {
    this.ws();
    if (this.eat('!')) return { k: 'not', a: this.term() };
    if (this.eat('(')) {
      const p = this.or();
      this.ws();
      if (!this.eat(')')) this.fail("Expected ')'");
      return p;
    }
    const a = this.operand();
    this.ws();
    const op = OPS.find((o) => this.s.startsWith(o, this.i));
    if (!op) return { k: 'test', a };
    this.i += op.length;
    this.ws();
    return { k: 'cmp', op, a, b: this.operand() };
  }
  operand(): Operand {
    const c = this.s[this.i];
    if (c === '@') {
      this.i++;
      return { k: 'path', steps: this.steps(false) };
    }
    if (c === '"' || c === "'") return { k: 'lit', v: this.quoted() };
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.s.startsWith(word, this.i)) {
        this.i += word.length;
        return { k: 'lit', v };
      }
    }
    const num = this.sticky(NUMBER_LIT);
    if (num !== null) return { k: 'lit', v: Number(num) };
    return this.fail(c === undefined ? 'The filter ends early' : 'Expected @.path, a string, a number, true, false or null');
  }
}

/** Parses a query, throwing QueryError (with the position) when it is not valid. */
function parseQuery(expr: string): Step[] {
  const p = new QueryParser(expr);
  p.ws();
  p.eat('$');
  const steps = p.steps(true);
  p.ws();
  if (p.i < expr.length) p.fail(`Unexpected '${expr[p.i]}'`);
  return steps;
}

/** A result: the node and its path from the root the query ran on. */
export interface Hit {
  node: JNode;
  path: Seg[];
}

// While walking, paths are linked lists so wide queries (..*) do not copy arrays per node.
interface Link {
  node: JNode;
  seg: Seg | null;
  up: Link | null;
}

/** Runs `expr` against `root`. Throws QueryError for an invalid expression. */
export function runQuery(root: JNode, expr: string): Hit[] {
  const steps = parseQuery(expr);
  return applySteps([{ node: root, seg: null, up: null }], steps).map((l) => ({ node: l.node, path: linkPath(l) }));
}

function linkPath(l: Link): Seg[] {
  const out: Seg[] = [];
  for (let x: Link | null = l; x && x.seg !== null; x = x.up) out.push(x.seg);
  return out.reverse();
}

function applySteps(start: Link[], steps: Step[]): Link[] {
  let cur = start;
  for (const step of steps) {
    if (step.k === 'desc') {
      cur = cur.flatMap(descendants);
      continue;
    }
    const next: Link[] = [];
    for (const l of cur) applyStep(l, step, next);
    cur = next;
  }
  return cur;
}

function applyStep(l: Link, step: Exclude<Step, { k: 'desc' }>, out: Link[]): void {
  const node = l.node;
  const child = (seg: Seg, v: JNode) => out.push({ node: v, seg, up: l });
  if (step.k === 'names') {
    for (const name of step.names) {
      if (node.t === 'obj') {
        const key = String(name);
        node.keys.forEach((k, i) => k === key && child(k, node.vals[i]));
      } else if (node.t === 'arr') {
        // items.0 works like items[0].
        const idx = typeof name === 'number' ? name : /^-?\d+$/.test(name) ? Number(name) : NaN;
        const at = idx < 0 ? node.items.length + idx : idx;
        if (Number.isInteger(at) && at >= 0 && at < node.items.length) child(at, node.items[at]);
      }
    }
  } else if (step.k === 'wild' || step.k === 'filter') {
    const keep = (v: JNode) => step.k === 'wild' || test(step.pred, v);
    if (node.t === 'obj') node.keys.forEach((k, i) => keep(node.vals[i]) && child(k, node.vals[i]));
    else if (node.t === 'arr') node.items.forEach((v, i) => keep(v) && child(i, v));
  } else if (step.k === 'slice' && node.t === 'arr') {
    const len = node.items.length;
    const norm = (x: number | null, dflt: number) => (x === null ? dflt : x < 0 ? Math.max(0, len + x) : Math.min(len, x));
    for (let i = norm(step.start, 0); i < norm(step.end, len); i++) child(i, node.items[i]);
  }
}

/** The node and everything under it, in document order. */
function descendants(l: Link): Link[] {
  const out: Link[] = [];
  const stack = [l];
  while (stack.length) {
    const x = stack.pop()!;
    out.push(x);
    const n = x.node;
    if (n.t === 'obj') for (let i = n.keys.length - 1; i >= 0; i--) stack.push({ node: n.vals[i], seg: n.keys[i], up: x });
    else if (n.t === 'arr') for (let i = n.items.length - 1; i >= 0; i--) stack.push({ node: n.items[i], seg: i, up: x });
  }
  return out;
}

function operandValue(o: Operand, node: JNode): { v: unknown } | null {
  if (o.k === 'lit') return { v: o.v };
  const hits = applySteps([{ node, seg: null, up: null }], o.steps);
  if (!hits.length) return null;
  const n = hits[0].node;
  switch (n.t) {
    case 'str':
    case 'bool': return { v: n.v };
    case 'num': return { v: Number(n.raw) };
    case 'null': return { v: null };
    default: return { v: n };
  }
}

function test(p: Pred, node: JNode): boolean {
  switch (p.k) {
    case 'or': return test(p.a, node) || test(p.b, node);
    case 'and': return test(p.a, node) && test(p.b, node);
    case 'not': return !test(p.a, node);
    case 'test': {
      const r = operandValue(p.a, node);
      return r !== null && r.v !== null && r.v !== false;
    }
    case 'cmp': {
      const a = operandValue(p.a, node);
      const b = operandValue(p.b, node);
      if (!a || !b) return p.op === '!=' && (a !== null) !== (b !== null);
      const x = a.v;
      const y = b.v;
      if (p.op === '==') return x === y;
      if (p.op === '!=') return x !== y;
      const comparable = (typeof x === 'number' && typeof y === 'number') || (typeof x === 'string' && typeof y === 'string');
      if (!comparable) return false;
      const [u, w] = [x as number | string, y as number | string];
      return p.op === '<' ? u < w : p.op === '<=' ? u <= w : p.op === '>' ? u > w : u >= w;
    }
  }
}

// ── Search ──────────────────────────────────────────────

export interface Match {
  node: JNode;
  /** Index of the root (query result) it is under. */
  top: number;
  /** The nodes from that root down to the match's parent. */
  ancestors: JNode[];
  /** Path from that root. */
  path: Seg[];
  key: boolean;
  value: boolean;
}

/**
 * Case-insensitive search of keys and values (strings, numbers as written, true/false/null)
 * under each root, in document order, one match per node. Stops collecting at `limit` but
 * keeps counting.
 */
export function search(tops: readonly JNode[], query: string, limit = 10_000): { matches: Match[]; total: number } {
  const q = query.toLowerCase();
  const matches: Match[] = [];
  let total = 0;
  if (!q) return { matches, total };
  tops.forEach((top, ti) => {
    const stack: Link[] = [{ node: top, seg: null, up: null }];
    while (stack.length) {
      const l = stack.pop()!;
      const n = l.node;
      const key = typeof l.seg === 'string' && l.seg.toLowerCase().includes(q);
      const value = n.t === 'str' ? n.v.toLowerCase().includes(q) : n.t === 'num' ? n.raw.toLowerCase().includes(q) : n.t === 'bool' || n.t === 'null' ? (n.t === 'null' ? 'null' : String(n.v)).includes(q) : false;
      if (key || value) {
        total++;
        if (matches.length < limit) {
          const ancestors: JNode[] = [];
          for (let x = l.up; x; x = x.up) ancestors.push(x.node);
          matches.push({ node: n, top: ti, ancestors: ancestors.reverse(), path: linkPath(l), key, value });
        }
      }
      if (n.t === 'obj') for (let i = n.keys.length - 1; i >= 0; i--) stack.push({ node: n.vals[i], seg: n.keys[i], up: l });
      else if (n.t === 'arr') for (let i = n.items.length - 1; i >= 0; i--) stack.push({ node: n.items[i], seg: i, up: l });
    }
  });
  return { matches, total };
}

// ── Tables ──────────────────────────────────────────────

export interface Table {
  /** The union of the row objects' keys, in first-seen order (capped). */
  columns: string[];
  /** Columns left out past the cap. */
  hiddenColumns: number;
  rows: { seg: Seg; node: JNode }[];
  /** Some rows are not objects; they get a "value" column. */
  valueColumn: boolean;
}

/**
 * Rows and columns for an array (rows by index) or an object whose values are all objects
 * (rows by key, e.g. a map of IDs to records). Null unless at least one row is an object.
 */
export function tableOf(node: JNode, maxColumns = 100): Table | null {
  let rows: Table['rows'];
  if (node.t === 'arr') rows = node.items.map((v, i) => ({ seg: i, node: v }));
  else if (node.t === 'obj' && isRecordMap(node)) rows = node.keys.map((k, i) => ({ seg: k, node: node.vals[i] }));
  else return null;
  const seen = new Set<string>();
  const columns: string[] = [];
  let valueColumn = false;
  for (const r of rows) {
    if (r.node.t !== 'obj') {
      valueColumn = true;
      continue;
    }
    for (const k of r.node.keys) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  if (!seen.size && !rows.some((r) => r.node.t === 'obj')) return null;
  return { columns: columns.slice(0, maxColumns), hiddenColumns: Math.max(0, columns.length - maxColumns), rows, valueColumn };
}

/**
 * An object whose values are records of the same shape ({"u1": {name…}, "u2": {name…}}), as
 * opposed to an ordinary object that happens to hold objects ({meta: {…}, data: {…}}): at
 * least two values, all objects, sharing at least half of their keys.
 */
function isRecordMap(node: JObj): boolean {
  if (node.vals.length < 2 || !node.vals.every((v) => v.t === 'obj')) return false;
  const records = node.vals as JObj[];
  const union = new Set(records.flatMap((r) => r.keys));
  let shared = 0;
  for (const k of union) if (records.every((r) => r.keys.includes(k))) shared++;
  return shared > 0 && shared * 2 >= union.size;
}

/** A row's value for a column (the last one, like JSON.parse, if a key repeats). */
export function cellOf(row: JNode, column: string): JNode | undefined {
  if (row.t !== 'obj') return undefined;
  const i = row.keys.lastIndexOf(column);
  return i < 0 ? undefined : row.vals[i];
}

const TYPE_RANK: Record<JNode['t'], number> = { num: 0, str: 1, bool: 2, null: 3, arr: 4, obj: 5 };
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Sort order for table cells: numbers by value, strings naturally, then other types; missing last. */
export function compareNodes(a: JNode | undefined, b: JNode | undefined): number {
  if (!a || !b) return a ? -1 : b ? 1 : 0;
  if (a.t !== b.t) return TYPE_RANK[a.t] - TYPE_RANK[b.t];
  switch (a.t) {
    case 'num': return Number(a.raw) - Number((b as JNum).raw) || a.raw.length - (b as JNum).raw.length;
    case 'str': return collator.compare(a.v, (b as JStr).v);
    case 'bool': return Number(a.v) - Number((b as JBool).v);
    case 'arr': return a.items.length - (b as JArr).items.length;
    case 'obj': return a.keys.length - (b as JObj).keys.length;
    default: return 0;
  }
}

/** The first array of objects under `root`, breadth first: for responses like {data: {items: […]}}. */
export function findTable(root: JNode, limit = 20_000): Hit | null {
  const queue: Link[] = [{ node: root, seg: null, up: null }];
  for (let q = 0; q < queue.length && q < limit; q++) {
    const l = queue[q];
    const n = l.node;
    if (n.t === 'arr' && n.items.some((v) => v.t === 'obj')) return { node: n, path: linkPath(l) };
    if (n.t === 'obj') n.keys.forEach((k, i) => isContainer(n.vals[i]) && queue.push({ node: n.vals[i], seg: k, up: l }));
    else if (n.t === 'arr') n.items.forEach((v, i) => isContainer(v) && queue.push({ node: v, seg: i, up: l }));
  }
  return null;
}

// ── JSON inside text ────────────────────────────────────

/**
 * The first JSON object (or array holding objects) embedded in a log or console message, e.g.
 * `Order payload: {"id": 1, …}`. Tries a few candidate brackets only, so long messages stay cheap,
 * and skips trivial matches like "[3]" or "{}".
 */
export function findJsonIn(text: string, maxTries = 8): { start: number; end: number; text: string } | null {
  if (text.length > 4_000_000) return null;
  let tries = 0;
  for (let i = 0; i < text.length && tries < maxTries; i++) {
    const c = text.charCodeAt(i);
    if (c !== 123 && c !== 91) continue;
    tries++;
    const r = parseJson(text, { from: i, trailing: true });
    if (r.error || r.partial || !r.root) continue;
    const worth = r.root.t === 'obj' ? r.root.keys.length > 0 : r.root.t === 'arr' && r.root.items.some(isContainer);
    if (worth) return { start: i, end: r.end, text: text.slice(i, r.end) };
    i = r.end - 1;
  }
  return null;
}
