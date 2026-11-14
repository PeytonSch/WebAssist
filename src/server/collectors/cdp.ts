import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

interface Waiter {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

/**
 * A deliberately thin Chrome DevTools Protocol client: JSON over one WebSocket, with
 * "flattened" sessions so every tab shares the connection.
 *
 * Events: 'event' (method, params, sessionId), 'close'.
 */
export class CdpConnection extends EventEmitter {
  private ws: WebSocket;
  private nextId = 1;
  private waiters = new Map<number, Waiter>();

  private constructor(ws: WebSocket) {
    super();
    this.ws = ws;
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', () => this.onClose());
    ws.on('error', () => ws.close());
  }

  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      ws.once('open', () => resolve(new CdpConnection(ws)));
      ws.once('error', reject);
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const w = this.waiters.get(msg.id);
      if (!w) return;
      this.waiters.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message ?? 'CDP error'));
      else w.resolve(msg.result);
    } else if (msg.method) {
      this.emit('event', msg.method, msg.params ?? {}, msg.sessionId);
    }
  }

  private onClose(): void {
    for (const w of this.waiters.values()) w.reject(new Error('CDP connection closed'));
    this.waiters.clear();
    this.emit('close');
  }
}
