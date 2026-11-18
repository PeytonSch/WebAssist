// Syntax colours for the merge view, a line at a time. The detail panel's highlighter
// (highlight.ts) works on whole texts; an editor needs the colours of one line from the line
// itself and what the line before it left open (a comment, a tag, a block of YAML text), so a
// keystroke repaints a line or two. Pure: no DOM. Classes are the hl-* ones of highlight.ts.

import type { FileKind } from '../shared/configkeys';

/** Characters [from, to) of a line, to wear the class hl-<cls>. */
export interface Tok {
  from: number;
  to: number;
  cls: string;
}

/** What a line leaves open for the next one: '' is nothing. */
export type LineState = string;

export interface LineTokens {
  toks: Tok[];
  /** The state after this line. */
  state: LineState;
}

type Push = (from: number, to: number, cls: string) => void;

const YAML_WORD = /^(?:true|false|null|yes|no|on|off|~)$/i;
const NUMBER = /^[-+]?(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?)$/i;

/** Where a trailing comment starts in a YAML or properties-like value, or -1. */
function hashComment(text: string, from: number): number {
  let q: string | null = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if ((c === '"' || c === "'") && (i === from || /[\s[{,:]/.test(text[i - 1]))) q = c;
    else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}

/** A plain value: quoted text, a number, a word like true. */
function scalar(text: string, from: number, to: number, push: Push, words: RegExp): void {
  let s = from;
  let e = to;
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (s >= e) return;
  const v = text.slice(s, e);
  if (v[0] === '"' || v[0] === "'") push(s, e, 'str');
  else if (NUMBER.test(v)) push(s, e, 'num');
  else if (words.test(v)) push(s, e, 'kw');
  else if (/^[&*!]/.test(v)) push(s, s + (/^\S+/.exec(v)?.[0].length ?? 1), 'id');
}

function yamlLine(text: string, state: LineState, push: Push): LineState {
  const indent = text.length - text.trimStart().length;
  if (state.startsWith('b')) {
    // Inside a block of text: lines indented deeper than its key.
    if (!text.trim() || indent > Number(state.slice(1))) {
      push(0, text.length, 'str');
      return state;
    }
  }
  if (/^(?:---|\.\.\.)(\s|$)/.test(text)) {
    push(0, 3, 'punc');
    return '';
  }
  const hash = hashComment(text, 0);
  const end = hash === -1 ? text.length : hash;
  if (hash !== -1) push(hash, text.length, 'com');
  let p = indent;
  while (text[p] === '-' && (p + 1 >= end || /\s/.test(text[p + 1]))) {
    push(p, p + 1, 'punc');
    p++;
    while (p < end && /\s/.test(text[p])) p++;
  }
  const key = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:'"[{][^:#]*?)(\s*):(?=\s|$)/.exec(text.slice(p, end));
  let valueFrom = p;
  if (key) {
    push(p, p + key[0].length - 1 - key[1].length, 'key');
    push(p + key[0].length - 1, p + key[0].length, 'punc');
    valueFrom = p + key[0].length;
  }
  const value = text.slice(valueFrom, end).trim();
  if (/^[|>][+\-\d]*$/.test(value)) {
    push(valueFrom, end, 'punc');
    return `b${p}`;
  }
  if (value[0] === '[' || value[0] === '{') flow(text, valueFrom, end, push, YAML_WORD);
  else scalar(text, valueFrom, end, push, YAML_WORD);
  return '';
}

/** Strings, numbers and words inside [a, b] and {a: 1}. */
function flow(text: string, from: number, to: number, push: Push, words: RegExp): void {
  const re = /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|[[\]{},:]|[^\s[\]{},:"']+/g;
  re.lastIndex = from;
  for (let m = re.exec(text); m && m.index < to; m = re.exec(text)) {
    const t = m[0];
    if (t[0] === '"' || t[0] === "'") push(m.index, m.index + t.length, 'str');
    else if (/^[[\]{},:]$/.test(t)) push(m.index, m.index + 1, 'punc');
    else if (NUMBER.test(t)) push(m.index, m.index + t.length, 'num');
    else if (words.test(t)) push(m.index, m.index + t.length, 'kw');
  }
}

function propertiesLine(text: string, state: LineState, push: Push, ini: boolean): LineState {
  const continues = !ini && /(?:^|[^\\])(?:\\\\)*\\$/.test(text);
  if (state === 'v') return continues ? 'v' : '';
  const s = text.length - text.trimStart().length;
  if (s === text.length) return '';
  if (text[s] === '#' || (ini ? text[s] === ';' : text[s] === '!')) {
    push(s, text.length, 'com');
    return '';
  }
  if (ini && /^\[.*\]\s*(?:[#;].*)?$/.test(text.slice(s))) {
    push(s, text.indexOf(']', s) + 1, 'tag');
    return '';
  }
  let k = s;
  while (k < text.length) {
    const c = text[k];
    if (c === '\\' && !ini) k += 2;
    else if (c === '=' || (!ini && (c === ':' || /\s/.test(c)))) break;
    else k++;
  }
  push(s, Math.min(k, text.length), 'key');
  const sep = /^\s*[=:]/.exec(text.slice(k));
  if (sep) push(k + sep[0].length - 1, k + sep[0].length, 'punc');
  if (ini) {
    const from = k + (sep?.[0].length ?? 0);
    scalar(text, from, text.length, push, /^(?:true|false|null|yes|no|on|off)$/i);
  }
  return continues ? 'v' : '';
}

const JS_WORDS = new Set(['var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'new', 'export', 'default', 'import', 'from', 'true', 'false', 'null', 'undefined', 'this', 'typeof', 'class', 'async', 'await', 'module', 'window']);

/** JSON and JavaScript. States: 'c' in a block comment, '`' in a template string. */
function jsLine(text: string, state: LineState, push: Push): LineState {
  let i = 0;
  if (state === 'c') {
    const end = text.indexOf('*/');
    if (end === -1) {
      push(0, text.length, 'com');
      return 'c';
    }
    push(0, end + 2, 'com');
    i = end + 2;
  } else if (state === '`') {
    const end = closing(text, 0, '`');
    push(0, end === -1 ? text.length : end + 1, 'str');
    if (end === -1) return '`';
    i = end + 1;
  }
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      push(i, text.length, 'com');
      return '';
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) {
        push(i, text.length, 'com');
        return 'c';
      }
      push(i, end + 2, 'com');
      i = end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const end = closing(text, i + 1, c);
      const to = end === -1 ? text.length : end + 1;
      // A string followed by a colon is a key.
      push(i, to, c !== '`' && /^\s*:/.test(text.slice(to)) ? 'key' : 'str');
      if (end === -1 && c === '`') return '`';
      i = to;
    } else if (/[\p{L}_$]/u.test(c)) {
      const m = /[\p{L}\p{N}_$]+/uy;
      m.lastIndex = i;
      const word = m.exec(text)![0];
      const to = i + word.length;
      if (/^\s*:(?!:)/.test(text.slice(to)) && !/\?\s*$/.test(text.slice(0, i))) push(i, to, 'key');
      else if (JS_WORDS.has(word)) push(i, to, 'kw');
      i = to;
    } else if (/\d/.test(c)) {
      const m = /(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[-+]?\d+)?)n?/iy;
      m.lastIndex = i;
      const num = m.exec(text)?.[0] ?? c;
      push(i, i + num.length, 'num');
      i += num.length;
    } else {
      if (/[{}[\](),;:]/.test(c)) push(i, i + 1, 'punc');
      i++;
    }
  }
  return '';
}

/** The closing quote of a string whose content starts at `from`, or -1. */
function closing(text: string, from: number, q: string): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === q) return i;
  }
  return -1;
}

/**
 * XML. States: 'c' in a comment, 'd' in CDATA, 'p' in a <? ?> instruction, 't' in a tag,
 * 't"' and "t'" in an attribute value of a tag.
 */
function xmlLine(text: string, state: LineState, push: Push): LineState {
  let i = 0;
  const until = (end: string, cls: string, st: LineState): LineState | null => {
    const e = text.indexOf(end, i);
    if (e === -1) {
      if (cls) push(i, text.length, cls);
      return st;
    }
    if (cls) push(i, e + end.length, cls);
    i = e + end.length;
    return null;
  };
  const tag = (st: LineState): LineState => {
    // Inside a tag: attribute names, values and the closing > or />.
    if (st.length === 2) {
      const e = text.indexOf(st[1], i);
      push(i, e === -1 ? text.length : e + 1, 'str');
      if (e === -1) return st;
      i = e + 1;
    }
    while (i < text.length) {
      const c = text[i];
      if (c === '>' || (c === '/' && text[i + 1] === '>') || (c === '?' && text[i + 1] === '>')) {
        const n = c === '>' ? 1 : 2;
        push(i, i + n, 'punc');
        i += n;
        return '';
      }
      if (c === '"' || c === "'") {
        const e = text.indexOf(c, i + 1);
        push(i, e === -1 ? text.length : e + 1, 'str');
        if (e === -1) return `t${c}`;
        i = e + 1;
      } else if (/[^\s=<>/"']/.test(c)) {
        const m = /[^\s=<>/"']+/y;
        m.lastIndex = i;
        const name = m.exec(text)![0];
        push(i, i + name.length, 'attr');
        i += name.length;
      } else {
        if (c === '=') push(i, i + 1, 'punc');
        i++;
      }
    }
    return 't';
  };
  let st: LineState | null = state;
  if (st === 'c') st = until('-->', 'com', 'c');
  else if (st === 'd') st = until(']]>', 'str', 'd');
  else if (st === 'p') st = until('?>', 'dim', 'p');
  else if (st.startsWith('t')) st = tag(st) || null;
  else st = null;
  if (st) return st;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    let open: LineState | null;
    if (text.startsWith('<!--', i)) open = until('-->', 'com', 'c');
    else if (text.startsWith('<![CDATA[', i)) open = until(']]>', 'str', 'd');
    else if (text.startsWith('<?', i)) open = until('?>', 'dim', 'p');
    else if (text.startsWith('<!', i)) open = until('>', 'dim', '');
    else {
      const m = /<\/?[A-Za-z_:][\w:.-]*/y;
      m.lastIndex = i;
      const name = m.exec(text);
      if (!name) {
        i++;
        continue;
      }
      const lead = name[0][1] === '/' ? 2 : 1;
      push(i, i + lead, 'punc');
      push(i + lead, i + name[0].length, 'tag');
      i += name[0].length;
      open = tag('t') || null;
    }
    if (open) return open;
    if (open === '') break;
  }
  return '';
}

/** The colours of one line, given what the line before it left open. */
export function tokenizeLine(kind: FileKind, text: string, state: LineState): LineTokens {
  const toks: Tok[] = [];
  if (kind === 'text' || text.length > 2000) return { toks, state: kind === 'text' ? '' : state };
  const push: Push = (from, to, cls) => {
    if (to > from) toks.push({ from, to, cls });
  };
  const next =
    kind === 'yaml' ? yamlLine(text, state, push)
    : kind === 'xml' ? xmlLine(text, state, push)
    : kind === 'properties' || kind === 'ini' ? propertiesLine(text, state, push, kind === 'ini')
    : jsLine(text, state, push);
  toks.sort((a, b) => a.from - b.from);
  return { toks, state: next };
}

/** The colours of every line of a text. */
export function tokenizeLines(kind: FileKind, lines: readonly string[]): LineTokens[] {
  const out: LineTokens[] = new Array(lines.length);
  let state: LineState = '';
  for (let i = 0; i < lines.length; i++) {
    out[i] = tokenizeLine(kind, lines[i], state);
    state = out[i].state;
  }
  return out;
}
