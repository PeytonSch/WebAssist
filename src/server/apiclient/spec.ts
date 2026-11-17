import {
  HTTP_METHODS,
  type ApiBody,
  type ApiContent,
  type ApiOperation,
  type ApiParam,
  type ApiResponse,
  type ApiSecurityScheme,
  type ApiSpec,
  type HttpMethod,
  type ParamIn,
  type Schema,
} from '../../shared/apiclient';
import { parseYaml } from './yaml';

/**
 * Reads an OpenAPI 3.0/3.1 or Swagger 2.0 document into the one model the API screen works
 * with (src/shared/apiclient.ts). Local `$ref`s to parameters, request bodies, responses and path
 * items are resolved here; schema `$ref`s are kept, with the schemas they point to collected into
 * `schemas`, because schemas may refer to themselves and the model has to stay plain JSON.
 */

export class SpecError extends Error {}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Text of a spec file to a document: JSON when it looks like JSON, YAML otherwise. */
export function parseSpecText(text: string, contentType = ''): unknown {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('{') || t.startsWith('[') || /json/i.test(contentType)) {
    try {
      return JSON.parse(t);
    } catch (err) {
      throw new SpecError(`Not valid JSON: ${(err as Error).message}`);
    }
  }
  if (/^\s*</.test(t)) throw new SpecError('Got an HTML page, not a spec. Check the URL: springdoc serves the spec at /v3/api-docs, springfox at /v2/api-docs.');
  try {
    return parseYaml(t);
  } catch (err) {
    throw new SpecError((err as Error).message);
  }
}

/** Reads a JSON pointer ("#/components/schemas/Order") in the document. */
function pointer(doc: unknown, ref: string): unknown {
  if (ref === '#') return doc;
  if (!ref.startsWith('#/')) return undefined;
  let node: any = doc;
  for (const raw of ref.slice(2).split('/')) {
    let key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    try {
      key = decodeURIComponent(key);
    } catch {
      /* keep as is */
    }
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

export function parseSpec(doc: unknown, name: string, source: string): ApiSpec {
  if (!isObj(doc)) throw new SpecError('The spec is not a JSON or YAML object');
  const swagger = str(doc.swagger);
  const openapi = str(doc.openapi);
  let format: ApiSpec['format'];
  if (swagger.startsWith('2.')) format = 'swagger-2.0';
  else if (openapi.startsWith('3.0')) format = 'openapi-3.0';
  else if (openapi.startsWith('3.')) format = 'openapi-3.1';
  else throw new SpecError('Not an OpenAPI 3 or Swagger 2 document (no "openapi" or "swagger" version at the top)');
  const v2 = format === 'swagger-2.0';
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w) && warnings.length < 50) warnings.push(w);
  };

  /** Follows a non-schema `$ref` (parameters, bodies, responses, path items, examples). */
  const resolve = (node: unknown, seen: string[] = []): any => {
    if (!isObj(node) || typeof node.$ref !== 'string') return node;
    const ref = node.$ref;
    if (!ref.startsWith('#')) {
      warn(`References to other files are not followed: ${ref}`);
      return {};
    }
    if (seen.includes(ref)) {
      warn(`Circular reference: ${ref}`);
      return {};
    }
    const target = pointer(doc, ref);
    if (target === undefined) {
      warn(`Reference not found: ${ref}`);
      return {};
    }
    return resolve(target, [...seen, ref]);
  };

  // ── Schemas: collect what $refs point to ──
  const schemas: Record<string, Schema> = {};
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        if (!v.startsWith('#')) warn(`References to other files are not followed: ${v}`);
        else if (!(v in schemas)) {
          const target = pointer(doc, v);
          if (isObj(target)) {
            schemas[v] = target;
            collect(target);
          } else warn(`Reference not found: ${v}`);
        }
      } else if (k !== 'example' && k !== 'examples' && k !== 'default' && k !== 'enum' && k !== 'const') collect(v);
    }
  };
  /** A schema for the model: a Swagger 2 parameter's inline type, or a schema as is. */
  const schemaOf = (s: unknown): Schema | null => {
    if (!isObj(s)) return null;
    collect(s);
    return s;
  };

  /** An example from a media type or parameter: `example`, else the first of `examples`. */
  const exampleOf = (o: Record<string, any>): { example?: unknown } => {
    if (o.example !== undefined) return { example: o.example };
    if (isObj(o.examples)) {
      const first = Object.values(o.examples)[0];
      const ex = resolve(first);
      if (isObj(ex) && ex.value !== undefined) return { example: ex.value };
    }
    if (o['x-example'] !== undefined) return { example: o['x-example'] };
    return {};
  };

  const contentsOf = (content: unknown): ApiContent[] =>
    isObj(content)
      ? Object.entries(content).map(([type, media]) => {
          const m = resolve(media);
          return { type, schema: schemaOf(isObj(m) ? m.schema : null), ...(isObj(m) ? exampleOf(m) : {}) };
        })
      : [];

  // ── Servers ──
  const servers = v2 ? swaggerServers(doc, source) : openapiServers(doc.servers, source, warn);
  if (!servers.length) warn('The spec names no server: set a base URL in Settings › API client');

  // ── Operations ──
  const globalConsumes: string[] = Array.isArray(doc.consumes) ? doc.consumes : [];
  const globalProduces: string[] = Array.isArray(doc.produces) ? doc.produces : [];
  const operations: ApiOperation[] = [];
  const keys = new Set<string>();

  const toParam = (raw: unknown): ApiParam | null => {
    const p = resolve(raw);
    if (!isObj(p) || typeof p.name !== 'string' || !['path', 'query', 'header', 'cookie'].includes(p.in)) return null;
    let schema: Schema | null;
    let example = exampleOf(p);
    if (v2) {
      // Swagger 2 puts the type on the parameter itself.
      const { name, in: _in, required, description, ...rest } = p;
      schema = schemaOf(rest.type ? rest : null);
    } else if (isObj(p.content)) {
      const first = contentsOf(p.content)[0];
      schema = first?.schema ?? null;
      if (example.example === undefined && first?.example !== undefined) example = { example: first.example };
    } else schema = schemaOf(p.schema);
    return {
      name: p.name,
      in: p.in as ParamIn,
      // Path parameters are always required, whatever the spec says.
      required: p.in === 'path' || p.required === true,
      description: str(p.description),
      deprecated: p.deprecated === true,
      schema,
      ...example,
    };
  };

  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = resolve(rawItem);
    if (!isObj(item)) continue;
    const shared: unknown[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const lower of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch']) {
      const op = item[lower];
      if (!isObj(op)) continue;
      const method = lower.toUpperCase() as HttpMethod;
      const own: unknown[] = Array.isArray(op.parameters) ? op.parameters : [];

      // Operation parameters override path-level ones with the same name and place.
      const byKey = new Map<string, unknown>();
      for (const raw of [...shared, ...own]) {
        const p = resolve(raw);
        if (isObj(p)) byKey.set(`${p.in}:${p.name}`, raw);
      }
      const rawParams = [...byKey.values()].map((p) => resolve(p));
      const params = rawParams.map(toParam).filter((p): p is ApiParam => !!p);

      let body: ApiBody | null = null;
      if (v2) body = swaggerBody(rawParams, op.consumes ?? globalConsumes, schemaOf);
      else if (op.requestBody) {
        const rb = resolve(op.requestBody);
        if (isObj(rb)) body = { required: rb.required === true, description: str(rb.description), contents: contentsOf(rb.content) };
      }

      const responses: ApiResponse[] = [];
      if (isObj(op.responses)) {
        for (const [status, rawRes] of Object.entries(op.responses)) {
          const r = resolve(rawRes);
          if (!isObj(r)) continue;
          let contents: ApiContent[];
          if (v2) {
            const produces: string[] = op.produces ?? globalProduces;
            const schema = schemaOf(r.schema);
            const examples = isObj(r.examples) ? r.examples : {};
            contents = schema || Object.keys(examples).length
              ? (produces.length ? produces : ['application/json']).map((type) => ({ type, schema, ...(examples[type] !== undefined && { example: examples[type] }) }))
              : [];
          } else contents = contentsOf(r.content);
          responses.push({ status, description: str(r.description), contents });
        }
      }

      const sec = Array.isArray(op.security) ? op.security : Array.isArray(doc.security) ? doc.security : [];
      const security = [...new Set(sec.filter(isObj).flatMap((s: Record<string, unknown>) => Object.keys(s)))];

      const operationId = str(op.operationId) || null;
      let key = operationId ?? `${method} ${path}`;
      if (keys.has(key)) {
        warn(`Duplicate operationId ${key}`);
        key = `${key} (${method} ${path})`;
      }
      keys.add(key);
      operations.push({
        key,
        operationId,
        method,
        path,
        summary: str(op.summary),
        description: str(op.description),
        tags: Array.isArray(op.tags) ? op.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
        deprecated: op.deprecated === true,
        params,
        body,
        responses,
        security,
      });
    }
  }
  if (!operations.length) warn('The spec has no operations');

  return {
    name,
    source,
    format,
    title: str(doc.info?.title) || name,
    version: str(doc.info?.version),
    description: str(doc.info?.description),
    servers,
    operations,
    schemas,
    securitySchemes: securitySchemes(v2 ? doc.securityDefinitions : doc.components?.securitySchemes, resolve),
    warnings,
  };
}

/** Swagger 2: a body parameter, or formData parameters as one form body. */
function swaggerBody(params: any[], consumes: string[], schemaOf: (s: unknown) => Schema | null): ApiBody | null {
  const bodyParam = params.find((p) => isObj(p) && p.in === 'body');
  if (bodyParam) {
    const types = consumes.filter((c) => !/form/.test(c));
    const schema = schemaOf(bodyParam.schema);
    return {
      required: bodyParam.required === true,
      description: str(bodyParam.description),
      contents: (types.length ? types : ['application/json']).map((type) => ({ type, schema, ...(bodyParam['x-example'] !== undefined && { example: bodyParam['x-example'] }) })),
    };
  }
  const form = params.filter((p) => isObj(p) && p.in === 'formData');
  if (!form.length) return null;
  const properties: Record<string, Schema> = {};
  for (const p of form) {
    const { name, in: _in, required, description, ...rest } = p;
    properties[name] = { ...rest, ...(description && { description }) };
  }
  const schema = schemaOf({ type: 'object', properties, required: form.filter((p) => p.required).map((p) => p.name) });
  const multipart = consumes.includes('multipart/form-data') || form.some((p) => p.type === 'file');
  return {
    required: form.some((p) => p.required === true),
    description: '',
    contents: [{ type: multipart ? 'multipart/form-data' : 'application/x-www-form-urlencoded', schema }],
  };
}

/** Swagger 2: schemes + host + basePath, defaulting to where the spec was loaded from. */
function swaggerServers(doc: Record<string, any>, source: string): ApiSpec['servers'] {
  let from: URL | null = null;
  try {
    from = /^https?:/i.test(source) ? new URL(source) : null;
  } catch {
    from = null;
  }
  const host = str(doc.host) || from?.host;
  if (!host) return [];
  const basePath = str(doc.basePath) || '/';
  const schemes: string[] = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : [from?.protocol.replace(':', '') ?? 'http'];
  // The scheme the spec itself was served over goes first: that one is known to work.
  schemes.sort((a, b) => Number(b === from?.protocol.replace(':', '')) - Number(a === from?.protocol.replace(':', '')));
  return schemes
    .filter((s) => s === 'http' || s === 'https')
    .map((s) => ({ url: `${s}://${host}${basePath === '/' ? '' : basePath.replace(/\/+$/, '')}`, description: '' }));
}

/** OpenAPI 3: server URLs with their variables filled in; relative ones resolved against the spec's URL. */
function openapiServers(raw: unknown, source: string, warn: (w: string) => void): ApiSpec['servers'] {
  const list: any[] = Array.isArray(raw) && raw.length ? raw : [{ url: '/' }];
  const out: ApiSpec['servers'] = [];
  for (const s of list) {
    if (!isObj(s) || typeof s.url !== 'string') continue;
    const url = s.url.replace(/\{([^}]+)\}/g, (m: string, name: string) => {
      const v = s.variables?.[name]?.default;
      return v === undefined ? m : String(v);
    });
    let abs: string;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) abs = url;
    else if (/^https?:/i.test(source)) abs = new URL(url, source).toString();
    else {
      if (url !== '/') warn(`Server URL ${url} is relative and the spec was read from a file: set a base URL in Settings`);
      continue;
    }
    out.push({ url: abs.replace(/\/+$/, ''), description: str(s.description) });
  }
  return out;
}

function securitySchemes(raw: unknown, resolve: (n: unknown) => any): ApiSecurityScheme[] {
  if (!isObj(raw)) return [];
  return Object.entries(raw).map(([name, value]) => {
    const s = resolve(value);
    return {
      name,
      type: str(s?.type),
      ...(s?.scheme && { scheme: str(s.scheme) }),
      ...(s?.bearerFormat && { bearerFormat: str(s.bearerFormat) }),
      ...(s?.in && { in: str(s.in) }),
      ...(s?.name && { paramName: str(s.name) }),
      description: str(s?.description),
    };
  });
}

export const isHttpMethod = (m: string): m is HttpMethod => (HTTP_METHODS as readonly string[]).includes(m);
