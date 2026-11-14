import { randomUUID } from 'node:crypto';
import type { CollectorStatus, HubEvent, Level } from '../../shared/types';
import type { Config } from '../config';
import { headerValue, makeEvent, redactHeaders, truncateText } from '../normalize';
import { CdpConnection } from './cdp';

interface PageSession {
  targetId: string;
  url: string;
}

interface NetEntry {
  netId: string;
  method: string;
  url: string;
  path: string;
  resourceType: string;
  /** Network.* timestamps are monotonic seconds; this converts them to epoch ms. */
  wallOffsetMs: number;
  startMs: number;
  requestHeaders: Record<string, unknown>;
  response?: any;
  pageUrl: string;
}

const RETRY_MS = 1000;
const TEXT_MIME = /json|text\/|xml|javascript|x-www-form-urlencoded|graphql/i;
const IGNORED_SCHEMES = /^(devtools|chrome|chrome-extension|chrome-untrusted|edge):/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shortUrl(url: string): string {
  if (url.startsWith('data:')) return url.slice(0, 40) + (url.length > 40 ? '…' : '');
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return (local ? '' : u.host) + u.pathname + u.search;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Renders a CDP RemoteObject the way the DevTools console would, in one line. */
function formatRemoteObject(o: any): string {
  if (!o) return '';
  if (o.type === 'string') return String(o.value);
  if (o.type === 'undefined') return 'undefined';
  if (o.type === 'number' || o.type === 'boolean' || o.type === 'bigint') {
    return o.unserializableValue ?? String(o.value);
  }
  if (o.subtype === 'null') return 'null';
  if (o.subtype === 'error') return o.description ?? 'Error';
  if (o.preview?.properties) {
    const props = o.preview.properties.map((p: any) => {
      const v = p.type === 'string' ? JSON.stringify(p.value) : p.value;
      return o.preview.subtype === 'array' ? v : `${p.name}: ${v}`;
    });
    if (o.preview.overflow) props.push('…');
    return o.preview.subtype === 'array' ? `[${props.join(', ')}]` : `{${props.join(', ')}}`;
  }
  if (o.value !== undefined) {
    try {
      return JSON.stringify(o.value);
    } catch {
      /* fall through */
    }
  }
  return o.description ?? o.type ?? '';
}

function formatStack(stackTrace: any): string | null {
  const frames = stackTrace?.callFrames;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  return frames
    .map((f: any) => `    at ${f.functionName || '(anonymous)'} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
    .join('\n');
}

const CONSOLE_LEVELS: Record<string, Level> = {
  error: 'error', assert: 'error', warning: 'warn', debug: 'debug', trace: 'debug', verbose: 'debug',
};

/**
 * Attaches to an already-running Chrome over its remote debugging port. It never launches a
 * browser and never enables the Debugger domain, so it coexists with the IDE's own debugger.
 */
export class ChromeCollector {
  status: CollectorStatus;
  private conn: CdpConnection | null = null;
  private stopped = false;
  private sessions = new Map<string, PageSession>();
  private attachedTargets = new Map<string, string>();
  private attaching = new Set<string>();
  private net = new Map<string, NetEntry>();

  constructor(
    private cfg: Config,
    private emit: (ev: HubEvent) => void,
    private onStatus: () => void,
  ) {
    this.status = { name: 'Chrome', state: 'waiting', detail: this.waitingDetail() };
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.conn?.close();
  }

  private get endpoint(): string {
    return `http://${this.cfg.chrome.host}:${this.cfg.chrome.port}`;
  }

  private waitingDetail(): string {
    return `Waiting for Chrome's debugging port at ${this.cfg.chrome.host}:${this.cfg.chrome.port}`;
  }

  private setStatus(state: CollectorStatus['state'], detail: string): void {
    if (this.status.state === state && this.status.detail === detail) return;
    this.status = { name: 'Chrome', state, detail };
    this.onStatus();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
        const version = (await res.json()) as { webSocketDebuggerUrl?: string; Browser?: string };
        if (!version.webSocketDebuggerUrl) throw new Error('No browser WebSocket URL');
        // Chrome reports the URL with whatever host it bound to; always dial the configured one.
        const wsUrl = new URL(version.webSocketDebuggerUrl);
        wsUrl.hostname = this.cfg.chrome.host;
        wsUrl.port = String(this.cfg.chrome.port);
        const conn = await CdpConnection.connect(wsUrl.toString());
        this.conn = conn;
        const closed = new Promise<void>((resolve) => conn.once('close', resolve));
        conn.on('event', (method, params, sessionId) => {
          this.onEvent(method, params, sessionId).catch(() => undefined);
        });
        await conn.send('Target.setDiscoverTargets', { discover: true });
        this.refreshStatus(version.Browser);
        await closed;
      } catch {
        /* Chrome is not up yet, or went away; retry below. */
      }
      this.conn = null;
      this.sessions.clear();
      this.attachedTargets.clear();
      this.attaching.clear();
      this.net.clear();
      if (!this.stopped) {
        this.setStatus('waiting', this.waitingDetail());
        await sleep(RETRY_MS);
      }
    }
  }

  private browserName = 'Chrome';
  private refreshStatus(browser?: string): void {
    if (browser) this.browserName = browser;
    const n = this.sessions.size;
    this.setStatus('connected', `${this.browserName} on port ${this.cfg.chrome.port} · ${n} tab${n === 1 ? '' : 's'} attached`);
  }

  /** The hub must not record its own UI, even when it is opened in the debugged browser. */
  private shouldAttach(info: any): boolean {
    if (info.type !== 'page') return false;
    const url: string = info.url ?? '';
    if (IGNORED_SCHEMES.test(url)) return false;
    try {
      const u = new URL(url);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (local && u.port === String(this.cfg.port)) return false;
    } catch {
      /* about:blank and friends are fine */
    }
    return true;
  }

  private async onTarget(info: any): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    const id: string = info.targetId;
    const sessionId = this.attachedTargets.get(id);
    const wanted = this.shouldAttach(info);

    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (s) s.url = info.url ?? s.url;
      if (!wanted) await conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      return;
    }
    if (!wanted || this.attaching.has(id)) return;

    this.attaching.add(id);
    try {
      const { sessionId: sid } = await conn.send('Target.attachToTarget', { targetId: id, flatten: true });
      this.attachedTargets.set(id, sid);
      this.sessions.set(sid, { targetId: id, url: info.url ?? '' });
      await Promise.all([
        conn.send('Runtime.enable', {}, sid),
        conn.send('Log.enable', {}, sid),
        conn.send('Page.enable', {}, sid),
        conn.send('Network.enable', { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 }, sid),
      ]);
      this.refreshStatus();
    } catch {
      /* the tab closed while we were attaching */
    } finally {
      this.attaching.delete(id);
    }
  }

  private dropSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.attachedTargets.delete(s.targetId);
    for (const key of this.net.keys()) if (key.startsWith(sessionId + ':')) this.net.delete(key);
    this.refreshStatus();
  }

  private async onEvent(method: string, p: any, sessionId?: string): Promise<void> {
    switch (method) {
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged':
        return this.onTarget(p.targetInfo);
      case 'Target.detachedFromTarget':
        return this.dropSession(p.sessionId);
      case 'Target.targetDestroyed': {
        const sid = this.attachedTargets.get(p.targetId);
        if (sid) this.dropSession(sid);
        return;
      }
    }
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (method) {
      case 'Runtime.consoleAPICalled':
        return this.onConsole(p, session);
      case 'Runtime.exceptionThrown':
        return this.onException(p, session);
      case 'Log.entryAdded':
        return this.onLogEntry(p.entry, session, sessionId);
      case 'Network.requestWillBeSent':
        return this.onRequest(p, session, sessionId);
      case 'Network.responseReceived': {
        const e = this.net.get(`${sessionId}:${p.requestId}`);
        if (e) {
          e.response = p.response;
          if (p.type) e.resourceType = p.type;
        }
        return;
      }
      case 'Network.loadingFinished':
        return this.onFinished(p, sessionId);
      case 'Network.loadingFailed':
        return this.onFailed(p, sessionId);
    }
  }

  private onConsole(p: any, session: PageSession): void {
    const args: string[] = (p.args ?? []).map(formatRemoteObject);
    const text = args.join(' ');
    const top = p.stackTrace?.callFrames?.[0];
    this.emit(
      makeEvent({
        tsMs: p.timestamp,
        source: 'browser',
        kind: 'console',
        level: CONSOLE_LEVELS[p.type] ?? 'info',
        summary: text || `console.${p.type}`,
        data: {
          type: p.type,
          text,
          url: top?.url ?? null,
          line: top ? top.lineNumber + 1 : null,
          stack: formatStack(p.stackTrace),
          pageUrl: session.url,
        },
      }),
    );
  }

  private onException(p: any, session: PageSession): void {
    const d = p.exceptionDetails ?? {};
    const description: string = d.exception?.description ?? d.exception?.value ?? d.text ?? 'Uncaught exception';
    const firstLine = String(description).split('\n')[0];
    this.emit(
      makeEvent({
        tsMs: p.timestamp,
        source: 'browser',
        kind: 'console',
        level: 'error',
        summary: firstLine.startsWith('Uncaught') ? firstLine : `Uncaught ${firstLine}`,
        data: {
          type: 'exception',
          text: String(description),
          url: d.url ?? null,
          line: d.lineNumber != null ? d.lineNumber + 1 : null,
          stack: formatStack(d.stackTrace),
          pageUrl: session.url,
        },
      }),
    );
  }

  private onLogEntry(entry: any, session: PageSession, sessionId: string): void {
    const linked = entry.networkRequestId ? this.net.get(`${sessionId}:${entry.networkRequestId}`) : undefined;
    this.emit(
      makeEvent({
        tsMs: entry.timestamp,
        source: 'browser',
        kind: 'console',
        level: CONSOLE_LEVELS[entry.level] ?? 'info',
        summary: entry.text ?? '',
        data: {
          type: `log:${entry.source}`,
          text: entry.text ?? '',
          url: entry.url ?? null,
          line: entry.lineNumber != null ? entry.lineNumber + 1 : null,
          stack: formatStack(entry.stackTrace),
          netId: linked?.netId ?? null,
          pageUrl: session.url,
        },
      }),
    );
  }

  private onRequest(p: any, session: PageSession, sessionId: string): void {
    const key = `${sessionId}:${p.requestId}`;
    const wallOffsetMs = p.wallTime * 1000 - p.timestamp * 1000;

    // A redirect reuses the request ID: close out the previous hop first.
    const previous = this.net.get(key);
    if (previous && p.redirectResponse) {
      previous.response = p.redirectResponse;
      this.emitResponse(previous, p.timestamp * 1000 + previous.wallOffsetMs, {});
    }

    const req = p.request;
    const entry: NetEntry = {
      netId: randomUUID(),
      method: req.method,
      url: req.url,
      path: pathOf(req.url),
      resourceType: p.type ?? 'Other',
      wallOffsetMs,
      startMs: p.wallTime * 1000,
      requestHeaders: req.headers ?? {},
      pageUrl: session.url,
    };
    this.net.set(key, entry);

    const body = typeof req.postData === 'string' ? truncateText(req.postData, this.cfg.maxBodyBytes) : null;
    this.emit(
      makeEvent({
        tsMs: entry.startMs,
        source: 'browser',
        kind: 'request',
        level: 'info',
        requestId: headerValue(entry.requestHeaders, this.cfg.correlation.header),
        summary: `${entry.method} ${shortUrl(entry.url)}`,
        data: {
          netId: entry.netId,
          method: entry.method,
          url: entry.url,
          path: entry.path,
          resourceType: entry.resourceType,
          headers: redactHeaders(entry.requestHeaders, this.cfg.redact.headers),
          ...(body && { body: body.text, bodyBytes: body.bytes, bodyTruncated: body.truncated }),
          pageUrl: entry.pageUrl,
        },
      }),
    );
  }

  private wantsBody(e: NetEntry): boolean {
    if (!this.cfg.chrome.captureBodies) return false;
    if (!this.cfg.chrome.bodyResourceTypes.includes(e.resourceType)) return false;
    const status = e.response?.status ?? 0;
    if (status === 204 || status === 304) return false;
    return TEXT_MIME.test(e.response?.mimeType ?? '');
  }

  private async onFinished(p: any, sessionId: string): Promise<void> {
    const key = `${sessionId}:${p.requestId}`;
    const e = this.net.get(key);
    if (!e) return;
    this.net.delete(key);

    const extra: Record<string, any> = { encodedBytes: p.encodedDataLength ?? null };
    if (this.wantsBody(e) && this.conn) {
      try {
        const r = await this.conn.send('Network.getResponseBody', { requestId: p.requestId }, sessionId);
        if (!r.base64Encoded) {
          const t = truncateText(r.body ?? '', this.cfg.maxBodyBytes);
          extra.body = t.text;
          extra.bodyBytes = t.bytes;
          extra.bodyTruncated = t.truncated;
        }
      } catch {
        extra.bodyUnavailable = true;
      }
    }
    this.emitResponse(e, p.timestamp * 1000 + e.wallOffsetMs, extra);
  }

  private onFailed(p: any, sessionId: string): void {
    const key = `${sessionId}:${p.requestId}`;
    const e = this.net.get(key);
    if (!e) return;
    this.net.delete(key);
    const endMs = p.timestamp * 1000 + e.wallOffsetMs;
    const reason = p.blockedReason ? `blocked: ${p.blockedReason}` : p.errorText || 'failed';
    this.emit(
      makeEvent({
        tsMs: endMs,
        source: 'browser',
        kind: 'response',
        level: p.canceled ? 'info' : 'error',
        requestId: headerValue(e.requestHeaders, this.cfg.correlation.header),
        summary: `${e.method} ${shortUrl(e.url)} ✕ ${p.canceled ? 'canceled' : reason}`,
        data: {
          netId: e.netId,
          method: e.method,
          url: e.url,
          path: e.path,
          resourceType: e.resourceType,
          failed: true,
          canceled: !!p.canceled,
          errorText: reason,
          status: e.response?.status ?? null,
          durationMs: Math.max(0, Math.round(endMs - e.startMs)),
          pageUrl: e.pageUrl,
        },
      }),
    );
  }

  private emitResponse(e: NetEntry, endMs: number, extra: Record<string, any>): void {
    const r = e.response ?? {};
    const status: number = r.status ?? 0;
    const header = this.cfg.correlation.header;
    this.emit(
      makeEvent({
        tsMs: endMs,
        source: 'browser',
        kind: 'response',
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        // The dev proxy echoes the ID it generated on the response, which is where the browser sees it.
        requestId: headerValue(r.headers, header) ?? headerValue(e.requestHeaders, header),
        summary: `${e.method} ${shortUrl(e.url)} → ${status}${r.statusText ? ' ' + r.statusText : ''}`,
        data: {
          netId: e.netId,
          method: e.method,
          url: e.url,
          path: e.path,
          resourceType: e.resourceType,
          status,
          statusText: r.statusText ?? '',
          mimeType: r.mimeType ?? null,
          headers: redactHeaders(r.headers, this.cfg.redact.headers),
          durationMs: Math.max(0, Math.round(endMs - e.startMs)),
          fromCache: !!(r.fromDiskCache || r.fromPrefetchCache),
          remoteAddress: r.remoteIPAddress ? `${r.remoteIPAddress}:${r.remotePort}` : null,
          ...extra,
          pageUrl: e.pageUrl,
        },
      }),
    );
  }
}
