import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { VARIABLE_NAME, type Catalog, type KeyValue, type ParamRow, type SavedRequest, type Variable } from '../../shared/apiclient';
import type { FieldError } from '../config';

/**
 * Saved requests and variables, in one JSON file next to the settings file
 * (api-requests.json), so they outlive the browser's storage and can be backed up or put in
 * git. Every change re-reads the file and writes it back through a temporary file, so edits made
 * to it by hand are kept and a crash never leaves half a file. Header values, tokens included,
 * are stored as plain text.
 */

export const CATALOG_FILE = 'api-requests.json';

export class CatalogError extends Error {
  constructor(
    message: string,
    public errors: FieldError[] = [],
  ) {
    super(message);
  }
}

export interface CatalogFile extends Catalog {
  file: string;
  /** The file exists but could not be read. The next change moves it aside and starts afresh. */
  error: string | null;
}

export interface ImportSummary {
  added: string[];
  updated: string[];
  unchanged: number;
  skipped: { name: string; reason: string }[];
  variables: { added: string[]; updated: string[] };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const IN = ['path', 'query', 'header', 'cookie'];
const MAX_TEXT = 10 * 1024 * 1024;

/**
 * Checks a request sent from the API screen (or found in an imported file) and returns it
 * cleaned up. Error paths name the field: "name", "headers.2.name".
 */
export function validateRequest(input: unknown): { request: Omit<SavedRequest, 'id' | 'created' | 'updated'>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const v = isObj(input) ? input : {};
  if (!isObj(input)) errors.push({ path: '', message: 'A saved request must be an object' });
  const text = (path: string, x: unknown, max: number, label: string): string => {
    if (x === undefined || x === null) return '';
    if (typeof x !== 'string') {
      errors.push({ path, message: `${label} must be text` });
      return '';
    }
    if (x.length > max) errors.push({ path, message: `${label} is too long` });
    return x;
  };
  const name = text('name', v.name, 200, 'Name').trim();
  if (!name) errors.push({ path: 'name', message: 'Name is required' });
  const method = text('method', v.method, 20, 'Method').trim().toUpperCase() || 'GET';
  if (!/^[A-Z]+$/.test(method)) errors.push({ path: 'method', message: 'Not a valid HTTP method' });
  const url = text('url', v.url, 16_384, 'URL').trim();
  if (!url) errors.push({ path: 'url', message: 'URL is required' });
  const rows = <T extends KeyValue>(path: string, list: unknown, extra: (item: Record<string, any>, at: string) => Partial<T> | null): T[] => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      errors.push({ path, message: 'Must be a list' });
      return [];
    }
    const out: T[] = [];
    list.slice(0, 500).forEach((item, i) => {
      const at = `${path}.${i}`;
      if (!isObj(item)) return errors.push({ path: at, message: 'Must be an object' });
      const row = {
        name: text(`${at}.name`, item.name, 1000, 'Name').trim(),
        value: text(`${at}.value`, item.value, 1_000_000, 'Value'),
        enabled: item.enabled !== false,
      } as T;
      if (!row.name && !row.value) return;
      const more = extra(item, at);
      if (more === null) return;
      out.push({ ...row, ...more });
    });
    return out;
  };
  const params = rows<ParamRow>('params', v.params, (item, at) => {
    if (!IN.includes(item.in)) {
      errors.push({ path: `${at}.in`, message: 'Must be path, query, header or cookie' });
      return null;
    }
    return { in: item.in };
  });
  const headers = rows<KeyValue>('headers', v.headers, (item, at) => {
    if (/[\r\n]/.test(String(item.value ?? ''))) errors.push({ path: `${at}.value`, message: 'A header value cannot contain line breaks' });
    return {};
  });
  let operation: SavedRequest['operation'] = null;
  if (isObj(v.operation)) {
    const o = v.operation;
    operation = {
      spec: text('operation.spec', o.spec, 200, 'Spec'),
      operationId: typeof o.operationId === 'string' && o.operationId ? o.operationId : null,
      method: text('operation.method', o.method, 20, 'Method').toUpperCase(),
      path: text('operation.path', o.path, 4000, 'Path'),
    };
  }
  return {
    request: {
      name,
      description: text('description', v.description, 20_000, 'Description'),
      folder: text('folder', v.folder, 200, 'Folder').trim().replace(/\s*\/\s*/g, '/').replace(/^\/+|\/+$/g, ''),
      method,
      url,
      params,
      headers,
      body: text('body', v.body, MAX_TEXT, 'Body'),
      contentType: text('contentType', v.contentType, 200, 'Content type').trim(),
      disabledDefaults: Array.isArray(v.disabledDefaults) ? v.disabledDefaults.filter((x: unknown): x is string => typeof x === 'string').slice(0, 100) : [],
      operation,
    },
    errors,
  };
}

export function validateVariables(input: unknown): { variables: Variable[]; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!Array.isArray(input)) return { variables: [], errors: [{ path: 'variables', message: 'Must be a list' }] };
  const out: Variable[] = [];
  const seen = new Set<string>();
  input.forEach((item, i) => {
    const at = `variables.${i}`;
    if (!isObj(item)) return errors.push({ path: at, message: 'Must be an object' });
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const value = typeof item.value === 'string' ? item.value : item.value == null ? '' : String(item.value);
    if (!name && !value) return;
    if (!VARIABLE_NAME.test(name)) errors.push({ path: `${at}.name`, message: 'Use letters, digits, _ . and -, starting with a letter or _' });
    else if (name === 'baseUrl') errors.push({ path: `${at}.name`, message: '{{baseUrl}} is built in: it is the base URL from Settings or the spec' });
    else if (seen.has(name)) errors.push({ path: `${at}.name`, message: `${name} is defined twice` });
    if (value.length > 1_000_000) errors.push({ path: `${at}.value`, message: 'Too long' });
    seen.add(name);
    out.push({ name, value });
  });
  return { variables: out, errors };
}

/** Compares two requests by content, ignoring when they were saved. */
const sameRequest = (a: SavedRequest, b: SavedRequest) => {
  const strip = ({ created: _c, updated: _u, ...rest }: SavedRequest) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

export class CatalogStore {
  /** Changes run one at a time, so two quick saves cannot lose each other's edits. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public file: string) {}

  read(): CatalogFile {
    const empty: CatalogFile = { file: this.file, error: null, variables: [], requests: [] };
    if (!existsSync(this.file)) return empty;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      return { ...empty, error: `${this.file} could not be read: ${(err as Error).message}` };
    }
    if (!isObj(raw)) return { ...empty, error: `${this.file} does not contain a JSON object` };
    // Entries edited by hand into something unusable are skipped, not fatal.
    const requests: SavedRequest[] = [];
    for (const r of Array.isArray(raw.requests) ? raw.requests : []) {
      const { request, errors } = validateRequest(r);
      if (errors.length || !isObj(r) || typeof r.id !== 'string') continue;
      requests.push({ ...request, id: r.id, created: String(r.created ?? ''), updated: String(r.updated ?? '') });
    }
    const variables = validateVariables(Array.isArray(raw.variables) ? raw.variables : []).variables.filter((x) => VARIABLE_NAME.test(x.name) && x.name !== 'baseUrl');
    return { file: this.file, error: null, variables, requests };
  }

  /** Runs `change` on the current contents and writes the result. Returns what `change` returns. */
  private mutate<R>(change: (cat: Catalog) => R): Promise<R & { notice?: string }> {
    const run = async () => {
      const current = this.read();
      let notice: string | undefined;
      if (current.error) {
        // Keep the unreadable file for the user to look at, and start a fresh one.
        const aside = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        renameSync(this.file, aside);
        notice = `${current.error}. It was renamed to ${aside} and a new file started.`;
      }
      const cat: Catalog = { variables: current.variables, requests: current.requests };
      const result = change(cat);
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, variables: cat.variables, requests: cat.requests }, null, 2) + '\n');
      renameSync(tmp, this.file);
      return Object.assign(result as object, notice ? { notice } : {}) as R & { notice?: string };
    };
    const done = this.queue.then(run, run);
    this.queue = done.catch(() => undefined);
    return done;
  }

  create(input: unknown): Promise<{ request: SavedRequest; notice?: string }> {
    const { request, errors } = validateRequest(input);
    if (errors.length) return Promise.reject(new CatalogError('The request cannot be saved', errors));
    return this.mutate((cat) => {
      const now = new Date().toISOString();
      const saved: SavedRequest = { ...request, id: randomUUID(), created: now, updated: now };
      cat.requests.push(saved);
      return { request: saved };
    });
  }

  update(id: string, input: unknown): Promise<{ request: SavedRequest; notice?: string }> {
    const { request, errors } = validateRequest(input);
    if (errors.length) return Promise.reject(new CatalogError('The request cannot be saved', errors));
    return this.mutate((cat) => {
      const i = cat.requests.findIndex((r) => r.id === id);
      if (i === -1) throw new CatalogError('That saved request no longer exists');
      const saved: SavedRequest = { ...request, id, created: cat.requests[i].created, updated: new Date().toISOString() };
      cat.requests[i] = saved;
      return { request: saved };
    });
  }

  remove(id: string): Promise<{ removed: boolean; notice?: string }> {
    return this.mutate((cat) => {
      const before = cat.requests.length;
      cat.requests = cat.requests.filter((r) => r.id !== id);
      return { removed: cat.requests.length !== before };
    });
  }

  setVariables(input: unknown): Promise<{ variables: Variable[]; notice?: string }> {
    const { variables, errors } = validateVariables(input);
    if (errors.length) return Promise.reject(new CatalogError('The variables cannot be saved', errors));
    return this.mutate((cat) => {
      cat.variables = variables;
      return { variables };
    });
  }

  /**
   * Merges an exported catalog (or a plain list of requests) into this one: requests by id
   * (new ids are added, known ids replaced when different), variables by name. Entries that do
   * not check out are skipped and listed.
   */
  import(input: unknown): Promise<ImportSummary & { notice?: string }> {
    const data = Array.isArray(input) ? { requests: input } : isObj(input) ? input : null;
    if (!data) return Promise.reject(new CatalogError('Not a Debug Hub catalog: expected { "requests": [...] }'));
    const incoming: SavedRequest[] = [];
    const skipped: ImportSummary['skipped'] = [];
    for (const r of Array.isArray(data.requests) ? data.requests : []) {
      const { request, errors } = validateRequest(r);
      const label = isObj(r) && typeof r.name === 'string' && r.name ? r.name : '(unnamed)';
      if (errors.length) {
        skipped.push({ name: label, reason: errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ') });
        continue;
      }
      const now = new Date().toISOString();
      const id = isObj(r) && typeof r.id === 'string' && r.id ? r.id : randomUUID();
      incoming.push({ ...request, id, created: isObj(r) && typeof r.created === 'string' ? r.created : now, updated: isObj(r) && typeof r.updated === 'string' ? r.updated : now });
    }
    const vars = data.variables === undefined ? { variables: [], errors: [] } : validateVariables(data.variables);
    if (vars.errors.length) skipped.push({ name: 'variables', reason: vars.errors.map((e) => `${e.path}: ${e.message}`).join('; ') });
    if (!incoming.length && !vars.variables.length && !skipped.length) {
      return Promise.reject(new CatalogError('The file has no saved requests or variables'));
    }
    return this.mutate((cat) => {
      const summary: ImportSummary = { added: [], updated: [], unchanged: 0, skipped, variables: { added: [], updated: [] } };
      for (const r of incoming) {
        const i = cat.requests.findIndex((x) => x.id === r.id);
        if (i === -1) {
          cat.requests.push(r);
          summary.added.push(r.name);
        } else if (sameRequest(cat.requests[i], r)) summary.unchanged++;
        else {
          cat.requests[i] = r;
          summary.updated.push(r.name);
        }
      }
      // Variables that failed the check are left out; the rest still merge.
      for (const v of vars.errors.length ? vars.variables.filter((x) => VARIABLE_NAME.test(x.name) && x.name !== 'baseUrl') : vars.variables) {
        const existing = cat.variables.find((x) => x.name === v.name);
        if (!existing) {
          cat.variables.push(v);
          summary.variables.added.push(v.name);
        } else if (existing.value !== v.value) {
          existing.value = v.value;
          summary.variables.updated.push(v.name);
        }
      }
      return summary;
    });
  }
}
