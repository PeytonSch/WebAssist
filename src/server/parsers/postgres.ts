import type { Level } from '../../shared/types';
import type { EventInput } from '../normalize';
import { findRequestId } from '../normalize';
import { parseLeadingTimestamp } from './timestamps';
import type { ParseContext } from './tomcat';

const SEVERITY = /\b(DEBUG[1-5]?|LOG|INFO|NOTICE|WARNING|ERROR|FATAL|PANIC|DETAIL|HINT|STATEMENT|CONTEXT|QUERY):\s+/;
/** These lines belong to the entry above them even though they carry their own prefix. */
const FOLLOW_UP = new Set(['DETAIL', 'HINT', 'STATEMENT', 'CONTEXT', 'QUERY']);

const LEVELS: Record<string, Level> = {
  LOG: 'info', INFO: 'info', NOTICE: 'info',
  WARNING: 'warn',
  ERROR: 'error', FATAL: 'error', PANIC: 'error',
};

function severityOf(line: string): string | null {
  const ts = parseLeadingTimestamp(line);
  if (!ts) return null;
  const m = SEVERITY.exec(line.slice(ts.length));
  return m ? m[1] : null;
}

export function isPostgresEntryStart(line: string): boolean {
  const sev = severityOf(line);
  return sev !== null && !FOLLOW_UP.has(sev);
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export function parsePostgresEntry(lines: string[], ctx: ParseContext): EventInput {
  const first = lines[0];
  const text = lines.join('\n');
  const ts = parseLeadingTimestamp(first);
  const afterTs = ts ? first.slice(ts.length) : first;
  const sevMatch = SEVERITY.exec(afterTs);
  const severity = sevMatch ? sevMatch[1] : 'LOG';
  const prefix = sevMatch ? afterTs.slice(0, sevMatch.index) : '';
  const pid = /\[(\d+)\]/.exec(prefix)?.[1] ?? null;

  // Message of the first line plus its tab-indented continuation lines.
  let headEnd = 1;
  while (headEnd < lines.length && severityOf(lines[headEnd]) === null) headEnd++;
  const headFirst = sevMatch ? afterTs.slice(sevMatch.index + sevMatch[0].length) : afterTs.trim();
  const head = [headFirst, ...lines.slice(1, headEnd)].join('\n');

  const durationMatch = /duration: ([\d.]+) ms/.exec(head);
  const durationMs = durationMatch ? Number(durationMatch[1]) : null;

  let statement: string | null = null;
  let plan: string | null = null;
  const planIdx = head.search(/\bplan:\s*\n/);
  if (planIdx !== -1) {
    plan = head.slice(head.indexOf('\n', planIdx) + 1).replace(/^\t/gm, '');
    const qt = /^Query Text: ([\s\S]*?)(?=\n\S|$)/m.exec(plan);
    if (qt) {
      statement = qt[1].trim();
      plan = plan.slice(qt.index + qt[0].length).trim();
    }
  } else {
    const st = /(?:statement|execute [^:]*|parse [^:]*|bind [^:]*):\s([\s\S]*)$/.exec(head);
    if (st) statement = st[1].trim();
  }

  // DETAIL / HINT / STATEMENT follow-up lines.
  const extras: Record<string, string> = {};
  for (let i = headEnd; i < lines.length; i++) {
    const sev = severityOf(lines[i]);
    if (!sev) continue;
    let j = i + 1;
    while (j < lines.length && severityOf(lines[j]) === null) j++;
    const lts = parseLeadingTimestamp(lines[i])!;
    const lm = SEVERITY.exec(lines[i].slice(lts.length))!;
    const body = [lines[i].slice(lts.length + lm.index + lm[0].length), ...lines.slice(i + 1, j)].join('\n');
    extras[sev.toLowerCase()] = body;
    i = j - 1;
  }
  if (!statement && extras.statement) statement = extras.statement.trim();

  const isQuery = durationMs !== null || statement !== null;
  let level: Level = LEVELS[severity] ?? 'debug';
  // Postgres only logs a duration when the statement crossed log_min_duration_statement.
  if (durationMs !== null && level === 'info') level = 'warn';

  let summary: string;
  if (durationMs !== null && statement) summary = `${Math.round(durationMs)} ms · ${squash(statement)}`;
  else if (severity === 'LOG') summary = squash(head);
  else summary = `${severity}: ${squash(head)}`;

  return {
    tsMs: ts ? ts.ms : ctx.nowMs,
    source: 'postgres',
    kind: isQuery ? 'query' : 'log',
    level,
    requestId: findRequestId(text, ctx.ridPatterns),
    summary,
    data: {
      file: ctx.file,
      message: text,
      severity,
      pid,
      durationMs,
      statement,
      plan,
      detail: extras.detail ?? null,
      hint: extras.hint ?? null,
    },
  };
}
