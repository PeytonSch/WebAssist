import type { Level } from '../../shared/types';
import type { EventInput } from '../normalize';
import { findRequestId } from '../normalize';
import { parseLeadingTimestamp, type ParsedTs } from './timestamps';

export interface ParseContext {
  file: string;
  ridPatterns: RegExp[];
  /** Used when a line carries no timestamp of its own. */
  nowMs: number;
}

const LEVELS: Record<string, Level> = {
  SEVERE: 'error', FATAL: 'error', ERROR: 'error',
  WARNING: 'warn', WARN: 'warn',
  INFO: 'info', CONFIG: 'info',
  DEBUG: 'debug', FINE: 'debug', FINER: 'debug', FINEST: 'debug', TRACE: 'debug',
};
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_WORDS = 'SEVERE|FATAL|ERROR|WARNING|WARN|INFO|CONFIG|DEBUG|FINE|FINER|FINEST|TRACE';
const LEVEL_RE = new RegExp(`\\b(${LEVEL_WORDS})\\b`);
// A level standing as a token of its own: DEBUG, DEBUG:, [DEBUG] or Log4j's padded [INFO ].
const LEVEL_TOKEN = new RegExp(`^(?:\\[\\s*(${LEVEL_WORDS})\\s*\\]|(${LEVEL_WORDS}):?)(?=\\s|$)`);
// Other leading decorations: [thread], "1234 ---" (Spring Boot's PID), "-", ":".
const DECORATION = /^(?:\[[^\]]*\]|\d+\s+---|-{1,3}(?=\s)|:)\s*/;
// Log4j's TTCC layout starts with milliseconds since startup: "1234 [main] DEBUG ...".
const RELATIVE_MS = /^\d+\s+(?=\[)/;
/**
 * A line without a timestamp that still starts an entry because it starts with a level, as
 * console appenders write them into catalina.out: "DEBUG com.x.Y - msg", "[DEBUG] msg",
 * "[main] DEBUG ...", "1234 [main] DEBUG ...". Group 3 is set for the "LEVEL:" form.
 */
const HEADLESS_START = new RegExp(
  `^(?:\\d+ +(?=\\[))?(?:\\[[^\\]\\s]{1,80}\\] +)?(?:\\[\\s*(?:${LEVEL_WORDS})\\s*\\]|(?:${LEVEL_WORDS})(:)?)(?=\\s|$)`,
);
const STACK_FRAME = /^\s+at\s/;
/**
 * The logger at the start of a message: a class name (com.x.OrderService, Logback's shortened
 * c.x.OrderService), or JUL's class and method (com.x.OrderService.load), as layouts print it.
 */
const LOGGER = /^((?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:\.[a-z_$<][\w$<>]*)?)(?=\s|:|$)/;
const EXCEPTION = /^\s*(?:Caused by:\s*)?((?:[\w$]+\.)+[\w$]*(?:Exception|Error|Throwable|Failure))\b(?::\s*(.*))?/;

interface Head {
  ts: ParsedTs | null;
  /** The level word as written (FINE, WARN), or null when the line has none in its prefix. */
  level: string | null;
  thread: string | null;
  /** The line with the timestamp, level and other decorations removed. */
  rest: string;
}

/**
 * Splits the prefix of a log line into timestamp, level and thread, whatever their order:
 * "16-Nov-2026 10:00:00.123 FINE [main] ...", "DEBUG 2026-11-16 10:00:00.123 [main] ...",
 * "10:02:11.123 [exec-1] DEBUG c.x.Y - ...", "[DEBUG] ...".
 */
function parseHead(line: string): Head {
  let rest = line.trim();
  let ts: ParsedTs | null = null;
  let level: string | null = null;
  let thread: string | null = null;
  const tt = RELATIVE_MS.exec(rest);
  if (tt) rest = rest.slice(tt[0].length);
  for (let i = 0; i < 16 && rest; i++) {
    if (!ts) {
      const t = parseLeadingTimestamp(rest);
      if (t) {
        ts = t;
        rest = rest.slice(t.length).trimStart();
        continue;
      }
    }
    // Only the first level counts; a second one ("WARN: disk full") is part of the message.
    const lv: RegExpExecArray | null = level ? null : LEVEL_TOKEN.exec(rest);
    if (lv) {
      level = lv[1] ?? lv[2];
      rest = rest.slice(lv[0].length).trimStart();
      continue;
    }
    const m = DECORATION.exec(rest);
    if (!m || m[0].length === 0) break;
    if (!thread && m[0].startsWith('[')) thread = m[0].trim().slice(1, -1);
    rest = rest.slice(m[0].length);
  }
  return { ts, level, thread, rest };
}

/** A header line of JUL's SimpleFormatter: a timestamp and the source, with the level on the next line. */
function isLevelLessHeader(line: string): boolean {
  if (/^\s/.test(line)) return false;
  const head = parseHead(line);
  return head.ts !== null && head.level === null;
}

/**
 * A line that starts a new application-log entry, as opposed to continuing one (a stack frame,
 * the rest of a multi-line message). `pending` is the entry collected so far, if any.
 */
export function isTomcatEntryStart(line: string, pending?: readonly string[]): boolean {
  if (parseLeadingTimestamp(line) !== null) return true;
  const m = HEADLESS_START.exec(line);
  if (!m) return false;
  // SimpleFormatter's second line ("FINE: Saved order 43") belongs to the timestamp line above it.
  if (m[1] && pending?.length === 1 && isLevelLessHeader(pending[0])) return false;
  return true;
}

/** The most severe level that a continuation line states at its start, e.g. "FINE: ..." under a JUL header. */
function levelFromLines(lines: string[]): { word: string; line: number } | null {
  let best: { word: string; line: number } | null = null;
  lines.forEach((l, i) => {
    if (/^\s/.test(l)) return;
    const word = parseHead(l).level;
    if (word && (!best || RANK[LEVELS[word]] > RANK[LEVELS[best.word]])) best = { word, line: i };
  });
  return best;
}

/** Turns one grouped application-log entry (first line plus continuation lines) into an event. */
export function parseTomcatEntry(lines: string[], ctx: ParseContext): EventInput {
  const first = lines[0];
  const text = lines.join('\n');
  const head = parseHead(first);
  const { ts, thread } = head;

  const stackFrames = lines.filter((l) => STACK_FRAME.test(l)).length;
  let exception: string | null = null;
  let rootCause: string | null = null;
  for (const l of lines) {
    const m = EXCEPTION.exec(l);
    if (!m) continue;
    const label = m[2] ? `${m[1]}: ${m[2]}` : m[1];
    if (!exception) exception = label;
    if (/^\s*Caused by:/.test(l)) rootCause = label;
  }

  let summary = head.rest || first.trim();
  // The level, in order of trust: a level token in the first line's prefix; a level word further
  // into a timestamped first line (layouts that print the logger first); a level the following
  // lines state themselves. Only with none of those is it guessed.
  let word = head.level ?? (ts ? LEVEL_RE.exec(head.rest.slice(0, 160))?.[1] ?? null : null);
  if (!word) {
    const found = levelFromLines(lines.slice(1));
    if (found) {
      word = found.word;
      // SimpleFormatter: the message is on the level line; the first line only names the source.
      if (found.line === 0) summary = parseHead(lines[1]).rest || summary;
    }
  }
  const level: Level = word ? LEVELS[word] : stackFrames > 0 ? 'error' : 'info';

  if (stackFrames > 0) {
    const cause = rootCause ?? exception;
    if (cause && !summary.includes(cause)) summary = `${summary} — ${cause}`;
  }

  return {
    tsMs: ts ? ts.ms : ctx.nowMs,
    source: 'tomcat',
    kind: 'log',
    level,
    requestId: findRequestId(text, ctx.ridPatterns),
    summary,
    data: {
      file: ctx.file,
      message: text,
      thread,
      logger: LOGGER.exec(head.rest)?.[1] ?? null,
      exception,
      rootCause,
      stackFrames,
      lines: lines.length,
    },
  };
}
