import { createReadStream, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HubEvent, ServerMessage } from '../shared/types';
import type { Hub } from './hub';

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

export function startServer(hub: Hub, uiDir: string): Promise<Server> {
  const port = hub.cfg.port;
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

      if (path === '/api/markers' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return json(res, 200, hub.addMarker(String(body.label ?? '')));
      }

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
  });
  // Keeps the event counter in the UI honest between status changes.
  setInterval(() => broadcast({ type: 'status', status: hub.status() }), 5000).unref();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => resolve(server));
  });
}
