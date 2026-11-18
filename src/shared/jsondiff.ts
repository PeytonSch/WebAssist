// Comparing two JSON documents, for the JSON compare view (src/ui/jsondiff.ts). Pure: no DOM.
//
// Two answers: which values differ, by path ("$.items[2].price: 10 → 12"), and the documents
// pretty-printed the same way with each value's line, so a text diff of the lines can be shown
// side by side and a path can be found in it.

import { diffSeq } from './diff';

/** Pretty-printed JSON and the line each value starts on, by path. */
export interface PrettyJson {
  lines: string[];
  lineOf: Map<string, number>;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** A path step as it is written: .name, ["odd name"] or [3]. */
export function pathStep(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`;
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keysOf = (o: Record<string, unknown>, sort: boolean) => (sort ? Object.keys(o).sort() : Object.keys(o));

/** Like JSON.stringify(value, null, 2), keys optionally sorted, noting where each value starts. */
export function prettyJson(value: unknown, opts: { sortKeys?: boolean } = {}): PrettyJson {
  const lines: string[] = [];
  const lineOf = new Map<string, number>();
  const sort = !!opts.sortKeys;
  const write = (v: unknown, path: string, indent: string, prefix: string, suffix: string) => {
    lineOf.set(path, lines.length);
    if (Array.isArray(v)) {
      if (!v.length) return void lines.push(`${indent}${prefix}[]${suffix}`);
      lines.push(`${indent}${prefix}[`);
      v.forEach((x, i) => write(x, path + pathStep(i), indent + '  ', '', i < v.length - 1 ? ',' : ''));
      lines.push(`${indent}]${suffix}`);
    } else if (isObject(v)) {
      const keys = keysOf(v, sort);
      if (!keys.length) return void lines.push(`${indent}${prefix}{}${suffix}`);
      lines.push(`${indent}${prefix}{`);
      keys.forEach((k, i) => write(v[k], path + pathStep(k), indent + '  ', `${JSON.stringify(k)}: `, i < keys.length - 1 ? ',' : ''));
      lines.push(`${indent}}${suffix}`);
    } else {
      lines.push(`${indent}${prefix}${JSON.stringify(v) ?? 'null'}${suffix}`);
    }
  };
  write(value, '$', '', '', '');
  return { lines, lineOf };
}

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface JsonChange {
  path: string;
  kind: ChangeKind;
  /** The value before and after, shortened, as JSON. */
  before?: string;
  after?: string;
}

/** A value as short JSON, for the list of changes. */
export function brief(v: unknown, max = 60): string {
  let s: string;
  if (Array.isArray(v)) s = v.length ? `[… ${v.length} item${v.length === 1 ? '' : 's'}]` : '[]';
  else if (isObject(v)) {
    const n = Object.keys(v).length;
    s = n ? `{… ${n} key${n === 1 ? '' : 's'}}` : '{}';
  } else s = JSON.stringify(v) ?? 'null';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const key = (v: unknown) => JSON.stringify(v);

/**
 * The values that differ between two documents, in document order. Arrays are matched up
 * element by element where elements are equal (so one inserted at the front is one addition,
 * not every element changed), and pairwise in between.
 */
export function jsonChanges(a: unknown, b: unknown, limit = 2000): { changes: JsonChange[]; truncated: boolean } {
  const changes: JsonChange[] = [];
  let truncated = false;
  const add = (c: JsonChange) => {
    if (changes.length >= limit) truncated = true;
    else changes.push(c);
  };
  const walk = (x: unknown, y: unknown, path: string) => {
    if (truncated) return;
    if (Array.isArray(x) && Array.isArray(y)) return walkArrays(x, y, path);
    if (isObject(x) && isObject(y)) {
      for (const k of Object.keys(x)) {
        if (!(k in y)) add({ path: path + pathStep(k), kind: 'removed', before: brief(x[k]) });
        else walk(x[k], y[k], path + pathStep(k));
      }
      for (const k of Object.keys(y)) if (!(k in x)) add({ path: path + pathStep(k), kind: 'added', after: brief(y[k]) });
      return;
    }
    if (key(x) !== key(y)) add({ path, kind: 'changed', before: brief(x), after: brief(y) });
  };
  const walkArrays = (x: unknown[], y: unknown[], path: string) => {
    const ids = new Map<string, number>();
    const idOf = (v: unknown) => {
      const k = key(v);
      let id = ids.get(k);
      if (id === undefined) ids.set(k, (id = ids.size));
      return id;
    };
    for (const c of diffSeq(x.map(idOf), y.map(idOf))) {
      const n = Math.min(c.a1 - c.a0, c.b1 - c.b0);
      // Paired up in place: the same element, changed.
      for (let i = 0; i < n; i++) walk(x[c.a0 + i], y[c.b0 + i], path + pathStep(c.b0 + i));
      for (let i = c.a0 + n; i < c.a1; i++) add({ path: path + pathStep(i), kind: 'removed', before: brief(x[i]) });
      for (let j = c.b0 + n; j < c.b1; j++) add({ path: path + pathStep(j), kind: 'added', after: brief(y[j]) });
    }
  };
  walk(a, b, '$');
  return { changes, truncated };
}

/** Parses JSON, saying where it fails. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Empty' };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch (err) {
    const msg = (err as Error).message;
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const before = t.slice(0, Number(pos[1]));
      const line = before.split('\n').length;
      const col = before.length - before.lastIndexOf('\n');
      return { ok: false, error: `Not valid JSON: ${msg.replace(/\s*in JSON at position \d+.*$/, '').replace(/ \(line \d+ column \d+\)$/, '')} at line ${line}, column ${col}` };
    }
    // V8 quotes the whole text: "Unexpected token '}', "{…}" is not valid JSON".
    return { ok: false, error: `Not valid JSON: ${msg.replace(/, "[\s\S]*" is not valid JSON$/, '')}` };
  }
}
