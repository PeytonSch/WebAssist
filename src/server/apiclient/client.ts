import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ApiSpec, SendInput, SendResult, SpecStatus } from '../../shared/apiclient';
import type { HubEvent } from '../../shared/types';
import type { Config } from '../config';
import { headerValue, makeEvent, redactHeaders, truncateText } from '../normalize';
import { RequestFailed, sendRaw, type RawResponse } from './http';
import { parseSpec, parseSpecText, SpecError } from './spec';

/** The most the API screen is sent of a response body. The timeline keeps maxBodyBytes of it. */
export const UI_BODY_LIMIT = 10 * 1024 * 1024;
/** Request bodies the hub accepts from the API screen. */
export const SEND_BODY_LIMIT = 10 * 1024 * 1024;
const SPEC_LIMIT = 30 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'DebugHub-API-Client';
const TEXT_MIME = /json|text\/|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv|html/i;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export class SendError extends Error {}

interface Cached {
  url: string;
  state: SpecStatus['state'];
  spec: ApiSpec | null;
  error: string | null;
  loadedAt: string | null;
  pending: Promise<ApiSpec> | null;
}

function shortUrl(url: URL): string {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return (local ? '' : url.host) + url.pathname + url.search;
}

const isLoopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);

/**
 * The API client: loads the OpenAPI specs named in Settings (cached until reloaded) and sends
 * requests for the API screen, recording each on the timeline as a request event and a
 * response event that share a netId, like the browser's. Requests carry the correlation header
 * with a fresh ID, so the Tomcat log lines and queries they cause link to them.
 */
export class ApiClient {
  private cache = new Map<string, Cached>();

  constructor(
    private cfg: Config,
    private emit: (ev: HubEvent) => void,
  ) {}

  reconfigure(cfg: Config): void {
    this.cfg = cfg;
    // A spec whose URL changed (or that was removed) is loaded afresh when next asked for.
    for (const [name, c] of this.cache) {
      if (cfg.api.specs.find((s) => s.name === name)?.url !== c.url) this.cache.delete(name);
    }
  }

  specs(): SpecStatus[] {
    return this.cfg.api.specs.map((s) => {
      const c = this.cache.get(s.name);
      return {
        name: s.name,
        url: s.url,
        state: c?.state ?? 'not-loaded',
        error: c?.error ?? null,
        loadedAt: c?.loadedAt ?? null,
        title: c?.spec?.title ?? null,
        operations: c?.spec?.operations.length ?? 0,
      };
    });
  }

  /** The parsed spec, loading it the first time or when `reload` is set. */
  spec(name: string, reload = false): Promise<ApiSpec> {
    const entry = this.cfg.api.specs.find((s) => s.name === name);
    if (!entry) return Promise.reject(new SpecError(`No spec called ${name} in Settings`));
    const c = this.cache.get(name);
    if (c && c.url === entry.url) {
      if (c.pending) return c.pending;
      if (c.spec && !reload) return Promise.resolve(c.spec);
    }
    const next: Cached = { url: entry.url, state: 'loading', spec: c?.spec ?? null, error: null, loadedAt: c?.loadedAt ?? null, pending: null };
    next.pending = this.load(entry.name, entry.url).then(
      (spec) => {
        Object.assign(next, { state: 'loaded', spec, error: null, loadedAt: new Date().toISOString(), pending: null });
        return spec;
      },
      (err: Error) => {
        Object.assign(next, { state: 'error', spec: null, error: err.message, pending: null });
        throw err;
      },
    );
    this.cache.set(name, next);
    return next.pending;
  }

  private async load(name: string, source: string): Promise<ApiSpec> {
    let text: string;
    let type = '';
    if (/^https?:/i.test(source)) {
      const url = new URL(source);
      const headers: [string, string][] = [['Accept', 'application/json, application/yaml;q=0.9, */*;q=0.5'], ['User-Agent', USER_AGENT]];
      // Default headers (an Authorization token, say) go only to this machine or the API's own
      // host, not to a public spec somewhere else.
      const base = this.cfg.api.baseUrl ? new URL(this.cfg.api.baseUrl) : null;
      if (isLoopback(url) || base?.origin === url.origin) headers.push(...this.cfg.api.headers.map((h) => [h.name, h.value] as [string, string]));
      let res: RawResponse;
      let target = url;
      for (let hop = 0; ; hop++) {
        try {
          res = await sendRaw({ method: 'GET', url: target.toString(), headers, timeoutMs: this.cfg.api.timeoutMs, insecureTls: this.cfg.api.insecureTls, maxBytes: SPEC_LIMIT });
        } catch (err) {
          throw new SpecError((err as Error).message);
        }
        const loc = res.headerMap.location;
        if (res.status >= 300 && res.status < 400 && loc && hop < MAX_REDIRECTS) target = new URL(loc, target);
        else break;
      }
      if (res.status !== 200) throw new SpecError(`${target} answered ${res.status} ${res.statusText}`.trim());
      if (res.truncated) throw new SpecError(`The spec is larger than ${SPEC_LIMIT / 1024 / 1024} MB`);
      text = res.body.toString('utf8');
      type = res.headerMap['content-type'] ?? '';
    } else {
      const file = /^file:/i.test(source) ? fileURLToPath(source) : source;
      try {
        text = await readFile(file, 'utf8');
      } catch (err: any) {
        throw new SpecError(err?.code === 'ENOENT' ? `File not found: ${file}` : `Could not read ${file}: ${err?.message}`);
      }
      if (/\.ya?ml$/i.test(file)) type = 'application/yaml';
    }
    return parseSpec(parseSpecText(text, type), name, source);
  }

  /**
   * Sends one request. Default headers from Settings come first, unless turned off for this
   * request or set by it; then the request's own headers; then the correlation header with a
   * fresh ID, unless the request set one. Both timeline events have their headers redacted as
   * configured; the API screen gets the response as received.
   */
  async send(input: SendInput, signal?: AbortSignal): Promise<SendResult> {
    const api = this.cfg.api;
    const method = String(input.method ?? '').trim().toUpperCase();
    if (!TOKEN.test(method)) throw new SendError('Not a valid HTTP method');
    let url: URL;
    try {
      url = new URL(String(input.url ?? '').trim());
    } catch {
      throw new SendError(`Not a complete URL: ${input.url || '(empty)'}. It must start with http:// or https://`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SendError('Only http:// and https:// URLs can be sent');

    const own = (Array.isArray(input.headers) ? input.headers : [])
      .map((h) => ({ name: String(h?.name ?? '').trim(), value: String(h?.value ?? '') }))
      .filter((h) => h.name);
    for (const h of own) {
      if (!TOKEN.test(h.name)) throw new SendError(`Not a valid header name: ${h.name}`);
      if (/[\r\n]/.test(h.value)) throw new SendError(`The ${h.name} header contains a line break`);
    }
    const has = (list: { name: string }[], name: string) => list.some((h) => h.name.toLowerCase() === name.toLowerCase());
    const off = new Set((input.disabledDefaults ?? []).map((n) => String(n).toLowerCase()));
    const headers: [string, string][] = [
      ...api.headers.filter((h) => !off.has(h.name.toLowerCase()) && !has(own, h.name)).map((h) => [h.name, h.value] as [string, string]),
      ...own.map((h) => [h.name, h.value] as [string, string]),
    ];
    const ridHeader = this.cfg.correlation.header;
    if (api.addRequestId && !headers.some(([n]) => n.toLowerCase() === ridHeader.toLowerCase())) headers.push([ridHeader, randomUUID()]);
    const lower = headers.map(([n]) => n.toLowerCase());
    if (!lower.includes('user-agent')) headers.push(['User-Agent', USER_AGENT]);
    if (!lower.includes('accept')) headers.push(['Accept', '*/*']);

    const bodyText = typeof input.body === 'string' ? input.body : '';
    const body = Buffer.from(bodyText, 'utf8');
    if (body.length > SEND_BODY_LIMIT) throw new SendError('The body is larger than 10 MB');
    const label = typeof input.label === 'string' ? input.label.slice(0, 200) : '';

    const redirects: SendResult['redirects'] = [];
    let hopMethod = method;
    let hopBody = body;
    let hopHeaders = headers;
    let target = url;
    for (let hop = 0; ; hop++) {
      const { result, res } = await this.once(hopMethod, target, hopHeaders, hopBody, label, signal);
      const loc = res?.headerMap.location;
      if (!input.followRedirects || !res || !loc || res.status < 300 || res.status >= 400 || res.status === 304 || hop >= MAX_REDIRECTS) {
        return { ...result, redirects };
      }
      redirects.push({ status: res.status, url: target.toString() });
      const next = new URL(loc, target);
      // As browsers do: 303, and 301/302 after a POST, turn into a GET without a body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && hopMethod === 'POST')) {
        hopMethod = 'GET';
        hopBody = Buffer.alloc(0);
        hopHeaders = hopHeaders.filter(([n]) => !/^content-(type|length)$/i.test(n));
      }
      // Credentials are not carried to another site.
      if (next.origin !== target.origin) hopHeaders = hopHeaders.filter(([n]) => !/^(authorization|cookie|proxy-authorization)$/i.test(n));
      target = next;
    }
  }

  /** One request and its two timeline events. */
  private async once(method: string, url: URL, headers: [string, string][], body: Buffer, label: string, signal?: AbortSignal) {
    const api = this.cfg.api;
    const netId = randomUUID();
    const started = Date.now();
    const headerObj = Object.fromEntries(headers.map(([n, v]) => [n, v]));
    const ridHeader = this.cfg.correlation.header;
    const requestId = headerValue(headerObj, ridHeader);
    const common = { netId, method, url: url.toString(), path: url.pathname + url.search, resourceType: 'API', ...(label && { label }) };
    const sentBody = body.length ? truncateText(body.toString('utf8'), this.cfg.maxBodyBytes) : null;
    const reqEv = makeEvent({
      tsMs: started,
      source: 'client',
      kind: 'request',
      level: 'info',
      requestId,
      summary: `${method} ${shortUrl(url)}`,
      data: {
        ...common,
        headers: redactHeaders(headerObj, this.cfg.redact.headers),
        ...(sentBody && { body: sentBody.text, bodyBytes: sentBody.bytes, bodyTruncated: sentBody.truncated }),
      },
    });
    this.emit(reqEv);

    const base: Omit<SendResult, 'redirects'> = {
      requestEventId: reqEv.id,
      responseEventId: '',
      requestId,
      url: url.toString(),
      method,
      sentHeaders: headers,
      ok: false,
      status: null,
      statusText: '',
      httpVersion: null,
      headers: [],
      body: '',
      binary: false,
      bodyBytes: 0,
      truncated: false,
      durationMs: 0,
      ttfbMs: null,
      error: null,
      canceled: false,
      remoteAddress: null,
    };

    let res: RawResponse;
    try {
      res = await sendRaw({ method, url: url.toString(), headers, body, timeoutMs: api.timeoutMs, insecureTls: api.insecureTls, maxBytes: UI_BODY_LIMIT, signal });
    } catch (err) {
      const e = err instanceof RequestFailed ? err : new RequestFailed((err as Error).message);
      const resEv = makeEvent({
        tsMs: started + e.durationMs,
        source: 'client',
        kind: 'response',
        level: e.canceled ? 'info' : 'error',
        requestId,
        summary: `${method} ${shortUrl(url)} ✕ ${e.canceled ? 'canceled' : e.message}`,
        data: { ...common, failed: true, canceled: e.canceled, errorText: e.message, status: null, durationMs: e.durationMs },
      });
      this.emit(resEv);
      return { result: { ...base, responseEventId: resEv.id, error: e.message, canceled: e.canceled, durationMs: e.durationMs }, res: null };
    }

    const mime = res.headerMap['content-type'] ?? null;
    const binary = isBinary(res.body, mime);
    const text = binary ? '' : res.body.toString('utf8');
    const kept = binary ? null : truncateText(text, this.cfg.maxBodyBytes);
    const status = res.status;
    const resEv = makeEvent({
      tsMs: started + res.durationMs,
      source: 'client',
      kind: 'response',
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      requestId: headerValue(res.headerMap, ridHeader) ?? requestId,
      summary: `${method} ${shortUrl(url)} → ${status}${res.statusText ? ' ' + res.statusText : ''}`,
      data: {
        ...common,
        status,
        statusText: res.statusText,
        mimeType: mime ? mime.split(';')[0].trim() : null,
        headers: redactHeaders(Object.fromEntries(res.headers.map(([n, v]) => [n, res.headerMap[n.toLowerCase()] ?? v])), this.cfg.redact.headers),
        durationMs: res.durationMs,
        ttfbMs: res.ttfbMs,
        encodedBytes: res.wireBytes,
        remoteAddress: res.remoteAddress,
        ...(kept
          ? { body: kept.text, bodyBytes: res.truncated ? Math.max(res.bodyBytes, kept.bytes) : kept.bytes, bodyTruncated: kept.truncated || res.truncated }
          : { binaryBytes: res.bodyBytes }),
      },
    });
    this.emit(resEv);
    return {
      result: {
        ...base,
        responseEventId: resEv.id,
        ok: status >= 200 && status < 300,
        status,
        statusText: res.statusText,
        httpVersion: res.httpVersion,
        headers: res.headers,
        body: text,
        binary,
        bodyBytes: res.bodyBytes,
        truncated: res.truncated,
        durationMs: res.durationMs,
        ttfbMs: res.ttfbMs,
        remoteAddress: res.remoteAddress,
      },
      res,
    };
  }
}

/** Images, archives and the like are not shown as text. */
function isBinary(body: Buffer, mime: string | null): boolean {
  if (mime && TEXT_MIME.test(mime)) return false;
  const head = body.subarray(0, 2048);
  if (head.includes(0)) return true;
  if (mime && /^(image|audio|video|font)\/|octet-stream|zip|pdf|protobuf/i.test(mime)) return true;
  return false;
}

