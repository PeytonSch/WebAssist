// What a config file sets, by path ("mail.smtp.timeout", "Loggers/Logger[com.shop]@level"), so
// two versions can be compared by setting instead of by line: which settings a new build adds,
// which it drops, and which have another value. Pure: no DOM, no Node.
//
// The readers are deliberately forgiving. They are line and token scanners, not validating
// parsers: a file that uses YAML anchors, JSON comments or JavaScript logic still gives up its
// keys, and each key comes with the line it is on, which a real parser would not keep.
// `checkSyntax` is the strict side: it says when a merged result no longer reads as its format.

import { parseYaml } from '../server/apiclient/yaml';

export type FileKind = 'yaml' | 'json' | 'properties' | 'ini' | 'xml' | 'js' | 'text';

export const KIND_LABEL: Record<FileKind, string> = {
  yaml: 'YAML',
  json: 'JSON',
  properties: 'Properties',
  ini: 'INI',
  xml: 'XML',
  js: 'JavaScript',
  text: 'Text',
};

/** The format of a file, from its name. */
export function fileKind(path: string): FileKind {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'json' || ext === 'jsonc' || ext === 'json5') return 'json';
  if (ext === 'properties') return 'properties';
  if (ext === 'ini' || ext === 'cfg' || ext === 'conf' || ext === 'toml' || ext === 'env' || name === '.env') return 'ini';
  if (ext === 'xml' || ext === 'xsd' || ext === 'xsl' || ext === 'xhtml' || ext === 'tld') return 'xml';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'ts') return 'js';
  return 'text';
}

/** A step of a path: a name, or a position in a list. */
export type Seg = string | number;

export interface KeyEntry {
  segs: Seg[];
  /** For display: "mail.smtp.timeout", "servers[0].host", "Appenders/Console[out]@target". */
  path: string;
  /** As written in the file. */
  value: string;
  /** 0-based line the setting is on. */
  line: number;
}

type Raw = Omit<KeyEntry, 'path'>;

export interface SyntaxProblem {
  message: string;
  /** 0-based. */
  line?: number;
}

export function formatPath(segs: readonly Seg[], kind: FileKind): string {
  if (kind === 'xml') return segs.join('/').replace(/\/@/g, '@');
  let out = '';
  for (const s of segs) out += typeof s === 'number' ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

const segKey = (segs: readonly Seg[], n = segs.length) => JSON.stringify(n === segs.length ? segs : segs.slice(0, n));

class LineIndex {
  private starts: number[] = [0];
  constructor(text: string) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }
  at(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

// ── Object literals: JSON, JavaScript, YAML's { } and [ ] ─

type Node =
  | { t: 'obj'; entries: { key: string; line: number; v: Node }[]; line: number }
  | { t: 'arr'; items: Node[]; line: number }
  | { t: 'leaf'; raw: string; line: number };

class ParseFail extends Error {
  constructor(message: string, public offset: number) {
    super(message);
  }
}

const OPEN: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

/**
 * Reads values written as object and array literals. In 'js' mode a value may be any expression
 * (kept as its source text), with // and block comments; in 'yaml' mode comments start with # and
 * a plain value runs to the next comma or closing bracket.
 */
class Reader {
  i = 0;
  lines: LineIndex;
  constructor(public s: string, public mode: 'js' | 'yaml') {
    this.lines = new LineIndex(s);
  }

  /** Skips spaces and comments. With `sameLine`, stops at a line break. */
  skip(sameLine = false): void {
    const s = this.s;
    for (;;) {
      const c = s[this.i];
      if (c === '\n' && sameLine) return;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') this.i++;
      else if (this.mode === 'js' && c === '/' && s[this.i + 1] === '/') this.i = this.lineEnd();
      else if (this.mode === 'js' && c === '/' && s[this.i + 1] === '*') {
        const end = s.indexOf('*/', this.i + 2);
        if (end === -1) throw new ParseFail('A /* comment is never closed', this.i);
        this.i = end + 2;
      } else if (this.mode === 'yaml' && c === '#') this.i = this.lineEnd();
      else return;
    }
  }

  private lineEnd(): number {
    const end = this.s.indexOf('\n', this.i);
    return end === -1 ? this.s.length : end;
  }

  /** The end of the string literal starting at `at` (after its closing quote). */
  stringEnd(at: number): number {
    const s = this.s;
    const q = s[at];
    for (let i = at + 1; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && !(this.mode === 'yaml' && q === "'")) i++;
      else if (c === q) {
        // YAML doubles a single quote to escape it.
        if (this.mode === 'yaml' && q === "'" && s[i + 1] === "'") i++;
        else return i + 1;
      } else if (c === '\n' && q !== '`' && this.mode === 'js') break;
    }
    throw new ParseFail(`A ${q} string is never closed`, at);
  }

  /** Whether a / at `at` starts a regular expression rather than dividing. */
  regexAt(at: number): boolean {
    let p = at - 1;
    while (p >= 0 && /\s/.test(this.s[p])) p--;
    return p < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(this.s[p]) || /(?:^|[^\w$.])(?:return|typeof|case|in|of|void|delete)$/.test(this.s.slice(Math.max(0, p - 10), p + 1));
  }

  regexEnd(at: number): number {
    const s = this.s;
    let cls = false;
    for (let i = at + 1; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') i++;
      else if (c === '\n') break;
      else if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) return i + 1;
    }
    return at + 1;
  }

  /**
   * The end of the expression starting here: the next comma, closing bracket or semicolon that is
   * not inside brackets or a string. With `statement`, also a line break after which a new
   * statement plainly starts.
   */
  expressionEnd(statement = false): number {
    const s = this.s;
    const stack: string[] = [];
    let i = this.i;
    while (i < s.length) {
      const c = s[i];
      if (c === '"' || c === "'" || (c === '`' && this.mode === 'js')) {
        i = this.stringEnd(i);
        continue;
      }
      if (this.mode === 'js' && c === '/') {
        if (s[i + 1] === '/') {
          const end = s.indexOf('\n', i);
          i = end === -1 ? s.length : end;
          continue;
        }
        if (s[i + 1] === '*') {
          const end = s.indexOf('*/', i + 2);
          if (end === -1) throw new ParseFail('A /* comment is never closed', i);
          i = end + 2;
          continue;
        }
        if (this.regexAt(i)) {
          i = this.regexEnd(i);
          continue;
        }
      }
      if (this.mode === 'yaml' && c === '#' && /\s/.test(s[i - 1] ?? ' ')) {
        const end = s.indexOf('\n', i);
        i = end === -1 ? s.length : end;
        continue;
      }
      if (OPEN[c]) stack.push(OPEN[c]);
      else if (c === '}' || c === ']' || c === ')') {
        if (!stack.length) return i;
        if (stack.pop() !== c) throw new ParseFail(`Unexpected ${c}`, i);
      } else if (!stack.length) {
        if (c === ',' || c === ';') return i;
        if (c === '\n' && statement) {
          let b = i - 1;
          while (b >= this.i && /\s/.test(s[b])) b--;
          let f = i;
          while (f < s.length && /\s/.test(s[f])) f++;
          // The expression goes on when the line ends in an operator or the next one starts with one.
          const open = /[+\-*/%=&|^<>?:,.([{!~]/.test(s[b] ?? '') || /^(?:[.+*/%=&|^<>?:,)\]}]|-(?!-)|instanceof\b|in\b)/.test(s.slice(f, f + 12));
          if (b >= this.i && !open) return i;
        }
      }
      i++;
    }
    if (stack.length) throw new ParseFail(`A ${Object.keys(OPEN).find((k) => OPEN[k] === stack[stack.length - 1])} is never closed`, this.i);
    return i;
  }

  leaf(statement = false): Node {
    const start = this.i;
    const end = this.expressionEnd(statement);
    const raw = this.s.slice(start, end).trim();
    if (!raw) throw new ParseFail('A value is missing', start);
    this.i = end;
    return { t: 'leaf', raw, line: this.lines.at(start) };
  }

  value(statement = false): Node {
    this.skip();
    const start = this.i;
    const c = this.s[start];
    if (c !== '{' && c !== '[') return this.leaf(statement);
    const node = c === '{' ? this.object() : this.array();
    // "{…}.x", "[…].join()" and the like are expressions, not literals.
    const save = this.i;
    this.skip(true);
    const next = this.s[this.i];
    this.i = save;
    if (this.mode === 'js' && next !== undefined && /[.([+\-*/%&|^<>?=]/.test(next) && !(next === '/' && /[/*]/.test(this.s[this.i + 1] ?? ''))) {
      this.i = start;
      return this.leaf(statement);
    }
    return node;
  }

  private object(): Node {
    const line = this.lines.at(this.i);
    const entries: { key: string; line: number; v: Node }[] = [];
    this.i++;
    for (;;) {
      this.skip();
      const c = this.s[this.i];
      if (c === undefined) throw new ParseFail('A { is never closed', this.i);
      if (c === '}') {
        this.i++;
        break;
      }
      if (c === ',') {
        this.i++;
        continue;
      }
      const at = this.i;
      const keyLine = this.lines.at(at);
      let key: string;
      if (this.s.startsWith('...', at)) {
        this.i += 3;
        this.leaf();
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const end = this.stringEnd(at);
        key = unquote(this.s.slice(at, end));
        this.i = end;
      } else if (c === '[') {
        this.i++;
        const end = this.expressionEnd();
        key = this.s.slice(at, end + 1);
        this.i = end + 1;
      } else {
        const m = (this.mode === 'yaml' ? /[^:,{}[\]\n]+/y : /[^\s:,(){}[\]]+/y);
        m.lastIndex = at;
        const found = m.exec(this.s);
        if (!found) throw new ParseFail(`Unexpected ${c}`, at);
        key = found[0].trim();
        this.i = at + found[0].length;
      }
      this.skip();
      const next = this.s[this.i];
      if (next === ':') {
        this.i++;
        this.skip();
        // "key: }" and "key: ," in YAML are an empty value.
        const here = this.s[this.i];
        if (this.mode === 'yaml' && (here === ',' || here === '}')) entries.push({ key, line: keyLine, v: { t: 'leaf', raw: '', line: keyLine } });
        else entries.push({ key, line: keyLine, v: this.value() });
      } else if (next === ',' || next === '}') {
        // { name } is short for { name: name }.
        entries.push({ key, line: keyLine, v: { t: 'leaf', raw: key, line: keyLine } });
      } else {
        // A method, getter or something else: keep its text as the value.
        this.i = at;
        entries.push({ key: key === 'get' || key === 'set' || key === 'async' ? this.s.slice(at, this.expressionEnd()).split(/[\s(]+/)[1] ?? key : key, line: keyLine, v: this.leaf() });
      }
    }
    return { t: 'obj', entries, line };
  }

  private array(): Node {
    const line = this.lines.at(this.i);
    const items: Node[] = [];
    this.i++;
    for (;;) {
      this.skip();
      const c = this.s[this.i];
      if (c === undefined) throw new ParseFail('A [ is never closed', this.i);
      if (c === ']') {
        this.i++;
        break;
      }
      if (c === ',') {
        this.i++;
        continue;
      }
      items.push(this.value());
    }
    return { t: 'arr', items, line };
  }
}

/** A string literal without its quotes; other text as it is. */
function unquote(raw: string): string {
  const q = raw[0];
  if (raw.length >= 2 && (q === '"' || q === "'" || q === '`') && raw[raw.length - 1] === q) {
    const inner = raw.slice(1, -1);
    return q === "'" ? inner.replace(/''/g, "'").replace(/\\(['\\])/g, '$1') : inner.replace(/\\(["\\/`])/g, '$1');
  }
  return raw;
}

function flatten(node: Node, segs: Seg[], out: Raw[]): void {
  if (node.t === 'leaf') out.push({ segs, value: node.raw, line: node.line });
  else if (node.t === 'obj') {
    if (!node.entries.length) out.push({ segs, value: '{}', line: node.line });
    for (const e of node.entries) flatten(e.v, [...segs, e.key], out);
  } else {
    if (!node.items.length) out.push({ segs, value: '[]', line: node.line });
    node.items.forEach((item, i) => flatten(item, [...segs, i], out));
  }
}

function jsonKeys(text: string): Raw[] | null {
  const r = new Reader(text, 'js');
  try {
    r.skip();
    const c = text[r.i];
    if (c !== '{' && c !== '[') return null;
    const node = r.value();
    r.skip();
    if (r.i < text.length) return null;
    const out: Raw[] = [];
    flatten(node, [], out);
    return out;
  } catch {
    return null;
  }
}

// ── JavaScript config files ─────────────────────────────

const JS_GLOBALS = new Set(['window', 'globalThis', 'self', 'global', 'this']);
const JS_KEYWORDS = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'function', 'class', 'new', 'typeof', 'await', 'yield', 'try', 'catch', 'finally', 'throw', 'import', 'from', 'as', 'of', 'in', 'instanceof', 'void', 'delete', 'async', 'static', 'extends']);

/** "window.CONFIG" → ["CONFIG"]; "module.exports" → []. */
function jsTarget(segs: Seg[]): Seg[] {
  let out = segs;
  while (out.length && typeof out[0] === 'string' && JS_GLOBALS.has(out[0])) out = out.slice(1);
  if (out[0] === 'module' && out[1] === 'exports') out = out.slice(2);
  else if (out[0] === 'exports') out = out.slice(1);
  return out;
}

/**
 * Best effort: assignments ("window.CONFIG = {…}", "var timeout = 30", "module.exports = {…}"),
 * "export default {…}", "return {…}" and object literals passed to a call
 * (".constant('CONFIG', {…})"), each taken apart into its keys.
 */
function jsKeys(text: string): Raw[] | null {
  const r = new Reader(text, 'js');
  const out: Raw[] = [];
  // What was read before the current position: the kind of token, and for a name or string its value.
  type Tok = { t: 'name'; segs: Seg[] } | { t: 'str'; v: string } | { t: 'punct'; v: string } | null;
  const seen: [Tok, Tok] = [null, null];
  const brackets: string[] = [];
  const shift = (t: Tok) => {
    seen[0] = seen[1];
    seen[1] = t;
  };
  const isPunct = (t: Tok, ...vs: string[]) => t?.t === 'punct' && vs.includes(t.v);
  try {
    for (;;) {
      r.skip();
      const at = r.i;
      const c = text[at];
      if (c === undefined) break;
      const [prev2, prev] = seen;
      if (c === '"' || c === "'" || c === '`') {
        r.i = r.stringEnd(at);
        shift({ t: 'str', v: unquote(text.slice(at, r.i)) });
        continue;
      }
      if (/[\p{L}_$]/u.test(c)) {
        // A name with what follows it: a.b, a?.b, a['b'], a[0].
        const segs: Seg[] = [];
        const id = /[\p{L}\p{N}_$]+/uy;
        id.lastIndex = at;
        segs.push(id.exec(text)![0]);
        r.i = id.lastIndex;
        for (;;) {
          const m = /\s*(?:\??\.\s*([\p{L}_$][\p{L}\p{N}_$]*)|\[\s*(?:(\d+)|"([^"\\\n]*)"|'([^'\\\n]*)')\s*\])/uy;
          m.lastIndex = r.i;
          const part = m.exec(text);
          if (!part) break;
          segs.push(part[1] ?? (part[2] !== undefined ? Number(part[2]) : (part[3] ?? part[4])));
          r.i = m.lastIndex;
        }
        const word = segs.length === 1 ? String(segs[0]) : '';
        const save = r.i;
        r.skip();
        const next = text[r.i];
        const inBlock = !brackets.length || brackets[brackets.length - 1] === '}';
        if (next === '=' && text[r.i + 1] !== '=' && text[r.i + 1] !== '>' && !JS_KEYWORDS.has(word) && inBlock) {
          r.i++;
          flatten(r.value(true), jsTarget(segs), out);
          shift({ t: 'punct', v: 'value' });
          continue;
        }
        if ((word === 'return' || (word === 'default' && prev?.t === 'name' && prev.segs[0] === 'export')) && (next === '{' || next === '[')) {
          flatten(r.value(true), [], out);
          shift({ t: 'punct', v: 'value' });
          continue;
        }
        r.i = save;
        shift(word === 'var' || word === 'let' || word === 'const' ? prev : { t: 'name', segs });
        continue;
      }
      if (/\d/.test(c)) {
        const num = /[\d.xXa-fA-F_n]+/y;
        num.lastIndex = at;
        num.exec(text);
        r.i = num.lastIndex;
        shift({ t: 'punct', v: 'value' });
        continue;
      }
      if (c === '{' && (isPunct(prev, '(', ',', '[', '?', ':', '||', '&&', '??'))) {
        // An object literal handed to a call: named by the string or name before it, if any.
        const named: Seg[] = isPunct(prev, ',') && prev2?.t === 'str' ? [prev2.v] : isPunct(prev, ',') && prev2?.t === 'name' ? jsTarget(prev2.segs) : [];
        flatten(r.value(true), named, out);
        shift({ t: 'punct', v: 'value' });
        continue;
      }
      if (c === '/' && !(prev?.t === 'name' || prev?.t === 'str' || isPunct(prev, ')', ']', 'value'))) {
        // A regular expression.
        let i = at + 1;
        for (let cls = false; i < text.length && text[i] !== '\n'; i++) {
          if (text[i] === '\\') i++;
          else if (text[i] === '[') cls = true;
          else if (text[i] === ']') cls = false;
          else if (text[i] === '/' && !cls) break;
        }
        r.i = i + 1;
        shift({ t: 'punct', v: 'value' });
        continue;
      }
      if (OPEN[c]) brackets.push(OPEN[c]);
      else if (c === '}' || c === ']' || c === ')') {
        if (brackets[brackets.length - 1] === c) brackets.pop();
      }
      const two = text.slice(at, at + 2);
      const op = two === '||' || two === '&&' || two === '??' || two === '=>' || two === '==' || two === '!=' || two === '<=' || two === '>=' ? two : c;
      r.i = at + op.length;
      shift({ t: 'punct', v: op });
    }
  } catch {
    // What was read before the part that could not be read still counts.
  }
  if (!out.length) return null;
  // Assigned twice: the last one is what the file ends up with.
  const last = new Map<string, Raw>();
  for (const e of out) last.set(segKey(e.segs), e);
  return [...last.values()].sort((a, b) => a.line - b.line);
}

// ── YAML ────────────────────────────────────────────────

/** The text with a trailing comment removed, respecting quotes. */
function stripYamlComment(text: string): string {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(text[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

function yamlSplitKey(t: string): { key: string; rest: string } | null {
  if (t[0] === '"' || t[0] === "'") {
    const m = t[0] === '"' ? /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+|$)/.exec(t) : /^'((?:[^']|'')*)'\s*:(?:\s+|$)/.exec(t);
    return m ? { key: m[1], rest: t.slice(m[0].length) } : null;
  }
  if (/^[[{?|>@`%]/.test(t)) return null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '#' && i > 0 && /\s/.test(t[i - 1])) return null;
    if ((c === '"' || c === "'") && /[\s[{,]/.test(t[i - 1] ?? ' ')) return null;
    if (c === ':' && (i + 1 === t.length || /\s/.test(t[i + 1]))) {
      const key = t.slice(0, i).trim();
      return key ? { key, rest: t.slice(i + 1).trim() } : null;
    }
  }
  return null;
}

/** Whether the brackets opened in a flow value ("[a, {b: c}]") are all closed. */
function flowClosed(text: string): boolean {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && /\s/.test(text[i - 1] ?? ' ')) {
      const end = text.indexOf('\n', i);
      if (end === -1) break;
      i = end;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !q;
}

interface YamlFrame {
  indent: number;
  seg: Seg | null;
  /** A "- " item of a list, as opposed to a key. */
  item: boolean;
  /** Items seen in the list this frame holds. */
  count: number;
  /** A key or item with nothing after it: an empty value unless children follow. */
  open: number | null;
  /** Keys seen directly under this frame, with their line. */
  keys: Map<string, number>;
}

function yamlKeys(text: string, problems?: SyntaxProblem[]): Raw[] {
  const lines = text.split('\n');
  const out: Raw[] = [];
  let doc = 0;
  let any = false;
  let stack: YamlFrame[] = [];
  const reset = () => (stack = [{ indent: -1, seg: null, item: false, count: 0, open: null, keys: new Map() }]);
  reset();
  const path = (): Seg[] => {
    const segs: Seg[] = doc ? [`document ${doc + 1}`] : [];
    for (const f of stack) if (f.seg !== null) segs.push(f.seg);
    return segs;
  };
  const top = () => stack[stack.length - 1];
  const pop = () => {
    const f = top();
    if (f.open !== null) out.push({ segs: path(), value: '', line: f.open });
    stack.pop();
  };
  let lastLeaf: Raw | null = null;
  let lastIndent = -1;
  let i = 0;

  const emit = (segs: Seg[], value: string, line: number, indent: number) => {
    lastLeaf = { segs, value, line };
    lastIndent = indent;
    out.push(lastLeaf);
  };

  const scalar = (segs: Seg[], rest: string, line: number, indent: number) => {
    let v = stripYamlComment(rest);
    // Anchors and tags are not part of the value.
    v = v.replace(/^(?:[&!][^\s]*\s+)+/, '');
    if (/^[|>][+\-\d]*$/.test(v)) {
      // A block of text: every following line indented deeper than the key.
      const body: string[] = [];
      while (i + 1 < lines.length) {
        const l = lines[i + 1];
        if (l.trim() && l.length - l.trimStart().length <= indent) break;
        body.push(l.trim());
        i++;
      }
      while (body.length && !body[body.length - 1]) body.pop();
      return emit(segs, body.join(v[0] === '|' ? '\n' : ' '), line, indent);
    }
    if (v[0] === '[' || v[0] === '{') {
      let flow = rest;
      for (let n = 0; !flowClosed(flow) && i + 1 < lines.length && n < 500; n++) flow += `\n${lines[++i]}`;
      try {
        const r = new Reader(flow, 'yaml');
        const node = r.value();
        r.skip();
        if (r.i >= flow.length) {
          const flat: Raw[] = [];
          flatten(node, segs, flat);
          for (const e of flat) out.push({ segs: e.segs, value: e.value, line: line + e.line });
          lastLeaf = null;
          return;
        }
      } catch {
        /* kept as text below */
      }
      return emit(segs, stripYamlComment(flow.replace(/\s*\n\s*/g, ' ')), line, indent);
    }
    if ((v[0] === '"' || v[0] === "'") && !new RegExp(v[0] === '"' ? '^"(?:[^"\\\\]|\\\\.)*"$' : "^'(?:[^']|'')*'$").test(v)) {
      // A quoted value that runs over several lines.
      let whole = rest;
      const closed = v[0] === '"' ? /^"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/ : /^'(?:[^']|'')*'\s*(?:#.*)?$/;
      for (let n = 0; !closed.test(whole) && i + 1 < lines.length && n < 200; n++) whole += ` ${lines[++i].trim()}`;
      v = stripYamlComment(whole);
    }
    emit(segs, v, line, indent);
  };

  const handle = (t: string, indent: number, line: number, inItem: boolean): void => {
    if (t === '-' || /^-\s/.test(t)) {
      while (stack.length > 1 && (top().indent > indent || (top().indent === indent && top().item))) pop();
      const holder = top();
      holder.open = null;
      stack.push({ indent, seg: holder.count++, item: true, count: 0, open: null, keys: new Map() });
      const rest = t.slice(1);
      const body = rest.trimStart();
      if (!body || body[0] === '#') {
        top().open = line;
        return;
      }
      return handle(body, indent + 1 + (rest.length - body.length), line, true);
    }
    const kv = yamlSplitKey(t);
    if (kv) {
      while (stack.length > 1 && top().indent >= indent && !(inItem && top().item && top().indent < indent)) pop();
      const parent = top();
      parent.open = null;
      const before = parent.keys.get(kv.key);
      if (before !== undefined && problems) {
        problems.push({ message: `"${formatPath([...path(), kv.key], 'yaml')}" is set twice (lines ${before + 1} and ${line + 1}).`, line });
      }
      parent.keys.set(kv.key, line);
      const rest = stripYamlComment(kv.rest).replace(/^(?:[&!][^\s]*(?:\s+|$))+/, '');
      if (!rest) {
        stack.push({ indent, seg: kv.key, item: false, count: 0, open: line, keys: new Map() });
        lastLeaf = null;
        return;
      }
      return scalar([...path(), kv.key], kv.rest, line, indent);
    }
    if (inItem) {
      top().open = null;
      return scalar(path(), t, line, indent);
    }
    // Neither a key nor an item: the previous value going on.
    if (lastLeaf && indent > lastIndent) lastLeaf.value += ` ${stripYamlComment(t)}`;
  };

  for (; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*(#.*)?$/.test(raw)) continue;
    if (/^---(\s|$)/.test(raw)) {
      while (stack.length > 1) pop();
      if (any) doc++;
      reset();
      lastLeaf = null;
      continue;
    }
    if (/^\.\.\.(\s|$)/.test(raw) || (!any && raw[0] === '%')) continue;
    any = true;
    const indent = raw.length - raw.trimStart().length;
    handle(raw.slice(indent).trimEnd(), indent, i, false);
  }
  while (stack.length > 1) pop();
  return out.sort((a, b) => a.line - b.line);
}

// ── .properties and INI ─────────────────────────────────

function propertiesKeys(text: string, ini: boolean, problems?: SyntaxProblem[]): Raw[] {
  const lines = text.split('\n');
  const out: Raw[] = [];
  const seen = new Map<string, number>();
  let section: Seg[] = [];
  const counts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].trimStart();
    if (!l || l[0] === '#' || (ini ? l[0] === ';' : l[0] === '!')) continue;
    const line = i;
    if (ini) {
      const sec = /^\[(\[?)\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$/.exec(l);
      if (sec) {
        section = sec[2].split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''));
        if (sec[1]) {
          // TOML's [[name]]: one more table in a list.
          const k = segKey(section);
          const n = counts.get(k) ?? 0;
          counts.set(k, n + 1);
          section = [...section, n];
        }
        continue;
      }
      l = l.replace(/^export\s+/, '');
    } else {
      // A line ending in an odd number of backslashes goes on in the next one.
      while (/(?:^|[^\\])(?:\\\\)*\\$/.test(l) && i + 1 < lines.length) l = l.slice(0, -1) + lines[++i].trimStart();
    }
    let k = 0;
    while (k < l.length) {
      const c = l[k];
      if (c === '\\' && !ini) k += 2;
      else if (c === '=' || (c === ':' && !ini) || (/\s/.test(c) && !ini)) break;
      else k++;
    }
    const key = (ini ? l.slice(0, k).trim().replace(/^["']|["']$/g, '') : l.slice(0, k).replace(/\\(.)/g, '$1'));
    if (!key) continue;
    let value = l.slice(k).replace(ini ? /^\s*=\s*/ : /^\s*[=:]?\s*/, '');
    if (ini) value = value.trim();
    const segs = [...section, ...key.split('.')];
    const id = segKey(segs);
    const before = seen.get(id);
    if (before !== undefined && problems) problems.push({ message: `"${formatPath(segs, 'properties')}" is set twice (lines ${before + 1} and ${line + 1}).`, line });
    seen.set(id, line);
    out.push({ segs, value, line });
  }
  const last = new Map<string, Raw>();
  for (const e of out) last.set(segKey(e.segs), e);
  return [...last.values()];
}

// ── XML ─────────────────────────────────────────────────

interface XNode {
  tag: string;
  attrs: { name: string; value: string; line: number }[];
  children: XNode[];
  text: string;
  line: number;
}

const BAD_AMP = /&(?!(?:[A-Za-z_][\w.-]*|#\d+|#x[0-9a-fA-F]+);)/;
const XML_IDS = ['name', 'id', 'key', 'ref'];

/** Reads the element tree, forgivingly, and notes the first thing that makes it not well formed. */
function xmlScan(text: string): { root: XNode | null; problem: SyntaxProblem | null } {
  const lines = new LineIndex(text);
  let problem: SyntaxProblem | null = null;
  const fail = (message: string, at: number) => {
    problem ??= { message, line: lines.at(at) };
  };
  let root: XNode | null = null;
  let roots = 0;
  const stack: XNode[] = [];
  let p = 0;
  const addText = (s: string, at: number, literal = false) => {
    if (!s.trim()) return;
    const cur = stack[stack.length - 1];
    if (!cur) return fail('There is text outside the root element.', at + (s.length - s.trimStart().length));
    if (!literal) {
      const amp = BAD_AMP.exec(s);
      if (amp) fail('An & must be written as &amp;.', at + amp.index);
    }
    cur.text += s;
  };
  while (p < text.length) {
    const lt = text.indexOf('<', p);
    if (lt === -1) {
      addText(text.slice(p), p);
      break;
    }
    addText(text.slice(p, lt), p);
    const until = (end: string, what: string): number => {
      const e = text.indexOf(end, lt);
      if (e === -1) {
        fail(`${what} is never closed.`, lt);
        return text.length;
      }
      return e + end.length;
    };
    if (text.startsWith('<!--', lt)) p = until('-->', 'A comment');
    else if (text.startsWith('<![CDATA[', lt)) {
      p = until(']]>', 'A CDATA section');
      addText(text.slice(lt + 9, Math.max(lt + 9, p - 3)), lt, true);
    } else if (text.startsWith('<?', lt)) p = until('?>', 'A <? instruction');
    else if (text.startsWith('<!', lt)) {
      const gt = text.indexOf('>', lt);
      const sub = text.indexOf('[', lt);
      p = sub !== -1 && gt !== -1 && sub < gt ? until(']>', 'The DOCTYPE') : until('>', 'A <! declaration');
    } else if (text[lt + 1] === '/') {
      const m = /^<\/([^\s>]*)\s*>/.exec(text.slice(lt, lt + 300));
      if (!m) {
        fail('A closing tag is not finished.', lt);
        p = lt + 2;
        continue;
      }
      p = lt + m[0].length;
      const cur = stack[stack.length - 1];
      if (cur?.tag === m[1]) stack.pop();
      else {
        fail(cur ? `</${m[1]}> closes <${cur.tag}>, which was opened on line ${cur.line + 1}.` : `</${m[1]}> closes nothing.`, lt);
        const up = stack.map((n) => n.tag).lastIndexOf(m[1]);
        if (up !== -1) stack.length = up;
      }
    } else {
      const name = /^<([A-Za-z_:][\w:.-]*)/.exec(text.slice(lt, lt + 200));
      if (!name) {
        fail('A < that does not start a tag must be written as &lt;.', lt);
        addText('<', lt, true);
        p = lt + 1;
        continue;
      }
      const node: XNode = { tag: name[1], attrs: [], children: [], text: '', line: lines.at(lt) };
      p = lt + name[0].length;
      let closed = false;
      let selfClosing = false;
      while (p < text.length) {
        const ws = /\s*/y;
        ws.lastIndex = p;
        ws.exec(text);
        p = ws.lastIndex;
        if (text[p] === '>') {
          p++;
          closed = true;
          break;
        }
        if (text.startsWith('/>', p)) {
          p += 2;
          closed = selfClosing = true;
          break;
        }
        const attr = /([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
        attr.lastIndex = p;
        const a = attr.exec(text);
        if (!a) {
          fail(`In <${node.tag}>, an attribute needs a value in quotes.`, p);
          const gt = text.indexOf('>', p);
          p = gt === -1 ? text.length : gt + 1;
          closed = gt !== -1;
          selfClosing = gt !== -1 && text[gt - 1] === '/';
          break;
        }
        const value = a[2] ?? a[3];
        if (node.attrs.some((x) => x.name === a[1])) fail(`<${node.tag}> has the attribute ${a[1]} twice.`, p);
        if (value.includes('<')) fail(`In ${a[1]}, a < must be written as &lt;.`, p);
        else if (BAD_AMP.test(value)) fail(`In ${a[1]}, an & must be written as &amp;.`, p);
        node.attrs.push({ name: a[1], value, line: lines.at(p) });
        p = attr.lastIndex;
      }
      if (!closed) fail(`The tag <${node.tag}> is not finished.`, lt);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else {
        if (++roots > 1) fail('There is more than one root element.', lt);
        root ??= node;
      }
      if (!selfClosing) stack.push(node);
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    fail(`<${open.tag}>, opened on line ${open.line + 1}, is never closed.`, text.length);
  } else if (!root && text.trim()) fail('There is no root element.', 0);
  return { root, problem };
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, n: string) => XML_ENTITIES[n]);

function xmlKeys(text: string): Raw[] | null {
  const { root } = xmlScan(text);
  if (!root) return null;
  const out: Raw[] = [];
  const walk = (node: XNode, segs: Seg[], idAttr: string | null) => {
    let own = 0;
    for (const a of node.attrs) {
      if (a.name === idAttr) continue;
      out.push({ segs: [...segs, `@${a.name}`], value: xmlText(a.value), line: a.line });
      own++;
    }
    const text = node.text.trim().replace(/\s+/g, ' ');
    if (!node.children.length && (text || !own)) out.push({ segs: segs.length ? segs : [node.tag], value: xmlText(text), line: node.line });
    // Children are told apart by their name="…" (or id, key, ref), else by position among the same tag.
    const labels = node.children.map((c) => {
      const id = XML_IDS.find((n) => c.attrs.some((a) => a.name === n)) ?? null;
      return { id, label: id ? `${c.tag}[${c.attrs.find((a) => a.name === id)!.value}]` : c.tag };
    });
    const total = new Map<string, number>();
    for (const l of labels) total.set(l.label, (total.get(l.label) ?? 0) + 1);
    const nth = new Map<string, number>();
    node.children.forEach((c, i) => {
      const { id, label } = labels[i];
      const n = (nth.get(label) ?? 0) + 1;
      nth.set(label, n);
      walk(c, [...segs, total.get(label)! > 1 ? `${label}[${n}]` : label], id);
    });
  };
  walk(root, [], null);
  return out;
}

// ── Reading and comparing ───────────────────────────────

/** A list of plain values ("hosts[0]", "hosts[1]"…) reads better as one setting: hosts = [a, b]. */
function foldLists(entries: Raw[]): Raw[] {
  const lists = new Map<string, { items: Raw[]; plain: boolean }>();
  for (const e of entries) {
    for (let k = 0; k < e.segs.length; k++) {
      if (typeof e.segs[k] !== 'number') continue;
      const id = segKey(e.segs, k);
      let l = lists.get(id);
      if (!l) lists.set(id, (l = { items: [], plain: true }));
      if (k === e.segs.length - 1) l.items.push(e);
      else l.plain = false;
    }
  }
  const drop = new Set<Raw>();
  const folded: Raw[] = [];
  for (const l of lists.values()) {
    if (!l.plain || !l.items.length) continue;
    for (const e of l.items) drop.add(e);
    folded.push({ segs: l.items[0].segs.slice(0, -1), value: `[${l.items.map((e) => e.value).join(', ')}]`, line: l.items[0].line });
  }
  if (!folded.length) return entries;
  return [...entries.filter((e) => !drop.has(e)), ...folded].sort((a, b) => a.line - b.line);
}

/**
 * The settings in a config file, in file order. Null when the format has no structure to read
 * (plain text) or none was found.
 */
export function readKeys(text: string, kind: FileKind): KeyEntry[] | null {
  let raw: Raw[] | null;
  try {
    raw =
      kind === 'yaml' ? yamlKeys(text)
      : kind === 'json' ? jsonKeys(text)
      : kind === 'js' ? jsKeys(text)
      : kind === 'properties' || kind === 'ini' ? propertiesKeys(text, kind === 'ini')
      : kind === 'xml' ? xmlKeys(text)
      : null;
  } catch {
    raw = null;
  }
  if (!raw?.length) return null;
  return foldLists(raw).map((e) => ({ ...e, path: formatPath(e.segs, kind) }));
}

/** A new or dropped setting, or a whole section of them. */
export interface KeyChange {
  path: string;
  /** Settings under it: 1 for a single setting, more for a section. */
  count: number;
  /** The value, for a single setting. */
  value?: string;
  /** 0-based line in the version that has it. */
  line: number;
}

export interface ValueChange {
  path: string;
  from: string;
  to: string;
  /** 0-based lines in the first and second version. */
  lineFrom: number;
  lineTo: number;
}

export interface KeyDelta {
  /** In the second version only. */
  added: KeyChange[];
  /** In the first version only. */
  removed: KeyChange[];
  /** In both, with another value. */
  changed: ValueChange[];
}

/** Values compared without their quotes and with runs of spaces as one. */
function sameValue(a: string, b: string): boolean {
  const norm = (v: string) => unquote(v.trim().replace(/,$/, '')).replace(/\s+/g, ' ');
  return a === b || norm(a) === norm(b);
}

function onlyIn(mine: KeyEntry[], theirs: KeyEntry[], kind: FileKind): KeyChange[] {
  const leaves = new Set(theirs.map((e) => segKey(e.segs)));
  const prefixes = new Set<string>();
  for (const e of theirs) for (let k = 1; k <= e.segs.length; k++) prefixes.add(segKey(e.segs, k));
  const groups = new Map<string, { section: Seg[]; entries: KeyEntry[] }>();
  for (const e of mine) {
    // There as a setting, or as a section with settings of its own (an element that lost its children).
    if (leaves.has(segKey(e.segs)) || prefixes.has(segKey(e.segs))) continue;
    // The topmost part of the path the other version does not have at all: a new section is one change.
    let k = 1;
    while (k < e.segs.length && prefixes.has(segKey(e.segs, k))) k++;
    const id = segKey(e.segs, k);
    const g = groups.get(id);
    if (g) g.entries.push(e);
    else groups.set(id, { section: e.segs.slice(0, k), entries: [e] });
  }
  return [...groups.values()]
    .map(({ section, entries }): KeyChange =>
      entries.length === 1
        ? { path: entries[0].path, count: 1, value: entries[0].value, line: entries[0].line }
        : { path: formatPath(section, kind), count: entries.length, line: Math.min(...entries.map((e) => e.line)) },
    )
    .sort((a, b) => a.line - b.line);
}

/** What the second version adds, drops and sets differently, compared with the first. */
export function compareKeys(first: KeyEntry[], second: KeyEntry[], kind: FileKind): KeyDelta {
  const byPath = new Map(first.map((e) => [segKey(e.segs), e]));
  const changed: ValueChange[] = [];
  for (const e of second) {
    const f = byPath.get(segKey(e.segs));
    if (f && !sameValue(f.value, e.value)) changed.push({ path: e.path, from: f.value, to: e.value, lineFrom: f.line, lineTo: e.line });
  }
  return { added: onlyIn(second, first, kind), removed: onlyIn(first, second, kind), changed };
}

/** Settings counted, sections by what is in them. */
export const countKeys = (changes: readonly KeyChange[]): number => changes.reduce((n, c) => n + c.count, 0);

// ── Does it still read as its format? ───────────────────

function lineOfOffset(text: string, offset: number): number {
  let line = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function jsonProblem(text: string): SyntaxProblem | null {
  try {
    JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const message = (err as Error).message;
    const pos = /position (\d+)/.exec(message);
    const ln = /line (\d+)/.exec(message);
    const line = ln ? Number(ln[1]) - 1 : pos ? lineOfOffset(text, Number(pos[1])) : undefined;
    return { message: message.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+/, '').replace(/^JSON\.parse: /, ''), line };
  }
  // Valid, but a key twice in one object is nearly always a merge slip.
  const dup = (node: Node, segs: Seg[]): SyntaxProblem | null => {
    if (node.t === 'leaf') return null;
    if (node.t === 'arr') {
      for (let i = 0; i < node.items.length; i++) {
        const p = dup(node.items[i], [...segs, i]);
        if (p) return p;
      }
      return null;
    }
    const seen = new Map<string, number>();
    for (const e of node.entries) {
      const before = seen.get(e.key);
      if (before !== undefined) return { message: `"${formatPath([...segs, e.key], 'json')}" is set twice (lines ${before + 1} and ${e.line + 1}).`, line: e.line };
      seen.set(e.key, e.line);
      const p = dup(e.v, [...segs, e.key]);
      if (p) return p;
    }
    return null;
  };
  try {
    return dup(new Reader(text, 'js').value(), []);
  } catch {
    return null;
  }
}

function jsProblem(text: string): SyntaxProblem | null {
  const r = new Reader(text, 'js');
  const open: { close: string; at: number }[] = [];
  try {
    for (;;) {
      r.skip();
      const c = text[r.i];
      if (c === undefined) break;
      if (c === '"' || c === "'" || c === '`') r.i = r.stringEnd(r.i);
      else if (c === '/' && r.regexAt(r.i)) r.i = r.regexEnd(r.i);
      else {
        if (OPEN[c]) open.push({ close: OPEN[c], at: r.i });
        else if (c === '}' || c === ']' || c === ')') {
          const o = open.pop();
          if (!o) return { message: `There is a ${c} without an opening bracket.`, line: r.lines.at(r.i) };
          if (o.close !== c) return { message: `A ${c} closes the ${text[o.at]} opened on line ${r.lines.at(o.at) + 1}.`, line: r.lines.at(r.i) };
        }
        r.i++;
      }
    }
  } catch (err) {
    if (err instanceof ParseFail) return { message: `${err.message}.`, line: r.lines.at(err.offset) };
    throw err;
  }
  const o = open.pop();
  return o ? { message: `The ${text[o.at]} opened on line ${r.lines.at(o.at) + 1} is never closed.`, line: r.lines.at(o.at) } : null;
}

/**
 * The first thing wrong with a text as its format, or null. Strict for YAML, JSON and XML;
 * for .properties and INI only a key set twice; for JavaScript unbalanced brackets and strings.
 */
export function checkSyntax(text: string, kind: FileKind): SyntaxProblem | null {
  if (kind === 'json') return jsonProblem(text);
  if (kind === 'xml') return xmlScan(text).problem;
  if (kind === 'js') return jsProblem(text);
  const problems: SyntaxProblem[] = [];
  if (kind === 'yaml') {
    try {
      parseYaml(text);
    } catch (err) {
      const message = (err as Error).message;
      const m = /^YAML line (\d+): (.*)$/s.exec(message);
      return m ? { message: m[2].charAt(0).toUpperCase() + m[2].slice(1) + '.', line: Number(m[1]) - 1 } : { message };
    }
    yamlKeys(text, problems);
  } else if (kind === 'properties' || kind === 'ini') propertiesKeys(text, kind === 'ini', problems);
  return problems[0] ?? null;
}

/**
 * What is wrong with a merged result that was not wrong before: the problem `checkSyntax` finds
 * in it, unless the versions it was merged from have a problem too (a file with JSON comments, or
 * YAML this reader does not cover, would otherwise always be reported).
 */
export function syntaxRegression(result: string, kind: FileKind, originals: readonly string[]): SyntaxProblem | null {
  if (originals.includes(result)) return null;
  const problem = checkSyntax(result, kind);
  if (!problem) return null;
  return originals.some((o) => !checkSyntax(o, kind)) ? problem : null;
}
