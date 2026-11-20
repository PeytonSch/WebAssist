// The XML viewer's model: a small, forgiving XML parser, a pretty-printer, SOAP recognition,
// XPaths for nodes, search and tables. No DOM, so it runs under Node for the tests.
//
// The parser is written here rather than using DOMParser: captured bodies are untrusted, and
// this one has no way to load a DTD or expand an entity (a DOCTYPE is skipped, entities other
// than the five built-in ones and character references stay as written). It also keeps going
// where DOMParser gives up: a body cut off at the capture limit still gives a tree, with the
// elements that never closed marked `cut`.

import { parseJson, plural, type ParseError } from './jsonmodel';

export interface XAttr {
  t: 'attr';
  /** As written: "xsi:type". */
  name: string;
  prefix: string;
  local: string;
  /** Namespace URI; null for an attribute without a prefix (they are in no namespace). */
  ns: string | null;
  value: string;
  /** The value as written, kept only when it has an entity XML does not define (see XText.src). */
  src?: string;
  /** An xmlns or xmlns:prefix declaration. */
  decl: boolean;
  parent: XEl;
  ord: number;
}

export interface XEl {
  t: 'el';
  name: string;
  prefix: string;
  local: string;
  ns: string | null;
  attrs: XAttr[];
  kids: XChild[];
  parent: XEl | null;
  /** Offset of its "<" in the text. */
  pos: number;
  /** Document order, for sorting query results. */
  ord: number;
  /** The text ended before its closing tag. */
  cut?: boolean;
}

export interface XText {
  t: 'text';
  v: string;
  cdata: boolean;
  parent: XEl | null;
  ord: number;
  cut?: boolean;
  /**
   * The text as written, kept only when it has an entity XML does not define (&nbsp;). Such an
   * entity stays in `v` as written, so writing `v` back out would turn it into &amp;nbsp;.
   */
  src?: string;
}

export interface XComment {
  t: 'comment';
  v: string;
  parent: XEl | null;
  ord: number;
  cut?: boolean;
}

export interface XPI {
  t: 'pi';
  target: string;
  v: string;
  parent: XEl | null;
  ord: number;
  cut?: boolean;
}

export type XChild = XEl | XText | XComment | XPI;
export type XNode = XChild | XAttr;

export interface XmlParse {
  /** Null when there is no element, or on a syntax error. */
  root: XEl | null;
  /** Comments and processing instructions before and after the root element. */
  before: XChild[];
  after: XChild[];
  /** The <?xml …?> declaration, as written. */
  decl: string | null;
  /** There is a DOCTYPE. It is skipped: nothing in it is read or loaded. */
  doctype: boolean;
  /** The text ended inside the document. Open elements are kept, marked `cut`. */
  partial: boolean;
  error: ParseError | null;
  /** Where the root element ended (with `trailing`), or where parsing stopped. */
  end: number;
  /** How many elements were read. */
  elements: number;
  /** The first namespace each prefix was bound to ("" is the default namespace). */
  prefixes: Map<string, string>;
  /** Entity references that are not built in (&nbsp;), left as written. */
  unknownEntities: number;
}

export const isEl = (n: XNode | null | undefined): n is XEl => !!n && n.t === 'el';

/** True when the element holds only text (or nothing), so it shows on one line with its value. */
export function isLeaf(el: XEl): boolean {
  for (const k of el.kids) if (k.t !== 'text') return false;
  return true;
}

/** The child elements. */
export function elements(el: XEl): XEl[] {
  return el.kids.filter(isEl);
}

/** Attributes that are not namespace declarations. */
export function plainAttrs(el: XEl): XAttr[] {
  return el.attrs.some((a) => a.decl) ? el.attrs.filter((a) => !a.decl) : el.attrs;
}

export function nsDecls(el: XEl): XAttr[] {
  return el.attrs.filter((a) => a.decl);
}

/** The text of a node: an element's is all the text inside it, as in XPath. */
export function textOf(n: XNode, max = Infinity): string {
  if (n.t === 'attr') return n.value;
  if (n.t !== 'el') return n.v;
  if (n.kids.length === 1 && n.kids[0].t === 'text') return n.kids[0].v;
  let out = '';
  const stack: XChild[] = [n];
  while (stack.length && out.length < max) {
    const x = stack.pop()!;
    if (x.t === 'text') out += x.v;
    else if (x.t === 'el') for (let k = x.kids.length - 1; k >= 0; k--) stack.push(x.kids[k]);
  }
  return out;
}

// ── Parser ──────────────────────────────────────────────

const WS = /[ \t\r\n]*/y;
/** A name: anything up to white space or markup. Forgiving on purpose (no Unicode tables). */
const NAME = /[^\s<>/=!?"'&][^\s<>/="']*/y;
const NOT_WS = /[^ \t\r\n]/;
const ENTITY = /&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g;
const BUILT_IN: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';

/** Namespace bindings in scope; a new one (chained to its parent) per element that declares any. */
type Scope = Record<string, string>;

/**
 * Parses XML into a tree. Never throws: a syntax error is returned with its position, and text
 * that simply ends early gives the tree so far with `partial` set. With `trailing`, parsing
 * stops after the root element and `end` says where (for XML inside a log message).
 */
export function parseXml(text: string, opts: { from?: number; trailing?: boolean } = {}): XmlParse {
  const s = text;
  const len = s.length;
  let i = opts.from ?? 0;
  if (i === 0 && s.charCodeAt(0) === 0xfeff) i = 1;
  const res: XmlParse = {
    root: null, before: [], after: [], decl: null, doctype: false, partial: false, error: null, end: len, elements: 0, prefixes: new Map(), unknownEntities: 0,
  };
  let ord = 0;
  let root: XEl | null = null;
  let rootDone = false;
  const open: XEl[] = [];
  const scopes: Scope[] = [{ xml: XML_NS, xmlns: XMLNS_NS }];
  let cur: XEl | null = null;

  /** Set by `decode` when the text it was given had an entity that is not built in. */
  let unknown = false;
  const decode = (raw: string): string => {
    unknown = false;
    if (raw.indexOf('&') === -1) return raw;
    return raw.replace(ENTITY, (m, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        // Not a character XML allows: leave it as written rather than fail.
        if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return m;
        return String.fromCodePoint(code);
      }
      const v = BUILT_IN[name];
      if (v === undefined) {
        res.unknownEntities++;
        unknown = true;
      }
      return v ?? m;
    });
  };
  const fail = (message: string, pos: number): XmlParse => {
    res.error = errorAt(s, message, pos);
    res.root = null;
    res.end = pos;
    return res;
  };
  /** Drops the white space between child elements; text beside real text stays as it is. */
  const tidy = (el: XEl): void => {
    const kids = el.kids;
    let other = false;
    let blank = false;
    for (const k of kids) {
      if (k.t !== 'text') other = true;
      else if (!k.cdata && !NOT_WS.test(k.v)) blank = true;
    }
    if (other && blank) el.kids = kids.filter((k) => k.t !== 'text' || k.cdata || NOT_WS.test(k.v));
  };
  const addText = (v: string, cdata: boolean, cut: boolean, at: number, src?: string): XmlParse | null => {
    if (cur) {
      const node: XText = { t: 'text', v, cdata, parent: cur, ord: ord++ };
      if (cut) node.cut = true;
      if (src !== undefined) node.src = src;
      cur.kids.push(node);
    } else if (cdata || NOT_WS.test(v)) {
      return fail(root ? 'Text after the end of the root element' : 'Text before the root element', at + (cdata ? 0 : v.search(NOT_WS)));
    }
    return null;
  };
  /** The text ran out: keep what is open, marked cut. */
  const ended = (): XmlParse => {
    res.partial = true;
    for (const el of open) {
      el.cut = true;
      tidy(el);
    }
    res.root = root;
    res.end = len;
    return res;
  };
  const misc = (node: XComment | XPI): void => {
    if (cur) cur.kids.push(node);
    else (root ? res.after : res.before).push(node);
  };

  while (i < len) {
    const lt = s.indexOf('<', i);
    if (lt === -1) {
      // Text up to the end. Inside an element that means the document was cut off.
      const raw = s.slice(i);
      if (cur) {
        const v = decode(raw);
        addText(v, false, true, i, unknown ? raw : undefined);
        return ended();
      }
      if (NOT_WS.test(raw)) {
        if (rootDone && opts.trailing) break;
        return fail(root ? 'Text after the end of the root element' : 'Text before the root element', i + raw.search(NOT_WS));
      }
      i = len;
      break;
    }
    if (lt > i) {
      if (rootDone && opts.trailing && NOT_WS.test(s.slice(i, lt))) break;
      const raw = s.slice(i, lt);
      const v = decode(raw);
      const bad = addText(v, false, false, i, unknown ? raw : undefined);
      if (bad) return bad;
    }
    i = lt;
    const c = s.charCodeAt(i + 1);

    if (c === 33 /* ! */) {
      if (s.startsWith('<!--', i)) {
        const close = s.indexOf('-->', i + 4);
        const node: XComment = { t: 'comment', v: s.slice(i + 4, close === -1 ? len : close), parent: cur, ord: ord++ };
        if (close === -1) {
          node.cut = true;
          misc(node);
          return ended();
        }
        misc(node);
        i = close + 3;
      } else if (s.startsWith('<![CDATA[', i)) {
        const close = s.indexOf(']]>', i + 9);
        const bad = addText(s.slice(i + 9, close === -1 ? len : close), true, close === -1, i);
        if (bad) return bad;
        if (close === -1) return ended();
        i = close + 3;
      } else if (/^<!DOCTYPE/i.test(s.slice(i, i + 9))) {
        if (root) return fail('A DOCTYPE after the root element', i);
        // Skipped whole, with its internal subset: nothing in it is read, loaded or expanded.
        const close = skipDoctype(s, i + 9);
        res.doctype = true;
        if (close === -1) return ended();
        i = close;
      } else if (i + 2 >= len || '<!--'.startsWith(s.slice(i)) || '<![CDATA['.startsWith(s.slice(i))) {
        return ended();
      } else {
        return fail('Unexpected "<!"', i);
      }
      continue;
    }

    if (c === 63 /* ? */) {
      const close = s.indexOf('?>', i + 2);
      const body = s.slice(i + 2, close === -1 ? len : close);
      const sp = body.search(/\s/);
      const target = sp === -1 ? body : body.slice(0, sp);
      if (target.toLowerCase() === 'xml' && !root && !res.before.length && close !== -1) {
        res.decl = s.slice(i, close + 2);
      } else {
        const node: XPI = { t: 'pi', target, v: sp === -1 ? '' : body.slice(sp + 1).trim(), parent: cur, ord: ord++ };
        if (close === -1) node.cut = true;
        misc(node);
      }
      if (close === -1) return ended();
      i = close + 2;
      continue;
    }

    if (c === 47 /* / */) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(s);
      if (!m) return i + 2 >= len ? ended() : fail('Expected a name after "</"', i + 2);
      let j = NAME.lastIndex;
      WS.lastIndex = j;
      WS.exec(s);
      j = WS.lastIndex;
      if (j >= len) return ended();
      if (!cur) return fail(`Closing tag </${m[0]}> without an opening tag`, i);
      if (m[0] !== cur.name) {
        const at = lineCol(s, cur.pos);
        return fail(`Closing tag </${m[0]}> does not match <${cur.name}> (opened at line ${at.line}, column ${at.col})`, i);
      }
      if (s.charCodeAt(j) !== 62) return fail(`Expected ">" to end </${m[0]}`, j);
      i = j + 1;
      tidy(cur);
      open.pop();
      scopes.pop();
      cur = open.length ? open[open.length - 1] : null;
      if (!cur) {
        rootDone = true;
        if (opts.trailing) {
          res.end = i;
          res.root = root;
          return res;
        }
      }
      continue;
    }

    // An opening tag.
    NAME.lastIndex = i + 1;
    const m = NAME.exec(s);
    if (!m) return i + 1 >= len ? ended() : fail('Expected a tag name after "<" (a "<" in text is written &lt;)', i);
    if (rootDone) {
      if (opts.trailing) break;
      return fail(`A second root element <${m[0]}>: a document has one`, i);
    }
    const name = m[0];
    const colon = name.indexOf(':');
    const el: XEl = {
      t: 'el', name, prefix: colon > 0 ? name.slice(0, colon) : '', local: colon > 0 ? name.slice(colon + 1) : name, ns: null, attrs: [], kids: [], parent: cur, pos: i, ord: ord++,
    };
    res.elements++;
    let j = NAME.lastIndex;
    let scope = scopes[scopes.length - 1];
    let declared = false;
    let selfClosed = false;
    let cutInTag = false;
    for (;;) {
      WS.lastIndex = j;
      WS.exec(s);
      j = WS.lastIndex;
      if (j >= len) {
        cutInTag = true;
        break;
      }
      const ch = s.charCodeAt(j);
      if (ch === 62 /* > */) {
        j++;
        break;
      }
      if (ch === 47 /* / */) {
        if (j + 1 >= len) {
          cutInTag = true;
          break;
        }
        if (s.charCodeAt(j + 1) !== 62) return fail(`Expected ">" after "/" in <${name}>`, j + 1);
        selfClosed = true;
        j += 2;
        break;
      }
      NAME.lastIndex = j;
      const am = NAME.exec(s);
      if (!am) return fail(`Unexpected ${JSON.stringify(s[j])} in <${name}>`, j);
      const aname = am[0];
      let k = NAME.lastIndex;
      WS.lastIndex = k;
      WS.exec(s);
      k = WS.lastIndex;
      if (k >= len) {
        cutInTag = true;
        break;
      }
      if (s.charCodeAt(k) !== 61 /* = */) return fail(`Attribute ${aname} in <${name}> has no value`, k);
      WS.lastIndex = k + 1;
      WS.exec(s);
      k = WS.lastIndex;
      if (k >= len) {
        cutInTag = true;
        break;
      }
      const q = s[k];
      if (q !== '"' && q !== "'") return fail(`The value of attribute ${aname} in <${name}> must be in quotes`, k);
      const close = s.indexOf(q, k + 1);
      const rawValue = s.slice(k + 1, close === -1 ? len : close);
      const value = decode(rawValue);
      const keep = unknown;
      const ac = aname.indexOf(':');
      const decl = aname === 'xmlns' || aname.startsWith('xmlns:');
      const attr: XAttr = {
        t: 'attr', name: aname, prefix: ac > 0 ? aname.slice(0, ac) : '', local: ac > 0 ? aname.slice(ac + 1) : aname, ns: null, value, decl, parent: el, ord: ord++,
      };
      if (keep) attr.src = rawValue;
      el.attrs.push(attr);
      if (decl) {
        if (!declared) {
          scope = Object.create(scope) as Scope;
          declared = true;
        }
        const p = aname === 'xmlns' ? '' : attr.local;
        scope[p] = value;
        if (!res.prefixes.has(p)) res.prefixes.set(p, value);
      }
      if (close === -1) {
        cutInTag = true;
        break;
      }
      j = close + 1;
    }
    // Resolved once all of the tag's declarations are known: they apply to the tag itself.
    el.ns = scope[el.prefix] || null;
    for (const a of el.attrs) a.ns = a.decl ? XMLNS_NS : a.prefix ? scope[a.prefix] || null : null;
    if (cur) cur.kids.push(el);
    else root = el;
    if (cutInTag) {
      open.push(el);
      return ended();
    }
    i = j;
    if (selfClosed) {
      if (!cur) {
        rootDone = true;
        if (opts.trailing) {
          res.end = i;
          res.root = root;
          return res;
        }
      }
    } else {
      open.push(el);
      scopes.push(scope);
      cur = el;
    }
  }

  if (open.length) return ended();
  res.root = root;
  res.end = rootDone && opts.trailing ? i : len;
  return res;
}

/** The index after the DOCTYPE's closing ">", or -1 when the text ends first. */
function skipDoctype(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const close = s.indexOf(c, i + 1);
      if (close === -1) return -1;
      i = close;
    } else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '<' && s.startsWith('<!--', i)) {
      const close = s.indexOf('-->', i + 4);
      if (close === -1) return -1;
      i = close + 2;
    } else if (c === '>' && depth <= 0) return i + 1;
  }
  return -1;
}

function lineCol(s: string, pos: number): { line: number; col: number } {
  let line = 1;
  let start = 0;
  for (let k = s.indexOf('\n'); k !== -1 && k < pos; k = s.indexOf('\n', k + 1)) {
    line++;
    start = k + 1;
  }
  return { line, col: pos - start + 1 };
}

function errorAt(s: string, message: string, pos: number): ParseError {
  return { message, pos, ...lineCol(s, pos) };
}

// ── Writing ─────────────────────────────────────────────

const escText = (v: string) => v.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const escAttr = (v: string) => v.replace(/[&<"\n\t]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '"' ? '&quot;' : c === '\n' ? '&#10;' : '&#9;'));

class Writer {
  parts: string[] = [];
  size = 0;
  constructor(readonly limit: number) {}
  add(s: string): boolean {
    this.parts.push(s);
    this.size += s.length;
    return this.size < this.limit;
  }
}

function openTag(el: XEl): string {
  let out = `<${el.name}`;
  for (const a of el.attrs) out += ` ${a.name}="${attrMarkup(a)}"`;
  return out;
}

const attrMarkup = (a: XAttr) => (a.src !== undefined ? a.src.replace(/"/g, '&quot;') : escAttr(a.value));
const textMarkup = (t: XText) => (t.cdata ? `<![CDATA[${t.v.replace(/]]>/g, ']]]]><![CDATA[>')}]]>` : t.src ?? escText(t.v));

/** A node with text beside elements is written on one line: white space there is content. */
function writeInline(n: XChild, out: Writer): boolean {
  switch (n.t) {
    case 'text': return out.add(textMarkup(n));
    case 'comment': return out.add(`<!--${n.v}-->`);
    case 'pi': return out.add(`<?${n.target}${n.v ? ' ' + n.v : ''}?>`);
    case 'el': {
      if (!n.kids.length) return out.add(`${openTag(n)}/>`);
      if (!out.add(`${openTag(n)}>`)) return false;
      for (const k of n.kids) if (!writeInline(k, out)) return false;
      return out.add(`</${n.name}>`);
    }
  }
}

function write(n: XChild, pad: string, indent: string, out: Writer): boolean {
  if (n.t !== 'el') return out.add(pad) && writeInline(n, out) && out.add('\n');
  if (!n.kids.length) return out.add(`${pad}${openTag(n)}/>\n`);
  if (n.kids.some((k) => k.t === 'text')) return out.add(pad) && writeInline(n, out) && out.add('\n');
  if (!out.add(`${pad}${openTag(n)}>\n`)) return false;
  for (const k of n.kids) if (!write(k, pad + indent, indent, out)) return false;
  return out.add(`${pad}</${n.name}>\n`);
}

/** A node as indented XML. Elements that hold text are kept on one line, so no text changes. */
export function serialize(n: XNode, indent = 2): string {
  return serializeCapped(n, indent, Infinity).text;
}

/** Like `serialize`, but stops soon after `limit` characters. */
export function serializeCapped(n: XNode, indent: number, limit: number): { text: string; cut: boolean } {
  if (n.t === 'attr') return { text: `${n.name}="${attrMarkup(n)}"`, cut: false };
  const out = new Writer(limit);
  const done = write(n, '', ' '.repeat(indent), out);
  const text = out.parts.join('').replace(/\n$/, '');
  return { text, cut: !done };
}

/** The whole document, pretty-printed: declaration, comments around the root, and the root. */
export function serializeDocument(p: XmlParse, indent = 2): string {
  if (!p.root) return '';
  const parts: string[] = [];
  if (p.decl) parts.push(p.decl);
  for (const n of p.before) parts.push(serialize(n, indent));
  parts.push(serialize(p.root, indent));
  for (const n of p.after) parts.push(serialize(n, indent));
  return parts.join('\n') + '\n';
}

/** Past this size the detail panel shows XML as captured instead of pretty-printing it. */
const PRETTY_MAX = 2_000_000;

/** `text` pretty-printed, or null when it is not complete, well-formed XML (or is very large). */
export function prettyXml(text: string): string | null {
  if (text.length > PRETTY_MAX) return null;
  const p = parseXml(text);
  if (!p.root || p.error || p.partial || p.doctype) return null;
  return serializeDocument(p).replace(/\n$/, '');
}

// ── What a text is ──────────────────────────────────────

/** Whether a body should get the XML viewer: an XML content type, or text that starts like XML. */
export function isXmlBody(body: string, mime?: string | null): boolean {
  const m = (mime ?? '').toLowerCase();
  if (/json|html/.test(m)) return false;
  const t = body.trimStart().slice(0, 200);
  if (/^<(?:!doctype\s+html|html[\s>])/i.test(t)) return false;
  if (/[/+]xml/.test(m)) return true;
  return t.startsWith('<?xml') || /^<[A-Za-z_!]/.test(t);
}

/** Past this size a text inside a document is not test-parsed to see what it holds. */
const NESTED_MAX = 4_000_000;

/** What a text value holds, when it is a whole document itself: escaped XML or JSON in a string. */
export function nestedKind(v: string): 'xml' | 'json' | null {
  if (v.length < 7 || v.length > NESTED_MAX) return null;
  const t = v.trim();
  const first = t[0];
  const last = t[t.length - 1];
  if (first === '<' && last === '>') {
    const p = parseXml(t);
    return p.root && !p.error && !p.partial ? 'xml' : null;
  }
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    const r = parseJson(t);
    if (r.error || r.partial || !r.root) return null;
    return r.root.t === 'obj' ? (r.root.keys.length ? 'json' : null) : r.root.t === 'arr' && r.root.items.some((x) => x.t === 'obj' || x.t === 'arr') ? 'json' : null;
  }
  return null;
}

/**
 * The first XML document embedded in a log or console message, e.g. a logged SOAP payload.
 * It has to be complete and hold at least one child element, so `<init>` in a stack trace or
 * `List<String>` are not taken for XML. Tries a few candidates only.
 */
export function findXmlIn(text: string, maxTries = 8): { start: number; end: number; text: string } | null {
  if (text.length > NESTED_MAX) return null;
  const re = /<(?:\?xml\s|[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?[\s>/])/g;
  let tries = 0;
  for (let m = re.exec(text); m && tries < maxTries; m = re.exec(text)) {
    tries++;
    const p = parseXml(text, { from: m.index, trailing: true });
    if (p.error || p.partial || !p.root) continue;
    if (p.root.kids.some(isEl)) return { start: m.index, end: p.end, text: text.slice(m.index, p.end) };
    re.lastIndex = p.end;
  }
  return null;
}

// ── SOAP ────────────────────────────────────────────────

export const SOAP_11 = 'http://schemas.xmlsoap.org/soap/envelope/';
export const SOAP_12 = 'http://www.w3.org/2003/05/soap-envelope';

export interface SoapFault {
  el: XEl;
  /** faultcode, or Code/Value. */
  code: string;
  /** Code/Subcode/Value, outermost first (SOAP 1.2). */
  subcodes: string[];
  /** faultstring, or Reason/Text. */
  reason: string;
  /** faultactor, or Role. */
  actor: string;
  /** Node (SOAP 1.2). */
  node: string;
  /** The detail (1.1) or Detail (1.2) element. */
  detail: XEl | null;
}

export interface SoapInfo {
  /** Null when the envelope is in neither SOAP namespace. */
  version: '1.1' | '1.2' | null;
  envelope: XEl;
  header: XEl | null;
  /** The header blocks: the Header's child elements. */
  headers: XEl[];
  body: XEl | null;
  /** The Body's first child element: the operation's request or response, or the Fault. */
  payload: XEl | null;
  fault: SoapFault | null;
}

const child = (el: XEl, local: string): XEl | null => {
  for (const k of el.kids) if (k.t === 'el' && k.local === local) return k;
  return null;
};
const childText = (el: XEl | null, local: string): string => {
  const c = el && child(el, local);
  return c ? textOf(c, 4000).trim() : '';
};

/** Recognises a SOAP 1.1 or 1.2 envelope: its Header, Body, operation and Fault. */
export function soapInfo(root: XEl | null): SoapInfo | null {
  if (!root || root.local !== 'Envelope') return null;
  const version = root.ns === SOAP_11 ? '1.1' : root.ns === SOAP_12 ? '1.2' : null;
  // An envelope in some other namespace (or none) still counts when it has a Header or Body.
  const part = (local: string) => root.kids.find((k): k is XEl => k.t === 'el' && k.local === local && (k.ns === root.ns || version === null)) ?? null;
  const header = part('Header');
  const body = part('Body');
  if (!version && !body && !header) return null;
  const payload = body ? body.kids.find(isEl) ?? null : null;
  let fault: SoapFault | null = null;
  if (payload && payload.local === 'Fault' && (payload.ns === root.ns || version === null)) {
    const code12 = child(payload, 'Code');
    const subcodes: string[] = [];
    for (let sub = code12 && child(code12, 'Subcode'); sub && subcodes.length < 8; sub = child(sub, 'Subcode')) subcodes.push(childText(sub, 'Value'));
    const reason12 = child(payload, 'Reason');
    fault = {
      el: payload,
      code: childText(payload, 'faultcode') || childText(code12, 'Value'),
      subcodes: subcodes.filter(Boolean),
      reason: childText(payload, 'faultstring') || childText(reason12, 'Text') || (reason12 ? textOf(reason12, 4000).trim() : ''),
      actor: childText(payload, 'faultactor') || childText(payload, 'Role'),
      node: childText(payload, 'Node'),
      detail: child(payload, 'detail') ?? child(payload, 'Detail'),
    };
  }
  return { version, envelope: root, header, headers: header ? elements(header) : [], body, payload, fault };
}

/** One line for a fault: "soap:Server: Order 4711 not found". */
export function faultSummary(f: SoapFault): string {
  const code = [f.code, ...f.subcodes].filter(Boolean).join(' › ');
  return [code, f.reason].filter(Boolean).join(': ') || 'No fault code or reason given';
}

// ── Paths ───────────────────────────────────────────────

/** Two sibling elements an unindexed XPath step cannot tell apart. */
function sameStep(a: XEl, b: XEl, anyNs: boolean): boolean {
  if (a.local !== b.local) return false;
  // A name without a prefix matches by local name alone here (see xmlquery.ts).
  return anyNs || !a.prefix ? true : a.ns === b.ns;
}

const indexCache = new WeakMap<XEl, { strict: Map<XChild, number>; loose: Map<XChild, number> }>();

/**
 * For each child of `parent` that needs one, its 1-based position among the siblings its step
 * would also match (0: it is the only one). Worked out once per parent, so paths of every item
 * of a long list do not each walk the list.
 */
function stepIndexes(parent: XEl): { strict: Map<XChild, number>; loose: Map<XChild, number> } {
  let hit = indexCache.get(parent);
  if (hit) return hit;
  hit = { strict: new Map(), loose: new Map() };
  for (const anyNs of [false, true]) {
    const map = anyNs ? hit.loose : hit.strict;
    const seen = new Map<string, XChild[]>();
    for (const k of parent.kids) {
      const key = k.t === 'el' ? (anyNs || !k.prefix ? `e|${k.local}` : `e|${k.ns ?? ''}|${k.local}`) : k.t;
      let list = seen.get(key);
      if (!list) seen.set(key, (list = []));
      list.push(k);
    }
    for (const list of seen.values()) list.forEach((k, n) => map.set(k, list.length > 1 ? n + 1 : 0));
  }
  indexCache.set(parent, hit);
  return hit;
}

const NCNAME = /^[A-Za-z_][\w.-]*$/;

/**
 * The XPath of a node, from the root: `/soap:Envelope/soap:Body/m:Order/m:Item[2]/@id`. With
 * `anyNs` the names are matched without their namespace, `*[local-name()='Item'][2]`, for tools
 * where the prefixes are not registered.
 */
export function xpathOf(n: XNode, anyNs = false): string {
  const steps: string[] = [];
  let x: XNode | null = n;
  for (; x; x = x.parent) {
    const parent: XEl | null = x.parent;
    if (x.t === 'attr') {
      steps.push(anyNs && x.prefix ? `@*[local-name()='${x.local}']` : `@${x.name}`);
      continue;
    }
    const idx = parent ? (anyNs ? stepIndexes(parent).loose : stepIndexes(parent).strict).get(x) ?? 0 : 0;
    const at = idx ? `[${idx}]` : '';
    if (x.t === 'el') {
      const plain = NCNAME.test(x.local) && (!x.prefix || NCNAME.test(x.prefix));
      steps.push((anyNs && x.prefix) || !plain ? `*[local-name()='${x.local}']${at}` : `${x.name}${at}`);
    } else {
      steps.push(`${x.t === 'text' ? 'text()' : x.t === 'comment' ? 'comment()' : 'processing-instruction()'}${at}`);
    }
  }
  return '/' + steps.reverse().join('/');
}

/** The elements above a node, outermost first. */
export function ancestorsOf(n: XNode): XEl[] {
  const out: XEl[] = [];
  for (let x = n.parent; x; x = x.parent) out.push(x);
  return out.reverse();
}

/** The namespaces in scope at an element: prefix to URI, nearest declaration first. */
export function namespacesInScope(el: XEl): { prefix: string; uri: string; own: boolean }[] {
  const out: { prefix: string; uri: string; own: boolean }[] = [];
  const seen = new Set<string>();
  for (let x: XEl | null = el; x; x = x.parent) {
    for (const a of x.attrs) {
      if (!a.decl) continue;
      const prefix = a.name === 'xmlns' ? '' : a.local;
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      out.push({ prefix, uri: a.value, own: x === el });
    }
  }
  return out;
}

// ── Describing ──────────────────────────────────────────

/** "Element · 2 attributes · 5 child elements". */
export function describe(n: XNode): string {
  switch (n.t) {
    case 'attr': return n.decl ? 'Namespace declaration' : 'Attribute';
    case 'text': return `${n.cdata ? 'CDATA section' : 'Text'} · ${plural(n.v.length, 'character')}`;
    case 'comment': return 'Comment';
    case 'pi': return 'Processing instruction';
    case 'el': {
      const attrs = plainAttrs(n).length;
      const kids = n.kids.filter(isEl).length;
      const parts = ['Element'];
      if (attrs) parts.push(plural(attrs, 'attribute'));
      if (kids) parts.push(`${kids.toLocaleString('en-US')} child element${kids === 1 ? '' : 's'}`);
      else if (n.kids.length) parts.push(n.kids.some((k) => k.t === 'text' && k.cdata) ? 'CDATA text' : 'text');
      else parts.push('empty');
      return parts.join(' · ');
    }
  }
}

/** What a closed element holds, on one line: "OrderId, Status, Item ×3". */
export function preview(el: XEl, max = 100): string {
  const names: string[] = [];
  const counts = new Map<string, number>();
  for (const k of el.kids) {
    if (k.t !== 'el') continue;
    const c = counts.get(k.local);
    if (c === undefined) names.push(k.local);
    counts.set(k.local, (c ?? 0) + 1);
    if (names.length > 40) break;
  }
  let out = '';
  for (const name of names) {
    const c = counts.get(name)!;
    const part = c > 1 ? `${name} ×${c}` : name;
    if (out.length + part.length + 2 > max) return out + ', …';
    out += (out ? ', ' : '') + part;
  }
  return out;
}

// ── Search ──────────────────────────────────────────────

export interface Match {
  /** The row the match is on: an element (its name, attributes or own text) or another node. */
  node: XNode;
  /** Index of the top it was found under. */
  top: number;
  /** The elements above it, from the top down. */
  ancestors: XEl[];
}

/**
 * Case-insensitive search in element names, attribute names and values, text and comments.
 * Returns at most `limit` matches, with `total` counting all of them.
 */
export function search(tops: readonly XNode[], query: string, limit = 10_000): { matches: Match[]; total: number } {
  const q = query.toLowerCase();
  const matches: Match[] = [];
  let total = 0;
  if (!q) return { matches, total };
  const has = (v: string) => v.toLowerCase().includes(q);
  const elMatches = (el: XEl): boolean => {
    if (has(el.name)) return true;
    for (const a of el.attrs) if (has(a.name) || has(a.value)) return true;
    // A leaf's text is on the element's own row.
    if (isLeaf(el)) for (const k of el.kids) if (has((k as XText).v)) return true;
    return false;
  };
  tops.forEach((top, ti) => {
    const chain: XEl[] = [];
    const visit = (n: XNode): void => {
      let hit: boolean;
      if (n.t === 'el') hit = elMatches(n);
      else if (n.t === 'attr') hit = has(n.name) || has(n.value);
      else if (n.t === 'pi') hit = has(n.target) || has(n.v);
      else hit = has(n.v);
      if (hit) {
        total++;
        if (matches.length < limit) matches.push({ node: n, top: ti, ancestors: chain.slice() });
      }
      if (n.t === 'el' && !isLeaf(n)) {
        chain.push(n);
        for (const k of n.kids) visit(k);
        chain.pop();
      }
    };
    visit(top);
  });
  return { matches, total };
}

// ── Tables ──────────────────────────────────────────────

export interface XTable {
  /** The repeated child elements, one row each. */
  rows: XEl[];
  /** Attribute columns ("@id") first, then child element names. */
  columns: string[];
  hiddenColumns: number;
}

/** Whether an element has rows for a table: at least two child elements with the same name. */
export function canTable(n: XNode): boolean {
  if (n.t !== 'el') return false;
  const seen = new Set<string>();
  for (const k of n.kids) {
    if (k.t !== 'el') continue;
    if (seen.has(k.local)) return true;
    seen.add(k.local);
  }
  return false;
}

/** The rows and columns for an element's repeated children; the most frequent name wins. */
export function tableOf(el: XEl, maxColumns = 60): XTable | null {
  const counts = new Map<string, number>();
  for (const k of el.kids) if (k.t === 'el') counts.set(k.local, (counts.get(k.local) ?? 0) + 1);
  let best = '';
  for (const [name, c] of counts) if (c > (counts.get(best) ?? 1)) best = name;
  if (!best) return null;
  return tableOfRows(el.kids.filter((k): k is XEl => k.t === 'el' && k.local === best), maxColumns);
}

/** A table with one row per element, e.g. the results of //Item. */
export function tableOfRows(rows: XEl[], maxColumns = 60): XTable {
  const attrs: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();
  // Columns from a sample: enough for lists whose items have optional parts.
  for (const row of rows.slice(0, 500)) {
    for (const a of row.attrs) {
      if (a.decl || seen.has(`@${a.name}`)) continue;
      seen.add(`@${a.name}`);
      attrs.push(`@${a.name}`);
    }
    for (const k of row.kids) {
      if (k.t !== 'el' || seen.has(k.local)) continue;
      seen.add(k.local);
      names.push(k.local);
    }
  }
  const all = [...attrs, ...names];
  // Rows that are plain text (<tag>a</tag><tag>b</tag>) get a value column.
  if (!names.length) all.push('(text)');
  return { rows, columns: all.slice(0, maxColumns), hiddenColumns: Math.max(0, all.length - maxColumns) };
}

/** The cell of `row` in `column`: an attribute, the first child of that name, or the row's text. */
export function cellOf(row: XEl, column: string): XNode | undefined {
  if (column === '(text)') return row.kids.some((k) => k.t === 'text') ? row : undefined;
  if (column[0] === '@') return row.attrs.find((a) => !a.decl && a.name === column.slice(1));
  for (const k of row.kids) if (k.t === 'el' && k.local === column) return k;
  return undefined;
}

/** A cell's text: an attribute or leaf's value, or what a nested element holds. */
export function cellText(n: XNode | undefined, max = 200): string {
  if (!n) return '';
  if (n.t === 'el' && !isLeaf(n)) return `<${preview(n, 60)}>`;
  const v = textOf(n, max + 1).trim();
  return v.length > max ? v.slice(0, max) + '…' : v;
}

/** The first element with repeated children under `root`, breadth first: what Table shows by default. */
export function findTable(root: XEl, limit = 20_000): XEl | null {
  const queue: XEl[] = [root];
  for (let i = 0; i < queue.length && i < limit; i++) {
    const el = queue[i];
    if (canTable(el)) return el;
    for (const k of el.kids) if (k.t === 'el') queue.push(k);
  }
  return null;
}
