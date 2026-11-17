import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogStore } from '../src/server/apiclient/catalog';
import { DEFAULT_CONFIG } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import type { SendResult } from '../src/shared/apiclient';
import { replayFromEvent, templateUrl, variableFor } from '../src/shared/replay';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-api-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  rawHeaders: string[];
  body: string;
}

/** The app under test: answers per path and remembers what it was sent. */
function targetApp(seen: Seen[]) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, rawHeaders: req.rawHeaders, body });
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/slow') return setTimeout(() => res.end('late'), 2000);
    if (url.pathname === '/moved') {
      res.writeHead(302, { location: '/orders?from=moved' });
      return res.end();
    }
    if (url.pathname === '/gzip') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      return res.end(gzipSync(JSON.stringify({ zipped: true })));
    }
    if (url.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('x'.repeat(5000));
    }
    if (url.pathname === '/png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
    }
    res.writeHead(req.method === 'POST' ? 201 : 200, {
      'content-type': 'application/json',
      'set-cookie': 'SESSION=secret; Path=/',
      'x-request-id': String(req.headers['x-request-id'] ?? ''),
    });
    res.end(JSON.stringify({ ok: true, method: req.method, got: body || null }));
  };
}

describe('POST /api/client/send', () => {
  let hub: Hub;
  let server: Server;
  let target: Server;
  let base: string;
  let app: string;
  let events: HubEvent[];
  let seen: Seen[];

  beforeEach(async () => {
    const port = await freePort();
    seen = [];
    target = createHttpServer(targetApp(seen));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    app = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
    const config = structuredClone(DEFAULT_CONFIG);
    config.port = port;
    config.chrome.enabled = false;
    config.sessionsDir = join(dir, 'sessions');
    config.maxBodyBytes = 1000;
    config.api.headers = [
      { name: 'Authorization', value: 'Bearer default-token' },
      { name: 'X-Team', value: 'core' },
    ];
    config.api.timeoutMs = 500;
    hub = new Hub(config);
    hub.start();
    events = [];
    hub.subscribe({ onEvent: (e) => events.push(e), onStatus: () => undefined });
    server = await startServer(hub, dir, { configFile: join(dir, 'debug-hub.config.json') });
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    server.close();
    target.closeAllConnections();
    target.close();
    await hub.stop();
  });

  const send = async (input: Record<string, unknown>, init: RequestInit = {}) => {
    const res = await fetch(`${base}/api/client/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), ...init });
    return { status: res.status, body: (await res.json()) as SendResult & { error?: string } };
  };

  it('sends with default headers and a fresh request ID, and records request and response events', async () => {
    const { status, body } = await send({
      method: 'get',
      url: `${app}/orders?x=1`,
      headers: [{ name: 'X-Team', value: 'mine' }, { name: 'Accept', value: 'application/json' }],
      label: 'List orders',
    });
    expect(status).toBe(200);
    expect(body.status).toBe(200);
    expect(JSON.parse(body.body)).toMatchObject({ ok: true, method: 'GET' });
    const got = seen[0];
    expect(got.method).toBe('GET');
    expect(got.url).toBe('/orders?x=1');
    expect(got.headers.authorization).toBe('Bearer default-token');
    // The request's own header wins over the default with the same name.
    expect(got.headers['x-team']).toBe('mine');
    expect(got.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(got.headers['user-agent']).toBe('DebugHub-API-Client');
    expect(body.requestId).toBe(got.headers['x-request-id']);
    expect(body.sentHeaders.map(([n]) => n)).toEqual(['Authorization', 'X-Team', 'Accept', 'X-Request-Id', 'User-Agent']);

    const [req, res] = events;
    expect(req).toMatchObject({ id: body.requestEventId, source: 'client', kind: 'request', level: 'info', requestId: body.requestId, summary: '/orders?x=1'.replace(/^/, 'GET ') });
    expect(req.data).toMatchObject({ method: 'GET', url: `${app}/orders?x=1`, path: '/orders?x=1', resourceType: 'API', label: 'List orders' });
    // Recorded headers are redacted as configured; what the screen gets back is not.
    expect(req.data.headers.Authorization).toBe('[redacted]');
    expect(res).toMatchObject({ id: body.responseEventId, source: 'client', kind: 'response', requestId: body.requestId });
    expect(res.data.netId).toBe(req.data.netId);
    expect(res.data).toMatchObject({ status: 200, mimeType: 'application/json', bodyTruncated: false });
    expect(res.data.headers['set-cookie']).toBe('[redacted]');
    expect(body.headers.find(([n]) => n.toLowerCase() === 'set-cookie')?.[1]).toBe('SESSION=secret; Path=/');
    expect(typeof res.data.durationMs).toBe('number');
  });

  it('leaves out defaults turned off, keeps a request ID the request set, and can skip the ID', async () => {
    await send({ method: 'GET', url: `${app}/a`, headers: [{ name: 'x-request-id', value: 'mine-123456' }], disabledDefaults: ['authorization'] });
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(seen[0].headers['x-request-id']).toBe('mine-123456');
    expect(events[0].requestId).toBe('mine-123456');
    hub.cfg.api.addRequestId = false;
    await send({ method: 'GET', url: `${app}/b`, headers: [] });
    expect(seen[1].headers['x-request-id']).toBeUndefined();
  });

  it('sends a body, returns all of it, and records it up to the body limit', async () => {
    const big = JSON.stringify({ text: 'y'.repeat(3000) });
    const { body } = await send({ method: 'POST', url: `${app}/orders`, headers: [{ name: 'Content-Type', value: 'application/json' }], body: big });
    expect(seen[0].body).toBe(big);
    expect(seen[0].headers['content-type']).toBe('application/json');
    expect(body.status).toBe(201);
    expect(JSON.parse(body.body).got).toBe(big);
    expect(events[0].data).toMatchObject({ bodyBytes: big.length, bodyTruncated: true });
    expect(events[0].data.body).toHaveLength(1000);
    expect(events[1].data.bodyTruncated).toBe(true);
    expect(body.truncated).toBe(false);
  });

  it('returns a redirect instead of following it, unless asked to', async () => {
    const first = await send({ method: 'GET', url: `${app}/moved`, headers: [] });
    expect(first.body.status).toBe(302);
    expect(first.body.headers.find(([n]) => n === 'location')?.[1]).toBe('/orders?from=moved');
    expect(seen).toHaveLength(1);
    const followed = await send({ method: 'GET', url: `${app}/moved`, headers: [], followRedirects: true });
    expect(followed.body.status).toBe(200);
    expect(followed.body.url).toBe(`${app}/orders?from=moved`);
    expect(followed.body.redirects).toEqual([{ status: 302, url: `${app}/moved` }]);
    // Each hop is on the timeline, with the same request ID.
    const hops = events.slice(2).filter((e) => e.kind === 'request');
    expect(hops.map((e) => e.data.path)).toEqual(['/moved', '/orders?from=moved']);
    expect(hops[0].requestId).toBe(hops[1].requestId);
  });

  it('times out, and records the failure', async () => {
    const { body } = await send({ method: 'GET', url: `${app}/slow`, headers: [] });
    expect(body.status).toBeNull();
    expect(body.error).toMatch(/No complete response within 500 ms/);
    expect(events[1]).toMatchObject({ kind: 'response', level: 'error', data: { failed: true, canceled: false } });
  });

  it('cancels the outgoing request when the screen aborts', async () => {
    const abort = new AbortController();
    const pending = send({ method: 'GET', url: `${app}/slow`, headers: [] }, { signal: abort.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    abort.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 100));
    expect(events[1]).toMatchObject({ kind: 'response', level: 'info', data: { failed: true, canceled: true } });
  });

  it('explains connection errors and bad input', async () => {
    const closed = await freePort();
    const { body } = await send({ method: 'GET', url: `http://127.0.0.1:${closed}/x`, headers: [] });
    expect(body.error).toMatch(/Connection refused/);
    expect((await send({ method: 'GET', url: 'localhost/x', headers: [] })).status).toBe(400);
    expect((await send({ method: 'GET', url: 'ftp://h/x', headers: [] })).body.error).toMatch(/Only http/);
    expect((await send({ method: 'GET', url: `${app}/`, headers: [{ name: 'Bad Name', value: '1' }] })).status).toBe(400);
    expect((await send({ method: 'G T', url: `${app}/`, headers: [] })).status).toBe(400);
  });

  it('decodes compressed bodies and does not show binary ones', async () => {
    const gz = await send({ method: 'GET', url: `${app}/gzip`, headers: [{ name: 'Accept-Encoding', value: 'gzip' }] });
    expect(JSON.parse(gz.body.body)).toEqual({ zipped: true });
    const png = await send({ method: 'GET', url: `${app}/png`, headers: [] });
    expect(png.body).toMatchObject({ binary: true, body: '', bodyBytes: 8 });
  });

  it('refuses callers other than its own page', async () => {
    const res = await fetch(`${base}/api/client/send`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('lists specs and saves requests through the catalog routes', async () => {
    const info = await (await fetch(`${base}/api/client`)).json();
    expect(info).toMatchObject({ specs: [], addRequestId: true, requestIdHeader: 'X-Request-Id' });
    const created = await (await fetch(`${base}/api/client/catalog/requests`, { method: 'POST', body: JSON.stringify({ name: 'One', method: 'get', url: '{{baseUrl}}/a' }) })).json();
    expect(created.request).toMatchObject({ name: 'One', method: 'GET' });
    const bad = await fetch(`${base}/api/client/catalog/requests`, { method: 'POST', body: JSON.stringify({ name: '', url: '' }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors.map((e: any) => e.path)).toEqual(['name', 'url']);
    const cat = await (await fetch(`${base}/api/client/catalog`)).json();
    expect(cat.file).toBe(join(dir, 'api-requests.json'));
    expect(cat.requests).toHaveLength(1);
    await fetch(`${base}/api/client/catalog/requests/${created.request.id}`, { method: 'DELETE' });
    expect((await (await fetch(`${base}/api/client/catalog`)).json()).requests).toEqual([]);
  });
});

describe.skipIf(!existsSync('/usr/bin/openssl') && process.platform !== 'win32')('untrusted certificates', () => {
  it('fails on a self-signed certificate unless insecure TLS is on', async () => {
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    } catch {
      return; // no openssl here
    }
    const tls = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (_req, res) => res.end('secure'));
    await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(tls.address() as AddressInfo).port}/`;
    const { ApiClient } = await import('../src/server/apiclient/client');
    const cfg = structuredClone(DEFAULT_CONFIG);
    const client = new ApiClient(cfg, () => undefined);
    try {
      const strict = await client.send({ method: 'GET', url, headers: [] });
      expect(strict.error).toMatch(/certificate is not trusted/);
      cfg.api.insecureTls = true;
      const loose = await client.send({ method: 'GET', url, headers: [] });
      expect(loose.body).toBe('secure');
    } finally {
      tls.close();
    }
  });
});

// ── Saved requests ──────────────────────────────────────

describe('CatalogStore', () => {
  const file = () => join(dir, 'api-requests.json');
  const req = (name: string, extra: Record<string, unknown> = {}) => ({ name, method: 'GET', url: '{{baseUrl}}/orders', ...extra });

  it('creates, updates and deletes, writing through a temporary file', async () => {
    const store = new CatalogStore(file());
    expect(store.read()).toEqual({ file: file(), error: null, variables: [], requests: [] });
    const { request: a } = await store.create(req('List', { folder: ' Orders / Smoke ', headers: [{ name: 'X', value: '1' }, { name: '', value: '' }] }));
    expect(a.folder).toBe('Orders/Smoke');
    expect(a.headers).toEqual([{ name: 'X', value: '1', enabled: true }]);
    expect(a.created).toBe(a.updated);
    const { request: b } = await store.create(req('Second'));
    await new Promise((r) => setTimeout(r, 5));
    const { request: a2 } = await store.update(a.id, { ...a, name: 'Renamed', body: '{}' });
    expect(a2).toMatchObject({ id: a.id, name: 'Renamed', created: a.created, body: '{}' });
    expect(a2.updated > a.updated).toBe(true);
    await store.remove(b.id);
    const onDisk = JSON.parse(readFileSync(file(), 'utf8'));
    expect(onDisk.version).toBe(1);
    expect(onDisk.requests.map((r: any) => r.name)).toEqual(['Renamed']);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
    await expect(store.update('nope', req('x'))).rejects.toThrow(/no longer exists/);
    await expect(store.create({ name: ' ', url: '' })).rejects.toMatchObject({ errors: [{ path: 'name' }, { path: 'url' }] });
  });

  it('runs changes one at a time', async () => {
    const store = new CatalogStore(file());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.create(req(`R${i}`))));
    expect(store.read().requests).toHaveLength(10);
  });

  it('keeps edits made to the file by hand, and skips broken entries', async () => {
    writeFileSync(file(), JSON.stringify({ variables: [{ name: 'token', value: 'abc' }, { name: 'bad name', value: 'x' }], requests: [{ id: 'k1', name: 'Hand', url: 'http://h/x' }, { name: 'no id', url: 'x' }, 'junk'], extra: 1 }));
    const store = new CatalogStore(file());
    const cat = store.read();
    expect(cat.error).toBeNull();
    expect(cat.requests.map((r) => r.name)).toEqual(['Hand']);
    expect(cat.variables).toEqual([{ name: 'token', value: 'abc' }]);
  });

  it('moves an unreadable file aside instead of overwriting it', async () => {
    writeFileSync(file(), '{ not json');
    const store = new CatalogStore(file());
    expect(store.read().error).toMatch(/could not be read/);
    const out = await store.create(req('New'));
    expect(out.notice).toMatch(/renamed to .*unreadable/);
    const aside = readdirSync(dir).find((f) => f.includes('.unreadable-'))!;
    expect(readFileSync(join(dir, aside), 'utf8')).toBe('{ not json');
    expect(store.read().requests.map((r) => r.name)).toEqual(['New']);
  });

  it('validates variables: names, duplicates and the built-in baseUrl', async () => {
    const store = new CatalogStore(file());
    await expect(store.setVariables([{ name: 'baseUrl', value: 'x' }, { name: 'a', value: '1' }, { name: 'a', value: '2' }, { name: '1x', value: '' }])).rejects.toMatchObject({
      errors: [{ path: 'variables.0.name' }, { path: 'variables.2.name' }, { path: 'variables.3.name' }],
    });
    const { variables } = await store.setVariables([{ name: 'token', value: ' secret ' }, { name: '', value: '' }]);
    expect(variables).toEqual([{ name: 'token', value: ' secret ' }]);
  });

  it('imports by merging requests by id and variables by name', async () => {
    const store = new CatalogStore(file());
    const { request: keep } = await store.create(req('Keep'));
    const { request: change } = await store.create(req('Change'));
    await store.setVariables([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
    const summary = await store.import({
      version: 1,
      variables: [{ name: 'a', value: '1' }, { name: 'b', value: '20' }, { name: 'c', value: '3' }],
      requests: [
        { ...keep },
        { ...change, url: 'http://elsewhere/x' },
        { id: 'new-1', name: 'Brand new', url: 'http://h/new' },
        { name: 'No id', url: 'http://h/noid' },
        { name: '', url: '' },
      ],
    });
    expect(summary).toMatchObject({
      added: ['Brand new', 'No id'],
      updated: ['Change'],
      unchanged: 1,
      variables: { added: ['c'], updated: ['b'] },
    });
    expect(summary.skipped).toHaveLength(1);
    const cat = store.read();
    expect(cat.requests.map((r) => r.name)).toEqual(['Keep', 'Change', 'Brand new', 'No id']);
    expect(cat.requests.find((r) => r.id === change.id)?.url).toBe('http://elsewhere/x');
    expect(cat.variables).toEqual([{ name: 'a', value: '1' }, { name: 'b', value: '20' }, { name: 'c', value: '3' }]);
    await expect(store.import({ something: 'else' })).rejects.toThrow(/no saved requests/);
    await expect(store.import('nope')).rejects.toThrow(/Not a Debug Hub catalog/);
  });
});

// ── Replaying recorded requests ─────────────────────────

describe('replayFromEvent', () => {
  const opts = { requestIdHeader: 'X-Request-Id', baseUrls: ['http://localhost:8080/shop'], defaultHeaders: [], variables: [] };
  const browserRequest = {
    method: 'POST',
    url: 'http://localhost:8080/shop/api/orders?x=1',
    headers: {
      ':authority': 'localhost:8080',
      Host: 'localhost:8080',
      'Content-Length': '25',
      Connection: 'keep-alive',
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Chromium"',
      'Sec-Fetch-Mode': 'cors',
      'X-Request-Id': 'old-id-123',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: '[redacted]',
      Cookie: '[redacted]',
      'X-Custom': 'keep me',
    },
    body: '{"sku":"A-100","qty":2}',
    bodyBytes: 23,
    bodyTruncated: false,
  };

  it('drops headers that are not resent, turns redacted ones into variables and templates the base URL', () => {
    const r = replayFromEvent(browserRequest, opts);
    expect(r.draft).toEqual({
      method: 'POST',
      url: '{{baseUrl}}/api/orders?x=1',
      params: [],
      headers: [
        { name: 'Accept', value: 'application/json', enabled: true },
        { name: 'Authorization', value: '{{authorization}}', enabled: true },
        { name: 'Cookie', value: '{{cookie}}', enabled: true },
        { name: 'X-Custom', value: 'keep me', enabled: true },
      ],
      body: '{"sku":"A-100","qty":2}',
      contentType: 'application/json',
      disabledDefaults: [],
    });
    expect(r.name).toBe('POST /shop/api/orders');
    expect(r.needs).toEqual([{ variable: 'authorization', header: 'Authorization' }, { variable: 'cookie', header: 'Cookie' }]);
    expect(r.warnings[0]).toMatch(/Authorization, Cookie were redacted.*\{\{authorization\}\}, \{\{cookie\}\}/);
    expect(r.blocking).toEqual([]);
  });

  it('leaves a redacted header to the default from Settings, and does not ask for variables that exist', () => {
    const r = replayFromEvent(browserRequest, { ...opts, defaultHeaders: ['authorization'], variables: ['cookie'] });
    expect(r.draft.headers.map((h) => h.name)).toEqual(['Accept', 'Cookie', 'X-Custom']);
    expect(r.fromDefaults).toEqual(['Authorization']);
    expect(r.needs).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/default from Settings/);
  });

  it('flags a body that was cut off when recorded', () => {
    const r = replayFromEvent({ ...browserRequest, body: '{"sku":', bodyBytes: 90000, bodyTruncated: true }, opts);
    expect(r.blocking[0]).toMatch(/cut off .*90000 bytes/);
  });

  it('keeps URLs on other hosts as they are, and drops the API client’s own User-Agent', () => {
    const r = replayFromEvent({ method: 'GET', url: 'http://other:9000/x', headers: { 'User-Agent': 'DebugHub-API-Client', 'X-Request-Id': 'r1' } }, opts);
    expect(r.draft.url).toBe('http://other:9000/x');
    expect(r.draft.headers).toEqual([]);
  });

  it('templates only at a path boundary', () => {
    expect(templateUrl('http://h/shop', ['http://h/shop/'])).toBe('{{baseUrl}}');
    expect(templateUrl('http://h/shopping', ['http://h/shop'])).toBe('http://h/shopping');
    expect(templateUrl('http://h/shop?a=1', ['', 'http://h/shop'])).toBe('{{baseUrl}}?a=1');
    expect(variableFor('X-Api-Key')).toBe('x-api-key');
    expect(variableFor('1weird name')).toBe('_1weird_name');
  });
});
