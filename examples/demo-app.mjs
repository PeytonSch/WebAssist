// A stand-in for the real stack, so the hub can be tried (and tested) without Tomcat or Postgres.
// It serves a page and a small API, and writes Tomcat-format and Postgres-format log files the
// way the real servers would. Run it, then start the hub with examples/demo.config.json.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DEMO_PORT ?? 4010);
const LOG_DIR = process.env.DEMO_LOG_DIR ?? fileURLToPath(new URL('./.demo-logs/', import.meta.url));
mkdirSync(LOG_DIR, { recursive: true });
const CATALINA = join(LOG_DIR, 'catalina.out');
const ACCESS = join(LOG_DIR, 'localhost_access_log.txt');
const POSTGRES = join(LOG_DIR, 'postgresql.log');
for (const f of [CATALINA, ACCESS, POSTGRES]) writeFileSync(f, '', { flag: 'a' });

const pad = (n, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const time = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
const julTs = (d = new Date()) => `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${time(d)}`;
const pgTs = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time(d)}`;
function isoTs(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${pgTs(d).replace(' ', 'T')}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const tomcat = (level, rid, msg) =>
  appendFileSync(CATALINA, `${julTs()} ${level} [http-nio-8080-exec-${1 + Math.floor(Math.random() * 8)}] ${rid ? `[rid=${rid}] ` : ''}${msg}\n`);

function access(req, status, bytes, startedAt, rid) {
  const ms = Date.now() - startedAt.getTime();
  appendFileSync(ACCESS, `127.0.0.1 - - [${isoTs(startedAt)}] "${req.method} ${req.url} HTTP/1.1" ${status} ${bytes} ${ms} "${rid ?? '-'}"\n`);
}

const STACK = (msg) => `	java.lang.IllegalStateException: ${msg}
		at com.example.orders.OrderService.loadOrder(OrderService.java:87)
		at com.example.orders.OrderController.getOrder(OrderController.java:42)
		at java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke(DirectMethodHandleAccessor.java:103)
		at org.apache.catalina.core.ApplicationFilterChain.doFilter(ApplicationFilterChain.java:166)
		at org.apache.catalina.core.StandardWrapperValve.invoke(StandardWrapperValve.java:167)
		at org.apache.coyote.http11.Http11Processor.service(Http11Processor.java:391)
		at java.base/java.lang.Thread.run(Thread.java:1583)
	Caused by: org.postgresql.util.PSQLException: ERROR: relation "order_items" does not exist
		at org.postgresql.core.v3.QueryExecutorImpl.receiveErrorResponse(QueryExecutorImpl.java:2713)
		at org.postgresql.jdbc.PgPreparedStatement.executeQuery(PgPreparedStatement.java:137)
		at com.example.orders.OrderRepository.findItems(OrderRepository.java:58)
		... 6 more`;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Demo app</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 0 20px; color: #101828; }
  button { font: inherit; padding: 8px 14px; margin: 0 8px 8px 0; border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; cursor: pointer; }
  pre { background: #f6f7f9; padding: 12px; border-radius: 8px; min-height: 80px; white-space: pre-wrap; }
</style>
<h1>Demo app</h1>
<p>Each button produces activity for Debug Hub to record.</p>
<button data-run="ok">Load orders (200)</button>
<button data-run="boom">Load order 42 (500)</button>
<button data-run="slow">Slow report (slow query)</button>
<button data-run="noid">Failure without request ID</button>
<button data-run="save">Save order (POST)</button>
<button data-run="missing">Missing endpoint (404)</button>
<button data-run="throw">Uncaught exception</button>
<button data-run="all">Run all</button>
<pre id="out"></pre>
<script>
  const out = document.getElementById('out');
  const say = (s) => { out.textContent += s + '\\n'; };
  async function call(path, init) {
    const res = await fetch(path, init);
    say(path + ' -> ' + res.status);
    if (!res.ok) throw new Error('Request failed: ' + path + ' returned ' + res.status);
    return res.json();
  }
  const actions = {
    ok: () => call('/api/orders').then((d) => console.log('Loaded orders', d)),
    boom: () => call('/api/orders/42').catch((e) => console.error('Could not load order 42:', e.message)),
    slow: () => call('/api/reports/revenue').then((d) => console.info('Report ready', d)),
    noid: () => call('/api/legacy/customers?norid=1').catch((e) => console.error(e.message)),
    save: () => call('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer demo-secret-token' }, body: JSON.stringify({ sku: 'A-100', qty: 2 }) }).then(() => console.log('Order saved')),
    missing: () => call('/api/nope').catch((e) => console.warn(e.message)),
    throw: () => setTimeout(() => { null.render(); }, 0),
  };
  actions.all = async () => { for (const k of ['ok', 'save', 'boom', 'slow', 'noid', 'missing', 'throw']) await actions[k](); };
  document.querySelectorAll('button').forEach((b) => b.onclick = () => actions[b.dataset.run]());
  if (new URLSearchParams(location.search).has('auto')) actions.all();
</script>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const startedAt = new Date();
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Stands in for the Vite proxy hook: generate an ID, pass it on, and echo it to the browser.
  const rid = url.searchParams.has('norid') ? null : (req.headers['x-request-id'] ?? randomUUID().slice(0, 13));

  const send = (status, body, type = 'application/json') => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': type,
      ...(rid && { 'x-request-id': rid }),
      ...(url.pathname.startsWith('/api/') && { 'set-cookie': 'JSESSIONID=demo-session-cookie; Path=/; HttpOnly' }),
    });
    res.end(payload);
    if (url.pathname.startsWith('/api/')) access(req, status, Buffer.byteLength(payload), startedAt, rid);
  };

  if (url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
  if (url.pathname === '/favicon.ico') return send(204, '', 'image/x-icon');

  if (url.pathname === '/api/orders' && req.method === 'GET') {
    tomcat('INFO', rid, 'com.example.orders.OrderController.list Listing orders for customer 7');
    return send(200, { orders: [{ id: 41, total: 129.5 }, { id: 42, total: 18.0 }] });
  }
  if (url.pathname === '/api/orders' && req.method === 'POST') {
    for await (const _ of req); // drain
    tomcat('INFO', rid, 'com.example.orders.OrderController.create Created order 43');
    return send(201, { id: 43 });
  }
  if (url.pathname === '/api/orders/42') {
    appendFileSync(POSTGRES, `${pgTs()} [4821] ERROR:  relation "order_items" does not exist at character 15\n${pgTs()} [4821] STATEMENT:  /* rid=${rid} */ SELECT * FROM order_items WHERE order_id = $1\n`);
    tomcat('SEVERE', rid, `org.apache.catalina.core.StandardWrapperValve.invoke Servlet.service() for servlet [dispatcher] in context with path [] threw exception\n${STACK('Order 42 could not be loaded')}`);
    return send(500, { error: 'Internal Server Error', message: 'Order 42 could not be loaded' });
  }
  if (url.pathname === '/api/reports/revenue') {
    await sleep(1250);
    appendFileSync(POSTGRES, `${pgTs()} [4822] LOG:  duration: 1238.412 ms  plan:
	Query Text: /* rid=${rid} */ SELECT c.region, sum(o.total) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.region
	HashAggregate  (cost=48211.00..48213.00 rows=200 width=40) (actual time=1236.1..1236.2 rows=5 loops=1)
	  Group Key: c.region
	  ->  Hash Join  (cost=1250.00..43211.00 rows=1000000 width=14) (actual time=14.2..982.6 rows=1000000 loops=1)
	        Hash Cond: (o.customer_id = c.id)
	        ->  Seq Scan on orders o  (cost=0.00..18334.00 rows=1000000 width=10) (actual time=0.01..311.9 rows=1000000 loops=1)
	        ->  Hash  (cost=750.00..750.00 rows=40000 width=12) (actual time=14.0..14.0 rows=40000 loops=1)
`);
    tomcat('WARNING', rid, 'com.example.reports.ReportService.revenue Revenue report took 1241 ms');
    return send(200, { regions: 5, total: 918211.4 });
  }
  if (url.pathname === '/api/legacy/customers') {
    tomcat('SEVERE', null, `com.example.legacy.CustomerServlet.doGet Unhandled error\n${STACK('Legacy customer lookup failed')}`);
    return send(500, { error: 'Internal Server Error' });
  }
  send(404, { error: 'Not Found', path: url.pathname });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Demo app   http://localhost:${PORT}   (add ?auto to run every action on load)`);
  console.log(`Logs       ${LOG_DIR}`);
});
