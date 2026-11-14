// End-to-end acceptance run for Phases 1, 2, 4 (hub side) and 5 against a real Chrome.
// Needs a Chrome/Chromium binary: set CHROME_PATH, or it tries a few common locations.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe']
  .find((p) => p && existsSync(p));
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(2);
}

const HUB = 4100, DEMO = 4110, CDP = 9333;
const work = mkdtempSync(join(tmpdir(), 'debug-hub-acceptance-'));
const logs = join(work, 'logs');
writeFileSync(join(work, 'config.json'), JSON.stringify({
  sessionsDir: 'sessions',
  tomcat: { enabled: true, appLogs: ['logs/catalina*'], accessLogs: ['logs/localhost_access_log*.txt'] },
  postgres: { enabled: true, logs: ['logs/postgresql*.log'] },
}));

const children = [];
const run = (cmd, args, env = {}) => {
  const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(c);
  return c;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}
const startChrome = () => run(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${join(work, 'profile')}`, 'about:blank']);
const openTab = (url) => fetch(`http://127.0.0.1:${CDP}/json/new?${url}`, { method: 'PUT' });
const status = async () => (await fetch(`http://127.0.0.1:${HUB}/api/status`)).json();
const chromeUp = async () => (await status()).collectors.find((c) => c.name === 'Chrome').state === 'connected';

const results = [];
const check = (name, ok, note = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
};

try {
  run('node', [join(root, 'examples/demo-app.mjs')], { DEMO_PORT: String(DEMO), DEMO_LOG_DIR: logs });
  let chrome = startChrome();
  run('node', [join(root, 'dist/cli.js'), '--config', join(work, 'config.json'), '--port', String(HUB), '--cdp-port', String(CDP)]);
  await until('hub', chromeUp);
  await until('log tailers', async () => (await status()).collectors.filter((c) => c.state === 'connected').length === 4);

  const sessionFile = () => {
    const dir = join(work, 'sessions');
    return join(dir, readdirSync(dir).sort().at(-1));
  };
  // Lag = how long after an event happened it was readable in the session file.
  const lag = new Map();
  let stop = false;
  (async () => {
    while (!stop) {
      for (const line of readFileSync(sessionFile(), 'utf8').split('\n')) {
        if (!line.endsWith('}')) continue;
        const ev = JSON.parse(line);
        if (!lag.has(ev.id)) lag.set(ev.id, { ev, lagMs: Date.now() - Date.parse(ev.ts) });
      }
      await sleep(20);
    }
  })();

  await openTab(`http://localhost:${DEMO}/?auto`);
  await until('activity', () => [...lag.values()].some((x) => x.ev.summary.startsWith('Uncaught')), 20000);
  await sleep(800);
  const all = () => [...lag.values()];
  const find = (fn) => all().find((x) => fn(x.ev));

  const consoleErr = find((e) => e.source === 'browser' && e.kind === 'console' && e.level === 'error' && e.summary.includes('Could not load order 42'));
  check('Phase 1: console.error is recorded', !!consoleErr);
  check('Phase 1: console.error in the session file within 1 s', !!consoleErr && consoleErr.lagMs < 1000, `${consoleErr?.lagMs} ms`);
  const failed = find((e) => e.source === 'browser' && e.kind === 'response' && e.data.status === 500 && e.data.path === '/api/orders/42');
  check('Phase 1: failing fetch is recorded with status, timing and headers', !!failed && failed.ev.data.durationMs >= 0 && !!failed.ev.data.headers['content-type']);
  check('Phase 1: failing fetch in the session file within 1 s', !!failed && failed.lagMs < 1000, `${failed?.lagMs} ms`);
  check('Phase 1: JSON response body captured', failed?.ev.data.body?.includes('Order 42 could not be loaded'));
  check('Phase 1: uncaught exception is recorded', !!find((e) => e.summary.startsWith('Uncaught TypeError')));
  const post = find((e) => e.kind === 'request' && e.data.method === 'POST');
  check('Store: Authorization header is redacted', post?.ev.data.headers.authorization === '[redacted]' || post?.ev.data.headers.Authorization === '[redacted]');
  // Chrome leaves Set-Cookie out of Network.responseReceived, so it is normally absent altogether.
  const setCookie = Object.entries(failed?.ev.data.headers ?? {}).find(([k]) => k.toLowerCase() === 'set-cookie');
  check('Store: Set-Cookie header is absent or redacted', !setCookie || setCookie[1] === '[redacted]');
  check('Store: no secret reaches the session file', !readFileSync(sessionFile(), 'utf8').match(/demo-secret-token|demo-session-cookie/));

  const traces = all().filter((x) => x.ev.source === 'tomcat' && x.ev.kind === 'log' && x.ev.data.message.includes('Order 42 could not be loaded'));
  check('Phase 2: Tomcat exception is one event with its full stack trace',
    traces.length === 1 && traces[0].ev.data.stackFrames === 10 && traces[0].ev.data.message.includes('... 6 more'), `${traces.length} event(s), ${traces[0]?.ev.data.stackFrames} frames`);
  const accessLine = find((e) => e.source === 'tomcat' && e.kind === 'request' && e.data.path === '/api/orders/42');
  check('Phase 2: access log parsed with status and duration', accessLine?.ev.data.status === 500 && accessLine?.ev.data.durationMs != null);

  const rid = failed?.ev.requestId;
  check('Phase 4: browser response carries the request ID', !!rid, rid);
  check('Phase 4: Tomcat stack trace shares that ID', !!rid && traces[0]?.ev.requestId === rid);
  check('Phase 4: access log line shares that ID', !!rid && accessLine?.ev.requestId === rid);

  const pgErr = find((e) => e.source === 'postgres' && e.level === 'error');
  check('Phase 5: Postgres error merged with its STATEMENT line and linked by ID', pgErr?.ev.data.statement?.includes('order_items') && pgErr?.ev.requestId === rid);
  const slow = find((e) => e.source === 'postgres' && e.kind === 'query' && e.data.durationMs > 1000);
  const slowReq = find((e) => e.source === 'browser' && e.kind === 'response' && e.data.path === '/api/reports/revenue');
  check('Phase 5: slow query has SQL, plan and the slow endpoint\'s ID',
    !!slow && slow.ev.data.statement.startsWith('/* rid=') && slow.ev.data.plan.includes('Seq Scan on orders') && slow.ev.requestId === slowReq?.ev.requestId);

  // Reconnect: kill Chrome, start it again, and expect capture to resume unaided.
  const before = lag.size;
  chrome.kill('SIGKILL');
  await until('hub noticing Chrome is gone', async () => !(await chromeUp()));
  chrome = startChrome();
  await until('hub re-attaching', chromeUp);
  await openTab(`http://localhost:${DEMO}/?auto`);
  await until('activity after restart', () => all().filter((x) => x.ev.summary.includes('Could not load order 42')).length >= 2, 20000);
  check('Phase 1: reconnects after Chrome restarts', lag.size > before);

  stop = true;
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed, ${lag.size} events recorded`);
} catch (err) {
  console.error(err);
  results.push(false);
} finally {
  for (const c of children) c.kill('SIGKILL');
  await sleep(200);
  rmSync(work, { recursive: true, force: true });
}
process.exit(results.every(Boolean) ? 0 : 1);
