import type { Level } from '../../shared/types';
import type { EventInput } from '../normalize';
import { findRequestId } from '../normalize';
import { parseLeadingTimestamp } from './timestamps';

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
const LEVEL_RE = /\b(SEVERE|FATAL|ERROR|WARNING|WARN|INFO|CONFIG|DEBUG|FINE|FINER|FINEST|TRACE)\b/;
// Leading decorations between the timestamp and the message: [thread], LEVEL, "1234 ---", "-", ":".
const PREFIX_TOKEN = /^(?:\[[^\]]*\]|(?:SEVERE|FATAL|ERROR|WARNING|WARN|INFO|CONFIG|DEBUG|FINE|FINER|FINEST|TRACE)\b:?|\d+\s+---|-{1,3}(?=\s)|:)\s*/;
const STACK_FRAME = /^\s+at\s/;
const EXCEPTION = /^\s*(?:Caused by:\s*)?((?:[\w$]+\.)+[\w$]*(?:Exception|Error|Throwable|Failure))\b(?::\s*(.*))?/;

/** A line that starts a new application-log entry (as opposed to continuing a stack trace). */
export function isTomcatEntryStart(line: string): boolean {
  return parseLeadingTimestamp(line) !== null;
}

/** Turns one grouped application-log entry (first line plus continuation lines) into an event. */
export function parseTomcatEntry(lines: string[], ctx: ParseContext): EventInput {
  const first = lines[0];
  const text = lines.join('\n');
  const ts = parseLeadingTimestamp(first);
  let rest = (ts ? first.slice(ts.length) : first).trim();

  const levelMatch = ts ? LEVEL_RE.exec(rest.slice(0, 160)) : null;
  let thread: string | null = null;
  for (;;) {
    const m = PREFIX_TOKEN.exec(rest);
    if (!m || m[0].length === 0) break;
    if (!thread && m[0].startsWith('[')) thread = m[0].trim().slice(1, -1);
    rest = rest.slice(m[0].length);
  }

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

  const level: Level = levelMatch ? LEVELS[levelMatch[1]] : stackFrames > 0 ? 'error' : 'info';

  let summary = rest || first.trim();
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
      exception,
      rootCause,
      stackFrames,
      lines: lines.length,
    },
  };
}
