import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingMessage, type Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/server/config';
import { loadHostedConfig } from '../src/server/hosted/defaults';
import { setHosted, type HostedInfo } from '../src/server/hosted/info';
import { isOwnTraffic, isOwnUi, isSelfWebapp, ownTomcat } from '../src/server/hosted/self';
import { HostedServer } from '../src/server/hosted/server';
import { H } from '../src/server/hosted/trust';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import { makeEvent } from '../src/server/normalize';
import { TomcatError } from '../src/server/tomcat/webapps';

const SECRET = 'k'.repeat(64);
let dir: string;
let info: HostedInfo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-hosted-http-'));
  for (const d of ['webapps/debug-hub', 'webapps/shop', 'logs', 'bin', 'debug-hub-data', 'ui']) mkdirSync(join(dir, d), { recursive: true });
  info = {
    secret: SECRET,
    contextPath: '/debug-hub',
    webappDir: join(dir, 'webapps', 'debug-hub'),
    catalinaBase: dir,
    catalinaHome: dir,
    javaHome: null,
    serverInfo: 'Apache Tomcat/9.0.89',
    dataDir: join(dir, 'debug-hub-data'),
    remote: '10.0.0.0/8',
    hosts: '',
    logFile: null,
  };
});
afterEach(() => {
  setHosted(null);
  rmSync(dir, { recursive: true, force: true });
});

/** A request as the launcher makes it, unless the headers say otherwise. */
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; headers: IncomingMessage['headers']; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          [H.secret]: SECRET,
          [H.remoteAddr]: '127.0.0.1',
          [H.host]: 'localhost:8080',
          ...(data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

describe('the hub inside Tomcat', () => {
  let hub: Hub;
  let server: Server;
  let port: number;
  const file = () => join(info.dataDir, 'debug-hub.config.json');

  beforeEach(async () => {
    setHosted(info);
    const { config } = loadHostedConfig(file(), info);
    config.port = 0;
    config.chrome.enabled = false;
    config.tomcat.enabled = false;
    hub = new Hub(config);
    hub.start();
    server = await startServer(hub, join(dir, 'ui'), { configFile: file(), hosted: new HostedServer(info, () => hub.cfg) });
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.close();
    server.closeAllConnections();
    await hub.stop();
  });

  it('listens on a port of its own choosing, on 127.0.0.1', () => {
    expect(port).toBeGreaterThan(0);
    expect((server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('answers the launcher and nobody else', async () => {
    expect((await call(port, 'GET', '/api/status')).status).toBe(200);
    // Another program on the machine that found the port: right Host, no secret.
    const direct = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(direct.status).toBe(403);
    expect((await call(port, 'GET', '/api/status', { [H.secret]: 'wrong' })).status).toBe(403);
    expect((await call(port, 'GET', '/', { [H.secret]: '' })).status).toBe(403);
  });

  it('routes by the path under the context path, which the launcher has taken off', async () => {
    const host = (await call(port, 'GET', '/api/host')).json();
    expect(host).toMatchObject({ hosted: true, local: true, contextPath: '/debug-hub', webapp: 'debug-hub', server: 'Apache Tomcat/9.0.89', access: 'list', ownTomcat: true });
    expect(host.dataDir).toBe(info.dataDir);
  });

  it('tells a browser on another computer why it is refused, and an allowed one that it is not local', async () => {
    const refused = await call(port, 'GET', '/', { [H.remoteAddr]: '192.168.7.7', accept: 'text/html' });
    expect(refused.status).toBe(403);
    expect(refused.headers['content-type']).toMatch(/text\/html/);
    expect(refused.text).toContain('debughub.remote');
    const api = await call(port, 'GET', '/api/status', { [H.remoteAddr]: '192.168.7.7' });
    expect(api.status).toBe(403);
    expect(api.json().error).toMatch(/only answers the computer it runs on/);

    const allowed = await call(port, 'GET', '/api/host', { [H.remoteAddr]: '10.1.2.3', [H.host]: '10.0.0.1:8080' });
    expect(allowed.json()).toMatchObject({ hosted: true, local: false });
  });

  it('keeps cross-site protection behind the proxy', async () => {
    const own = await call(port, 'POST', '/api/markers', { [H.origin]: 'http://localhost:8080' }, { label: 'mine' });
    expect(own.status).toBe(200);
    const other = await call(port, 'POST', '/api/markers', { [H.origin]: 'http://evil.example' }, { label: 'theirs' });
    expect(other.status).toBe(403);
    const rebound = await call(port, 'GET', '/api/sessions', { [H.host]: 'evil.example:8080' });
    expect(rebound.status).toBe(403);
    expect(hub.store.count).toBe(1);
  });

  it('refuses what only makes sense on its own machine to a browser elsewhere', async () => {
    const remote = { [H.remoteAddr]: '10.1.2.3', [H.host]: '10.0.0.1:8080' };
    for (const path of ['/api/chrome/launch', '/api/tomcat/reveal', '/api/source/open', '/api/source/test']) {
      const res = await call(port, 'POST', path, remote, {});
      expect(res.status, path).toBe(403);
      expect(res.json().error).toMatch(/computer Debug Hub runs on/);
    }
    // The same request from the machine itself gets to the route (which answers that no editor is set up).
    expect((await call(port, 'POST', '/api/source/open', {}, {})).json().error ?? '').not.toMatch(/computer Debug Hub runs on/);
  });

  it('shows detected settings as values, and needs no restart for the port', async () => {
    const got = (await call(port, 'GET', '/api/config')).json();
    expect(got.file).toBe(file());
    expect(got.config.tomcat.webappsDir.replace(/\\/g, '/')).toBe(join(dir, 'webapps').replace(/\\/g, '/'));
    expect(got.detected['tomcat.webappsDir'].why).toMatch(/deployed/);
    expect(got.runningPort).toBe(got.config.port);

    const next = { ...got.config, port: 4999, chrome: { ...got.config.chrome, enabled: false } };
    const saved = await call(port, 'PUT', '/api/config', { [H.origin]: 'http://localhost:8080' }, next);
    expect(saved.status).toBe(200);
    expect(saved.json().restartNeeded).toBe(false);
  });

  it('lists its own Tomcat with zero configuration, and marks itself', async () => {
    const state = (await call(port, 'GET', '/api/tomcat')).json();
    expect(state.problems).toEqual([]);
    expect(state.hosted).toEqual({ path: '/debug-hub', server: 'Apache Tomcat/9.0.89' });
    expect(state.webapps.map((a: any) => [a.name, !!a.self])).toEqual([['debug-hub', true], ['shop', false]]);
    expect(state.launch.home.replace(/\\/g, '/')).toBe(dir.replace(/\\/g, '/'));
  });

  it('does not stop, reload, disable or delete itself, or start the Tomcat it runs in', async () => {
    const post = { [H.origin]: 'http://localhost:8080' };
    for (const action of ['disable', 'stop', 'reload']) {
      const res = await call(port, 'POST', `/api/tomcat/webapps/debug-hub/${action}`, post, {});
      expect(res.status, action).toBe(409);
      expect(res.json().error).toMatch(/Debug Hub itself/);
    }
    const del = await call(port, 'POST', '/api/tomcat/delete', post, { name: 'debug-hub', from: 'webapps', items: ['debug-hub'] });
    expect(del.status).toBe(409);
    const start = await call(port, 'POST', '/api/tomcat/server/start', post, {});
    expect(start.status).toBe(409);
    expect(start.json().error).toMatch(/already running/);
    // Stop Tomcat is allowed, once the page has asked: without ?self=1 it is only explained.
    const stop = await call(port, 'POST', '/api/tomcat/server/stop', post, {});
    expect(stop.status).toBe(409);
    expect(stop.json()).toMatchObject({ self: true });
    // Another webapp is not affected by any of this.
    await expect(hub.tomcat.webappAction('shop', 'disable')).resolves.toMatch(/Disabled shop/);
  });

  it('streams live messages as Server-Sent Events', async () => {
    const chunks: string[] = [];
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/api/live', headers: { [H.secret]: SECRET, [H.remoteAddr]: '127.0.0.1', [H.host]: 'localhost:8080', accept: 'text/event-stream' } }, resolve);
      r.on('error', reject);
      r.end();
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    res.setEncoding('utf8');
    res.on('data', (c) => chunks.push(c));
    const messages = () => chunks.join('').split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)));
    const until = async (test: () => boolean) => {
      for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20));
      expect(test()).toBe(true);
    };

    // The status comes at once, without waiting for something to happen.
    await until(() => messages().some((m) => m.type === 'status'));
    hub.addMarker('over the stream');
    await until(() => messages().some((m) => m.type === 'events' && m.events[0].summary === 'over the stream'));
    expect(messages().find((m) => m.type === 'events').session).toBe(hub.store.id);
    res.destroy();
  });

  it('has no WebSocket: nothing can open one through the launcher', async () => {
    const res = await new Promise<string>((resolve) => {
      const r = request({ host: '127.0.0.1', port, path: '/ws', headers: { [H.secret]: SECRET, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
      r.on('upgrade', () => resolve('upgraded'));
      r.on('response', () => resolve('answered'));
      r.on('error', () => resolve('closed'));
      r.end();
    });
    expect(res).toBe('closed');
  });
});

describe('the hub on its own', () => {
  it('still answers by Host, says it is not hosted, and offers the event stream too', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.port = 0;
    config.chrome.enabled = false;
    config.sessionsDir = join(dir, 'sessions');
    // The Host check needs the port, so find a free one first, as the settings tests do.
    const free = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    config.port = free;
    const hub = new Hub(config);
    hub.start();
    const server = await startServer(hub, dir, { configFile: join(dir, 'debug-hub.config.json') });
    try {
      const base = `http://127.0.0.1:${free}`;
      expect(await (await fetch(`${base}/api/host`)).json()).toEqual({ hosted: false, local: true });
      const ctrl = new AbortController();
      const live = await fetch(`${base}/api/live`, { signal: ctrl.signal });
      expect(live.headers.get('content-type')).toMatch(/text\/event-stream/);
      const first = new TextDecoder().decode((await live.body!.getReader().read()).value);
      expect(first).toContain('retry: 1000');
      ctrl.abort();
      // A webapp that happens to be called debug-hub is nobody's own without hosting.
      expect(ownTomcat(hub.cfg)).toBe(false);
    } finally {
      server.close();
      server.closeAllConnections();
      await hub.stop();
    }
  });
});

describe('knowing itself', () => {
  const cfg = (webappsDir: string) => ({ ...structuredClone(DEFAULT_CONFIG), tomcat: { ...structuredClone(DEFAULT_CONFIG.tomcat), webappsDir } });

  it('only guards its own Tomcat: a hub hosted in one Tomcat may manage another', () => {
    expect(ownTomcat(cfg(join(dir, 'webapps')), info)).toBe(true);
    expect(isSelfWebapp(cfg(join(dir, 'webapps')), { name: 'debug-hub' }, info)).toBe(true);
    expect(isSelfWebapp(cfg(join(dir, 'webapps')), { name: 'debug-hub##2' }, info)).toBe(true);
    expect(isSelfWebapp(cfg(join(dir, 'webapps')), { name: 'shop' }, info)).toBe(false);
    const other = join(dir, 'other-tomcat', 'webapps');
    expect(ownTomcat(cfg(other), info)).toBe(false);
    expect(isSelfWebapp(cfg(other), { name: 'debug-hub' }, info)).toBe(false);
    expect(ownTomcat(cfg(''), info)).toBe(false);
  });

  it('keeps the guard in the service, not only in the page', async () => {
    setHosted(info);
    const config = cfg(join(dir, 'webapps'));
    config.sessionsDir = join(dir, 'sessions');
    config.tomcat.disabledDir = join(dir, 'webapps-disabled');
    const hub = new Hub(config);
    await expect(hub.tomcat.webappAction('debug-hub', 'disable')).rejects.toBeInstanceOf(TomcatError);
    await expect(hub.tomcat.deleteWebapp('debug-hub', 'webapps', ['debug-hub'])).rejects.toThrow(/Debug Hub itself/);
    await expect(hub.tomcat.startTomcat()).rejects.toThrow(/already running/);
  });

  it('leaves its own requests out of the timeline', () => {
    const access = (path: string) => makeEvent({ tsMs: 1, source: 'tomcat', kind: 'request', level: 'info', summary: path, data: { path } });
    expect(isOwnTraffic(access('/debug-hub/api/tomcat'), info)).toBe(true);
    expect(isOwnTraffic(access('/debug-hub/'), info)).toBe(true);
    expect(isOwnTraffic(access('/debug-hub'), info)).toBe(true);
    expect(isOwnTraffic(access('/debug-hubbub/x'), info)).toBe(false);
    expect(isOwnTraffic(access('/shop/api/orders?x=/debug-hub/'), info)).toBe(false);
    expect(isOwnTraffic(makeEvent({ tsMs: 1, source: 'browser', kind: 'request', level: 'info', summary: 'x', data: { path: '/debug-hub/api/x' } }), info)).toBe(false);
    const asRoot = { ...info, contextPath: '' };
    expect(isOwnTraffic(access('/api/status'), asRoot)).toBe(true);
    expect(isOwnTraffic(access('/shop/api/orders'), asRoot)).toBe(false);
  });

  it('does not record its own page in the debugged browser', () => {
    const seen = new Set(['localhost:8080']);
    expect(isOwnUi(new URL('http://localhost:8080/debug-hub/'), seen, info)).toBe(true);
    expect(isOwnUi(new URL('http://localhost:8080/debug-hub/#tomcat'), seen, info)).toBe(true);
    expect(isOwnUi(new URL('http://localhost:8080/shop/'), seen, info)).toBe(false);
    expect(isOwnUi(new URL('http://localhost:3000/debug-hub/'), seen, info)).toBe(false);
    expect(isOwnUi(new URL('http://localhost:8080/debug-hub/'), seen, null)).toBe(false);
  });
});
