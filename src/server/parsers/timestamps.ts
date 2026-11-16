export interface ParsedTs {
  ms: number;
  /** Number of characters the timestamp occupies at the start of the line. */
  length: number;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 2026-11-14 08:16:00.123 | 2026-11-14T08:16:00,123-08:00 | 2026-11-14 08:16:00.123 UTC
// A zone separated by a space must be Z/UTC/GMT or a full +hhmm, so "… -12 items" is not an offset.
const ISO = /^\[?(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?(?:(?:(Z|[+-]\d\d(?::?\d\d)?)| (Z|UTC|GMT|[+-]\d\d:?\d\d))(?![\w:]))?\]?/;
// 14-Nov-2026 08:16:00.123 (Tomcat JUL)
const JUL = /^\[?(\d\d)-([A-Za-z]{3})-(\d{4}) (\d\d):(\d\d):(\d\d)(?:[.,](\d{1,9}))?\]?/;
// 14/Nov/2026:08:16:00 -0800 (Common Log Format)
const CLF = /^\[?(\d\d)\/([A-Za-z]{3})\/(\d{4}):(\d\d):(\d\d):(\d\d)(?: ([+-]\d{4}))?\]?/;
// Nov 14, 2026 8:16:00 AM (java.util.logging's SimpleFormatter, the JUL default outside Tomcat)
const JUL_SIMPLE = /^([A-Za-z]{3}) (\d{1,2}), (\d{4}),? (\d{1,2}):(\d\d):(\d\d) ?([AP]M)\b/i;
// 08:16:00.123 (Logback's default pattern has no date)
const TIME_ONLY = /^\[?(\d\d):(\d\d):(\d\d)[.,](\d{3})\]?/;

function fracToMs(frac?: string): number {
  return frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
}

function offsetMinutes(tz: string): number {
  if (tz === 'Z' || tz === 'UTC' || tz === 'GMT') return 0;
  const sign = tz[0] === '-' ? -1 : 1;
  const digits = tz.slice(1).replace(':', '');
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
}

function build(
  y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, tz?: string,
): number {
  // No zone on the line means the log was written in local time on this machine.
  if (!tz) return new Date(y, mo, d, h, mi, s, ms).getTime();
  return Date.UTC(y, mo, d, h, mi, s, ms) - offsetMinutes(tz) * 60_000;
}

/** Parses a timestamp at the start of a log line. Returns null when there is none. */
export function parseLeadingTimestamp(line: string, now = new Date()): ParsedTs | null {
  let m = ISO.exec(line);
  if (m) {
    return {
      ms: build(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], fracToMs(m[7]), m[8] ?? m[9]),
      length: m[0].length,
    };
  }
  m = JUL.exec(line);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo === undefined) return null;
    return { ms: build(+m[3], mo, +m[1], +m[4], +m[5], +m[6], fracToMs(m[7])), length: m[0].length };
  }
  m = CLF.exec(line);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo === undefined) return null;
    return { ms: build(+m[3], mo, +m[1], +m[4], +m[5], +m[6], 0, m[7]), length: m[0].length };
  }
  m = JUL_SIMPLE.exec(line);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) return null;
    const h12 = +m[4] % 12;
    const h = m[7].toUpperCase() === 'PM' ? h12 + 12 : h12;
    return { ms: build(+m[3], mo, +m[2], h, +m[5], +m[6], 0), length: m[0].length };
  }
  m = TIME_ONLY.exec(line);
  if (m) {
    return {
      ms: build(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], +m[3], +m[4]),
      length: m[0].length,
    };
  }
  return null;
}
