/**
 * A small YAML reader for the part of YAML that OpenAPI and Swagger files use: block mappings
 * and sequences (including "- key: value" items), plain, single- and double-quoted scalars, block
 * scalars (| and >, with - and + chomping), flow collections ([a, b], {a: 1}) that may span
 * lines, comments and a leading "---". Scalars follow the YAML 1.2 core schema (null, true/false,
 * numbers). Anchors, aliases, tags other than the standard !!str/!!int/…, complex keys and
 * multiple documents are not supported and fail with the line number, rather than being guessed.
 *
 * Spring's springdoc and springfox serve JSON (/v3/api-docs, /v2/api-docs), which is always
 * preferred; this is for hand-written openapi.yaml files.
 */

export class YamlError extends Error {
  constructor(message: string, line: number) {
    super(`YAML line ${line}: ${message}`);
  }
}

interface Line {
  /** 1-based, for messages. */
  no: number;
  indent: number;
  /** The text after the indentation, comments still in. */
  text: string;
}

export function parseYaml(source: string): unknown {
  const lines: Line[] = [];
  const raw = source.replace(/^﻿/, '').split(/\r?\n/);
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i];
    if (!started && /^%/.test(l)) continue;
    if (/^---(\s|$)/.test(l)) {
      if (started && lines.some((x) => !isBlank(x.text))) break; // a second document: ignored
      started = true;
      const rest = l.slice(3).trim();
      if (rest && !rest.startsWith('#')) lines.push({ no: i + 1, indent: 0, text: rest });
      continue;
    }
    if (/^\.\.\.(\s|$)/.test(l)) break;
    started = true;
    const m = /^( *)(.*)$/.exec(l)!;
    if (m[2].startsWith('\t') && !isBlank(m[2])) throw new YamlError('tabs cannot be used for indentation', i + 1);
    lines.push({ no: i + 1, indent: m[1].length, text: m[2] });
  }
  const p = new Parser(lines);
  const value = p.node(0);
  p.skipBlank();
  if (p.i < lines.length) throw new YamlError('unexpected content (check the indentation)', lines[p.i].no);
  return value === undefined ? null : value;
}

const isBlank = (text: string) => /^\s*(#.*)?$/.test(text);

/** The text with a trailing comment removed, respecting quotes. */
function stripComment(text: string): string {
  let q: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      // A quote only opens a string at the start of a scalar.
      if (i === 0 || /[\s:,[{-]/.test(text[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/**
 * Where a "key: value" line's colon is, or -1 when the line is not a mapping entry. Quoted keys
 * and colons inside quotes or brackets (URLs, "{id}") do not count.
 */
function keyColon(text: string): number {
  if (/^[[{]/.test(text)) return -1;
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) {
        if (q === "'" && text[i + 1] === "'") i++;
        else q = null;
      }
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) q = c;
    else if (c === '#' && i > 0 && /\s/.test(text[i - 1])) return -1;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ':' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i;
  }
  return -1;
}

const isSeqItem = (text: string) => text === '-' || text.startsWith('- ');

class Parser {
  i = 0;
  constructor(private lines: Line[]) {}

  skipBlank(): void {
    while (this.i < this.lines.length && isBlank(this.lines[this.i].text)) this.i++;
  }

  /** The node starting at the next line, if it is indented at least `min`. */
  node(min: number): unknown {
    this.skipBlank();
    const line = this.lines[this.i];
    if (!line || line.indent < min) return undefined;
    if (isSeqItem(line.text)) return this.seq(line.indent);
    if (keyColon(line.text) !== -1) return this.map(line.indent);
    this.i++;
    return this.inline(stripComment(line.text), line, line.indent - 1);
  }

  private seq(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      this.skipBlank();
      const line = this.lines[this.i];
      if (!line || line.indent !== indent || !isSeqItem(line.text)) break;
      const rest = line.text.slice(1);
      const pad = rest.length - rest.trimStart().length;
      if (isBlank(rest)) {
        this.i++;
        const v = this.node(indent + 1);
        out.push(v === undefined ? null : v);
      } else {
        // "- key: value" or "- - x": treat what follows the dash as a node at its own column.
        this.lines[this.i] = { no: line.no, indent: indent + 1 + pad, text: rest.trimStart() };
        out.push(this.node(indent + 1));
      }
    }
    return out;
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipBlank();
      const line = this.lines[this.i];
      if (!line || line.indent !== indent) break;
      if (isSeqItem(line.text)) throw new YamlError('a list item where a key was expected', line.no);
      const colon = keyColon(line.text);
      if (colon === -1) throw new YamlError('expected "key: value"', line.no);
      const key = this.key(line.text.slice(0, colon).trim(), line);
      const rest = stripComment(line.text.slice(colon + 1)).trim();
      this.i++;
      let value: unknown;
      if (rest === '') {
        this.skipBlank();
        const next = this.lines[this.i];
        // A list may sit at the same indentation as its key.
        if (next && next.indent === indent && isSeqItem(next.text)) value = this.seq(indent);
        else value = this.node(indent + 1);
        if (value === undefined) value = null;
      } else value = this.inline(rest, line, indent);
      out[key] = value;
    }
    return out;
  }

  private key(text: string, line: Line): string {
    if (text.startsWith('"') || text.startsWith("'")) return String(this.quoted(text, line).value);
    if (/^[&*!?|>]/.test(text)) throw new YamlError(`keys like ${text} are not supported`, line.no);
    return text;
  }

  /** A value given on the key's line, which may continue on more-indented lines. */
  private inline(text: string, line: Line, parentIndent: number): unknown {
    if (text.startsWith('&') || text.startsWith('*')) throw new YamlError('anchors and aliases are not supported', line.no);
    if (text.startsWith('!')) {
      const m = /^!!(str|int|float|bool|null|map|seq)\s*(.*)$/.exec(text);
      if (!m) throw new YamlError(`tag ${text.split(/\s/)[0]} is not supported`, line.no);
      const v = this.inline(m[2], line, parentIndent);
      return m[1] === 'str' ? String(v ?? '') : v;
    }
    if (/^[|>]/.test(text)) return this.block(text, line, parentIndent);
    if (text.startsWith('[') || text.startsWith('{')) {
      let src = text;
      // A flow collection may go on over the next lines until its brackets balance.
      while (!balanced(src)) {
        const next = this.lines[this.i];
        if (!next) throw new YamlError('unclosed [ or {', line.no);
        src += ' ' + stripComment(next.text).trim();
        this.i++;
      }
      const f = new Flow(src, line.no);
      const v = f.value();
      f.end();
      return v;
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      let src = text;
      let q = this.quoted(src, line);
      // A quoted string may span lines; line breaks fold into spaces.
      while (!q.closed) {
        const next = this.lines[this.i];
        if (!next) throw new YamlError('unclosed quoted string', line.no);
        src += isBlank(next.text) ? '\n' : (src.endsWith('\n') ? '' : ' ') + next.text.trim();
        this.i++;
        q = this.quoted(src.replace(/ \n/g, '\n'), line);
      }
      if (q.rest && !q.rest.startsWith('#')) throw new YamlError('unexpected text after the closing quote', line.no);
      return q.value;
    }
    // A plain scalar: more-indented lines that follow are part of it.
    let value = text;
    for (;;) {
      const next = this.lines[this.i];
      if (!next || next.indent <= parentIndent) break;
      if (isBlank(next.text)) {
        // Blank lines inside a plain scalar become line breaks, but only if it goes on after them.
        let j = this.i;
        while (j < this.lines.length && isBlank(this.lines[j].text)) j++;
        const after = this.lines[j];
        if (!after || after.indent <= parentIndent) break;
        value += '\n'.repeat(j - this.i);
        this.i = j;
        continue;
      }
      const t = stripComment(next.text).trim();
      if (keyColon(t) !== -1 || isSeqItem(t)) break;
      value += (value.endsWith('\n') ? '' : ' ') + t;
      this.i++;
    }
    return plain(value);
  }

  /** "…" or '…' at the start of `text`; `rest` is what follows the closing quote. */
  quoted(text: string, line: Line): { value: string; closed: boolean; rest: string } {
    const r = readQuoted(text, 0, line.no);
    return { value: r.value, closed: r.closed, rest: text.slice(r.end).trim() };
  }

  /** | and > block scalars: the lines indented more than the key. */
  private block(header: string, line: Line, parentIndent: number): string {
    const m = /^([|>])([1-9]?)([+-]?)([1-9]?)\s*(#.*)?$/.exec(header);
    if (!m) throw new YamlError(`bad block scalar header ${header}`, line.no);
    const folded = m[1] === '>';
    const chomp = m[3] || '';
    const explicit = Number(m[2] || m[4] || 0);
    const body: string[] = [];
    let indent = explicit ? parentIndent + explicit : -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const blank = l.text.trim() === '';
      if (!blank) {
        if (indent === -1) indent = l.indent;
        if (l.indent < indent || l.indent <= parentIndent) break;
      }
      body.push(blank ? '' : ' '.repeat(l.indent - indent) + l.text);
      this.i++;
    }
    // Trailing blank lines belong to the chomping, not the content.
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let text: string;
    if (!folded) text = body.join('\n');
    else {
      text = '';
      for (let k = 0; k < body.length; k++) {
        const cur = body[k];
        if (k === 0) text = cur;
        else {
          const prev = body[k - 1];
          const moreIndented = /^\s/.test(cur) || /^\s/.test(prev);
          if (cur === '') text += '\n';
          else if (prev === '' || moreIndented) text += (prev === '' && !moreIndented ? '' : '\n') + cur;
          else text += ' ' + cur;
        }
      }
    }
    if (!body.length) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return text + '\n';
  }
}

const ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', b: '\b', f: '\f', e: '\x1b', N: '\u0085', _: '\u00a0',
};

/** A quoted scalar starting at text[from]; `end` is just past the closing quote. */
function readQuoted(text: string, from: number, lineNo: number): { value: string; closed: boolean; end: number } {
  const q = text[from];
  let out = '';
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i];
    if (q === "'") {
      if (c !== "'") out += c;
      else if (text[i + 1] === "'") {
        out += "'";
        i++;
      } else return { value: out, closed: true, end: i + 1 };
      continue;
    }
    if (c === '"') return { value: out, closed: true, end: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = text[++i];
    if (e in ESCAPES) out += ESCAPES[e];
    else if (e === 'x' || e === 'u' || e === 'U') {
      const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const hex = text.slice(i + 1, i + 1 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new YamlError(`bad escape \\${e}${hex}`, lineNo);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += len;
    } else if (e !== '\n') throw new YamlError(`unknown escape \\${e ?? ''}`, lineNo);
  }
  return { value: out, closed: false, end: text.length };
}

function balanced(src: string): boolean {
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !q;
}

/** YAML 1.2 core schema for unquoted scalars. */
function plain(text: string): unknown {
  const t = text.trim();
  if (t === '' || t === '~' || /^(null|Null|NULL)$/.test(t)) return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?[0-9]+$/.test(t)) {
    const n = Number(t);
    // Too big for a JavaScript number without losing digits: keep the text.
    return Number.isSafeInteger(n) ? n : t;
  }
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return Number(t);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(t)) return NaN;
  return t;
}

/** Flow collections: [a, "b", {c: 1}]. */
class Flow {
  private i = 0;
  constructor(private s: string, private line: number) {}

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  end(): void {
    this.ws();
    const rest = this.s.slice(this.i).trim();
    if (rest && !rest.startsWith('#')) throw new YamlError(`unexpected "${rest.slice(0, 20)}" after ]/}`, this.line);
  }

  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.list();
    if (c === '{') return this.object();
    if (c === '"' || c === "'") return this.quoted();
    if (c === '&' || c === '*') throw new YamlError('anchors and aliases are not supported', this.line);
    const start = this.i;
    while (this.i < this.s.length && !/[,\]}]/.test(this.s[this.i])) {
      // "key: value" inside {…}: stop at the colon.
      if (this.s[this.i] === ':' && /[\s,\]}]/.test(this.s[this.i + 1] ?? ' ')) break;
      this.i++;
    }
    return plain(this.s.slice(start, this.i));
  }

  private quoted(): string {
    const r = readQuoted(this.s, this.i, this.line);
    if (!r.closed) throw new YamlError('unclosed quoted string', this.line);
    this.i = r.end;
    return r.value;
  }

  private list(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === ']') {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== ']') throw new YamlError('expected , or ] in a [ ] list', this.line);
    }
  }

  private object(): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === '}') {
        this.i++;
        return out;
      }
      const key = this.value();
      this.ws();
      let v: unknown = null;
      if (this.s[this.i] === ':') {
        this.i++;
        this.ws();
        v = /[,}]/.test(this.s[this.i] ?? '') ? null : this.value();
      }
      out[String(key)] = v;
      this.ws();
      if (this.s[this.i] === ',') this.i++;
      else if (this.s[this.i] !== '}') throw new YamlError('expected , or } in a { } map', this.line);
    }
  }
}
