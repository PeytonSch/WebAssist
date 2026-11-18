import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The live channel as Server-Sent Events (GET /api/live): the same messages the WebSocket at
 * /ws carries, one JSON object per event. The UI uses it when a WebSocket cannot connect, which
 * is always the case inside Tomcat, where requests reach the hub through a plain HTTP proxy.
 */

/** A client that does not read is dropped once this much is waiting for it; it reconnects and reloads the session. */
const MAX_BUFFERED = 8 * 1024 * 1024;
const PING_MS = 15_000;

export class LiveStreams {
  private clients = new Set<ServerResponse>();
  private timer: NodeJS.Timeout;

  constructor() {
    // A comment line now and then keeps proxies from closing a quiet stream, and lets a proxy
    // notice a browser that has gone away: its next write fails.
    this.timer = setInterval(() => this.write(': ping\n\n'), PING_MS);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Answers a GET /api/live. `first` are messages for this client alone, sent at once. */
  open(req: IncomingMessage, res: ServerResponse, first: string[] = []): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      // For nginx in front: do not hold the stream back.
      'x-accel-buffering': 'no',
    });
    // Reconnect after a second, as the WebSocket client does.
    res.write('retry: 1000\n\n');
    for (const raw of first) res.write(`data: ${raw}\n\n`);
    this.clients.add(res);
    const gone = () => this.clients.delete(res);
    req.on('close', gone);
    res.on('close', gone);
    res.on('error', gone);
  }

  /** Sends one message (JSON on a single line) to every client. */
  send(raw: string): void {
    this.write(`data: ${raw}\n\n`);
  }

  private write(chunk: string): void {
    for (const res of this.clients) {
      if (res.writableEnded || res.destroyed) this.clients.delete(res);
      else if (res.writableLength > MAX_BUFFERED) {
        this.clients.delete(res);
        res.destroy();
      } else res.write(chunk);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}
