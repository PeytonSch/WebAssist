import { describe, expect, it } from 'vitest';
import { compilePatterns } from '../src/server/normalize';
import { DEFAULT_CONFIG } from '../src/server/config';
import { parseAccessLine } from '../src/server/parsers/access';
import { isPostgresEntryStart, parsePostgresEntry } from '../src/server/parsers/postgres';
import { parseLeadingTimestamp } from '../src/server/parsers/timestamps';
import { isTomcatEntryStart, parseTomcatEntry } from '../src/server/parsers/tomcat';

const ctx = { file: 'x.log', ridPatterns: compilePatterns(DEFAULT_CONFIG.correlation.logPatterns), nowMs: 1_000 };
const local = (y: number, mo: number, d: number, h: number, mi: number, s: number, ms = 0) =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime();

describe('timestamps', () => {
  it('parses the Tomcat JUL format as local time', () => {
    expect(parseLeadingTimestamp('14-Nov-2026 08:16:00.123 SEVERE [main] x')?.ms).toBe(local(2026, 11, 14, 8, 16, 0, 123));
  });
  it('parses ISO with an offset, a comma fraction and a T', () => {
    expect(parseLeadingTimestamp('2026-11-14T08:16:00,123-08:00 ERROR')?.ms).toBe(Date.UTC(2026, 10, 14, 16, 16, 0, 123));
  });
  it('honours UTC and treats unknown zone abbreviations as local', () => {
    expect(parseLeadingTimestamp('2026-11-14 08:16:00.123 UTC [1] LOG:  x')?.ms).toBe(Date.UTC(2026, 10, 14, 8, 16, 0, 123));
    expect(parseLeadingTimestamp('2026-11-14 08:16:00.123 PST [1] LOG:  x')?.ms).toBe(local(2026, 11, 14, 8, 16, 0, 123));
  });
  it('parses Common Log Format in brackets', () => {
    expect(parseLeadingTimestamp('[14/Nov/2026:08:16:00 -0800]')?.ms).toBe(Date.UTC(2026, 10, 14, 16, 16, 0));
  });
  it('does not mistake a number after the time for an offset', () => {
    expect(parseLeadingTimestamp('2026-11-14 08:16:00.123 -12 items left')?.ms).toBe(local(2026, 11, 14, 8, 16, 0, 123));
  });
  it('returns null for stack frames', () => {
    expect(parseLeadingTimestamp('\tat com.example.Foo.bar(Foo.java:1)')).toBeNull();
    expect(parseLeadingTimestamp('Caused by: java.lang.Error')).toBeNull();
  });
});

describe('tomcat application log', () => {
  const entry = [
    '14-Nov-2026 08:16:00.123 SEVERE [http-nio-8080-exec-3] [rid=abc12345] org.apache.catalina.core.StandardWrapperValve.invoke Servlet.service() threw exception',
    '\tjava.lang.IllegalStateException: Order 42 could not be loaded',
    '\t\tat com.example.OrderService.load(OrderService.java:87)',
    '\t\tat com.example.OrderController.get(OrderController.java:42)',
    '\tCaused by: org.postgresql.util.PSQLException: ERROR: relation "order_items" does not exist',
    '\t\tat org.postgresql.core.v3.QueryExecutorImpl.receiveErrorResponse(QueryExecutorImpl.java:2713)',
    '\t\t... 6 more',
  ];
  it('only timestamped lines start an entry', () => {
    expect(entry.map(isTomcatEntryStart)).toEqual([true, false, false, false, false, false, false]);
  });
  it('keeps the whole stack trace in one event', () => {
    const ev = parseTomcatEntry(entry, ctx);
    expect(ev.level).toBe('error');
    expect(ev.requestId).toBe('abc12345');
    expect(ev.data!.stackFrames).toBe(3);
    expect(ev.data!.thread).toBe('http-nio-8080-exec-3');
    expect(ev.data!.exception).toBe('java.lang.IllegalStateException: Order 42 could not be loaded');
    expect(ev.data!.rootCause).toContain('PSQLException');
    expect(ev.data!.message.split('\n')).toHaveLength(7);
    expect(ev.summary).toContain('threw exception');
    expect(ev.summary).toContain('PSQLException');
  });
  it('parses Logback and Spring Boot layouts', () => {
    const lb = parseTomcatEntry(['2026-11-14 08:16:00.123 [main] WARN  c.e.Foo - disk is 91% full'], ctx);
    expect(lb.level).toBe('warn');
    expect(lb.summary).toBe('c.e.Foo - disk is 91% full');
    const sb = parseTomcatEntry(['2026-11-14T08:16:00.123-08:00  INFO 4242 --- [nio-8080-exec-1] c.e.Foo : started'], ctx);
    expect(sb.level).toBe('info');
    expect(sb.summary).toBe('c.e.Foo : started');
  });
  it('treats an untimestamped stack trace (printStackTrace) as an error at arrival time', () => {
    const ev = parseTomcatEntry(['java.lang.NullPointerException: boom', '\tat com.example.Foo.bar(Foo.java:1)'], ctx);
    expect(ev.level).toBe('error');
    expect(ev.tsMs).toBe(1_000);
    expect(ev.summary).toContain('NullPointerException: boom');
  });
});

describe('tomcat access log', () => {
  const actx = { ...ctx, durationUnit: 'ms' as const };
  it('parses the plain common pattern', () => {
    const ev = parseAccessLine('127.0.0.1 - - [14/Nov/2026:08:16:00 -0800] "GET /api/orders?page=2 HTTP/1.1" 200 1234', actx)!;
    expect(ev.kind).toBe('request');
    expect(ev.data).toMatchObject({ method: 'GET', path: '/api/orders?page=2', status: 200, bytes: 1234, durationMs: null });
    expect(ev.requestId).toBeNull();
  });
  it('parses the recommended pattern with duration and request ID', () => {
    const ev = parseAccessLine('127.0.0.1 - bob [2026-11-14T08:16:00.123-08:00] "POST /api/orders HTTP/1.1" 500 - 87 "abc12345"', actx)!;
    expect(ev.level).toBe('error');
    expect(ev.requestId).toBe('abc12345');
    expect(ev.tsMs).toBe(Date.UTC(2026, 10, 14, 16, 16, 0, 123));
    expect(ev.data).toMatchObject({ status: 500, bytes: 0, durationMs: 87, user: 'bob' });
  });
  it('converts Tomcat 10 microseconds and ignores a missing ID', () => {
    const ev = parseAccessLine('::1 - - [14/Nov/2026:08:16:00 -0800] "GET / HTTP/1.1" 404 9 87500 "-"', { ...ctx, durationUnit: 'us' })!;
    expect(ev.data!.durationMs).toBe(87.5);
    expect(ev.level).toBe('warn');
    expect(ev.requestId).toBeNull();
  });
  it('rejects lines that are not access-log lines', () => {
    expect(parseAccessLine('not an access log line', actx)).toBeNull();
  });
});

describe('postgres log', () => {
  it('parses a slow statement', () => {
    const lines = ['2026-11-14 08:16:00.123 UTC [77] LOG:  duration: 1532.4 ms  statement: SELECT *', '\t  FROM orders /* rid=abc12345 */'];
    expect(lines.map(isPostgresEntryStart)).toEqual([true, false]);
    const ev = parsePostgresEntry(lines, ctx);
    expect(ev.kind).toBe('query');
    expect(ev.level).toBe('warn');
    expect(ev.requestId).toBe('abc12345');
    expect(ev.data).toMatchObject({ durationMs: 1532.4, pid: '77' });
    expect(ev.data!.statement).toContain('FROM orders');
    expect(ev.summary).toMatch(/^1532 ms · SELECT \* FROM orders/);
  });
  it('splits an auto_explain entry into SQL and plan', () => {
    const ev = parsePostgresEntry([
      '2026-11-14 08:16:00.123 UTC [77] LOG:  duration: 20.5 ms  plan:',
      '\tQuery Text: SELECT count(*) FROM orders',
      '\tAggregate  (cost=1.00..2.00 rows=1 width=8)',
      '\t  ->  Seq Scan on orders  (cost=0.00..1.00 rows=10 width=0)',
    ], ctx);
    expect(ev.data!.statement).toBe('SELECT count(*) FROM orders');
    expect(ev.data!.plan).toMatch(/^Aggregate/);
    expect(ev.data!.plan).toContain('Seq Scan on orders');
  });
  it('folds DETAIL and STATEMENT lines into the error above them', () => {
    const lines = [
      '2026-11-14 08:16:00.123 UTC [77] ERROR:  duplicate key value violates unique constraint "orders_pkey"',
      '2026-11-14 08:16:00.123 UTC [77] DETAIL:  Key (id)=(42) already exists.',
      '2026-11-14 08:16:00.123 UTC [77] STATEMENT:  INSERT INTO orders VALUES ($1)',
    ];
    expect(lines.map(isPostgresEntryStart)).toEqual([true, false, false]);
    const ev = parsePostgresEntry(lines, ctx);
    expect(ev.level).toBe('error');
    expect(ev.kind).toBe('query');
    expect(ev.data!.detail).toBe('Key (id)=(42) already exists.');
    expect(ev.data!.statement).toBe('INSERT INTO orders VALUES ($1)');
    expect(ev.summary).toMatch(/^ERROR: duplicate key/);
  });
  it('keeps ordinary server messages as logs, with a custom prefix', () => {
    const ev = parsePostgresEntry(['2026-11-14 08:16:00.123 PST [77] myapp@shop LOG:  checkpoint starting: time'], ctx);
    expect(ev.kind).toBe('log');
    expect(ev.level).toBe('info');
    expect(ev.summary).toBe('checkpoint starting: time');
  });
});
