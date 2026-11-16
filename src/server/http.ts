import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HubEvent, ServerMessage } from '../shared/types';
import { scanLogsFolder } from './collectors/logsdir';
import { chromeSetup, startChrome } from './chrome-launch';
import { matchPattern } from './collectors/tail';
import { editableConfig, resolvePaths, saveConfig, validateConfig } from './config';
import type { Hub } from './hub';
import { tomcatRoute } from './tomcat/routes';

export interface ServerOptions {
  /** Where the settings screen reads and saves settings. */
  configFile: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

const BATCH_MS = 50;
export const BIND_HOST = '127.0.0.1';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startServer(hub: Hub, uiDir: string, opts: ServerOptions): Promise<Server> {
  const port = hub.cfg.port;
  const configDir = dirname(opts.configFile);
  // "Also start Chrome" on the Tomcat page starts it as the Start Chrome button does.
  hub.tomcat.chromeStarter = () => startChrome(hub.cfg, configDir);
  // Saves run one at a time, so two quick saves cannot interleave their reconfigures.
  let saving: Promise<unknown> = Promise.resolve();

  const saveSettings = async (input: unknown) => {
    const { config, errors } = validateConfig(input);
    if (errors.length) return { status: 400, body: { errors } };
    try {
      await hub.reconfigure(resolvePaths(structuredClone(config), configDir));
    } catch (err) {
      return { status: 400, body: { errors: [{ path: 'sessionsDir', message: `Cannot use this folder: ${(err as Error).message}` }] } };
    }
    saveConfig(opts.configFile, config);
    return { status: 200, body: { config, restartNeeded: config.port !== port } };
  };
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  /**
   * Captured sessions contain request bodies and server logs, so refuse anything that is not
   * plainly this machine talking to itself: an unexpected Host header (DNS rebinding) or a
   * cross-site Origin (another page in the browser calling the API).
   */
  const trusted = (req: IncomingMessage): boolean => {
    if (!hosts.has(req.headers.host ?? '')) return false;
    const origin = req.headers.origin;
    return origin === undefined || origins.has(origin);
  };

  const server = createServer(async (req, res) => {
    try {
      if (!trusted(req)) return json(res, 403, { error: 'Forbidden' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const path = url.pathname;

      if (path === '/api/status' && req.method === 'GET') return json(res, 200, hub.status());
      if (path === '/api/sessions' && req.method === 'GET') return json(res, 200, hub.store.list());

      if (path === '/api/sessions/new' && req.method === 'POST') {
        return json(res, 200, { session: hub.newSession() });
      }

      const m = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
      if (m && req.method === 'GET') {
        const file = hub.store.pathFor(decodeURIComponent(m[1]));
        if (!file || !existsSync(file)) return json(res, 404, { error: 'Unknown session' });
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        createReadStream(file).pipe(res);
        return;
      }

      if (path === '/api/config' && req.method === 'GET') {
        return json(res, 200, { ...editableConfig(opts.configFile), runningPort: port });
      }
      if (path === '/api/config' && req.method === 'PUT') {
        const input = JSON.parse((await readBody(req)) || 'null');
        const done = saving.then(() => saveSettings(input));
        saving = done.catch(() => undefined);
        const out = await done;
        return json(res, out.status, out.body);
      }
      if (path === '/api/config/match' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const patterns: unknown[] = Array.isArray(body.patterns) ? body.patterns.slice(0, 50) : [];
        const results = await Promise.all(
          patterns.map(async (p) => {
            const pattern = String(p ?? '').trim();
            if (!pattern) return { pattern, resolved: '', files: [], problem: null };
            const resolved = isAbsolute(pattern) ? pattern : resolve(configDir, pattern);
            return { pattern, resolved, ...(await matchPattern(resolved)) };
          }),
        );
        return json(res, 200, results);
      }

      // What following a Tomcat logs folder would pick up, for the preview under that setting.
      if (path === '/api/config/logs-folder' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const abs = (p: unknown) => {
          const s = String(p ?? '').trim();
          return s && (isAbsolute(s) ? s : resolve(configDir, s));
        };
        const dir = abs(body.dir);
        if (!dir) return json(res, 200, null);
        const lists = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50).map(abs).filter(Boolean) : []);
        return json(res, 200, await scanLogsFolder(dir, lists(body.appLogs), lists(body.accessLogs)));
      }

      if (path === '/api/chrome/setup' && req.method === 'GET') {
        // The settings screen passes its unsaved values; without them, the running settings.
        const q = url.searchParams;
        const exe = q.has('executable') ? q.get('executable')! : hub.cfg.chrome.executable;
        const profile = q.has('profileDir') ? q.get('profileDir')! : hub.cfg.chrome.profileDir;
        return json(res, 200, chromeSetup(exe, profile, configDir));
      }
      if (path === '/api/chrome/launch' && req.method === 'POST') {
        return json(res, 200, await startChrome(hub.cfg, configDir));
      }

      if (path === '/api/markers' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return json(res, 200, hub.addMarker(String(body.label ?? '')));
      }

      if (await tomcatRoute(hub.tomcat, req, res, path, json, readBody)) return;

      if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      const rel = normalize(path === '/' ? 'index.html' : path.slice(1));
      if (rel.startsWith('..') || rel.includes(`..${sep}`)) return json(res, 400, { error: 'Bad path' });
      const file = join(uiDir, rel);
      if (!existsSync(file)) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
      });
      createReadStream(file).pipe(res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  server.on('upgrade', (req, socket, head) => {
    if (!trusted(req) || req.url !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => ws.close());
      ws.send(JSON.stringify({ type: 'status', status: hub.status() } satisfies ServerMessage));
    });
  });

  const broadcast = (msg: ServerMessage) => {
    const raw = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(raw);
  };

  // Events are batched so a burst of log lines becomes one frame, not hundreds.
  let queue: HubEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (queue.length === 0) return;
    broadcast({ type: 'events', session: hub.store.id, events: queue });
    queue = [];
  };

  hub.subscribe({
    onEvent: (ev) => {
      queue.push(ev);
      if (!timer) timer = setTimeout(flush, BATCH_MS);
    },
    onStatus: () => {
      flush();
      broadcast({ type: 'status', status: hub.status() });
    },
    onWar: (war) => broadcast({ type: 'war', war }),
  });
  // Keeps the event counter in the UI honest between status changes.
  setInterval(() => broadcast({ type: 'status', status: hub.status() }), 5000).unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => resolve(server));
  });
}
