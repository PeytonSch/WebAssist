import type { KeyValue, RequestDraft } from './apiclient';

/**
 * Turns a request recorded on the timeline (a browser request, or one the API client sent) into
 * a request the API screen can send again or save. What was recorded is not always what can be
 * replayed: headers the browser or Node manage themselves are dropped, values that were redacted
 * before recording become {{variables}} to fill in, and a body cut off at capture is flagged.
 */

/** The value normalize.ts writes in place of a redacted header. */
export const REDACTED = '[redacted]';

/**
 * Headers not worth sending again: set by Node or the connection (host, length, keep-alive),
 * HTTP/2 pseudo-headers, the browser's fetch metadata and client hints, compression (the API
 * screen wants readable bodies), and the API client's own defaults.
 */
const DROP = new Set([
  'host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-connection', 'accept-encoding', 'priority', 'purpose', 'sec-purpose', 'upgrade-insecure-requests',
  'expect', 'pragma', 'cache-control',
]);
const DROP_PREFIX = [':', 'sec-ch-', 'sec-fetch-'];

export interface ReplayOptions {
  /** The correlation header: the recorded ID is dropped, so a fresh one is added. */
  requestIdHeader: string;
  /** Base URLs to write as {{baseUrl}}: the one {{baseUrl}} currently stands for first. */
  baseUrls: string[];
  /** Default headers from Settings: a redacted header that has a default is left to it. */
  defaultHeaders: string[];
  /** Variables already defined, so only the missing ones are reported. */
  variables: string[];
}

export interface Replay {
  draft: RequestDraft;
  /** A name to suggest when saving: "POST /api/orders". */
  name: string;
  /** Variables the request uses that have no value yet (redacted headers). */
  needs: { variable: string; header: string }[];
  /** Redacted headers left to the default header from Settings. */
  fromDefaults: string[];
  /** Things to tell the user before sending. */
  warnings: string[];
  /** Reasons the request cannot be sent again as it is (a cut-off body). */
  blocking: string[];
}

/** A header name as a variable name: {{authorization}}, {{x-api-key}}. */
export function variableFor(header: string): string {
  const v = header.toLowerCase().replace(/[^\w.-]/g, '_');
  return /^[A-Za-z_]/.test(v) ? v : `_${v}`;
}

/** The URL with a known base replaced by {{baseUrl}}, so a saved request follows a changed base. */
export function templateUrl(url: string, baseUrls: string[]): string {
  for (const raw of baseUrls) {
    const base = raw.replace(/\/+$/, '');
    if (!base) continue;
    if (url === base) return '{{baseUrl}}';
    const next = url.charAt(base.length);
    if (url.startsWith(base) && (next === '/' || next === '?' || next === '#')) return '{{baseUrl}}' + url.slice(base.length);
  }
  return url;
}

export function replayFromEvent(data: Record<string, any>, opts: ReplayOptions): Replay {
  const method = String(data.method ?? 'GET').toUpperCase();
  const url = String(data.url ?? '');
  const warnings: string[] = [];
  const blocking: string[] = [];
  const needs: Replay['needs'] = [];
  const fromDefaults: string[] = [];
  const defaults = new Set(opts.defaultHeaders.map((n) => n.toLowerCase()));
  const known = new Set(opts.variables);
  const rid = opts.requestIdHeader.toLowerCase();

  let contentType = '';
  const headers: KeyValue[] = [];
  const recorded: Record<string, unknown> = data.headers && typeof data.headers === 'object' ? data.headers : {};
  for (const [name, raw] of Object.entries(recorded)) {
    const lower = name.toLowerCase();
    const value = String(raw ?? '');
    if (DROP.has(lower) || DROP_PREFIX.some((p) => lower.startsWith(p)) || lower === rid) continue;
    // The API client's own User-Agent is added again anyway.
    if (lower === 'user-agent' && value === 'DebugHub-API-Client') continue;
    if (lower === 'content-type') {
      contentType = value;
      continue;
    }
    if (value === REDACTED) {
      if (defaults.has(lower)) {
        fromDefaults.push(name);
        continue;
      }
      const variable = variableFor(name);
      headers.push({ name, value: `{{${variable}}}`, enabled: true });
      if (!known.has(variable)) needs.push({ variable, header: name });
      continue;
    }
    headers.push({ name, value, enabled: true });
  }

  const body = typeof data.body === 'string' ? data.body : '';
  if (data.bodyTruncated) {
    const msg = `The request body was cut off when it was recorded (${data.bodyBytes ?? '?'} bytes, more than the body size limit), so it cannot be sent again as it was.`;
    warnings.push(msg);
    blocking.push(msg);
  }
  if (needs.length) {
    warnings.push(
      `${needs.map((n) => n.header).join(', ')} ${needs.length === 1 ? 'was' : 'were'} redacted when recorded. Give ${needs.map((n) => `{{${n.variable}}}`).join(', ')} a value in Variables, or set ${needs.length === 1 ? 'the header' : 'these headers'} under Default headers in Settings.`,
    );
  }
  if (fromDefaults.length) warnings.push(`${fromDefaults.join(', ')} ${fromDefaults.length === 1 ? 'was' : 'were'} redacted when recorded; the default from Settings is sent instead.`);

  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* not a full URL */
  }
  return {
    draft: {
      method,
      url: templateUrl(url, opts.baseUrls),
      params: [],
      headers,
      body,
      contentType,
      disabledDefaults: [],
    },
    name: `${method} ${path}`.slice(0, 200),
    needs,
    fromDefaults,
    warnings,
    blocking,
  };
}
