/**
 * Short names for request paths, so a timeline full of /user/id/12345, /user/id/67890 and
 * /orders/42/items?page=2 reads as "user/id" and "orders/{id}/items" at a glance.
 *
 * IDs are recognised by their shape (numbers, UUIDs, long hex strings, dates, long random
 * tokens). When an OpenAPI spec is loaded, its path templates win: they are exact, and they
 * also catch IDs that look like words (/users/john against /users/{username}).
 */

export interface RouteTemplate {
  /** Full path template, e.g. /api/orders/{id}: the spec's server path plus the operation path. */
  path: string;
  /** Upper case; empty matches any method. */
  method: string;
  /** Shown in the tooltip, e.g. "Get one order · Demo shop". */
  title: string;
}

export interface Route {
  /** e.g. "user/id", "orders/{id}/items". */
  label: string;
  /** The path with IDs as {name}: /orders/{id}/items. */
  template: string;
  /** The values that stood in for the {name}s, in order. */
  params: string[];
  /** The query string with its "?", or "". */
  query: string;
  /** Set when a spec template matched. */
  title: string | null;
}

const NUMBER = /^[+-]?\d+(?:[.,_]\d+)*$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
// Mongo ObjectIds, hashes, hex keys. At least one digit, so words like "deadbeefcafe" stay words.
const HEX = /^(?=.*\d)[0-9a-f]{12,}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::\d{2}){0,2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
// ULIDs, base64 / base64url keys, JWT-like and other generated tokens: long, mixed letters and digits.
const TOKEN = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-=~.]{16,}$/;

/** True when a path segment looks like an identifier rather than a resource name. */
export function isIdSegment(segment: string): boolean {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    /* keep it as written */
  }
  if (!s) return false;
  if (s.includes('@')) return true;
  return NUMBER.test(s) || UUID.test(s) || HEX.test(s) || DATE.test(s) || TOKEN.test(s);
}

/** The path and query of a URL or path, without the origin or the fragment. */
export function splitUrl(urlOrPath: string): { path: string; query: string } {
  let s = urlOrPath.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(s);
  if (scheme) s = s.slice(scheme[0].length);
  const hash = s.indexOf('#');
  if (hash !== -1) s = s.slice(0, hash);
  const q = s.indexOf('?');
  const path = q === -1 ? s : s.slice(0, q);
  const query = q === -1 ? '' : s.slice(q);
  return { path: path || '/', query: query === '?' ? '' : query };
}

const segmentsOf = (path: string) => path.split('/').filter(Boolean);

/** "user/id/{id}" → "user/id": trailing IDs say nothing about which endpoint it is. */
function labelOf(templateSegments: string[]): string {
  const segs = [...templateSegments];
  while (segs.length > 1 && /^\{[^}]*\}$/.test(segs[segs.length - 1])) segs.pop();
  return segs.join('/') || '/';
}

interface Compiled {
  t: RouteTemplate;
  segs: string[];
  literals: number;
}

/** Templates prepared for matching; build once per set of specs. */
export class RouteMatcher {
  private compiled: Compiled[];

  constructor(templates: RouteTemplate[] = []) {
    this.compiled = templates
      .map((t) => {
        const segs = segmentsOf(t.path);
        return { t, segs, literals: segs.filter((s) => !/^\{[^}]*\}$/.test(s)).length };
      })
      .filter((c) => c.segs.length > 0)
      // Most specific first: more fixed segments, then longer.
      .sort((a, b) => b.literals - a.literals || b.segs.length - a.segs.length);
  }

  get size(): number {
    return this.compiled.length;
  }

  /** The route of a request. `method` narrows spec matches when given. */
  route(urlOrPath: string, method?: string | null): Route {
    const { path, query } = splitUrl(urlOrPath);
    const segs = segmentsOf(path);
    const m = (method ?? '').toUpperCase();
    // Exact method first, then any method: the label is the same either way, only the title differs.
    const hit = this.match(segs, m, true) ?? this.match(segs, m, false);
    if (hit) return { ...hit, query };

    const params: string[] = [];
    const tpl = segs.map((s) => {
      if (!isIdSegment(s)) return s;
      params.push(safeDecode(s));
      return '{id}';
    });
    return { label: labelOf(tpl), template: `/${tpl.join('/')}`, params, query, title: null };
  }

  private match(segs: string[], method: string, sameMethod: boolean): Route | null {
    for (const c of this.compiled) {
      if (sameMethod && c.t.method && method && c.t.method !== method) continue;
      if (c.segs.length !== segs.length) continue;
      const params: string[] = [];
      let ok = true;
      for (let i = 0; i < segs.length && ok; i++) {
        const want = c.segs[i];
        if (/^\{[^}]*\}$/.test(want)) params.push(safeDecode(segs[i]));
        else ok = want === segs[i] || want.toLowerCase() === safeDecode(segs[i]).toLowerCase();
      }
      if (!ok) continue;
      return { label: labelOf(c.segs), template: `/${c.segs.join('/')}`, params, query: '', title: c.t.title || null };
    }
    return null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * The path a spec's server puts in front of its operations: "/api" for
 * http://localhost:8080/api or a relative "/api", "" for a bare host.
 */
export function serverPath(serverUrl: string): string {
  const { path } = splitUrl(serverUrl.replace(/\{[^}]*\}/g, 'x'));
  const p = path.replace(/\/+$/, '');
  return p === '/' ? '' : p;
}
