import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

/**
 * One HTTP request with node:http/https directly, rather than fetch: the API client needs the
 * raw response headers in order, the time to the first byte, a switch for untrusted
 * certificates, a hard size limit, and redirects returned instead of followed.
 */

export interface RawRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: Buffer;
  timeoutMs: number;
  insecureTls: boolean;
  /** Stop reading the body past this many (decoded) bytes. */
  maxBytes: number;
  signal?: AbortSignal;
}

export interface RawResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: [string, string][];
  /** Lower-cased names; repeated headers joined with ", " (set-cookie with "\n"). */
  headerMap: Record<string, string>;
  /** Decoded (gunzipped…) body, cut at maxBytes. */
  body: Buffer;
  /** Decoded size, as far as it was read. */
  bodyBytes: number;
  /** Bytes on the wire, before decoding. */
  wireBytes: number;
  truncated: boolean;
  ttfbMs: number;
  durationMs: number;
  remoteAddress: string | null;
}

export class RequestFailed extends Error {
  constructor(
    message: string,
    public canceled = false,
    public durationMs = 0,
  ) {
    super(message);
  }
}

/** A person-readable reason for a failed connection. */
export function describeError(err: any, url: URL, timeoutMs: number): string {
  const where = url.host;
  switch (err?.code) {
    case 'ECONNREFUSED': return `Connection refused: nothing is listening on ${where}`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return `Host not found: ${url.hostname}`;
    case 'ECONNRESET': return `The connection to ${where} was reset by the server`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `${where} cannot be reached from this machine`;
    case 'ETIMEDOUT': return `Timed out connecting to ${where}`;
    case 'TIMEOUT': return `No complete response within ${timeoutMs.toLocaleString('en-US')} ms (Settings › API client › Timeout)`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `${where}'s certificate is not trusted (${err.code}). For a dev server with a self-signed certificate, turn on "Allow untrusted certificates" in Settings › API client.`;
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return `TLS handshake with ${where} failed: is it really https? (${err.message})`;
  }
  return err?.message ? String(err.message) : String(err);
}

function decoder(encoding: string) {
  switch (encoding.trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return createGunzip();
    case 'deflate': return createInflate();
    case 'br': return createBrotliDecompress();
    default: return null;
  }
}

export function sendRaw(r: RawRequest): Promise<RawResponse> {
  const url = new URL(r.url);
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const fail = (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const canceled = err?.code === 'ABORTED';
      reject(new RequestFailed(canceled ? 'Canceled' : describeError(err, url, r.timeoutMs), canceled, elapsed()));
    };
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of r.headers) {
      const prev = headers[name];
      headers[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
    }
    const options = {
      method: r.method,
      headers,
      // Only consulted for https: with it off, self-signed dev certificates are accepted.
      rejectUnauthorized: !r.insecureTls,
      // A fresh connection per request, so timings and the remote address are this request's.
      agent: false as const,
    };
    let req;
    try {
      req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options);
    } catch (err) {
      fail(err);
      return;
    }
    const timer = setTimeout(() => {
      const e: any = new Error('timeout');
      e.code = 'TIMEOUT';
      fail(e);
      req.destroy();
    }, r.timeoutMs);
    const onAbort = () => {
      const e: any = new Error('aborted');
      e.code = 'ABORTED';
      fail(e);
      req.destroy();
    };
    if (r.signal?.aborted) return onAbort();
    r.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('error', fail);
    req.on('response', (res: IncomingMessage) => {
      const ttfbMs = elapsed();
      const pairs: [string, string][] = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
      const headerMap: Record<string, string> = {};
      for (const [k, v] of pairs) {
        const key = k.toLowerCase();
        headerMap[key] = key in headerMap ? `${headerMap[key]}${key === 'set-cookie' ? '\n' : ', '}${v}` : v;
      }
      let wireBytes = 0;
      res.on('data', (c: Buffer) => (wireBytes += c.length));
      const dec = headerMap['content-encoding'] ? decoder(headerMap['content-encoding']) : null;
      const stream = dec ? res.pipe(dec) : res;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        r.signal?.removeEventListener('abort', onAbort);
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          httpVersion: res.httpVersion,
          headers: pairs,
          headerMap,
          body: Buffer.concat(chunks),
          bodyBytes: size,
          wireBytes,
          truncated,
          ttfbMs,
          durationMs: elapsed(),
          remoteAddress: res.socket?.remoteAddress ? `${res.socket.remoteAddress}:${res.socket.remotePort}` : null,
        });
      };
      stream.on('data', (c: Buffer) => {
        if (truncated) return;
        const room = r.maxBytes - size;
        size += c.length;
        if (c.length > room) {
          chunks.push(c.subarray(0, Math.max(0, room)));
          truncated = true;
          // Enough has been read; the rest is not wanted.
          finish();
          res.destroy();
        } else chunks.push(c);
      });
      stream.on('end', finish);
      stream.on('error', (err: Error) => {
        // A body that does not decompress: report what arrived rather than nothing.
        if (dec && chunks.length === 0) fail(new Error(`Could not decode the ${headerMap['content-encoding']} body: ${err.message}`));
        else finish();
      });
      res.on('aborted', () => fail(new Error('The server closed the connection before the response was complete')));
    });
    req.end(r.body && r.body.length ? r.body : undefined);
  });
}
