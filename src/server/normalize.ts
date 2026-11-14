import { randomUUID } from 'node:crypto';
import type { HubEvent, Kind, Level, Source } from '../shared/types';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Epoch ms -> ISO-8601 in the hub machine's time zone, millisecond precision. */
export function isoLocal(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export interface EventInput {
  tsMs: number;
  source: Source;
  kind: Kind;
  level: Level;
  requestId?: string | null;
  summary: string;
  data?: Record<string, any>;
}

const MAX_SUMMARY = 400;

export function makeEvent(input: EventInput): HubEvent {
  const oneLine = input.summary.replace(/\s+/g, ' ').trim();
  return {
    id: randomUUID(),
    ts: isoLocal(Number.isFinite(input.tsMs) ? input.tsMs : Date.now()),
    source: input.source,
    kind: input.kind,
    level: input.level,
    requestId: input.requestId ?? null,
    summary: oneLine.length > MAX_SUMMARY ? oneLine.slice(0, MAX_SUMMARY - 1) + '…' : oneLine,
    data: input.data ?? {},
  };
}

export const REDACTED = '[redacted]';

export function redactHeaders(
  headers: Record<string, unknown> | undefined,
  names: string[],
): Record<string, string> {
  const deny = new Set(names.map((n) => n.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k] = deny.has(k.toLowerCase()) ? REDACTED : String(v);
  }
  return out;
}

export function headerValue(headers: Record<string, unknown> | undefined, name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === want && v != null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

export interface Truncated {
  text: string;
  truncated: boolean;
  bytes: number;
}

export function truncateText(text: string, maxBytes: number): Truncated {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  // Cut on a byte boundary, then drop a trailing partial character if there is one.
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
  return { text: cut, truncated: true, bytes };
}

export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'));
}

export function findRequestId(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m && m[1]) return m[1];
  }
  return null;
}
