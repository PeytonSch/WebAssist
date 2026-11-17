/**
 * Links browser requests to server events.
 *
 * Level 2/3 (exact): events share a request ID.
 * Level 1 (approximate): no ID available, so match by URL path and time window.
 */
export interface CorrItem {
  id: string;
  /** Start time, epoch ms. */
  t: number;
  /** End time, epoch ms (network rows that have completed). */
  tEnd?: number;
  source: string;
  /** 'network' | 'console' | 'log' | 'query' | 'marker' */
  group: string;
  level: string;
  requestId: string | null;
  path?: string;
  method?: string;
}

export interface Correlation {
  exact: CorrItem[];
  approx: CorrItem[];
}

/** Access-log timestamps are often second-resolution, so allow for truncation. */
const ACCESS_LOG_SLACK_MS = 1500;
const LOG_LEAD_MS = 100;
const LOG_TRAIL_MS = 250;

function stripQuery(p: string): string {
  const i = p.search(/[?#]/);
  return i === -1 ? p : p.slice(0, i);
}

/** A dev proxy may add or strip a prefix, so a suffix match counts. */
export function pathsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = stripQuery(a);
  const y = stripQuery(b);
  if (x === y) return true;
  if (x.length < 2 || y.length < 2) return false;
  return x.endsWith(y) || y.endsWith(x);
}

/** Where requests are made from: the browser, or the hub's API client. Both match the same way. */
const sender = (source: string) => source === 'browser' || source === 'client';

function methodsMatch(a?: string, b?: string): boolean {
  return !a || !b || a === b;
}

export function correlate(target: CorrItem, all: CorrItem[], windowMs = 2000): Correlation {
  const none: Correlation = { exact: [], approx: [] };
  if (target.group === 'marker') return none;

  if (target.requestId) {
    return {
      exact: all.filter((x) => x.id !== target.id && x.requestId === target.requestId),
      approx: [],
    };
  }

  const end = target.tEnd ?? target.t;
  let approx: CorrItem[] = [];

  if (sender(target.source) && target.group === 'network') {
    const access = all
      .filter(
        (x) =>
          x.source === 'tomcat' &&
          x.group === 'network' &&
          !x.requestId &&
          methodsMatch(x.method, target.method) &&
          pathsMatch(x.path, target.path) &&
          x.t >= target.t - ACCESS_LOG_SLACK_MS &&
          x.t <= end + windowMs,
      )
      .sort((p, q) => Math.abs(p.t - target.t) - Math.abs(q.t - target.t))[0];
    const logs = all.filter(
      (x) =>
        !sender(x.source) &&
        x.source !== 'hub' &&
        x.group !== 'network' &&
        !x.requestId &&
        x.t >= target.t - LOG_LEAD_MS &&
        x.t <= end + LOG_TRAIL_MS,
    );
    approx = access ? [access, ...logs] : logs;
  } else if (target.source === 'browser') {
    // A console message: surface requests that failed just before it.
    approx = all.filter((x) => {
      if (x.source !== 'browser' || x.group !== 'network') return false;
      if (x.level !== 'error' && x.level !== 'warn') return false;
      const xe = x.tEnd ?? x.t;
      return xe >= target.t - windowMs && xe <= target.t + LOG_LEAD_MS;
    });
  } else if (target.group === 'network') {
    // A Tomcat access-log line: find the browser request it served.
    approx = all.filter(
      (x) =>
        sender(x.source) &&
        x.group === 'network' &&
        !x.requestId &&
        methodsMatch(x.method, target.method) &&
        pathsMatch(x.path, target.path) &&
        target.t >= x.t - ACCESS_LOG_SLACK_MS &&
        target.t <= (x.tEnd ?? x.t) + windowMs,
    );
  } else {
    // A server log line or query: find browser requests in flight at that moment.
    approx = all.filter(
      (x) =>
        sender(x.source) &&
        x.group === 'network' &&
        !x.requestId &&
        target.t >= x.t - LOG_LEAD_MS &&
        target.t <= (x.tEnd ?? x.t) + LOG_TRAIL_MS,
    );
  }

  return { exact: [], approx: approx.sort((p, q) => p.t - q.t) };
}
