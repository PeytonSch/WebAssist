import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { correlate, pathsMatch, type CorrItem } from '../src/shared/correlate';
import { EntryGrouper } from '../src/server/collectors/logfile';
import { Tailer } from '../src/server/collectors/tail';
import { isoLocal, makeEvent, redactHeaders, truncateText } from '../src/server/normalize';
import { isTomcatEntryStart } from '../src/server/parsers/tomcat';
import { SessionStore } from '../src/server/store';

describe('normalize', () => {
  it('writes local ISO timestamps with millisecond precision that round-trip', () => {
    const ms = Date.UTC(2026, 10, 14, 16, 16, 0, 123);
    const iso = isoLocal(ms);
    expect(iso).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
    expect(Date.parse(iso)).toBe(ms);
  });
  it('redacts credential headers regardless of case and leaves the rest', () => {
    expect(redactHeaders({ Authorization: 'Bearer x', COOKIE: 'a=b', Accept: '*/*' }, ['authorization', 'cookie'])).toEqual({
      Authorization: '[redacted]', COOKIE: '[redacted]', Accept: '*/*',
    });
  });
  it('truncates by bytes without splitting a character, and reports the original size', () => {
    const t = truncateText('é'.repeat(100), 51);
    expect(t.truncated).toBe(true);
    expect(t.bytes).toBe(200);
    expect(t.text).toBe('é'.repeat(25));
    expect(truncateText('short', 64).truncated).toBe(false);
  });
  it('flattens summaries to one line', () => {
    expect(makeEvent({ tsMs: 0, source: 'tomcat', kind: 'log', level: 'info', summary: 'a\n\tb' }).summary).toBe('a b');
  });
});

describe('EntryGrouper', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('groups continuation lines and flushes when the next entry starts or the file goes quiet', () => {
    const out: string[][] = [];
    const g = new EntryGrouper(isTomcatEntryStart, 150, (_f, lines) => out.push(lines));
    g.push('a', '14-Nov-2026 08:16:00.123 SEVERE boom');
    g.push('a', '\tjava.lang.Error: x');
    g.push('a', '\t\tat Foo.bar(Foo.java:1)');
    expect(out).toHaveLength(0);
    g.push('a', '14-Nov-2026 08:16:00.200 INFO next');
    expect(out).toEqual([['14-Nov-2026 08:16:00.123 SEVERE boom', '\tjava.lang.Error: x', '\t\tat Foo.bar(Foo.java:1)']]);
    vi.advanceTimersByTime(151);
    expect(out).toHaveLength(2);
  });
  it('keeps files separate', () => {
    const out: [string, number][] = [];
    const g = new EntryGrouper(isTomcatEntryStart, 150, (f, lines) => out.push([f, lines.length]));
    g.push('a', '14-Nov-2026 08:16:00.123 SEVERE boom');
    g.push('b', '14-Nov-2026 08:16:00.123 INFO other file');
    g.push('a', '\tat Foo.bar(Foo.java:1)');
    g.flushAll();
    expect(out).toEqual([['a', 2], ['b', 1]]);
  });
});

describe('Tailer', () => {
  let dir: string;
  let lines: string[];
  const make = (patterns: string[], fromStart = false) =>
    new Tailer(patterns.map((p) => join(dir, p)), { fromStart, pollMs: 10_000, onLine: (_f, l) => lines.push(l) });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-tail-'));
    lines = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips existing content, then emits only complete new lines', async () => {
    const f = join(dir, 'app.log');
    writeFileSync(f, 'old line\n');
    const t = make(['app.log']);
    await t.tick(true);
    appendFileSync(f, 'one\r\ntw');
    await t.tick();
    expect(lines).toEqual(['one']);
    appendFileSync(f, 'o\n');
    await t.tick();
    expect(lines).toEqual(['one', 'two']);
  });
  it('reads from the start when asked to', async () => {
    writeFileSync(join(dir, 'app.log'), 'old line\n');
    const t = make(['app.log'], true);
    await t.tick(true);
    expect(lines).toEqual(['old line']);
  });
  it('picks up date-rotated files that appear later and reads them from the top', async () => {
    writeFileSync(join(dir, 'localhost.2026-11-14.log'), 'yesterday\n');
    const t = make(['localhost.*.log']);
    await t.tick(true);
    writeFileSync(join(dir, 'localhost.2026-11-15.log'), 'first line of the new day\n');
    writeFileSync(join(dir, 'unrelated.txt'), 'ignore me\n');
    await t.tick(true);
    expect(lines).toEqual(['first line of the new day']);
    expect(t.watched).toHaveLength(2);
  });
  it('follows truncation and rename-and-recreate rotation', async () => {
    const f = join(dir, 'catalina.out');
    writeFileSync(f, 'a long line that was here before\n');
    const t = make(['catalina.out']);
    await t.tick(true);
    writeFileSync(f, 'after truncate\n');
    await t.tick();
    renameSync(f, join(dir, 'catalina.out.1'));
    writeFileSync(f, 'after rotate, and longer than before\n');
    await t.tick(true);
    expect(lines).toEqual(['after truncate', 'after rotate, and longer than before']);
  });
});

describe('SessionStore', () => {
  it('writes JSONL, lists sessions newest first and rejects unsafe IDs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-store-'));
    const store = new SessionStore(dir);
    const first = store.start();
    store.append(makeEvent({ tsMs: 1, source: 'hub', kind: 'marker', level: 'info', summary: 'one' }));
    const second = store.start();
    expect(second).not.toBe(first);
    await store.close();
    const list = store.list();
    expect(list.map((s) => s.id)).toEqual([second, first]);
    expect(list.find((s) => s.id === first)!.bytes).toBeGreaterThan(0);
    expect(store.pathFor('../../etc/passwd')).toBeNull();
    expect(store.pathFor('..')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('correlate', () => {
  const item = (o: Partial<CorrItem> & { id: string }): CorrItem => ({
    t: 0, source: 'browser', group: 'network', level: 'info', requestId: null, ...o,
  });
  const req = item({ id: 'req', t: 10_000, tEnd: 10_080, method: 'GET', path: '/api/orders/42?x=1', level: 'error' });

  it('links by request ID exactly, across sources, ignoring time', () => {
    const all = [
      { ...req, requestId: 'r1' },
      item({ id: 'trace', source: 'tomcat', group: 'log', requestId: 'r1', t: 99_000 }),
      item({ id: 'sql', source: 'postgres', group: 'query', requestId: 'r1', t: 10_050 }),
      item({ id: 'other', source: 'tomcat', group: 'log', requestId: 'r2', t: 10_050 }),
      item({ id: 'noid', source: 'tomcat', group: 'log', t: 10_050 }),
    ];
    const c = correlate(all[0], all);
    expect(c.exact.map((x) => x.id)).toEqual(['trace', 'sql']);
    expect(c.approx).toEqual([]);
  });
  it('falls back to path and time window, never claiming events that carry another ID', () => {
    const all = [
      req,
      item({ id: 'access', source: 'tomcat', group: 'network', method: 'GET', path: '/orders/42', t: 10_000 }),
      item({ id: 'access-post', source: 'tomcat', group: 'network', method: 'POST', path: '/orders/42', t: 10_000 }),
      item({ id: 'access-late', source: 'tomcat', group: 'network', method: 'GET', path: '/orders/42', t: 20_000 }),
      item({ id: 'trace', source: 'tomcat', group: 'log', t: 10_060 }),
      item({ id: 'trace-owned', source: 'tomcat', group: 'log', t: 10_060, requestId: 'r9' }),
      item({ id: 'trace-early', source: 'tomcat', group: 'log', t: 9_000 }),
    ];
    const c = correlate(req, all);
    expect(c.exact).toEqual([]);
    expect(c.approx.map((x) => x.id)).toEqual(['access', 'trace']);
  });
  it('finds the request in flight for a server log line without an ID', () => {
    const trace = item({ id: 'trace', source: 'tomcat', group: 'log', t: 10_060 });
    const other = item({ id: 'other-req', t: 30_000, tEnd: 30_100, path: '/api/x' });
    expect(correlate(trace, [req, other, trace]).approx.map((x) => x.id)).toEqual(['req']);
  });
  it('points a console error at the request that failed just before it', () => {
    const consoleErr = item({ id: 'c', group: 'console', t: 10_100, level: 'error' });
    const ok = item({ id: 'ok', t: 10_000, tEnd: 10_050 });
    expect(correlate(consoleErr, [req, ok, consoleErr]).approx.map((x) => x.id)).toEqual(['req']);
  });
  it('matches paths across a proxy prefix', () => {
    expect(pathsMatch('/api/orders?x=1', '/orders')).toBe(true);
    expect(pathsMatch('/api/orders', '/api/customers')).toBe(false);
    expect(pathsMatch('/api/orders', '/')).toBe(false);
  });
});

describe('config', async () => {
  const { forgiveBackslashes, loadConfig, DEFAULT_CONFIG } = await import('../src/server/config');
  it('accepts Windows paths pasted with single backslashes', () => {
    const pasted = '{ "tomcat": { "appLogs": ["C:\\Users\\me\\tomcat\\logs\\catalina*"] } }';
    expect(JSON.parse(forgiveBackslashes(pasted)).tomcat.appLogs).toEqual(['C:/Users/me/tomcat/logs/catalina*']);
  });
  it('leaves properly escaped backslashes and quotes alone', () => {
    const proper = JSON.stringify({ a: 'C:\\Users\\me', b: 'say "hi"', c: DEFAULT_CONFIG.correlation.logPatterns[0] });
    expect(JSON.parse(forgiveBackslashes(proper))).toEqual(JSON.parse(proper));
  });
  it('loads a config file and resolves relative paths against it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dh-cfg-'));
    writeFileSync(join(dir, 'c.json'), '{ "port": 4321, "tomcat": { "enabled": true, "appLogs": ["logs/catalina*"] } }');
    const { config } = loadConfig(join(dir, 'c.json'));
    expect(config.port).toBe(4321);
    expect(config.chrome.port).toBe(9222);
    expect(config.tomcat.appLogs).toEqual([join(dir, 'logs', 'catalina*')]);
    expect(config.sessionsDir).toBe(join(dir, 'sessions'));
    rmSync(dir, { recursive: true, force: true });
  });
});
