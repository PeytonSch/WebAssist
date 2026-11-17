import type { Route } from '../shared/route';
import {
  durationOf, failedOf, groupOf, isSender, isStatic, levelOf, RANK, resOf, ridOf, statusOf, webappOf, type Row,
} from './rows';

/**
 * The numbers behind the Metrics screen, worked out from the timeline's rows in one pass. No DOM
 * here, so it is tested in node (test/metrics.test.ts).
 *
 * The questions it answers are a debugging session's: which endpoints are slow, which fail, which
 * are called far more often than expected, and what the server logged while that happened.
 */

/**
 * Which side's record of a request is counted. The same request usually appears twice: once as
 * the browser (or the API screen) saw it and once in Tomcat's access log. Counting both would
 * double every number, so one side is chosen.
 */
export type Side = 'server' | 'client';

/**
 * A request's outcome. Listed in stacking order, from the baseline up: the failures sit on the
 * baseline where they are easiest to compare across time.
 */
export type StatusClass = 'failed' | 's5' | 's4' | 's3' | 's2';
export const CLASSES: readonly StatusClass[] = ['failed', 's5', 's4', 's3', 's2'];
export const CLASS_LABEL: Record<StatusClass, string> = { failed: 'Failed', s5: '5xx', s4: '4xx', s3: '3xx', s2: '2xx' };
const CLASS_INDEX: Record<StatusClass, number> = { failed: 0, s5: 1, s4: 2, s3: 3, s2: 4 };

/** 'all', the last N minutes, or a [from, to] window picked on the chart. */
export type Range = 'all' | number | readonly [number, number];

export interface MetricsOptions {
  range: Range;
  /** 'auto' counts the server's side when the session has access-log requests. */
  side: 'auto' | Side;
  includeStatic: boolean;
  /** Only Tomcat events from this webapp ('' for those with no known webapp); null for all. */
  webapp: string | null;
  /** About how many time buckets the charts get. */
  buckets?: number;
}

export interface Window {
  from: number;
  to: number;
}

export interface Bucket {
  t: number;
  /** Requests per status class, indexed like CLASSES. */
  counts: number[];
  total: number;
  p50: number | null;
  p95: number | null;
  /** The slowest request in the bucket. */
  max: number | null;
}

export interface EndpointStat {
  key: string;
  method: string;
  label: string;
  template: string;
  /** The OpenAPI operation, when a spec named it. */
  title: string | null;
  count: number;
  share: number;
  s4: number;
  s5: number;
  failed: number;
  errors: number;
  /** Errors over answered requests, 0..1. */
  errorRate: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  avgBytes: number | null;
  last: number;
  lastKey: string;
  /** Requests per bucket, for the sparkline. */
  spark: number[];
  /** Whether these are browser asset requests (the timeline hides those by default). */
  isStatic: boolean;
}

export interface Group {
  key: string;
  /** The latest occurrence's text. */
  text: string;
  /** More about it: the root cause of an exception, the logger's error / warning split. */
  detail: string | null;
  count: number;
  errors: number;
  warns: number;
  last: number;
  lastKey: string;
}

export interface QueryGroup {
  statement: string;
  count: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  last: number;
  lastKey: string;
}

export interface Split {
  /** Requests seen by both the browser (or API screen) and the access log, by request ID. */
  n: number;
  clientP50: number;
  serverP50: number;
  /** What the server's time leaves out: network, proxy, queueing. Median of client − server. */
  overheadP50: number;
  overheadP95: number;
  /** The server's part of the total time, 0..1. */
  serverShare: number;
}

export interface Metrics {
  window: Window;
  side: Side;
  /** What the whole session holds, for the controls. */
  hasServer: boolean;
  hasClient: boolean;
  webapps: string[];

  requests: number;
  /** Requests with an outcome (not pending, not canceled). */
  answered: number;
  /** Pending or canceled: counted as requests but not in the outcome numbers. */
  unanswered: number;
  byClass: Record<StatusClass, number>;
  errorRate: number;
  perMin: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  slow: number;

  bucketMs: number;
  buckets: Bucket[];
  endpoints: EndpointStat[];
  /** Status codes, most frequent first; 'failed' for requests that got no response. */
  statuses: { code: string; cls: StatusClass; count: number }[];
  webappStats: { name: string; count: number; errors: number; p95: number | null }[];

  logErrors: number;
  logWarns: number;
  exceptions: Group[];
  exceptionCount: number;
  browserExceptions: number;
  loggers: Group[];
  pgErrors: Group[];
  consoleErrors: Group[];
  consoleErrorCount: number;
  queries: QueryGroup[];
  slowQueries: number;
  split: Split | null;
}

export const SLOW_MS = 1000;
const MIN = 60_000;

// ── Small pure helpers ──────────────────────────────────

/** Nearest-rank percentile of an ascending array: the smallest value with q of the values at or below it. */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

const ascending = (a: number, b: number) => a - b;

export function classOf(status: number | null, failed: boolean, canceled: boolean): StatusClass | null {
  if (failed) return canceled ? null : 'failed';
  if (!status) return null;
  if (status >= 500) return 's5';
  if (status >= 400) return 's4';
  if (status >= 300) return 's3';
  return 's2';
}

/** Bucket sizes that read well on an axis, smallest first. */
const NICE_MS = [
  1, 2, 5, 10, 15, 30,
].map((s) => s * 1000).concat([1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * MIN));

/** The smallest nice bucket size that splits the span into at most `target` buckets. */
export function bucketSize(spanMs: number, target = 60): number {
  for (const size of NICE_MS) if (spanMs / size <= target) return size;
  return Math.ceil(spanMs / target / (1440 * MIN)) * 1440 * MIN;
}

/**
 * SQL with its literals taken out, so the same statement with different values groups together:
 * comments (the request ID tag /* rid=… *\/ among them) dropped, strings, numbers and $n
 * parameters as ?, IN lists and VALUES rows folded to one, whitespace collapsed.
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/[Ee]?'(?:[^']|'')*'/g, '?')
    .replace(/\$\d+/g, '?')
    .replace(/(?<![\w$."])\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(?)')
    .replace(/\(\?\)(?:\s*,\s*\(\?\))+/g, '(?)')
    .trim();
}

const UUID_RE = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi;

/** A message's first line with IDs and numbers as ?, so repeats of one error group together. */
export function messageKey(text: string): string {
  const first = text.split('\n', 1)[0];
  return first.replace(UUID_RE, '?').replace(/\b0x[0-9a-f]+\b/gi, '?').replace(/\d+/g, '?').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** "java.lang.IllegalStateException: Order 42 …" → "java.lang.IllegalStateException". */
export const exceptionClass = (label: string | null | undefined): string => (label ?? '').split(':', 1)[0].trim();

/** First index whose row starts at or after t (rows are oldest first). */
function lowerBound(rows: readonly Row[], t: number): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The window a range covers. `now` is the live clock, or null for a saved session (its last event). */
export function windowOf(rows: readonly Row[], range: Range, now: number | null): Window {
  if (Array.isArray(range)) return { from: range[0], to: range[1] };
  const first = rows.length ? rows[0].t : now ?? 0;
  const last = rows.length ? rows[rows.length - 1].t : now ?? 0;
  const to = now == null ? last : Math.max(now, last);
  if (range === 'all') return { from: Math.min(first, to), to };
  return { from: to - (range as number) * MIN, to };
}

/** Whether a row is one of the requests the chosen side counts. */
export function countsAsRequest(r: Row, side: Side): boolean {
  if (groupOf(r) !== 'network') return false;
  return side === 'server' ? r.ev.source === 'tomcat' : isSender(r.ev.source);
}

/** What the whole session holds: which sides recorded requests, and the webapps seen. */
export function sessionFacts(rows: readonly Row[]): { hasServer: boolean; hasClient: boolean; webapps: string[] } {
  let hasServer = false;
  let hasClient = false;
  const webapps = new Set<string>();
  for (const r of rows) {
    const src = r.ev.source;
    if (src === 'tomcat') {
      if (r.ev.kind === 'request') hasServer = true;
      const app = r.ev.data.webapp;
      if (app) webapps.add(app);
    } else if (!hasClient && isSender(src) && groupOf(r) === 'network') hasClient = true;
  }
  return { hasServer, hasClient, webapps: [...webapps].sort() };
}

// ── Aggregation ─────────────────────────────────────────

interface EndpointAcc {
  stat: EndpointStat;
  durations: number[];
  bytes: number;
  bytesN: number;
  answered: number;
}

interface GroupAcc extends Group {}

function bump(map: Map<string, GroupAcc>, key: string, r: Row, text: string, detail: string | null): GroupAcc {
  let g = map.get(key);
  if (!g) {
    g = { key, text, detail, count: 0, errors: 0, warns: 0, last: r.t, lastKey: r.key };
    map.set(key, g);
  }
  g.count++;
  const lvl = levelOf(r);
  if (lvl === 'error') g.errors++;
  else if (lvl === 'warn') g.warns++;
  // Rows arrive oldest first, so the latest occurrence wins.
  g.text = text;
  if (detail) g.detail = detail;
  g.last = r.t;
  g.lastKey = r.key;
  return g;
}

const byCountThenLast = (a: { count: number; last: number }, b: { count: number; last: number }) => b.count - a.count || b.last - a.last;

/**
 * Everything the Metrics screen shows, in one pass over the rows in the window. `route` names a
 * network row's endpoint (the timeline's routeOf, which knows the OpenAPI templates).
 */
export function computeMetrics(
  rows: readonly Row[],
  opts: MetricsOptions,
  route: (r: Row) => Route | null,
  now: number | null,
): Metrics {
  const facts = sessionFacts(rows);
  const side: Side = opts.side === 'auto' ? (facts.hasServer ? 'server' : 'client') : opts.side;
  const window = windowOf(rows, opts.range, now);
  const span = Math.max(1, window.to - window.from);
  const bucketMs = bucketSize(span, opts.buckets ?? 60);
  const bucketStart = Math.floor(window.from / bucketMs) * bucketMs;
  const nb = Math.max(1, Math.ceil((window.to + 1 - bucketStart) / bucketMs));
  const bucketCounts = Array.from({ length: nb }, () => [0, 0, 0, 0, 0]);
  const bucketDur: number[][] = Array.from({ length: nb }, () => []);
  const bucketOf = (t: number) => Math.min(nb - 1, Math.max(0, Math.floor((t - bucketStart) / bucketMs)));

  const byClass: Record<StatusClass, number> = { failed: 0, s5: 0, s4: 0, s3: 0, s2: 0 };
  let requests = 0;
  let unanswered = 0;
  let slow = 0;
  const durations: number[] = [];
  const endpoints = new Map<string, EndpointAcc>();
  const statuses = new Map<string, { code: string; cls: StatusClass; count: number }>();
  const webapps = new Map<string, { name: string; count: number; errors: number; durations: number[] }>();

  let logErrors = 0;
  let logWarns = 0;
  let browserExceptions = 0;
  let consoleErrorCount = 0;
  let slowQueries = 0;
  const exceptions = new Map<string, GroupAcc>();
  const loggers = new Map<string, GroupAcc>();
  const pgErrors = new Map<string, GroupAcc>();
  const consoleErrors = new Map<string, GroupAcc>();
  const queries = new Map<string, QueryGroup>();
  // Request ID → time, from each side, for the server-vs-browser split.
  const serverTime = new Map<string, number>();
  const clientTime: [string, number][] = [];

  const start = lowerBound(rows, window.from);
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    if (r.t > window.to) break;
    const src = r.ev.source;
    const app = webappOf(r);
    if (opts.webapp !== null && app !== null && app !== opts.webapp) continue;
    const g = groupOf(r);

    if (g === 'network') {
      const asset = isStatic(r);
      // Like the timeline's Hide assets: an asset that failed still counts.
      if (asset && !opts.includeStatic && RANK[levelOf(r)] < RANK.warn) continue;
      const dur = durationOf(r);
      const rid = ridOf(r);
      if (rid && dur != null) {
        if (src === 'tomcat') {
          if (!serverTime.has(rid)) serverTime.set(rid, dur);
        } else if (!failedOf(r)) clientTime.push([rid, dur]);
      }
      if (!countsAsRequest(r, side)) continue;
      requests++;
      const status = statusOf(r);
      const cls = classOf(status, failedOf(r), !!resOf(r)?.data.canceled);
      const rt = route(r);
      const method = String(r.ev.data.method ?? '').toUpperCase();
      const template = rt?.template ?? String(r.ev.data.path ?? r.ev.data.url ?? '?');
      const key = `${method} ${template}`;
      let ep = endpoints.get(key);
      if (!ep) {
        ep = {
          stat: {
            key, method, label: rt?.label ?? template, template, title: rt?.title ?? null,
            count: 0, share: 0, s4: 0, s5: 0, failed: 0, errors: 0, errorRate: 0,
            p50: null, p95: null, max: null, avgBytes: null, last: r.t, lastKey: r.key,
            spark: new Array(nb).fill(0), isStatic: asset,
          },
          durations: [], bytes: 0, bytesN: 0, answered: 0,
        };
        endpoints.set(key, ep);
      }
      const st = ep.stat;
      st.count++;
      st.last = r.t;
      st.lastKey = r.key;
      const b = bucketOf(r.t);
      st.spark[b]++;
      const bytes: number | null | undefined = src === 'tomcat' ? r.ev.data.bytes : resOf(r)?.data.encodedBytes;
      if (typeof bytes === 'number') {
        ep.bytes += bytes;
        ep.bytesN++;
      }
      if (src === 'tomcat') {
        const name = app || '(unknown)';
        let w = webapps.get(name);
        if (!w) webapps.set(name, (w = { name, count: 0, errors: 0, durations: [] }));
        w.count++;
        if (cls === 's5' || cls === 's4' || cls === 'failed') w.errors++;
        if (dur != null) w.durations.push(dur);
      }
      if (cls === null) {
        unanswered++;
        continue;
      }
      byClass[cls]++;
      ep.answered++;
      bucketCounts[b][CLASS_INDEX[cls]]++;
      if (cls === 's4') st.s4++;
      else if (cls === 's5') st.s5++;
      else if (cls === 'failed') st.failed++;
      const code = cls === 'failed' ? 'failed' : String(status);
      const sc = statuses.get(code);
      if (sc) sc.count++;
      else statuses.set(code, { code, cls, count: 1 });
      if (dur != null) {
        durations.push(dur);
        ep.durations.push(dur);
        bucketDur[b].push(dur);
        if (dur >= SLOW_MS) slow++;
      }
      continue;
    }

    const lvl = r.ev.level;
    if (src === 'tomcat' && g === 'log') {
      if (lvl === 'error') logErrors++;
      else if (lvl === 'warn') logWarns++;
      const d = r.ev.data;
      if (d.exception) {
        const cause = exceptionClass(d.rootCause);
        const cls = exceptionClass(d.exception);
        // By class, message (with its numbers folded) and root cause: one IllegalStateException
        // thrown from two places is two problems.
        bump(exceptions, `${cls}|${messageKey(d.exception)}|${cause}`, r, d.exception, d.rootCause && cause !== cls ? d.rootCause : null);
      }
      if (lvl === 'error' || lvl === 'warn') {
        const logger: string = d.logger ?? '';
        bump(loggers, logger, r, r.ev.summary, null);
      }
    } else if (src === 'postgres') {
      if (lvl === 'error') bump(pgErrors, messageKey(r.ev.summary), r, r.ev.summary.split('\n', 1)[0], r.ev.data.statement ?? null);
      const ms = r.ev.data.durationMs;
      if (g === 'query' && typeof ms === 'number') {
        slowQueries++;
        const stmt = normalizeSql(String(r.ev.data.statement ?? r.ev.summary.replace(/^\d+ ms · /, '')));
        let q = queries.get(stmt);
        if (!q) queries.set(stmt, (q = { statement: stmt, count: 0, totalMs: 0, avgMs: 0, maxMs: 0, last: r.t, lastKey: r.key }));
        q.count++;
        q.totalMs += ms;
        q.maxMs = Math.max(q.maxMs, ms);
        q.last = r.t;
        q.lastKey = r.key;
      }
    } else if (src === 'browser' && g === 'console' && lvl === 'error') {
      consoleErrorCount++;
      if (r.ev.data.type === 'exception') browserExceptions++;
      bump(consoleErrors, messageKey(r.ev.summary), r, r.ev.summary.split('\n', 1)[0], null);
    }
  }

  durations.sort(ascending);
  const answered = requests - unanswered;
  const errorCount = byClass.s4 + byClass.s5 + byClass.failed;

  const buckets: Bucket[] = bucketCounts.map((counts, i) => {
    const d = bucketDur[i].sort(ascending);
    return { t: bucketStart + i * bucketMs, counts, total: counts.reduce((a, b) => a + b, 0), p50: percentile(d, 0.5), p95: percentile(d, 0.95), max: d.length ? d[d.length - 1] : null };
  });

  const endpointStats = [...endpoints.values()].map(({ stat, durations: d, bytes, bytesN, answered: n }) => {
    d.sort(ascending);
    stat.share = requests ? stat.count / requests : 0;
    stat.errors = stat.s4 + stat.s5 + stat.failed;
    stat.errorRate = n ? stat.errors / n : 0;
    stat.p50 = percentile(d, 0.5);
    stat.p95 = percentile(d, 0.95);
    stat.max = d.length ? d[d.length - 1] : null;
    stat.avgBytes = bytesN ? bytes / bytesN : null;
    return stat;
  }).sort(byCountThenLast);

  for (const q of queries.values()) q.avgMs = q.totalMs / q.count;

  return {
    window,
    side,
    ...facts,
    requests,
    answered,
    unanswered,
    byClass,
    errorRate: answered ? errorCount / answered : 0,
    perMin: requests / Math.max(1, span / MIN),
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    max: durations.length ? durations[durations.length - 1] : null,
    slow,
    bucketMs,
    buckets,
    endpoints: endpointStats,
    statuses: [...statuses.values()].sort((a, b) => b.count - a.count),
    webappStats: [...webapps.values()]
      .map((w) => ({ name: w.name, count: w.count, errors: w.errors, p95: percentile(w.durations.sort(ascending), 0.95) }))
      .sort((a, b) => b.count - a.count),
    logErrors,
    logWarns,
    exceptions: [...exceptions.values()].sort(byCountThenLast),
    exceptionCount: [...exceptions.values()].reduce((n, g) => n + g.count, 0),
    browserExceptions,
    loggers: [...loggers.values()].sort((a, b) => b.errors - a.errors || byCountThenLast(a, b)),
    pgErrors: [...pgErrors.values()].sort(byCountThenLast),
    consoleErrors: [...consoleErrors.values()].sort(byCountThenLast),
    consoleErrorCount,
    queries: [...queries.values()].sort((a, b) => b.totalMs - a.totalMs),
    slowQueries,
    split: splitOf(serverTime, clientTime),
  };
}

/** How much of the browser's time for a request was the server's, over requests both sides saw. */
function splitOf(serverTime: Map<string, number>, clientTime: [string, number][]): Split | null {
  const client: number[] = [];
  const server: number[] = [];
  const overhead: number[] = [];
  let sumClient = 0;
  let sumServer = 0;
  for (const [rid, c] of clientTime) {
    const s = serverTime.get(rid);
    if (s === undefined) continue;
    client.push(c);
    server.push(s);
    overhead.push(Math.max(0, c - s));
    sumClient += c;
    sumServer += Math.min(s, c);
  }
  if (client.length === 0) return null;
  client.sort(ascending);
  server.sort(ascending);
  overhead.sort(ascending);
  return {
    n: client.length,
    clientP50: percentile(client, 0.5)!,
    serverP50: percentile(server, 0.5)!,
    overheadP50: percentile(overhead, 0.5)!,
    overheadP95: percentile(overhead, 0.95)!,
    serverShare: sumClient ? sumServer / sumClient : 0,
  };
}
