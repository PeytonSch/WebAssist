import { describe, expect, it } from 'vitest';
import { bodyLang, highlight, MAX_CHARS, type Lang, type Token } from '../src/ui/highlight';

/** The texts given the class `cls`, in order. */
const of = (tokens: Token[], cls: string) => tokens.filter((t) => t.cls === cls).map((t) => t.text);
const join = (tokens: Token[]) => tokens.map((t) => t.text).join('');

const TOMCAT = [
  '14-Nov-2026 08:16:00.123 SEVERE [http-nio-8080-exec-3] [rid=abc12345] org.apache.catalina.core.StandardWrapperValve.invoke Servlet.service() for servlet [dispatcher] threw exception',
  '\tjava.lang.IllegalStateException: Order 42 could not be loaded',
  '\t\tat com.example.OrderService.load(OrderService.java:87)',
  '\t\tat java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)',
  '\tCaused by: org.postgresql.util.PSQLException: ERROR: relation "order_items" does not exist',
  '\t\tat org.postgresql.core.v3.QueryExecutorImpl.receiveErrorResponse(QueryExecutorImpl.java:2713)',
  '\t\t... 6 more',
].join('\n');

const PLAN = [
  'HashAggregate  (cost=48211.00..48213.00 rows=200 width=40) (actual time=1236.1..1236.2 rows=5 loops=1)',
  '  Group Key: c.region',
  '  ->  Hash Join  (cost=1250.00..43211.00 rows=1000000 width=14)',
  '        Hash Cond: (o.customer_id = c.id)',
  "        Filter: ((status)::text = 'open'::text)",
  '        ->  Seq Scan on orders o  (cost=0.00..18334.00 rows=1000000 width=10)',
  '        ->  Index Scan using orders_pkey on orders  (cost=0.29..8.31 rows=1 width=10)',
  '              Index Cond: (id = $1)',
  'Planning Time: 0.120 ms',
].join('\n');

// Samples of every kind of text the panel shows, including awkward and broken ones.
const SAMPLES: [Lang, string][] = [
  ['log', TOMCAT],
  ['log', '2026-11-14 08:16:00.123 [main] WARN  c.e.Foo - disk is 91% full, see https://example.com/disk?x=1.'],
  ['log', '2026-11-14T08:16:00.123-08:00  INFO 4242 --- [nio-8080-exec-1] c.e.Foo : started in 3.2 s'],
  ['log', '2026-11-14 08:16:00.123 UTC [77] LOG:  duration: 1532.4 ms  statement: SELECT *\n\t  FROM orders /* rid=abc12345 */'],
  ['log', "2026-11-14 08:16:00.123 PST [77] myapp@shop LOG:  checkpoint starting: time\nit's the customer's 'quoted' text"],
  ['log', 'TypeError: Cannot read properties of null (reading \'render\')\n    at render (http://localhost:4010/app.js:12:5)\n    at http://localhost:4010/:43:44\n    at async Promise.all (index 0)'],
  ['log', 'Request 3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b failed: "unterminated\n\tat \n...'],
  ['json', '{\n  "orders": [\n    { "id": 41, "total": 129.5, "ok": true, "note": null, "esc": "a\\"b" }\n  ]\n}'],
  ['json', '{"truncated": "never clo'],
  ['sql', "/* rid=abc12345 */ SELECT c.\"Region\", sum(o.total) FROM orders o -- trailing\nWHERE o.id = $1 AND name = 'O''Brien' AND x = ? AND body = $$ raw $$ AND n > 1.5e3"],
  ['sql', "SELECT 'unterminated"],
  ['plan', PLAN],
  ['xml', '<?xml version="1.0"?>\n<!-- note -->\n<order id="42" status=\'open\' flag><item sku="A-100">2 &amp; more</item><br/></order>'],
  ['xml', '<div class="x'],
  ['form', 'sku=A-100&qty=2&note=hello%20world&flag'],
  ['text', ''],
  ['text', '\n\n'],
];

describe('highlight', () => {
  it.each(SAMPLES)('reproduces the input exactly (%s)', (lang, text) => {
    expect(join(highlight(text, lang))).toBe(text);
  });

  it('reproduces any input in every language', () => {
    // Mixes every sample with shuffled pieces of the others, so tokenizers meet foreign syntax.
    const all = SAMPLES.map(([, t]) => t).join('\n');
    const langs: Lang[] = ['json', 'sql', 'plan', 'log', 'xml', 'form', 'text'];
    for (let n = 0; n < 40; n++) {
      const start = (n * 137) % all.length;
      const piece = all.slice(start, start + 50 + ((n * 61) % 400));
      for (const lang of langs) expect(join(highlight(piece, lang))).toBe(piece);
    }
  });

  it('merges neighbouring tokens of the same class', () => {
    const tokens = highlight(TOMCAT, 'log');
    for (let i = 1; i < tokens.length; i++) expect(tokens[i].cls).not.toBe(tokens[i - 1].cls);
  });
});

describe('logs and stack traces', () => {
  const t = highlight(TOMCAT, 'log');
  it('marks the header parts', () => {
    expect(of(t, 'time')).toEqual(['14-Nov-2026 08:16:00.123']);
    expect(of(t, 'err')).toEqual(['SEVERE']);
    expect(of(t, 'thread')).toEqual(['[http-nio-8080-exec-3]']);
    expect(of(t, 'id')).toEqual(['abc12345']);
    expect(of(t, 'logger')).toEqual(['org.apache.catalina.core.StandardWrapperValve.invoke']);
  });
  it('marks exceptions, causes and their messages', () => {
    expect(of(t, 'exc')).toEqual(['IllegalStateException', 'PSQLException']);
    expect(of(t, 'cause')).toEqual(['Caused by: ']);
    expect(of(t, 'msg')).toContain(' could not be loaded\n');
    expect(of(t, 'num')).toEqual(['42']);
    expect(of(t, 'str')).toContain('"order_items"');
  });
  it('dims the package of a frame and brings out Class.method and the location', () => {
    expect(of(t, 'fn')).toEqual([
      'OrderService.load', 'DirectMethodHandleAccessor.invoke', 'QueryExecutorImpl.receiveErrorResponse',
    ]);
    expect(of(t, 'loc')).toEqual(['OrderService.java:87', 'DirectMethodHandleAccessor.java:103', 'QueryExecutorImpl.java:2713']);
    expect(of(t, 'dim').join('|')).toContain('java.base/jdk.internal.reflect.');
    expect(of(t, 'dim').join('|')).toContain('... 6 more');
  });
  it('colours the level by severity in Logback and Spring Boot layouts', () => {
    const lb = highlight('2026-11-14 08:16:00.123 [main] WARN  c.e.Foo - disk is 91% full', 'log');
    expect(of(lb, 'warn')).toEqual(['WARN']);
    expect(of(lb, 'logger')).toEqual(['c.e.Foo']);
    expect(of(lb, 'num')).toEqual(['91%']);
    const sb = highlight('2026-11-14T08:16:00.123-08:00  INFO 4242 --- [nio-8080-exec-1] c.e.Foo : started', 'log');
    expect(of(sb, 'time')).toEqual(['2026-11-14T08:16:00.123-08:00']);
    expect(of(sb, 'info')).toEqual(['INFO']);
    const bare = highlight('2026-11-14 08:16:00.123 ERROR [main] boom', 'log');
    expect(of(bare, 'time')).toEqual(['2026-11-14 08:16:00.123']);
    expect(of(bare, 'err')).toEqual(['ERROR']);
  });
  it('reads Postgres log lines, with SQL after "statement:"', () => {
    const pg = highlight('2026-11-14 08:16:00.123 UTC [77] LOG:  duration: 1532.4 ms  statement: SELECT *\n\t  FROM orders /* rid=abc12345 */', 'log');
    expect(of(pg, 'time')).toEqual(['2026-11-14 08:16:00.123 UTC']);
    expect(of(pg, 'info')).toEqual(['LOG:']);
    expect(of(pg, 'kw')).toEqual(['SELECT', 'FROM']);
    expect(of(pg, 'id')).toEqual(['abc12345']);
    const prefixed = highlight('2026-11-14 08:16:00.123 PST [77] myapp@shop ERROR:  boom', 'log');
    expect(of(prefixed, 'err')).toEqual(['ERROR:']);
  });
  it('reads JavaScript stack traces', () => {
    const js = highlight("TypeError: Cannot read properties of null (reading 'render')\n    at render (http://localhost:4010/app.js:12:5)\n    at http://localhost:4010/:43:44", 'log');
    expect(of(js, 'exc')).toEqual(['TypeError']);
    expect(of(js, 'fn')).toEqual(['render']);
    expect(of(js, 'loc')).toEqual(['http://localhost:4010/app.js:12:5', 'http://localhost:4010/:43:44']);
    expect(of(js, 'str')).toEqual(["'render'"]);
  });
  it('picks out IDs, URLs, paths and quoted strings in plain text, but not apostrophes', () => {
    const p = highlight("GET /api/orders/42 for 3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b at https://example.com/x. it's the customer's 'quoted' text, requestId=abc-123456", 'text');
    expect(of(p, 'url')).toEqual(['/api/orders/42', 'https://example.com/x']);
    expect(of(p, 'id')).toEqual(['3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b', 'abc-123456']);
    expect(of(p, 'str')).toEqual(["'quoted'"]);
  });
  it('names the class behind frames, loggers and exceptions, for Go to source', () => {
    const refs = t.filter((x) => x.ref).map((x) => [x.cls, x.text, x.ref]);
    expect(refs).toEqual([
      ['logger', 'org.apache.catalina.core.StandardWrapperValve.invoke', { cls: 'org.apache.catalina.core.StandardWrapperValve.invoke' }],
      ['exc', 'IllegalStateException', { cls: 'java.lang.IllegalStateException' }],
      ['fn', 'OrderService.load', { cls: 'com.example.OrderService', file: 'OrderService.java', line: 87 }],
      ['loc', 'OrderService.java:87', { cls: 'com.example.OrderService', file: 'OrderService.java', line: 87 }],
      // The module prefix is not part of the class name.
      ['fn', 'DirectMethodHandleAccessor.invoke', { cls: 'jdk.internal.reflect.DirectMethodHandleAccessor', file: 'DirectMethodHandleAccessor.java', line: 103 }],
      ['loc', 'DirectMethodHandleAccessor.java:103', { cls: 'jdk.internal.reflect.DirectMethodHandleAccessor', file: 'DirectMethodHandleAccessor.java', line: 103 }],
      ['exc', 'PSQLException', { cls: 'org.postgresql.util.PSQLException' }],
      ['fn', 'QueryExecutorImpl.receiveErrorResponse', { cls: 'org.postgresql.core.v3.QueryExecutorImpl', file: 'QueryExecutorImpl.java', line: 2713 }],
      ['loc', 'QueryExecutorImpl.java:2713', { cls: 'org.postgresql.core.v3.QueryExecutorImpl', file: 'QueryExecutorImpl.java', line: 2713 }],
    ]);
    // Classes named in the message itself, not only as the logger.
    const mention = highlight('2026-11-17 10:00:00.123 INFO [main] Registered com.example.orders.OrderService and calls com.example.orders.OrderController.getOrder:42; not e.g. example.com or System.out', 'log');
    expect(mention.filter((x) => x.cls === 'cls').map((x) => [x.text, x.ref])).toEqual([
      ['com.example.orders.OrderService', { cls: 'com.example.orders.OrderService' }],
      ['com.example.orders.OrderController.getOrder:42', { cls: 'com.example.orders.OrderController', line: 42 }],
    ]);
    const inner = highlight('\tat com.x.Foo$Bar.lambda$run$0(Foo.kt:12)\n\tat com.x.Gen.call(Unknown Source)', 'log');
    expect(inner.filter((x) => x.ref).map((x) => x.ref)).toEqual([
      { cls: 'com.x.Foo$Bar', file: 'Foo.kt', line: 12 },
      { cls: 'com.x.Foo$Bar', file: 'Foo.kt', line: 12 },
      { cls: 'com.x.Gen' },
      { cls: 'com.x.Gen' },
    ]);
    // JavaScript frames name no class.
    expect(highlight('TypeError: x\n    at render (http://localhost:4010/app.js:12:5)', 'log').some((x) => x.ref)).toBe(false);
  });

  it('does not treat stack frames after a statement as SQL', () => {
    const t2 = highlight('2026-11-14 08:16:00.123 ERROR [main] c.e.Repo - bad statement: select 1\n\tat com.e.Repo.run(Repo.java:3)', 'log');
    expect(of(t2, 'fn')).toEqual(['Repo.run']);
  });
});

describe('SQL', () => {
  const t = highlight("/* rid=abc12345 */ SELECT c.\"Region\", sum(o.total) FROM orders o -- note\nWHERE o.id = $1 AND name = 'O''Brien' AND n > 1.5e3", 'sql');
  it('marks keywords, strings, numbers, parameters, identifiers and comments', () => {
    expect(of(t, 'kw')).toEqual(['SELECT', 'FROM', 'WHERE', 'AND', 'AND']);
    expect(of(t, 'str')).toEqual(["'O''Brien'"]);
    expect(of(t, 'num')).toEqual(['1.5e3']);
    expect(of(t, 'param')).toEqual(['$1']);
    expect(of(t, 'ident')).toEqual(['"Region"']);
    expect(of(t, 'com')).toEqual(['/* rid=', ' */', '-- note']);
    expect(of(t, 'id')).toEqual(['abc12345']);
  });
  it('does not mistake digits inside names for numbers', () => {
    expect(of(highlight('SELECT t1.col2 FROM t1', 'sql'), 'num')).toEqual([]);
  });
});

describe('Postgres plans', () => {
  const t = highlight(PLAN, 'plan');
  it('marks node types, labels and numbers', () => {
    expect(of(t, 'node')).toEqual(['HashAggregate', 'Hash Join', 'Seq Scan', 'Index Scan']);
    expect(of(t, 'label')).toEqual(['Group Key:', 'Hash Cond:', 'Filter:', 'Index Cond:', 'Planning Time:']);
    expect(of(t, 'num').slice(0, 4)).toEqual(['48211.00', '48213.00', '200', '40']);
    expect(of(t, 'str')).toEqual(["'open'"]);
    expect(of(t, 'param')).toEqual(['$1']);
  });
});

describe('bodies', () => {
  it('marks JSON keys apart from string values', () => {
    const t = highlight('{ "id": 41, "name": "x", "ok": true, "n": null, "list": [-1.5e2] }', 'json');
    expect(of(t, 'key')).toEqual(['"id"', '"name"', '"ok"', '"n"', '"list"']);
    expect(of(t, 'str')).toEqual(['"x"']);
    expect(of(t, 'num')).toEqual(['41', '-1.5e2']);
    expect(of(t, 'kw')).toEqual(['true', 'null']);
  });
  it('marks XML tags, attributes and values', () => {
    const t = highlight('<order id="42" status=\'open\'><item>2 &amp; more</item></order>', 'xml');
    expect(of(t, 'tag')).toEqual(['order', 'item', 'item', 'order']);
    expect(of(t, 'attr')).toEqual(['id', 'status']);
    expect(of(t, 'str')).toEqual(['"42"', "'open'"]);
  });
  it('marks form fields', () => {
    const t = highlight('sku=A-100&qty=2', 'form');
    expect(of(t, 'key')).toEqual(['sku', 'qty']);
    expect(of(t, 'str')).toEqual(['A-100', '2']);
  });
  it('picks a language from the MIME type or the content', () => {
    expect(bodyLang('{}', 'application/json; charset=utf-8')).toBe('json');
    expect(bodyLang('x', 'application/problem+json')).toBe('json');
    expect(bodyLang('<a/>', 'text/html')).toBe('xml');
    expect(bodyLang('a=1', 'application/x-www-form-urlencoded')).toBe('form');
    expect(bodyLang(' [1, 2')).toBe('json');
    expect(bodyLang('<?xml version="1.0"?><a/>')).toBe('xml');
    expect(bodyLang('sku=A-100&qty=2')).toBe('form');
    expect(bodyLang('hello world')).toBe('text');
  });
});

describe('limits', () => {
  it('highlights only the first part of a huge body, and stays fast', () => {
    const row = '{ "id": 1, "name": "x" },\n';
    const text = `[\n${row.repeat(Math.ceil((MAX_CHARS * 2) / row.length))}]`;
    const started = performance.now();
    const t = highlight(text, 'json');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(join(t)).toBe(text);
    const tail = t[t.length - 1];
    expect(tail.cls).toBeUndefined();
    expect(tail.text.length).toBeGreaterThan(MAX_CHARS / 2);
  });
  it('stays linear on input built to make regexes backtrack', () => {
    const nasty = [
      'a.'.repeat(50_000),
      "'".repeat(50_000),
      '"'.repeat(50_000),
      'x '.repeat(50_000) + '=',
      '/a'.repeat(50_000),
      '\tat ' + 'a.'.repeat(20_000) + '(',
      'Seq Scan' + ' on'.repeat(20_000),
    ];
    for (const text of nasty) {
      for (const lang of ['log', 'sql', 'plan', 'json', 'xml'] as Lang[]) {
        const started = performance.now();
        expect(join(highlight(text, lang))).toBe(text);
        expect(performance.now() - started).toBeLessThan(1500);
      }
    }
  });
});
