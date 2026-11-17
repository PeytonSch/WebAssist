// The API client's model, shared by the hub (which parses specs and sends requests) and the UI
// (which builds requests). Everything here is plain data and pure functions, so it can be unit
// tested in node and sent over JSON.

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type ParamIn = 'path' | 'query' | 'header' | 'cookie';

/** A JSON Schema (OpenAPI flavour) as found in the spec. Local `$ref`s are kept as they are. */
export type Schema = Record<string, any>;

export interface ApiParam {
  name: string;
  in: ParamIn;
  required: boolean;
  description: string;
  deprecated: boolean;
  schema: Schema | null;
  /** From the parameter's example, its first named example, or its schema's. */
  example?: unknown;
}

export interface ApiContent {
  /** e.g. application/json */
  type: string;
  schema: Schema | null;
  example?: unknown;
}

export interface ApiBody {
  required: boolean;
  description: string;
  contents: ApiContent[];
}

export interface ApiResponse {
  /** "200", "4XX" or "default". */
  status: string;
  description: string;
  contents: ApiContent[];
}

export interface ApiOperation {
  /** Unique within the spec: the operationId, or "METHOD /path" when there is none. */
  key: string;
  operationId: string | null;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  params: ApiParam[];
  body: ApiBody | null;
  responses: ApiResponse[];
  /** Names of the security schemes that apply, any of which will do. */
  security: string[];
}

export interface ApiSecurityScheme {
  name: string;
  /** apiKey, http, oauth2, openIdConnect, basic (Swagger 2). */
  type: string;
  /** For http: bearer, basic… */
  scheme?: string;
  bearerFormat?: string;
  /** For apiKey: where the key goes and under which name. */
  in?: string;
  paramName?: string;
  description: string;
}

export interface ApiSpec {
  /** The name given in Settings. */
  name: string;
  /** The URL or file it was loaded from. */
  source: string;
  format: 'openapi-3.0' | 'openapi-3.1' | 'swagger-2.0';
  title: string;
  version: string;
  description: string;
  /** Absolute base URLs, best first. Empty when the spec names none and was read from a file. */
  servers: { url: string; description: string }[];
  operations: ApiOperation[];
  /** Schemas that `$ref`s point to, by the reference itself ("#/components/schemas/Order"). */
  schemas: Record<string, Schema>;
  securitySchemes: ApiSecurityScheme[];
  /** Things that were skipped or could not be resolved, for the spec's status line. */
  warnings: string[];
}

/** One configured spec as listed by the hub, loaded or not. */
export interface SpecStatus {
  name: string;
  url: string;
  state: 'not-loaded' | 'loading' | 'loaded' | 'error';
  error: string | null;
  loadedAt: string | null;
  title: string | null;
  operations: number;
}

// ── Requests ─────────────────────────────────────────────

/** A row of the params or headers table. Disabled rows are kept but not sent. */
export interface KeyValue {
  name: string;
  value: string;
  enabled: boolean;
}

export interface ParamRow extends KeyValue {
  in: ParamIn;
}

/** What the API screen's request builder holds; also what a saved request stores. */
export interface RequestDraft {
  method: string;
  /** May contain {{variables}} (e.g. {{baseUrl}}) and {pathParams}. */
  url: string;
  params: ParamRow[];
  headers: KeyValue[];
  body: string;
  /** Content-Type of the body; empty for none. */
  contentType: string;
  /** Default headers from Settings that are not sent with this request, by name. */
  disabledDefaults: string[];
}

/** Which spec operation a request was made from, for its docs and parameter hints. */
export interface OperationLink {
  spec: string;
  operationId: string | null;
  method: string;
  path: string;
}

export interface SavedRequest extends RequestDraft {
  id: string;
  name: string;
  description: string;
  /** Free-text group, e.g. "Orders" or "Smoke tests/Orders". Empty: no folder. */
  folder: string;
  operation: OperationLink | null;
  created: string;
  updated: string;
}

export interface Variable {
  name: string;
  value: string;
}

export interface Catalog {
  variables: Variable[];
  requests: SavedRequest[];
}

/** POST /api/client/send */
export interface SendInput {
  method: string;
  url: string;
  headers: { name: string; value: string }[];
  body?: string;
  /** Default headers from Settings to leave out, by name (case-insensitive). */
  disabledDefaults?: string[];
  /** Follow 3xx responses (up to 5). Off by default: the 3xx itself is returned. */
  followRedirects?: boolean;
  /** Shown on the timeline event, e.g. the saved request's name. */
  label?: string;
}

export interface SendResult {
  /** Timeline events: the request and its response. */
  requestEventId: string;
  responseEventId: string;
  requestId: string | null;
  url: string;
  method: string;
  /** Headers as actually sent, in order. */
  sentHeaders: [string, string][];
  ok: boolean;
  status: number | null;
  statusText: string;
  httpVersion: string | null;
  headers: [string, string][];
  body: string;
  /** The body was binary and is not shown. */
  binary: boolean;
  /** Size of the (decoded) body; the shown body may be cut at the UI limit. */
  bodyBytes: number;
  truncated: boolean;
  durationMs: number;
  /** Time to the response headers. */
  ttfbMs: number | null;
  /** Redirects followed, in order, when following was asked for. */
  redirects: { status: number; url: string }[];
  /** Connection errors, timeouts and cancels. */
  error: string | null;
  canceled: boolean;
  remoteAddress: string | null;
}

// ── Variables ────────────────────────────────────────────

const VAR = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;
export const VARIABLE_NAME = /^[A-Za-z_][\w.-]*$/;

/**
 * Replaces {{name}} placeholders. Names missing from `vars` stay as they are and are listed in
 * `missing`, so the UI can refuse to send rather than send a literal "{{token}}".
 */
export function substitute(text: string, vars: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(VAR, (m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (!missing.includes(name)) missing.push(name);
    return m;
  });
  return { text: out, missing };
}

// ── URLs ─────────────────────────────────────────────────

/** Joins a base URL and a path without doubling or dropping the slash between them. */
export function joinUrl(base: string, path: string): string {
  if (!base) return path;
  if (!path) return base;
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/**
 * The final URL of a request: path parameters substituted into {name} (encoded), query
 * parameters appended (encoded). Disabled rows and empty optional query values are left out.
 * Header and cookie rows are not part of the URL; see requestHeaders.
 */
export function buildUrl(url: string, params: ParamRow[]): { url: string; missing: string[] } {
  const missing: string[] = [];
  const path = new Map(params.filter((p) => p.in === 'path' && p.enabled).map((p) => [p.name, p.value]));
  // Single braces only: {{variables}} are substituted before this, and are not path params.
  let out = url.replace(/(?<!\{)\{([^{}/?#]+)\}(?!\})/g, (m, name: string) => {
    const v = path.get(name);
    if (v === undefined || v === '') {
      if (!missing.includes(name)) missing.push(name);
      return m;
    }
    return encodeURIComponent(v);
  });
  const query = params
    .filter((p) => p.in === 'query' && p.enabled && p.name)
    .map((p) => `${encodeURIComponent(p.name)}${p.value === '' ? '' : '=' + encodeURIComponent(p.value)}`);
  if (query.length) {
    const hash = out.indexOf('#');
    const frag = hash === -1 ? '' : out.slice(hash);
    if (hash !== -1) out = out.slice(0, hash);
    out += (out.includes('?') ? (/[?&]$/.test(out) ? '' : '&') : '?') + query.join('&') + frag;
  }
  return { url: out, missing };
}

/** Header and cookie parameters as headers. Cookies are joined into one Cookie header. */
export function paramHeaders(params: ParamRow[]): { name: string; value: string }[] {
  const out = params.filter((p) => p.in === 'header' && p.enabled && p.name).map((p) => ({ name: p.name, value: p.value }));
  const cookies = params.filter((p) => p.in === 'cookie' && p.enabled && p.name).map((p) => `${p.name}=${encodeURIComponent(p.value)}`);
  if (cookies.length) out.push({ name: 'Cookie', value: cookies.join('; ') });
  return out;
}

/** application/x-www-form-urlencoded from a JSON object body, for form operations. */
export function formEncode(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x] as const) : [[k, v] as const]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''))}`)
    .join('&');
}

// ── Schemas ──────────────────────────────────────────────

const MAX_DEPTH = 8;
const MAX_PROPS = 60;

/**
 * Follows `$ref`s through the spec's schema table. Returns null for a reference that is not
 * there (external files) or that only leads back to itself.
 */
export function deref(schema: Schema | null | undefined, schemas: Record<string, Schema>): Schema | null {
  let s = schema ?? null;
  const seen = new Set<string>();
  while (s && typeof s.$ref === 'string') {
    if (seen.has(s.$ref)) return null;
    seen.add(s.$ref);
    s = schemas[s.$ref] ?? null;
  }
  return s;
}

/** A schema's type, allowing for 3.1's ["string", "null"] and for type left out. */
export function schemaType(s: Schema): string | undefined {
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') ?? s.type[0] : s.type;
  if (t) return t;
  if (s.properties || s.additionalProperties) return 'object';
  if (s.items) return 'array';
  return undefined;
}

/** The first example a schema carries itself: example, examples (3.1), default, const, enum. */
function ownExample(s: Schema): { value: unknown } | null {
  if (s.example !== undefined) return { value: s.example };
  if (Array.isArray(s.examples) && s.examples.length) return { value: s.examples[0] };
  if (s.default !== undefined) return { value: s.default };
  if (s.const !== undefined) return { value: s.const };
  if (Array.isArray(s.enum) && s.enum.length) return { value: s.enum.find((x: unknown) => x !== null) ?? s.enum[0] };
  return null;
}

const STRING_FORMATS: Record<string, string> = {
  'date-time': '2026-01-01T12:00:00Z',
  date: '2026-01-01',
  time: '12:00:00',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  email: 'user@example.com',
  uri: 'https://example.com',
  url: 'https://example.com',
  hostname: 'example.com',
  ipv4: '192.168.0.1',
  ipv6: '::1',
  byte: 'ZXhhbXBsZQ==',
  binary: '',
  password: '',
};

export interface ExampleOptions {
  /** Leave out readOnly properties (request bodies) or writeOnly ones (responses). */
  for?: 'request' | 'response';
}

/**
 * An example value for a schema, the way Swagger UI makes one: the schema's own example first,
 * else built from its type. allOf parts are merged; for oneOf and anyOf the first choice is used.
 * Recursive schemas stop where they would repeat, and everything stops at a depth limit.
 */
export function exampleFromSchema(schema: Schema | null | undefined, schemas: Record<string, Schema>, opts: ExampleOptions = {}): unknown {
  return build(schema, [], 0);

  function build(raw: Schema | null | undefined, stack: string[], depth: number): unknown {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.$ref === 'string') {
      // A schema that contains itself: stop here instead of looping.
      if (stack.includes(raw.$ref)) return undefined;
      const target = schemas[raw.$ref];
      if (!target) return null;
      return build(target, [...stack, raw.$ref], depth);
    }
    const s = raw;
    const own = ownExample(s);
    if (own) return own.value;
    if (depth > MAX_DEPTH) return undefined;

    if (Array.isArray(s.allOf) && s.allOf.length) {
      const parts = s.allOf.map((p: Schema) => build(p, stack, depth));
      const rest: Schema = { ...s, allOf: undefined };
      if (rest.properties || rest.type === 'object') parts.push(build(rest, stack, depth));
      const objects = parts.filter((p: unknown) => p && typeof p === 'object' && !Array.isArray(p));
      if (objects.length) return Object.assign({}, ...objects);
      return parts.find((p: unknown) => p !== undefined) ?? null;
    }
    const choice = (Array.isArray(s.oneOf) && s.oneOf[0]) || (Array.isArray(s.anyOf) && s.anyOf.find((x: Schema) => deref(x, schemas)?.type !== 'null'));
    if (choice) {
      const base = s.properties ? build({ ...s, oneOf: undefined, anyOf: undefined }, stack, depth) : undefined;
      const picked = build(choice, stack, depth);
      return base && typeof base === 'object' && picked && typeof picked === 'object' ? { ...base, ...picked } : picked;
    }

    switch (schemaType(s)) {
      case 'object': {
        const out: Record<string, unknown> = {};
        const props = Object.entries<Schema>(s.properties ?? {}).slice(0, MAX_PROPS);
        for (const [name, prop] of props) {
          const p = deref(prop, schemas) ?? prop;
          if (opts.for === 'request' && p?.readOnly) continue;
          if (opts.for === 'response' && p?.writeOnly) continue;
          const v = build(prop, stack, depth + 1);
          if (v !== undefined) out[name] = v;
        }
        if (!props.length && s.additionalProperties && typeof s.additionalProperties === 'object') {
          const v = build(s.additionalProperties, stack, depth + 1);
          if (v !== undefined) out.key = v;
        }
        return out;
      }
      case 'array': {
        const item = build(s.items, stack, depth + 1);
        return item === undefined ? [] : [item];
      }
      case 'integer':
      case 'number':
        return typeof s.minimum === 'number' ? s.minimum : typeof s.exclusiveMinimum === 'number' ? s.exclusiveMinimum + 1 : 0;
      case 'boolean':
        return true;
      case 'null':
        return null;
      case 'string':
        return STRING_FORMATS[s.format] ?? 'string';
      default:
        return null;
    }
  }
}

// ── Putting a request together ───────────────────────────

/**
 * The request a draft stands for, ready for POST /api/client/send: {{variables}} filled in
 * everywhere, path and query parameters put into the URL, header and cookie parameters and the
 * content type added to the headers, and a JSON object body form-encoded when the content type
 * asks for that. `problems` lists what stops it from being sent (unknown variables, empty path
 * parameters, an incomplete URL).
 */
export function resolveDraft(d: RequestDraft, vars: Record<string, string>): { input: SendInput; problems: string[] } {
  const missing = new Set<string>();
  const sub = (s: string) => {
    const r = substitute(s, vars);
    r.missing.forEach((m) => missing.add(m));
    return r.text;
  };
  const params = d.params.filter((p) => p.enabled).map((p) => ({ ...p, name: sub(p.name), value: sub(p.value) }));
  const built = buildUrl(sub(d.url.trim()), params);
  const headers = [
    ...d.headers.filter((h) => h.enabled && h.name.trim()).map((h) => ({ name: sub(h.name.trim()), value: sub(h.value) })),
    ...paramHeaders(params),
  ];
  let body = sub(d.body);
  const type = d.contentType.trim();
  if (body && /x-www-form-urlencoded/i.test(type) && /^\s*\{/.test(body)) {
    try {
      body = formEncode(JSON.parse(body));
    } catch {
      /* not JSON after all: sent as written */
    }
  }
  if (body && type && !headers.some((h) => h.name.toLowerCase() === 'content-type')) headers.push({ name: 'Content-Type', value: type });

  const problems: string[] = [];
  for (const m of missing) {
    problems.push(
      m === 'baseUrl'
        ? '{{baseUrl}} has no value: pick a spec that names its server, or set a base URL in Settings › API client.'
        : `{{${m}}} has no value. Add it under Variables.`,
    );
  }
  for (const m of built.missing) problems.push(`Path parameter {${m}} has no value.`);
  if (!missing.size && !/^https?:\/\/[^/\s]/i.test(built.url)) problems.push('The URL must start with http:// or https://');
  return {
    input: { method: d.method.trim().toUpperCase() || 'GET', url: built.url, headers, body, disabledDefaults: d.disabledDefaults },
    problems,
  };
}

/** A short description of a schema's type for the params table, e.g. "integer · int64", "string[]". */
export function typeHint(schema: Schema | null | undefined, schemas: Record<string, Schema>): string {
  const s = deref(schema, schemas);
  if (!s) return '';
  const t = schemaType(s);
  if (t === 'array') {
    const inner = typeHint(s.items, schemas);
    return inner ? `${inner.split(' · ')[0]}[]` : 'array';
  }
  const parts = [t ?? (s.oneOf || s.anyOf ? 'one of' : 'any')];
  if (s.format) parts.push(s.format);
  if (typeof s.minimum === 'number' || typeof s.maximum === 'number') parts.push(`${s.minimum ?? ''}…${s.maximum ?? ''}`);
  if (s.pattern) parts.push(`/${s.pattern}/`);
  return parts.join(' · ');
}

/** The allowed values of a parameter, for a select in the params table. */
export function enumOf(schema: Schema | null | undefined, schemas: Record<string, Schema>): string[] | null {
  let s = deref(schema, schemas);
  if (s && schemaType(s) === 'array') s = deref(s.items, schemas);
  if (s && schemaType(s) === 'boolean' && !s.enum) return ['true', 'false'];
  return s && Array.isArray(s.enum) ? s.enum.filter((x: unknown) => x !== null).map((x: unknown) => String(x)) : null;
}

/** A starting value for a parameter: its example, else its schema's, else empty. */
export function paramValue(p: ApiParam, schemas: Record<string, Schema>): string {
  const v = p.example !== undefined ? p.example : ownExample(deref(p.schema, schemas) ?? {})?.value;
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
