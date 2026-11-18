import { createHash, type Hash } from 'node:crypto';
import { createWriteStream, readFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { ENV_REF, type RegistryConfig } from '../../shared/registry';

/**
 * How the hub talks to a package registry: the login and custom headers, certificates, timeouts
 * and redirects, and errors that say what to fix. With node:http directly, like the API client
 * (src/server/apiclient/http.ts), because a download is streamed to a file and redirects need
 * care: a registry often redirects a download to blob storage on another host, and the login
 * must not follow it there.
 */

export type FailureKind =
  /** A setting is wrong or an environment variable is missing. */
  | 'config'
  /** 401: no login, or the wrong one. */
  | 'auth'
  /** 403. */
  | 'forbidden'
  | 'not-found'
  | 'tls'
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'network'
  /** Any other HTTP status. */
  | 'http'
  /** The answer is not what a registry sends, e.g. a login page instead of a WAR. */
  | 'content'
  | 'checksum'
  | 'canceled';

/** A problem the user can act on. The message never contains a password, token or header value. */
export class RegistryError extends Error {
  constructor(
    message: string,
    public kind: FailureKind,
    /** The HTTP status, when there was one. */
    public status = 0,
    /** What to try, when there is something specific. */
    public hint?: string,
  ) {
    super(message);
  }
}

export interface Transport {
  /** The registry's name, for messages. */
  name: string;
  /** The login and the custom headers. Sent to the host a request starts at, never to one it is redirected to. */
  headers: [string, string][];
  /** Whether any of those headers is a login. */
  hasLogin: boolean;
  insecureTls: boolean;
  /** PEM text of an extra certificate authority. */
  ca: string | null;
  timeoutMs: number;
  /** Text that must never appear in a message, log or API answer. */
  secrets: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Replaces ${env:NAME} with that environment variable. A variable that is not set is an error
 * rather than an empty password: the request would fail with a 401 that says nothing about why.
 */
export function resolveEnv(text: string, what: string, env: Env = process.env, used?: string[]): string {
  return text.replace(ENV_REF, (_m, name: string) => {
    const value = env[name];
    if (value === undefined || value === '') {
      throw new RegistryError(
        `The environment variable ${name}, used for ${what}, is not set where Debug Hub runs.`,
        'config',
        0,
        `Set ${name} and restart Debug Hub, or write the value into the setting.`,
      );
    }
    used?.push(value);
    return value;
  });
}

/** Too short to hide: replacing every "a" in a message would only garble it. */
const MIN_SECRET = 4;

/** Removes secrets, and logins written into URLs, from text shown to the user. */
export function scrub(text: string, secrets: string[]): string {
  let out = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1');
  // Longest first, so a secret that contains another is replaced whole.
  for (const s of [...new Set(secrets)].filter((x) => x.length >= MIN_SECRET).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join('***');
  }
  return out;
}

/** A URL without the login some people write into it (https://user:password@host/). */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^/@\s]+@/, '//');
  }
}

/** "Basic dXNlcjpwYXNz" for a user name and password. */
export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Works out what is sent to a registry from its settings: Authorization for a user name and
 * password or a token, then the custom headers (which win over the login when both set the same
 * header), with ${env:NAME} filled in. Throws a RegistryError naming the setting that is wrong.
 */
export function buildTransport(reg: RegistryConfig, env: Env = process.env, readFile: (path: string) => string = (p) => readFileSync(p, 'utf8')): Transport {
  const secrets: string[] = [];
  const of = (what: string) => `registry ${reg.name}’s ${what}`;
  const secret = (text: string, what: string): string => {
    const value = resolveEnv(text, of(what), env, secrets);
    if (value) secrets.push(value);
    return value;
  };
  const headers = new Map<string, [string, string]>();
  let hasLogin = false;
  if (reg.auth.type === 'basic') {
    const username = resolveEnv(reg.auth.username ?? '', of('user name'), env, secrets);
    const password = secret(reg.auth.password ?? '', 'password');
    const value = basicAuth(username, password);
    secrets.push(value.slice('Basic '.length));
    headers.set('authorization', ['Authorization', value]);
    hasLogin = true;
  } else if (reg.auth.type === 'bearer') {
    const token = secret(reg.auth.token ?? '', 'token');
    if (!token) throw new RegistryError(`Registry ${reg.name} is set to log in with a token, but the token is empty.`, 'config');
    headers.set('authorization', ['Authorization', `Bearer ${token}`]);
    hasLogin = true;
  }
  for (const h of reg.headers ?? []) {
    if (!h.name) continue;
    const value = secret(h.value ?? '', `${h.name} header`);
    if (/[\r\n]/.test(value)) throw new RegistryError(`${of(`${h.name} header`)} contains a line break.`, 'config');
    headers.set(h.name.toLowerCase(), [h.name, value]);
    hasLogin = true;
  }
  // A login written into the URL is sent by Node as Basic; keep it out of messages too.
  try {
    const u = new URL(resolveEnv(reg.url, of('URL'), env, secrets));
    if (u.password) secrets.push(decodeURIComponent(u.password), u.password);
    if (u.username) hasLogin = true;
  } catch (err) {
    if (err instanceof RegistryError) throw err;
    /* no URL, or not one: reported by whoever uses it */
  }
  let ca: string | null = null;
  if (reg.caFile) {
    try {
      ca = readFile(reg.caFile);
    } catch (err: any) {
      throw new RegistryError(`The certificate file of registry ${reg.name} cannot be read: ${reg.caFile} (${err?.code ?? err?.message})`, 'config');
    }
    if (!/-----BEGIN CERTIFICATE-----/.test(ca)) {
      throw new RegistryError(`The certificate file of registry ${reg.name} is not a PEM file (it has no "-----BEGIN CERTIFICATE-----"): ${reg.caFile}`, 'config', 0, 'Export the certificate authority as Base-64 encoded X.509 (.pem, .crt or .cer).');
    }
  }
  return { name: reg.name, headers: [...headers.values()], hasLogin, insecureTls: reg.insecureTls === true, ca, timeoutMs: reg.timeoutMs, secrets };
}

// ── Requests ────────────────────────────────────────────

const MAX_REDIRECTS = 8;
const USER_AGENT = 'debug-hub';

export interface RequestOptions {
  method?: 'GET' | 'HEAD';
  /** Besides the registry's own, e.g. Range. */
  headers?: [string, string][];
  signal?: AbortSignal;
}

interface Opened {
  res: IncomingMessage;
  /** Where the answer came from, after redirects. */
  url: URL;
  /** Set when a redirect left the registry's host, so the login was not sent: the host it went to. */
  leftFor: string | null;
  /** Ends the idle timer and the abort listener. */
  done: () => void;
  /** Restarts the idle timer; call for every chunk read. */
  alive: () => void;
}

const port = (u: URL) => u.port || (u.protocol === 'https:' ? '443' : '80');

/**
 * Whether a URL is on the host the request started at, so the login may be sent there: the same
 * scheme, host name and port, as curl has it. The one exception is the plain upgrade from
 * http://host to https://host on the default ports.
 */
export function sameHost(first: URL, next: URL): boolean {
  if (first.hostname.toLowerCase() !== next.hostname.toLowerCase()) return false;
  if (first.protocol === next.protocol) return port(first) === port(next);
  return first.protocol === 'http:' && next.protocol === 'https:' && port(first) === '80' && port(next) === '443';
}

export function failure(t: Transport, err: any, url: URL): RegistryError {
  if (err instanceof RegistryError) return err;
  const host = url.host;
  const code: string = err?.code ?? '';
  const make = (message: string, kind: FailureKind, hint?: string) => new RegistryError(scrub(message, t.secrets), kind, 0, hint);
  switch (code) {
    case 'ABORTED':
      return make('Canceled', 'canceled');
    case 'TIMEOUT':
      return make(`No answer from ${host} within ${+(t.timeoutMs / 1000).toFixed(1)} s.`, 'timeout', 'If the registry is just slow, raise the timeout in its settings. A registry on the company network may need the VPN.');
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return make(`Host not found: ${url.hostname}.`, 'dns', 'Check the registry’s URL. A registry on the company network may need the VPN.');
    case 'ECONNREFUSED':
      return make(`Connection refused: nothing is listening on ${host}.`, 'refused', 'Check the port in the registry’s URL.');
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return make(`${host} cannot be reached from this machine.`, 'network', 'A registry on the company network may need the VPN.');
    case 'ECONNRESET':
    case 'EPIPE':
      return make(`The connection to ${host} was closed by the other side.`, 'network');
    case 'EPROTO':
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return make(`The secure connection to ${host} could not be set up: is it really https? (${err?.message})`, 'tls');
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return make(`${host}’s certificate is for another host name.`, 'tls', 'Use the host name the certificate was issued for in the registry’s URL.');
    case 'CERT_HAS_EXPIRED':
      return make(`${host}’s certificate has expired.`, 'tls');
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_/.test(code)) {
    return make(
      `${host}’s certificate is not trusted (${code}).`,
      'tls',
      'If the registry uses your company’s own certificate authority, give its certificate file (PEM) in the registry’s settings, or turn on “Allow untrusted certificates” for this registry.',
    );
  }
  return make(`Could not reach ${host}: ${err?.message ?? err}`, 'network');
}

/** Says what an HTTP status means for someone setting up a registry. */
function statusError(t: Transport, o: Opened, asked: URL): RegistryError {
  const status = o.res.statusCode ?? 0;
  const where = displayUrl(o.url.toString());
  const moved = o.leftFor
    ? ` The request was redirected to ${o.leftFor}, and the login is not sent to another host. If the registry really is there, use that address as its URL.`
    : '';
  const make = (message: string, kind: FailureKind, hint?: string) => new RegistryError(scrub(message + moved, t.secrets), kind, status, hint);
  const scheme = /^\s*([A-Za-z]+)/.exec(String(o.res.headers['www-authenticate'] ?? ''))?.[1];
  switch (status) {
    case 401:
      return t.hasLogin
        ? make(`${o.url.host} did not accept the login (401 Unauthorized) for ${where}.`, 'auth', `Check the user name and password, or the token, of registry ${t.name}${scheme ? `; the server asks for ${scheme} authentication` : ''}.`)
        : make(`${o.url.host} wants a login (401 Unauthorized) for ${where}.`, 'auth', `Set a login for registry ${t.name}${scheme ? `; the server asks for ${scheme} authentication` : ''}.`);
    case 403:
      return make(
        `${o.url.host} refused access (403 Forbidden) to ${where}.`,
        'forbidden',
        t.hasLogin ? 'The login was understood, but this account may not read here. Check its permissions for the repository.' : 'Anonymous access is not allowed here: set a login for the registry.',
      );
    case 404:
      return make(`Not found (404): ${where}`, 'not-found');
    case 407:
      return make(`A proxy between Debug Hub and ${asked.host} wants a login (407).`, 'http', 'Debug Hub does not log in to proxies. Reach the registry directly, e.g. over the VPN.');
    case 429:
      return make(`${o.url.host} is limiting requests (429 Too Many Requests).`, 'http', 'Check less often: raise “Check every” in the registry’s settings.');
  }
  if (status >= 300 && status < 400) return make(`${o.url.host} answered ${status} without saying where to go, for ${where}.`, 'http');
  if (status >= 500) return make(`${o.url.host} failed with ${status} ${o.res.statusMessage ?? ''} for ${where}.`.replace(/\s+\./, '.'), 'http', 'The registry itself has a problem; try again later.');
  return make(`${o.url.host} answered ${status} ${o.res.statusMessage ?? ''} for ${where}.`.replace(/\s+\./, '.'), 'http');
}

/**
 * Sends a request and follows redirects until an answer that is not one. The registry's headers
 * go only to the host the request started at. Resolves for any status; `expectOk` turns the
 * others into errors.
 */
function open(t: Transport, target: string, opts: RequestOptions = {}): Promise<Opened> {
  let first: URL;
  try {
    first = new URL(target);
    if (first.protocol !== 'http:' && first.protocol !== 'https:') throw new Error('not http');
  } catch {
    return Promise.reject(new RegistryError(scrub(`Not an http:// or https:// address: ${target}`, t.secrets), 'config'));
  }
  return new Promise<Opened>((resolve, reject) => {
    let settled = false;
    let current: ClientRequest | null = null;
    /** Set once the answer's headers are in: from then on, problems reach the body's reader through it. */
    let response: IncomingMessage | null = null;
    let timer: NodeJS.Timeout | null = null;
    let at = first;
    const done = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: any) => {
      if (settled) return void response?.destroy(err instanceof Error ? err : undefined);
      settled = true;
      done();
      current?.destroy();
      reject(failure(t, err, at));
    };
    const alive = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const e = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        fail(settled ? failure(t, e, at) : e);
      }, t.timeoutMs);
    };
    function onAbort() {
      const e = Object.assign(new Error('aborted'), { code: 'ABORTED' });
      if (settled) done();
      fail(settled ? failure(t, e, at) : e);
    }
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let leftFor: string | null = null;
    const go = (url: URL, hops: number) => {
      at = url;
      const own = sameHost(first, url);
      if (!own) leftFor = url.host;
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: '*/*' };
      if (own) for (const [name, value] of t.headers) headers[name] = value;
      for (const [name, value] of opts.headers ?? []) headers[name] = value;
      // Node sends a login written into the URL as Basic; off the registry's host it is dropped too.
      const safe = new URL(url);
      if (!own) {
        safe.username = '';
        safe.password = '';
      }
      let req: ClientRequest;
      try {
        req = (safe.protocol === 'https:' ? httpsRequest : httpRequest)(safe, {
          method: opts.method ?? 'GET',
          headers,
          agent: false,
          rejectUnauthorized: !t.insecureTls,
          ...(t.ca ? { ca: [...rootCertificates, t.ca] } : {}),
        });
      } catch (err) {
        return fail(err);
      }
      current = req;
      alive();
      req.on('error', fail);
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          if (hops >= MAX_REDIRECTS) return fail(new RegistryError(scrub(`Too many redirects, last to ${location}.`, t.secrets), 'http', status));
          let next: URL;
          try {
            next = new URL(location, url);
            if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('not http');
          } catch {
            return fail(new RegistryError(scrub(`${url.host} redirected to something that is not a web address: ${location}`, t.secrets), 'http', status));
          }
          // The login written into the first URL stays with the first host.
          if (sameHost(first, next) && !next.username) {
            next.username = first.username;
            next.password = first.password;
          }
          return go(next, hops + 1);
        }
        if (settled) return void res.destroy();
        settled = true;
        response = res;
        alive();
        resolve({ res, url, leftFor: sameHost(first, url) ? null : leftFor, done, alive });
      });
      req.end();
    };
    go(first, 0);
  });
}

export interface Answer {
  status: number;
  /** Lower-cased names. */
  headers: Record<string, string>;
  /** Where the answer came from, after redirects, without any login in it. */
  url: string;
  body: Buffer;
}

const headerMap = (res: IncomingMessage): Record<string, string> =>
  Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));

/**
 * One request with its answer read into memory, for metadata. `maxBytes` guards against a
 * registry (or a login page, or a WAR where metadata was expected) sending far more than that.
 * A status other than 2xx is an error unless `allow` lists it.
 */
export async function fetchAnswer(
  t: Transport,
  url: string,
  opts: RequestOptions & { maxBytes?: number; allow?: number[]; /** Do not read the body: only the headers matter. */ headersOnly?: boolean } = {},
): Promise<Answer> {
  const o = await open(t, url, opts);
  const status = o.res.statusCode ?? 0;
  const ok = (status >= 200 && status < 300) || (opts.allow ?? []).includes(status);
  if (!ok || opts.headersOnly || opts.method === 'HEAD') {
    o.done();
    o.res.destroy();
    if (!ok) throw statusError(t, o, new URL(url));
    return { status, headers: headerMap(o.res), url: displayUrl(o.url.toString()), body: Buffer.alloc(0) };
  }
  const max = opts.maxBytes ?? 8 * 1024 * 1024;
  return new Promise<Answer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const end = (err?: any) => {
      o.done();
      if (err) reject(failure(t, err, o.url));
      else resolve({ status, headers: headerMap(o.res), url: displayUrl(o.url.toString()), body: Buffer.concat(chunks) });
    };
    o.res.on('data', (c: Buffer) => {
      o.alive();
      size += c.length;
      if (size > max) {
        o.res.destroy();
        end(new RegistryError(scrub(`${displayUrl(o.url.toString())} sent more than ${Math.round(max / 1024 / 1024)} MB where a short answer was expected.`, t.secrets), 'content'));
      } else chunks.push(c);
    });
    let complete = false;
    o.res.on('end', () => {
      complete = true;
      end();
    });
    o.res.on('error', end);
    // After 'error' when there is one (a timeout, a cancel), so that is what gets reported.
    o.res.on('close', () => {
      if (!complete) end(Object.assign(new Error('closed early'), { code: 'ECONNRESET' }));
    });
  });
}

/** The answer as text. */
export async function fetchText(t: Transport, url: string, opts: Parameters<typeof fetchAnswer>[2] = {}): Promise<{ text: string; answer: Answer }> {
  const answer = await fetchAnswer(t, url, opts);
  return { text: answer.body.toString('utf8'), answer };
}

export type HashName = 'sha512' | 'sha256' | 'sha1' | 'md5';

export interface Downloaded {
  bytes: number;
  headers: Record<string, string>;
  url: string;
  /** Hex digests of what was written, for the algorithms asked for. */
  digests: Partial<Record<HashName, string>>;
}

/**
 * Streams a URL into a file, hashing it on the way. The idle timeout applies between chunks, not
 * to the whole download. A body shorter than its Content-Length is an error, not a short file.
 */
export async function downloadTo(
  t: Transport,
  url: string,
  dest: string,
  opts: { signal?: AbortSignal; hashes?: HashName[]; onProgress?: (received: number, total: number | null) => void } = {},
): Promise<Downloaded> {
  const o = await open(t, url, { signal: opts.signal });
  const status = o.res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    o.done();
    o.res.destroy();
    throw statusError(t, o, new URL(url));
  }
  const headers = headerMap(o.res);
  const length = Number(headers['content-length']);
  const total = Number.isFinite(length) && length >= 0 && headers['content-length'] !== undefined ? length : null;
  const hashes = new Map<HashName, Hash>((opts.hashes ?? []).map((name) => [name, createHash(name)]));
  return new Promise<Downloaded>((resolve, reject) => {
    const out = createWriteStream(dest);
    let received = 0;
    let finished = false;
    const end = (err?: any) => {
      if (finished) return;
      finished = true;
      o.done();
      if (err) {
        o.res.destroy();
        out.destroy();
        reject(failure(t, err, o.url));
      } else {
        resolve({
          bytes: received,
          headers,
          url: displayUrl(o.url.toString()),
          digests: Object.fromEntries([...hashes].map(([name, hash]) => [name, hash.digest('hex')])),
        });
      }
    };
    opts.onProgress?.(0, total);
    o.res.on('data', (c: Buffer) => {
      o.alive();
      received += c.length;
      for (const hash of hashes.values()) hash.update(c);
      // Wait for the disk when it is slower than the network.
      if (!out.write(c)) {
        o.res.pause();
        out.once('drain', () => o.res.resume());
      }
      opts.onProgress?.(received, total);
    });
    let complete = false;
    o.res.on('error', end);
    o.res.on('close', () => {
      if (!complete) end(Object.assign(new Error('closed early'), { code: 'ECONNRESET' }));
    });
    o.res.on('end', () => {
      complete = true;
      if (total !== null && received !== total) {
        return end(new RegistryError(`The download stopped early: ${received.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} bytes arrived.`, 'network'));
      }
      out.end(() => end());
    });
    out.on('error', (err: any) => {
      end(new RegistryError(err?.code === 'ENOSPC' ? 'Not enough disk space for the download.' : `Could not write the download: ${err?.message ?? err}`, 'network'));
    });
  });
}
