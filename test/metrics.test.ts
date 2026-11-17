import { describe, expect, it } from 'vitest';
import { RouteMatcher } from '../src/shared/route';
import type { HubEvent, Level, Source } from '../src/shared/types';
import {
  bucketSize, classOf, computeMetrics, messageKey, normalizeSql, percentile, windowOf, type MetricsOptions,
} from '../src/ui/metricsmodel';
import { routeWith, type Row } from '../src/ui/rows';

const T0 = Date.parse('2026-11-17T10:00:00.000Z');
let seq = 0;

function event(t: number, source: Source, kind: HubEvent['kind'], level: Level, data: Record<string, any>, extra: Partial<HubEvent> = {}): HubEvent {
  return { id: `e${++seq}`, ts: new Date(t).toISOString(), source, kind, level, requestId: null, summary: '', data, ...extra };
}

/** A browser (or API screen) request row with its response folded in, like the timeline's. */
function clientReq(t: number, url: string, status: number | null, ms: number | null, o: { method?: string; source?: Source; type?: string; rid?: string; failed?: boolean; canceled?: boolean; bytes?: number } = {}): Row {
  const source = o.source ?? 'browser';
  const method = o.method ?? 'GET';
  const ev = event(t, source, 'request', 'info', { method, url, resourceType: o.type ?? (source === 'client' ? 'API' : 'Fetch') }, { requestId: o.rid ?? null });
  const row: Row = { key: ev.id, t, ev };
  if (status !== null || o.failed) {
    const level: Level = o.failed && !o.canceled ? 'error' : (status ?? 0) >= 500 ? 'error' : (status ?? 0) >= 400 ? 'warn' : 'info';
    row.res = event(t + (ms ?? 0), source, 'response', level, {
      method, url, status, durationMs: ms, resourceType: o.type ?? 'Fetch',
      ...(o.failed && { failed: true, canceled: !!o.canceled, errorText: 'net::ERR_FAILED' }),
      ...(o.bytes !== undefined && { encodedBytes: o.bytes }),
    }, { requestId: o.rid ?? null });
    row.tEnd = t + (ms ?? 0);
  }
  return row;
}

/** A Tomcat access-log request row. */
function serverReq(t: number, path: string, status: number, ms: number, o: { method?: string; rid?: string; webapp?: string; bytes?: number } = {}): Row {
  const level: Level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  const ev = event(t, 'tomcat', 'request', level, { method: o.method ?? 'GET', path, status, durationMs: ms, bytes: o.bytes ?? 100, ...(o.webapp !== undefined && { webapp: o.webapp }) }, { requestId: o.rid ?? null });
  return { key: ev.id, t, ev, tEnd: t + ms };
}

function logRow(t: number, source: Source, kind: HubEvent['kind'], level: Level, summary: string, data: Record<string, any> = {}): Row {
  const ev = event(t, source, kind, level, data, { summary });
  return { key: ev.id, t, ev };
}

const sorted = (rows: Row[]) => rows.sort((a, b) => a.t - b.t);
const OPTS: MetricsOptions = { range: 'all', side: 'auto', includeStatic: false, webapp: null };
const matcher = new RouteMatcher();
const route = (r: Row) => routeWith(r, matcher);
const run = (rows: Row[], o: Partial<MetricsOptions> = {}, now: number | null = null) => computeMetrics(sorted(rows), { ...OPTS, ...o }, route, now);

describe('percentile', () => {
  it('uses the nearest rank', () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.95)).toBe(100);
    expect(percentile(xs, 0.9)).toBe(90);
    expect(percentile([7], 0.5)).toBe(7);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('classOf', () => {
  it('sorts outcomes into status classes', () => {
    expect(classOf(200, false, false)).toBe('s2');
    expect(classOf(204, false, false)).toBe('s2');
    expect(classOf(302, false, false)).toBe('s3');
    expect(classOf(404, false, false)).toBe('s4');
    expect(classOf(503, false, false)).toBe('s5');
    expect(classOf(null, true, false)).toBe('failed');
  });
  it('leaves pending and canceled requests without an outcome', () => {
    expect(classOf(null, false, false)).toBeNull();
    expect(classOf(0, false, false)).toBeNull();
    expect(classOf(null, true, true)).toBeNull();
  });
});

describe('bucketSize and windowOf', () => {
  it('picks a nice size that keeps the bucket count at or under the target', () => {
    expect(bucketSize(5 * 60_000, 60)).toBe(5_000);
    expect(bucketSize(15 * 60_000, 60)).toBe(15_000);
    expect(bucketSize(60 * 60_000, 60)).toBe(60_000);
    expect(bucketSize(30_000, 60)).toBe(1_000);
    expect(bucketSize(8 * 3600_000, 60)).toBe(10 * 60_000);
  });

  it('ends a live window now and a saved session at its last event', () => {
    const rows = sorted([serverReq(T0, '/a', 200, 5), serverReq(T0 + 120_000, '/a', 200, 5)]);
    expect(windowOf(rows, 'all', null)).toEqual({ from: T0, to: T0 + 120_000 });
    expect(windowOf(rows, 'all', T0 + 600_000)).toEqual({ from: T0, to: T0 + 600_000 });
    expect(windowOf(rows, 5, T0 + 600_000)).toEqual({ from: T0 + 300_000, to: T0 + 600_000 });
    expect(windowOf(rows, 1, null)).toEqual({ from: T0 + 60_000, to: T0 + 120_000 });
    expect(windowOf(rows, [T0 + 1, T0 + 2], null)).toEqual({ from: T0 + 1, to: T0 + 2 });
  });

  it('buckets requests by time across the window', () => {
    const rows = [
      serverReq(T0, '/a', 200, 5),
      serverReq(T0 + 1_000, '/a', 500, 5),
      serverReq(T0 + 4 * 60_000 + 59_000, '/a', 200, 5),
    ];
    const m = run(rows, { range: 5 }, T0 + 5 * 60_000);
    expect(m.bucketMs).toBe(5_000);
    expect(m.buckets).toHaveLength(61);
    expect(m.buckets[0].t).toBe(T0);
    expect(m.buckets[0].counts).toEqual([0, 1, 0, 0, 1]);
    expect(m.buckets[59].total).toBe(1);
    expect(m.buckets.reduce((n, b) => n + b.total, 0)).toBe(3);
  });
});

describe('range filtering', () => {
  it('counts only what falls in the window', () => {
    const rows = [
      serverReq(T0, '/old', 200, 5),
      serverReq(T0 + 10 * 60_000, '/new', 200, 5),
      serverReq(T0 + 14 * 60_000, '/new', 404, 5),
      logRow(T0 + 1_000, 'tomcat', 'log', 'error', 'boom'),
      logRow(T0 + 14 * 60_000, 'tomcat', 'log', 'error', 'boom'),
    ];
    const m = run(rows, { range: 5 }, T0 + 15 * 60_000);
    expect(m.requests).toBe(2);
    expect(m.endpoints.map((e) => e.template)).toEqual(['/new']);
    expect(m.logErrors).toBe(1);
    expect(m.perMin).toBeCloseTo(2 / 5);
    const all = run(rows, {}, T0 + 15 * 60_000);
    expect(all.requests).toBe(3);
    const picked = run(rows, { range: [T0 + 9 * 60_000, T0 + 11 * 60_000] }, T0 + 15 * 60_000);
    expect(picked.requests).toBe(1);
  });
});

describe('status classes and latency', () => {
  it('splits requests by outcome and works out the error rate over answered requests', () => {
    const rows = [
      clientReq(T0, 'http://x/api/a', 200, 100),
      clientReq(T0 + 1, 'http://x/api/a', 302, 50),
      clientReq(T0 + 2, 'http://x/api/a', 404, 10),
      clientReq(T0 + 3, 'http://x/api/a', 500, 1500),
      clientReq(T0 + 4, 'http://x/api/a', null, 30, { failed: true }),
      clientReq(T0 + 5, 'http://x/api/a', null, 30, { failed: true, canceled: true }),
      clientReq(T0 + 6, 'http://x/api/a', null, null),
    ];
    const m = run(rows);
    expect(m.side).toBe('client');
    expect(m.requests).toBe(7);
    expect(m.unanswered).toBe(2);
    expect(m.answered).toBe(5);
    expect(m.byClass).toEqual({ failed: 1, s5: 1, s4: 1, s3: 1, s2: 1 });
    expect(m.errorRate).toBeCloseTo(3 / 5);
    expect(m.slow).toBe(1);
    expect(m.p50).toBe(50);
    expect(m.max).toBe(1500);
    expect(m.statuses.map((s) => s.code).sort()).toEqual(['200', '302', '404', '500', 'failed']);
  });
});

describe('endpoints', () => {
  it('groups by method and route, folding IDs into {id}', () => {
    const rows = [
      serverReq(T0, '/api/orders/41', 200, 10, { bytes: 200 }),
      serverReq(T0 + 1, '/api/orders/42', 500, 30, { bytes: 100 }),
      serverReq(T0 + 2, '/api/orders/43?x=1', 200, 20),
      serverReq(T0 + 3, '/api/orders', 201, 5, { method: 'POST' }),
      serverReq(T0 + 4, '/api/orders', 200, 5),
    ];
    const m = run(rows);
    expect(m.side).toBe('server');
    const byId = m.endpoints[0];
    expect(byId).toMatchObject({ method: 'GET', label: 'api/orders', template: '/api/orders/{id}', count: 3, s5: 1, errors: 1, p50: 20, max: 30 });
    expect(byId.errorRate).toBeCloseTo(1 / 3);
    expect(byId.share).toBeCloseTo(3 / 5);
    expect(byId.avgBytes).toBeCloseTo(400 / 3);
    expect(byId.lastKey).toBe(rows[2].key);
    expect(m.endpoints.map((e) => e.key).sort()).toEqual(['GET /api/orders', 'GET /api/orders/{id}', 'POST /api/orders']);
  });

  it('uses OpenAPI templates when the route function knows them', () => {
    const spec = new RouteMatcher([{ path: '/api/users/{username}', method: 'GET', title: 'Get a user · Shop' }]);
    const rows = sorted([serverReq(T0, '/api/users/john', 200, 5), serverReq(T0 + 1, '/api/users/jane', 200, 7)]);
    const m = computeMetrics(rows, OPTS, (r) => routeWith(r, spec), null);
    expect(m.endpoints).toHaveLength(1);
    expect(m.endpoints[0]).toMatchObject({ template: '/api/users/{username}', title: 'Get a user · Shop', count: 2 });
    // Without the spec, the names look like words and stay apart.
    rows.forEach((r) => (r.route = undefined));
    expect(run(rows).endpoints).toHaveLength(2);
  });

  it('draws a per-bucket sparkline of each endpoint', () => {
    const rows = [serverReq(T0, '/a', 200, 1), serverReq(T0 + 30_000, '/a', 200, 1), serverReq(T0 + 30_500, '/a', 200, 1)];
    const m = run(rows, { range: 1 }, T0 + 60_000);
    const spark = m.endpoints[0].spark;
    expect(spark.reduce((a, b) => a + b, 0)).toBe(3);
    expect(Math.max(...spark)).toBe(2);
  });
});

describe('which side counts', () => {
  const both = () => [
    clientReq(T0, 'http://localhost:5173/api/orders', 200, 120, { rid: 'r1' }),
    serverReq(T0 + 10, '/api/orders', 200, 80, { rid: 'r1' }),
    clientReq(T0 + 1000, 'http://localhost:5173/api/orders/42', 500, 60, { rid: 'r2' }),
    serverReq(T0 + 1010, '/api/orders/42', 500, 40, { rid: 'r2' }),
    // Only the server saw this one (curl, another client).
    serverReq(T0 + 2000, '/api/health', 200, 1),
  ];

  it('counts the access log by default when it has requests, and never both sides', () => {
    const m = run(both());
    expect(m.hasServer && m.hasClient).toBe(true);
    expect(m.side).toBe('server');
    expect(m.requests).toBe(3);
  });

  it('counts the browser and API screen when asked', () => {
    const m = run(both(), { side: 'client' });
    expect(m.requests).toBe(2);
    expect(m.endpoints.every((e) => e.template.startsWith('/api/orders'))).toBe(true);
  });

  it('falls back to the browser without an access log', () => {
    const m = run([clientReq(T0, 'http://x/a', 200, 1), clientReq(T0 + 1, 'http://x/b', 200, 1, { source: 'client' })]);
    expect(m.side).toBe('client');
    expect(m.requests).toBe(2);
  });

  it('splits the browser time into the server part and the rest, by request ID', () => {
    const m = run(both());
    expect(m.split).toMatchObject({ n: 2, overheadP50: 20, overheadP95: 40 });
    expect(m.split!.serverShare).toBeCloseTo(120 / 180);
  });
});

describe('static assets and webapps', () => {
  it('leaves assets out unless asked, but keeps failed ones', () => {
    const rows = [
      clientReq(T0, 'http://x/app.js', 200, 5, { type: 'Script' }),
      clientReq(T0 + 1, 'http://x/logo.png', 404, 5, { type: 'Image' }),
      clientReq(T0 + 2, 'http://x/api/a', 200, 5),
    ];
    expect(run(rows).requests).toBe(2);
    const m = run(rows, { includeStatic: true });
    expect(m.requests).toBe(3);
    expect(m.endpoints.find((e) => e.template === '/app.js')?.isStatic).toBe(true);
  });

  it('filters Tomcat events by webapp and breaks requests down by webapp', () => {
    const rows = [
      serverReq(T0, '/shop/a', 200, 5, { webapp: 'shop' }),
      serverReq(T0 + 1, '/shop/a', 500, 50, { webapp: 'shop' }),
      serverReq(T0 + 2, '/admin/a', 200, 5, { webapp: 'admin' }),
      logRow(T0 + 3, 'tomcat', 'log', 'error', 'x', { webapp: 'admin' }),
    ];
    const all = run(rows);
    expect(all.webapps).toEqual(['admin', 'shop']);
    expect(all.webappStats).toEqual([
      { name: 'shop', count: 2, errors: 1, p95: 50 },
      { name: 'admin', count: 1, errors: 0, p95: 5 },
    ]);
    const shop = run(rows, { webapp: 'shop' });
    expect(shop.requests).toBe(2);
    expect(shop.logErrors).toBe(0);
  });
});

describe('errors', () => {
  it('groups exceptions by class and root cause, loggers, Postgres and console errors', () => {
    const exc = (t: number, id: number) => logRow(t, 'tomcat', 'log', 'error', `Servlet.service() threw — order ${id}`, {
      logger: 'org.apache.catalina.core.StandardWrapperValve',
      exception: `java.lang.IllegalStateException: Order ${id} could not be loaded`,
      rootCause: 'org.postgresql.util.PSQLException: ERROR: relation "order_items" does not exist',
    });
    const rows = [
      exc(T0, 42),
      exc(T0 + 10, 43),
      logRow(T0 + 20, 'tomcat', 'log', 'warn', 'Report slow', { logger: 'com.example.ReportService' }),
      logRow(T0 + 30, 'tomcat', 'log', 'info', 'Fine', { logger: 'com.example.ReportService' }),
      logRow(T0 + 40, 'postgres', 'query', 'error', 'ERROR: relation "order_items" does not exist at character 15', { statement: 'SELECT 1' }),
      logRow(T0 + 50, 'postgres', 'log', 'error', 'ERROR: relation "order_items" does not exist at character 22'),
      logRow(T0 + 60, 'browser', 'console', 'error', 'Could not load order 42: Request failed', { type: 'error' }),
      logRow(T0 + 70, 'browser', 'console', 'error', 'Could not load order 43: Request failed', { type: 'error' }),
      logRow(T0 + 80, 'browser', 'console', 'error', "Uncaught TypeError: Cannot read properties of null (reading 'render')", { type: 'exception' }),
      logRow(T0 + 90, 'browser', 'console', 'warn', 'Just a warning', { type: 'warning' }),
    ];
    const m = run(rows);
    expect(m.logErrors).toBe(2);
    expect(m.logWarns).toBe(1);
    expect(m.exceptions).toHaveLength(1);
    expect(m.exceptions[0]).toMatchObject({ count: 2, text: 'java.lang.IllegalStateException: Order 43 could not be loaded', lastKey: rows[1].key });
    expect(m.exceptions[0].detail).toContain('PSQLException');
    expect(m.exceptionCount).toBe(2);
    expect(m.loggers.map((l) => [l.key, l.errors, l.warns])).toEqual([
      ['org.apache.catalina.core.StandardWrapperValve', 2, 0],
      ['com.example.ReportService', 0, 1],
    ]);
    expect(m.pgErrors).toHaveLength(1);
    expect(m.pgErrors[0].count).toBe(2);
    expect(m.consoleErrors.map((g) => g.count)).toEqual([2, 1]);
    expect(m.consoleErrorCount).toBe(3);
    expect(m.browserExceptions).toBe(1);
  });

  it('keeps one exception class thrown with different messages apart', () => {
    const exc = (t: number, msg: string) => logRow(t, 'tomcat', 'log', 'error', msg, { exception: `java.lang.IllegalStateException: ${msg}` });
    const m = run([exc(T0, 'Order 42 could not be loaded'), exc(T0 + 1, 'Legacy customer lookup failed'), exc(T0 + 2, 'Order 7 could not be loaded')]);
    expect(m.exceptions.map((g) => [g.text, g.count])).toEqual([
      ['java.lang.IllegalStateException: Order 7 could not be loaded', 2],
      ['java.lang.IllegalStateException: Legacy customer lookup failed', 1],
    ]);
    expect(m.exceptions[0].detail).toBeNull();
  });
});

describe('queries', () => {
  it('normalises SQL so the same statement with other values groups together', () => {
    expect(normalizeSql("/* rid=abc-1 */ SELECT *  FROM orders\n WHERE id = 42 AND name = 'O''Brien'")).toBe('SELECT * FROM orders WHERE id = ? AND name = ?');
    expect(normalizeSql('select * from t where id in (1, 2, 3) and x = $1 -- note')).toBe('select * from t where id in (?) and x = ?');
    expect(normalizeSql('insert into t (a, b) values (1, 2), (3, 4)')).toBe('insert into t (a, b) values (?)');
    expect(normalizeSql('select t1.c2, 3.5 from t1')).toBe('select t1.c2, ? from t1');
  });

  it('adds up count, total, average and max per statement, slowest total first', () => {
    const q = (t: number, ms: number, sql: string) => logRow(t, 'postgres', 'query', 'warn', `${ms} ms · ${sql}`, { durationMs: ms, statement: sql });
    const rows = [
      q(T0, 100, '/* rid=1 */ SELECT * FROM a WHERE id = 1'),
      q(T0 + 1, 300, '/* rid=2 */ SELECT * FROM a WHERE id = 2'),
      q(T0 + 2, 1000, 'SELECT sum(x) FROM b'),
      logRow(T0 + 3, 'postgres', 'query', 'error', 'ERROR: x', { statement: 'SELECT 1', durationMs: null }),
    ];
    const m = run(rows);
    expect(m.slowQueries).toBe(3);
    expect(m.queries).toEqual([
      { statement: 'SELECT sum(x) FROM b', count: 1, totalMs: 1000, avgMs: 1000, maxMs: 1000, last: T0 + 2, lastKey: rows[2].key },
      { statement: 'SELECT * FROM a WHERE id = ?', count: 2, totalMs: 400, avgMs: 200, maxMs: 300, last: T0 + 1, lastKey: rows[1].key },
    ]);
  });
});

describe('messageKey', () => {
  it('folds numbers and IDs', () => {
    expect(messageKey('Order 42 failed\nat x')).toBe('Order ? failed');
    expect(messageKey('id 550e8400-e29b-41d4-a716-446655440000 gone')).toBe('id ? gone');
  });
});

describe('performance', () => {
  it('aggregates 50,000 events quickly', () => {
    const rows: Row[] = [];
    const paths = ['/api/orders', '/api/orders/{n}', '/api/users/{n}/cart', '/api/reports/revenue', '/static/app.js'];
    for (let i = 0; i < 50_000; i++) {
      const t = T0 + i * 20;
      const p = paths[i % paths.length].replace('{n}', String(i % 997));
      const k = i % 10;
      if (k < 4) rows.push(serverReq(t, p, i % 37 === 0 ? 500 : 200, (i * 7) % 900, { rid: `r${i}` }));
      else if (k < 8) rows.push(clientReq(t, `http://localhost:5173${p}`, 200, (i * 11) % 1200, { rid: `r${i - 1}`, type: p.endsWith('.js') ? 'Script' : 'Fetch' }));
      else if (k === 8) rows.push(logRow(t, 'tomcat', 'log', i % 3 ? 'info' : 'error', `Something ${i}`, { logger: `com.example.L${i % 20}` }));
      else rows.push(logRow(t, 'postgres', 'query', 'warn', 'q', { durationMs: i % 500, statement: `SELECT * FROM t${i % 30} WHERE id = ${i}` }));
    }
    const started = performance.now();
    const m = computeMetrics(rows, OPTS, route, null);
    const first = performance.now() - started;
    const again = performance.now();
    computeMetrics(rows, { ...OPTS, side: 'client', range: 5 }, route, null);
    const second = performance.now() - again;
    expect(m.requests).toBe(20_000);
    // Every tenth event is a query, on three tables (t9, t19, t29) with different ids.
    expect(m.queries.length).toBe(3);
    expect(first).toBeLessThan(1500);
    expect(second).toBeLessThan(500);
  });
});
