import type { Level } from '../../shared/types';
import type { EventInput } from '../normalize';
import { parseLeadingTimestamp } from './timestamps';
import type { ParseContext } from './tomcat';

/**
 * Common Log Format, optionally followed by the two fields the hub recommends adding:
 *   %h %l %u %t "%r" %s %b %D "%{X-Request-Id}i"
 * %t may also be an ISO timestamp in brackets for millisecond precision.
 */
const LINE = /^(\S+) (\S+) (\S+) (\[[^\]]+\]) "([^"]*)" (\d{3}) (\S+)(?: (\d+(?:\.\d+)?))?(?: "([^"]*)")?/;

const TO_MS = { ms: 1, us: 0.001, s: 1000 } as const;

export function parseAccessLine(
  line: string,
  ctx: ParseContext & { durationUnit: keyof typeof TO_MS },
): EventInput | null {
  const m = LINE.exec(line);
  if (!m) return null;
  const [, remote, , user, bracketed, requestLine, statusText, bytesText, durationText, rid] = m;
  const ts = parseLeadingTimestamp(bracketed);
  const [method, path, protocol] = requestLine.split(' ');
  const status = Number(statusText);
  const durationMs =
    durationText === undefined ? null : Math.round(Number(durationText) * TO_MS[ctx.durationUnit] * 10) / 10;
  const level: Level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

  return {
    tsMs: ts ? ts.ms : ctx.nowMs,
    source: 'tomcat',
    kind: 'request',
    level,
    requestId: rid && rid !== '-' ? rid : null,
    summary: `${method} ${path ?? ''} → ${status}`,
    data: {
      file: ctx.file,
      method,
      path: path ?? '',
      protocol: protocol ?? null,
      status,
      bytes: bytesText === '-' ? 0 : Number(bytesText),
      durationMs,
      remote,
      user: user === '-' ? null : user,
      raw: line,
    },
  };
}
