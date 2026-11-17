// Syntax highlighting for the detail panel.
//
// Tokenizers are pure functions over strings (no DOM), so they can be unit tested in node. Each
// one splits its input into tokens whose texts concatenate back to the input exactly; a token's
// `cls` names what it is (keyword, string, stack frame…) and becomes an `hl-<cls>` class on a
// span. Everything highlighted here is untrusted captured text, so `paint` only ever sets
// textContent, never HTML.
//
// The scanners walk the text once with sticky regexes that cannot backtrack badly, because
// bodies can be several hundred KB and the panel re-renders on every selection.

export interface Token {
  text: string;
  cls?: string;
  /** A Java class this token names (a stack frame, logger or exception), for Go to source. */
  ref?: SourceRef;
}

/** Where a token points in the sources: the class, and for a stack frame its file and line. */
export interface SourceRef {
  cls: string;
  file?: string;
  line?: number;
}

export type Lang = 'json' | 'sql' | 'plan' | 'log' | 'xml' | 'form' | 'text';

/** Past this many characters or lines only the first part is highlighted; the rest stays plain. */
export const MAX_CHARS = 200_000;
export const MAX_LINES = 5_000;

/** Highlights `text` as `lang`. Concatenating the token texts always gives back `text`. */
export function highlight(text: string, lang: Lang): Token[] {
  const end = highlightEnd(text);
  const out = new Out();
  TOKENIZERS[lang](out, text.slice(0, end));
  out.add(text.slice(end));
  return out.list;
}

/** Picks a language for an HTTP body from its MIME type, falling back to sniffing the text. */
export function bodyLang(body: string, mime?: string | null): Lang {
  const m = (mime ?? '').toLowerCase();
  if (/json/.test(m)) return 'json';
  if (/[/+](?:xml|html|xhtml|svg)/.test(m)) return 'xml';
  if (/x-www-form-urlencoded/.test(m)) return 'form';
  const t = body.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  if (t.startsWith('<')) return 'xml';
  if (/^[\w.%*~-]+=[^\s&]*(?:&[\w.%*~-]+=[^\s&]*)*$/.test(t.slice(0, 4000))) return 'form';
  return 'text';
}

/** Tokens turned into spans straight away; the rest of a long text is upgraded when idle. */
const PAINT_CHUNK = 2_000;

/**
 * Puts highlighted tokens into `el` as text nodes and spans, replacing what was there.
 * Thousands of spans take tens of milliseconds to lay out, which would make stepping through
 * events with big bodies sluggish. So only the first chunk is painted now; the remainder starts
 * as plain text and is swapped for spans chunk by chunk when the browser is idle, unless the
 * panel has moved on by then.
 */
export function paint(el: HTMLElement, tokens: Token[]): HTMLElement {
  el.replaceChildren(spans(tokens, 0, PAINT_CHUNK));
  delete el.dataset.painting;
  if (tokens.length <= PAINT_CHUNK) return el;
  // Marks the element until the plain tail is gone, so the find bar can tell (see find.ts).
  el.dataset.painting = '';
  let rest = '';
  for (let i = PAINT_CHUNK; i < tokens.length; i++) rest += tokens[i].text;
  const plain = document.createTextNode(rest);
  el.append(plain);
  let from = PAINT_CHUNK;
  const step = () => {
    if (!plain.isConnected) return;
    const to = Math.min(tokens.length, from + PAINT_CHUNK);
    let len = 0;
    for (let i = from; i < to; i++) len += tokens[i].text.length;
    el.insertBefore(spans(tokens, from, to), plain);
    plain.deleteData(0, len);
    from = to;
    if (from < tokens.length) later(step);
    else {
      plain.remove();
      delete el.dataset.painting;
    }
  };
  later(step);
  return el;
}

/** Called for each span that names a class, also those painted later; see source.ts. */
let refHook: ((span: HTMLElement) => void) | null = null;
export function onSourceRef(hook: (span: HTMLElement) => void): void {
  refHook = hook;
}

function spans(tokens: Token[], from: number, to: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (let i = from; i < Math.min(to, tokens.length); i++) {
    const t = tokens[i];
    if (!t.cls) {
      frag.append(t.text);
      continue;
    }
    const span = document.createElement('span');
    span.className = `hl-${t.cls}`;
    span.textContent = t.text;
    if (t.ref) {
      // Only attributes: the text stays as it is, so the find bar and copying see plain text.
      span.dataset.src = t.ref.cls;
      if (t.ref.file) span.dataset.srcFile = t.ref.file;
      if (t.ref.line) span.dataset.srcLine = String(t.ref.line);
      refHook?.(span);
    }
    frag.append(span);
  }
  return frag;
}

const later = (fn: () => void) =>
  typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 500 }) : setTimeout(fn, 16);

// ── Plumbing ────────────────────────────────────────────

/** Collects tokens, merging neighbours of the same class so the DOM stays small. */
class Out {
  readonly list: Token[] = [];
  /** Set for the next add() only: the class the token names. Such tokens are never merged. */
  ref: SourceRef | null = null;
  add(text: string, cls?: string): void {
    const ref = this.ref;
    this.ref = null;
    if (!text) return;
    const last = this.list[this.list.length - 1];
    if (ref && cls) this.list.push({ text, cls, ref });
    else if (last && last.cls === cls && !last.ref) last.text += text;
    else this.list.push(cls ? { text, cls } : { text });
  }
}

/** A cursor over one string. Characters it steps over without emitting are output as plain text. */
class Scan {
  i = 0;
  private plain = 0;
  constructor(readonly s: string, readonly out: Out, readonly base?: string) {}
  get done(): boolean {
    return this.i >= this.s.length;
  }
  /** Matches a sticky regex at the cursor. */
  at(re: RegExp): RegExpExecArray | null {
    re.lastIndex = this.i;
    return re.exec(this.s);
  }
  /** Emits the next `len` characters as one token, optionally naming a class (see Token.ref). */
  emit(len: number, cls?: string, ref?: SourceRef | null): void {
    this.flush();
    this.out.ref = ref ?? null;
    this.out.add(this.s.slice(this.i, this.i + len), cls);
    this.i += len;
    this.plain = this.i;
  }
  /** Hands the next `len` characters to another tokenizer. */
  sub(len: number, fn: (out: Out, text: string) => void): void {
    this.flush();
    fn(this.out, this.s.slice(this.i, this.i + len));
    this.i += len;
    this.plain = this.i;
  }
  flush(): void {
    this.out.add(this.s.slice(this.plain, this.i), this.base);
    this.plain = this.i;
  }
  end(): void {
    this.i = this.s.length;
    this.flush();
  }
}

function highlightEnd(text: string): number {
  let end = Math.min(text.length, MAX_CHARS);
  let lines = 0;
  for (let nl = text.indexOf('\n'); nl !== -1 && nl < end; nl = text.indexOf('\n', nl + 1)) {
    if (++lines >= MAX_LINES) return nl + 1;
  }
  if (end < text.length) {
    // Stop at a line boundary so the plain remainder does not start mid-token.
    const nl = text.lastIndexOf('\n', end - 1);
    if (nl > 0) end = nl + 1;
  }
  return end;
}

/** Splits text into lines that keep their trailing newline. */
function lines(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let nl = s.indexOf('\n'); nl !== -1; nl = s.indexOf('\n', start)) {
    out.push(s.slice(start, nl + 1));
    start = nl + 1;
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isWordChar = (c: string | undefined) => !!c && /[\w$]/.test(c);

// ── JSON ────────────────────────────────────────────────

const JSON_STR = /"(?:[^"\\\n]|\\.)*"?/y;
const JSON_NUM = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_LIT = /(?:true|false|null)\b/y;
const SPACES = /[ \t\r\n]*/y;

/** Truncated or otherwise broken JSON still highlights as far as it makes sense. */
function tokJson(out: Out, s: string): void {
  const sc = new Scan(s, out);
  while (!sc.done) {
    const c = s[sc.i];
    let m: RegExpExecArray | null = null;
    if (c === '"' && (m = sc.at(JSON_STR))) {
      SPACES.lastIndex = sc.i + m[0].length;
      SPACES.exec(s);
      sc.emit(m[0].length, s[SPACES.lastIndex] === ':' ? 'key' : 'str');
    } else if ((c === '-' || isDigit(c)) && (m = sc.at(JSON_NUM))) {
      sc.emit(m[0].length, 'num');
    } else if ((c === 't' || c === 'f' || c === 'n') && (m = sc.at(JSON_LIT))) {
      sc.emit(m[0].length, 'kw');
    } else {
      // Punctuation stays plain: it is most of the tokens, and spans for it would double the DOM.
      sc.i++;
    }
  }
  sc.end();
}

// ── SQL ─────────────────────────────────────────────────

const SQL_KEYWORDS = new Set(`
  select from where and or not in is null as on join left right inner outer full cross natural
  group by order having limit offset fetch first next rows row only insert into values default
  update set delete returning with recursive union intersect except all distinct case when then
  else end exists between like ilike similar asc desc nulls last create table index view sequence
  drop alter add column primary key foreign references constraint unique check if begin commit
  rollback savepoint release transaction isolation level read write true false cast using lateral
  over partition window filter for share nowait skip locked conflict do nothing explain analyze
  verbose truncate grant revoke any some interval collate escape materialized refresh vacuum
  prepare execute deallocate declare cursor close returns language function trigger schema
  int integer bigint smallint numeric decimal real double precision text varchar char character
  boolean bool date time timestamp timestamptz uuid json jsonb bytea serial bigserial array
  zone at local current_date current_time current_timestamp
`.trim().split(/\s+/));
const SQL_WORD = /[A-Za-z_][\w$]*/y;
const SQL_NUM = /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const SQL_STR = /'(?:[^']|'')*'?/y;
const SQL_QIDENT = /"(?:[^"]|"")*"?/y;
const SQL_PARAM = /\$\d+/y;
const SQL_DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;
// Request IDs that applications put in SQL comments (/* rid=… */) for correlation.
const RID_IN_TEXT = /\b(?:rid|request[_-]?id|req[_-]?id|x-request-id|trace[_-]?id|correlation[_-]?id)["']?\s*[=:]\s*["']?([A-Za-z0-9._-]{6,})/gi;

function tokSql(out: Out, s: string): void {
  const sc = new Scan(s, out);
  while (!sc.done) {
    const c = s[sc.i];
    const next = s[sc.i + 1];
    let m: RegExpExecArray | null = null;
    if (c === '-' && next === '-') {
      const nl = s.indexOf('\n', sc.i);
      sc.sub((nl === -1 ? s.length : nl) - sc.i, comment);
    } else if (c === '/' && next === '*') {
      const close = s.indexOf('*/', sc.i + 2);
      sc.sub((close === -1 ? s.length : close + 2) - sc.i, comment);
    } else if (c === "'" && (m = sc.at(SQL_STR))) {
      sc.emit(m[0].length, 'str');
    } else if (c === '"' && (m = sc.at(SQL_QIDENT))) {
      sc.emit(m[0].length, 'ident');
    } else if (c === '$' && (m = sc.at(SQL_PARAM))) {
      sc.emit(m[0].length, 'param');
    } else if (c === '$' && (m = sc.at(SQL_DOLLAR_TAG))) {
      // $$ … $$ or $tag$ … $tag$: a string body, typically a function definition.
      const close = s.indexOf(m[0], sc.i + m[0].length);
      sc.emit((close === -1 ? s.length : close + m[0].length) - sc.i, 'str');
    } else if (c === '?' && !isWordChar(s[sc.i - 1])) {
      sc.emit(1, 'param'); // JDBC placeholder, as Hibernate and friends log it
    } else if (isDigit(c) && !isWordChar(s[sc.i - 1]) && (m = sc.at(SQL_NUM))) {
      sc.emit(m[0].length, 'num');
    } else if ((m = sc.at(SQL_WORD))) {
      if (SQL_KEYWORDS.has(m[0].toLowerCase())) sc.emit(m[0].length, 'kw');
      else sc.i += m[0].length; // identifiers stay plain
    } else {
      sc.i++;
    }
  }
  sc.end();
}

/** A comment, with any request ID inside it picked out. */
function comment(out: Out, text: string): void {
  let last = 0;
  RID_IN_TEXT.lastIndex = 0;
  for (let m = RID_IN_TEXT.exec(text); m; m = RID_IN_TEXT.exec(text)) {
    const idStart = m.index + m[0].length - m[1].length;
    out.add(text.slice(last, idStart), 'com');
    out.add(m[1], 'id');
    last = idStart + m[1].length;
  }
  out.add(text.slice(last), 'com');
}

// ── Postgres plans (EXPLAIN / auto_explain) ─────────────

const PLAN_INDENT = /[ \t]*(?:->[ \t]*)?/y;
// "Filter:", "Index Cond:", "Rows Removed by Filter:", "Planning Time:"…
const PLAN_LABEL = /[A-Z][A-Za-z]*(?: [A-Za-z]+)*:(?= |\n|$)/y;
// The node type at the start of a node line: "Seq Scan", "Hash Join", "InitPlan 1".
const PLAN_NODE = /[A-Za-z][A-Za-z ]*?(?: \d+)?(?= on | using |  \(| \(|\n|$)/y;
const PLAN_KEY = /[a-z]+(?: [a-z]+)?=/y; // cost=, rows=, actual time=, loops=
const PLAN_NUM = /\d+(?:\.\d+)?/y;
const PLAN_WORD = /[A-Za-z_][\w$]*/y;
const PLAN_DIM_WORDS = new Set(['on', 'using', 'never', 'executed']);

function tokPlan(out: Out, s: string): void {
  for (const line of lines(s)) {
    const sc = new Scan(line, out);
    const indent = sc.at(PLAN_INDENT)![0];
    const arrow = indent.indexOf('->');
    if (arrow !== -1) {
      sc.emit(arrow);
      sc.emit(indent.length - arrow, 'dim');
    } else {
      sc.i = indent.length;
    }
    let m = arrow === -1 ? sc.at(PLAN_LABEL) : null;
    if (m) {
      sc.emit(m[0].length, 'label');
      sc.sub(line.length - sc.i, tokSql); // conditions and keys are SQL expressions
      continue;
    }
    if ((m = sc.at(PLAN_NODE)) && m[0].trim()) sc.emit(m[0].length, 'node');
    while (!sc.done) {
      const c = line[sc.i];
      if (c === '(' || c === ')') sc.emit(1, 'dim');
      else if (isDigit(c) && (m = sc.at(PLAN_NUM))) sc.emit(m[0].length, 'num');
      else if ((m = sc.at(PLAN_KEY))) sc.emit(m[0].length, 'dim');
      else if ((m = sc.at(PLAN_WORD))) {
        if (PLAN_DIM_WORDS.has(m[0]) || m[0] === 'actual') sc.emit(m[0].length, 'dim');
        else sc.i += m[0].length;
      } else sc.i++;
    }
    sc.end();
  }
}

// ── Logs and stack traces (Java and JavaScript) ─────────

const LEVEL_ALT =
  '(?:SEVERE|FATAL|ERROR|PANIC|WARNING|WARN|INFO|CONFIG|LOG|NOTICE|DEBUG[1-5]?|FINEST|FINER|FINE|TRACE|DETAIL|HINT|STATEMENT|CONTEXT|QUERY|LOCATION)';
// A timestamp at the start of a line, in the layouts src/server/parsers/timestamps.ts reads.
// A zone abbreviation after it (Postgres writes "… 08:16:00.123 PST") is included, a level is not.
const LOG_TS = new RegExp(
  '\\[?(?:' +
    '\\d{4}-\\d\\d-\\d\\d[T ]\\d\\d:\\d\\d:\\d\\d(?:[.,]\\d{1,9})?(?:Z|[+-]\\d\\d(?::?\\d\\d)?| (?!' + LEVEL_ALT + '\\b)[A-Z]{2,5}(?= ))?' +
    '|\\d\\d-[A-Za-z]{3}-\\d{4} \\d\\d:\\d\\d:\\d\\d(?:[.,]\\d{1,9})?' +
    '|\\d\\d/[A-Za-z]{3}/\\d{4}:\\d\\d:\\d\\d:\\d\\d(?: [+-]\\d{4})?' +
    '|\\d\\d:\\d\\d:\\d\\d[.,]\\d{3}' +
  ')\\]?',
  'y',
);
const LEVEL_CLS: Record<string, string> = {
  SEVERE: 'err', FATAL: 'err', ERROR: 'err', PANIC: 'err',
  WARNING: 'warn', WARN: 'warn',
  INFO: 'info', CONFIG: 'info', LOG: 'info', NOTICE: 'info',
  DEBUG: 'debug', DEBUG1: 'debug', DEBUG2: 'debug', DEBUG3: 'debug', DEBUG4: 'debug', DEBUG5: 'debug',
  FINE: 'debug', FINER: 'debug', FINEST: 'debug', TRACE: 'debug',
  // Postgres follow-up lines.
  DETAIL: 'label', HINT: 'label', STATEMENT: 'label', CONTEXT: 'label', QUERY: 'label', LOCATION: 'label',
};
const LEVEL_WORD = new RegExp(`${LEVEL_ALT}\\b:?`, 'y');
const LEVEL_ANYWHERE = new RegExp(`\\b${LEVEL_ALT}\\b:?`);
const BRACKET = /\[[^\]\n]{0,200}\]/y;
const BRACKET_KV = /^\[([\w.-]+)([=:]\s?)([^\]]*)\]$/;
const SPRING_PID = /\d+ +---(?= )/y;
const DASHES = /(?:-{1,3}|:)(?= )/y;
const BLANKS = /[ \t]+/y;
const LOGGER = /(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?::\d+)?(?= |:|\n|$)/y;
// What follows these in a Postgres message is SQL.
const PG_SQL_INTRO = /\b(?:statement|execute [^:\n]*|parse [^:\n]*|bind [^:\n]*|Query Text): /;
const PG_PLAN_INTRO = /\bplan:\s*\n?$/;

// Stack traces.
const INDENT = /[ \t]*/y;
const CAUSE = /(?:Caused by|Suppressed|Wrapped by):[ \t]*/y;
const UNCAUGHT = /(?:Uncaught|Unhandled(?: promise rejection)?):? (?=[\w$.]*(?:Exception|Error))/y;
const EXCEPTION_HEAD = /(?:[A-Za-z_$][\w$]*\.)*[\w$]*(?:Exception|Error|Throwable|Failure)(?=:|[ \t]*(?:\n|$))/y;
const FRAME_AT = /at[ \t]+/y;
const JAVA_FRAME = /([^\s(]+)\(([^)\n]*)\)([^\n]*)/y;
const MORE = /\.\.\. \d+ (?:more|common frames omitted)[^\n]*/y;
const STACKISH = /^[ \t]*(?:at[ \t]|\.\.\. \d|Caused by:|(?:[\w$]+\.)+[\w$]*(?:Exception|Error)\b)/;
const JS_LOCATION = /^\S*:\d+(?::\d+)?$/;

type LineMode = 'text' | 'sql' | 'plan';

/**
 * Log entries: a header line (timestamp, level, [thread], logger, message) and continuation lines
 * that are stack frames, exception lines or more message text. Also used for console messages
 * and any plain text, where the header parts simply do not match.
 */
function tokLog(out: Out, s: string): void {
  // Continuation lines of a Postgres entry carry on whatever the header started (SQL or a plan).
  let mode: LineMode = 'text';
  for (const line of lines(s)) {
    const sc = new Scan(line, out);
    const ts = sc.at(LOG_TS);
    if (ts) {
      sc.emit(ts[0].length, 'time');
      mode = logHeader(sc);
      continue;
    }
    if (mode === 'sql' && /^[ \t]/.test(line) && !STACKISH.test(line)) {
      tokSql(out, line);
      continue;
    }
    if (mode === 'plan' && /^[ \t]/.test(line)) {
      tokPlan(out, line);
      continue;
    }
    mode = 'text';
    stackLine(sc);
  }
}

/** The rest of a header line after its timestamp. Returns how continuation lines should read. */
function logHeader(sc: Scan): LineMode {
  let level: string | null = null;
  let m: RegExpExecArray | null;
  // Decorations between the timestamp and the message, as the Tomcat parser skips them.
  for (;;) {
    if ((m = sc.at(BLANKS))) sc.i += m[0].length;
    else if (!level && (m = sc.at(LEVEL_WORD))) {
      level = m[0].replace(/:$/, '');
      sc.emit(m[0].length, LEVEL_CLS[level]);
    } else if ((m = sc.at(BRACKET))) bracket(sc, m[0]);
    else if ((m = sc.at(SPRING_PID)) || (m = sc.at(DASHES))) sc.emit(m[0].length, 'dim');
    else break;
  }
  if ((m = sc.at(LOGGER))) {
    const [, name, line] = /^(.*?)(?::(\d+))?$/.exec(m[0])!;
    sc.emit(m[0].length, 'logger', javaRef(name, undefined, line ? Number(line) : undefined));
    if ((m = sc.at(BLANKS))) sc.i += m[0].length;
    if ((m = sc.at(DASHES))) sc.emit(m[0].length, 'dim');
  }
  let rest = sc.s.slice(sc.i);
  // A level further in, after a custom prefix (Postgres log_line_prefix "user@db LOG:").
  if (!level) {
    const lm = LEVEL_ANYWHERE.exec(rest.slice(0, 160));
    if (lm) {
      sc.sub(lm.index, tokText);
      level = lm[0].replace(/:$/, '');
      sc.emit(lm[0].length, LEVEL_CLS[level]);
      rest = sc.s.slice(sc.i);
    }
  }
  if (level === 'STATEMENT' || level === 'QUERY') {
    sc.sub(rest.length, tokSql);
    return 'sql';
  }
  const intro = PG_SQL_INTRO.exec(rest);
  if (intro) {
    sc.sub(intro.index + intro[0].length, tokText);
    sc.sub(sc.s.length - sc.i, tokSql);
    return 'sql';
  }
  sc.sub(rest.length, tokText);
  return PG_PLAN_INTRO.test(rest) ? 'plan' : 'text';
}

/** [thread], [rid=…], [pid] and the like. */
function bracket(sc: Scan, text: string): void {
  const kv = BRACKET_KV.exec(text);
  if (kv && /^(?:rid|req(?:uest)?[_-]?id|x-request-id|trace[_-]?id|correlation[_-]?id|traceId|requestId)$/i.test(kv[1])) {
    sc.emit(1 + kv[1].length + kv[2].length, 'dim');
    sc.emit(kv[3].length, 'id');
    sc.emit(1, 'dim');
  } else {
    sc.emit(text.length, 'thread');
  }
}

/** A line that is not a log header: a stack frame, an exception line, or message text. */
function stackLine(sc: Scan): void {
  sc.i += sc.at(INDENT)![0].length;
  let m: RegExpExecArray | null;
  if ((m = sc.at(FRAME_AT)) && m.index === sc.i && sc.i > 0) {
    sc.emit(m[0].length, 'dim');
    frame(sc);
    return;
  }
  if ((m = sc.at(MORE))) {
    sc.emit(m[0].length, 'dim');
    sc.end();
    return;
  }
  let cause = false;
  if ((m = sc.at(CAUSE)) || (m = sc.at(UNCAUGHT))) {
    sc.emit(m[0].length, 'cause');
    cause = true;
  }
  if ((m = sc.at(EXCEPTION_HEAD)) && m[0]) {
    exceptionName(sc, m[0]);
    if (sc.s[sc.i] === ':') {
      sc.emit(1);
      sc.sub(sc.s.length - sc.i, (out, text) => tokText(out, text, 'msg'));
    }
    sc.end();
    return;
  }
  if (cause) {
    sc.sub(sc.s.length - sc.i, (out, text) => tokText(out, text, 'msg'));
    return;
  }
  sc.sub(sc.s.length - sc.i, tokText);
}

/** org.example.FooException: the package dimmed, the class name stands out. */
function exceptionName(sc: Scan, name: string): void {
  const dot = name.lastIndexOf('.');
  if (dot !== -1) sc.emit(dot + 1, 'dim');
  sc.emit(name.length - dot - 1, 'exc', dot !== -1 ? javaRef(name) : null);
}

const JVM_CLASS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const JVM_SOURCE = /^([\w$-]+\.(?:java|kt|groovy|scala)):(\d+)$/;

/**
 * A reference to a JVM class, for Go to source, or null when `name` is not one. Java 9+ frames
 * may start with a module or class loader ("java.base/", "app//"), which is not part of the name.
 */
function javaRef(name: string, location?: string, line?: number): SourceRef | null {
  const cls = name.replace(/^.*\//, '');
  if (!JVM_CLASS.test(cls)) return null;
  const loc = location ? JVM_SOURCE.exec(location) : null;
  const ref: SourceRef = { cls };
  if (loc) {
    ref.file = loc[1];
    ref.line = Number(loc[2]);
  } else if (line) ref.line = line;
  return ref;
}

/**
 * After "at ": Java "pkg.Class.method(File.java:12)" or JavaScript "fn (url:line:col)" / "url:line:col".
 * The package is dimmed; Class.method and the source location stand out.
 */
function frame(sc: Scan): void {
  const s = sc.s;
  const java = sc.at(JAVA_FRAME);
  if (java) {
    const name = java[1];
    // Keep "Class.method" (or "Class$Inner.lambda$0") bright and dim the package before it.
    const lastDot = name.lastIndexOf('.');
    const classDot = lastDot > 0 ? name.lastIndexOf('.', lastDot - 1) : -1;
    // The class is everything before the method; the file and line come from the location.
    const ref = lastDot > 0 ? javaRef(name.slice(0, lastDot), java[2]) : null;
    if (classDot !== -1) sc.emit(classDot + 1, 'dim');
    sc.emit(name.length - classDot - 1, 'fn', ref);
    sc.emit(1, 'dim');
    sc.emit(java[2].length, 'loc', ref);
    sc.emit(1, 'dim');
    sc.emit(java[3].replace(/\n$/, '').length, 'dim'); // e.g. Logback's " ~[app.jar:1.0]"
    sc.end();
    return;
  }
  const body = s.slice(sc.i).replace(/\r?\n$/, '');
  const open = body.lastIndexOf(' (');
  if (open > 0 && body.endsWith(')')) {
    sc.emit(open, 'fn');
    sc.emit(2, 'dim');
    sc.emit(body.length - open - 3, 'loc');
    sc.emit(1, 'dim');
  } else {
    sc.emit(body.length, JS_LOCATION.test(body) ? 'loc' : 'fn');
  }
  sc.end();
}

// Plain text: request IDs, UUIDs, URLs, paths, quoted strings, numbers, exception names, key=.
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\w-])/y;
const RID_KEY = /(?:rid|request[_-]?id|req[_-]?id|x-request-id|trace[_-]?id|correlation[_-]?id)(["']?\s*[=:]\s*["']?)([A-Za-z0-9._-]{6,})/iy;
const URL_RE = /(?:https?|wss?|file|jdbc:[a-z]+):\/\/[^\s"'<>()[\]{}]*[^\s"'<>()[\]{}.,;:!?]/y;
const PATH = /\/[\w.~%-]+(?:\/[\w.~%-]*)*(?:\?[^\s"'<>()]*[^\s"'<>().,;:!?])?/y;
const NUM = /\d+(?:\.\d+)?(?:ms|s|kB|KB|MB|GB|B|%)?(?![\w.])/y;
const WORD = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;
const EXC_WORD = /(?:^|\.)[A-Z][\w$]*(?:Exception|Error|Throwable)$/;
const QUOTE_MAX = 300;

/** Free text such as a log message. Untouched characters get `base` (e.g. an exception message). */
function tokText(out: Out, s: string, base?: string): void {
  const sc = new Scan(s, out, base);
  while (!sc.done) {
    const c = s[sc.i];
    const prev = s[sc.i - 1];
    let m: RegExpExecArray | null = null;
    if (/[0-9a-fA-F]/.test(c) && !isWordChar(prev) && (m = sc.at(UUID))) {
      sc.emit(m[0].length, 'id');
    } else if (/[A-Za-z_$]/.test(c)) {
      if (!isWordChar(prev) && (m = sc.at(RID_KEY))) {
        sc.emit(m[0].length - m[2].length, 'key');
        sc.emit(m[2].length, 'id');
      } else if (!isWordChar(prev) && (m = sc.at(URL_RE))) {
        sc.emit(m[0].length, 'url');
      } else {
        m = sc.at(WORD)!;
        const w = m[0];
        if (EXC_WORD.test(w)) sc.emit(w.length, 'exc', w.includes('.') ? javaRef(w) : null);
        else if (s[sc.i + w.length] === '=' && s[sc.i + w.length + 1] !== '=' && !isWordChar(prev)) sc.emit(w.length, 'key');
        else sc.i += w.length;
      }
    } else if (isDigit(c)) {
      if (!isWordChar(prev) && prev !== '.' && prev !== '-' && (m = sc.at(NUM))) sc.emit(m[0].length, 'num');
      else sc.i += 1;
    } else if ((c === '"' || c === "'") && !isWordChar(prev)) {
      const close = closingQuote(s, sc.i, c);
      if (close !== -1) sc.emit(close + 1 - sc.i, 'str');
      else sc.i++;
    } else if (c === '/' && (prev === undefined || prev === ' ' || prev === '\t' || prev === '"' || prev === "'" || prev === '(') && (m = sc.at(PATH))) {
      sc.emit(m[0].length, 'url');
    } else {
      sc.i++;
    }
  }
  sc.end();
}

/** The matching quote on the same line, not followed by a word character (so "it's" is not a string). */
function closingQuote(s: string, open: number, q: string): number {
  const limit = Math.min(s.length, open + QUOTE_MAX);
  for (let j = open + 1; j < limit; j++) {
    const c = s[j];
    if (c === '\n') return -1;
    if (c === q && !isWordChar(s[j + 1])) return j;
  }
  return -1;
}

// ── XML / HTML ──────────────────────────────────────────

const XML_TAG_OPEN = /<\/?[A-Za-z_][\w:.-]*/y;
const XML_ATTR = /[^\s=/>"']+/y;
const XML_VALUE = /"[^"]*"?|'[^']*'?|[^\s>]+/y;
const XML_ENTITY = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z]\w*);/y;

function tokXml(out: Out, s: string): void {
  const sc = new Scan(s, out);
  while (!sc.done) {
    const c = s[sc.i];
    let m: RegExpExecArray | null;
    if (c === '<' && s.startsWith('<!--', sc.i)) {
      const close = s.indexOf('-->', sc.i + 4);
      sc.emit((close === -1 ? s.length : close + 3) - sc.i, 'com');
    } else if (c === '<' && s.startsWith('<![CDATA[', sc.i)) {
      const close = s.indexOf(']]>', sc.i);
      sc.emit((close === -1 ? s.length : close + 3) - sc.i, 'str');
    } else if (c === '<' && (s[sc.i + 1] === '!' || s[sc.i + 1] === '?')) {
      const close = s.indexOf('>', sc.i);
      sc.emit((close === -1 ? s.length : close + 1) - sc.i, 'dim'); // <!doctype …>, <?xml …?>
    } else if (c === '<' && (m = sc.at(XML_TAG_OPEN))) {
      sc.emit(1 + (m[0][1] === '/' ? 1 : 0), 'punc');
      sc.emit(m[0].length - 1 - (m[0][1] === '/' ? 1 : 0), 'tag');
      xmlAttributes(sc);
    } else if (c === '&' && (m = sc.at(XML_ENTITY))) {
      sc.emit(m[0].length, 'num');
    } else {
      sc.i++;
    }
  }
  sc.end();
}

/** Attributes up to and including the tag's closing ">". */
function xmlAttributes(sc: Scan): void {
  const s = sc.s;
  let m: RegExpExecArray | null;
  while (!sc.done) {
    const c = s[sc.i];
    if (c === '>') return sc.emit(1, 'punc');
    if (c === '/' && s[sc.i + 1] === '>') return sc.emit(2, 'punc');
    if (/\s/.test(c)) sc.i++;
    else if (c === '=') {
      sc.emit(1, 'punc');
      if ((m = sc.at(XML_VALUE))) sc.emit(m[0].length, 'str');
    } else if ((m = sc.at(XML_ATTR))) sc.emit(m[0].length, 'attr');
    else sc.i++;
  }
}

// ── Form-encoded bodies ─────────────────────────────────

function tokForm(out: Out, s: string): void {
  s.split('&').forEach((pair, n) => {
    if (n > 0) out.add('&', 'punc');
    const eq = pair.indexOf('=');
    if (eq === -1) return out.add(pair, 'key');
    out.add(pair.slice(0, eq), 'key');
    out.add('=', 'punc');
    out.add(pair.slice(eq + 1), 'str');
  });
}

const TOKENIZERS: Record<Lang, (out: Out, s: string) => void> = {
  json: tokJson,
  sql: tokSql,
  plan: tokPlan,
  log: tokLog,
  xml: tokXml,
  form: tokForm,
  text: (out, s) => tokLog(out, s),
};
