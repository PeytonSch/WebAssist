import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSpec, parseSpecText, SpecError } from '../src/server/apiclient/spec';
import { parseYaml } from '../src/server/apiclient/yaml';
import {
  buildUrl,
  enumOf,
  exampleFromSchema,
  formEncode,
  joinUrl,
  paramHeaders,
  resolveDraft,
  substitute,
  typeHint,
  type RequestDraft,
} from '../src/shared/apiclient';

// ── Fixtures ────────────────────────────────────────────

/** OpenAPI 3.0 like springdoc writes it, plus a self-referencing schema and shared parameters. */
const OPENAPI3 = {
  openapi: '3.0.1',
  info: { title: 'Orders API', version: '1.2' },
  servers: [{ url: '/shop', description: 'Generated server url' }],
  tags: [{ name: 'orders' }],
  paths: {
    '/orders': {
      get: {
        tags: ['orders'],
        operationId: 'listOrders',
        summary: 'List orders',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'shipped'] } },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } },
      },
      post: {
        tags: ['orders'],
        operationId: 'createOrder',
        requestBody: { $ref: '#/components/requestBodies/NewOrder' },
        responses: { '201': { $ref: '#/components/responses/Created' } },
        security: [{ bearerAuth: [] }],
      },
    },
    '/orders/{id}': {
      parameters: [{ name: 'id', in: 'path', schema: { type: 'integer', format: 'int64' }, example: 42 }],
      get: {
        tags: ['orders'],
        operationId: 'getOrder',
        deprecated: true,
        parameters: [{ name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'The order', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } }, default: { description: 'Error' } },
      },
      delete: { responses: { '204': { description: 'Gone' } } },
    },
  },
  components: {
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, minimum: 1 } } },
    requestBodies: {
      NewOrder: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NewOrder' } } } },
    },
    responses: { Created: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
    schemas: {
      Order: {
        allOf: [
          { $ref: '#/components/schemas/NewOrder' },
          { type: 'object', properties: { id: { type: 'integer', format: 'int64', readOnly: true }, created: { type: 'string', format: 'date-time' } } },
        ],
      },
      NewOrder: {
        type: 'object',
        required: ['sku'],
        properties: {
          sku: { type: 'string', example: 'A-100' },
          qty: { type: 'integer', minimum: 1 },
          customer: { $ref: '#/components/schemas/Customer' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      Customer: {
        type: 'object',
        properties: { id: { type: 'string', format: 'uuid' }, referredBy: { $ref: '#/components/schemas/Customer' }, kind: { oneOf: [{ $ref: '#/components/schemas/Person' }, { type: 'string' }] } },
      },
      Person: { type: 'object', properties: { email: { type: 'string', format: 'email' } } },
    },
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
};

/** Swagger 2.0 like springfox writes it. */
const SWAGGER2 = {
  swagger: '2.0',
  info: { title: 'Legacy', version: '1' },
  host: 'legacy.local:8443',
  basePath: '/api/',
  schemes: ['http', 'https'],
  consumes: ['application/json'],
  produces: ['application/json'],
  paths: {
    '/customers/{id}': {
      get: {
        tags: ['customers'],
        operationId: 'getCustomer',
        parameters: [
          { name: 'id', in: 'path', required: true, type: 'string', format: 'uuid' },
          { name: 'expand', in: 'query', type: 'array', items: { type: 'string', enum: ['orders', 'notes'] } },
        ],
        responses: { '200': { description: 'OK', schema: { $ref: '#/definitions/Customer' } } },
      },
      put: {
        operationId: 'updateCustomer',
        parameters: [
          { name: 'id', in: 'path', required: true, type: 'string' },
          { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/Customer' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/login': {
      post: {
        operationId: 'login',
        consumes: ['application/x-www-form-urlencoded'],
        parameters: [
          { name: 'user', in: 'formData', required: true, type: 'string' },
          { name: 'remember', in: 'formData', type: 'boolean', default: false },
        ],
        responses: { '302': { description: 'Redirect' } },
      },
    },
  },
  definitions: {
    Customer: { type: 'object', properties: { id: { type: 'string' }, parent: { $ref: '#/definitions/Customer' } } },
  },
  securityDefinitions: { api_key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
};

// ── Spec parsing ────────────────────────────────────────

describe('parseSpec: OpenAPI 3', () => {
  const spec = parseSpec(structuredClone(OPENAPI3), 'shop', 'http://localhost:8080/v3/api-docs');

  it('reads the title, format and relative servers against the spec URL', () => {
    expect(spec.format).toBe('openapi-3.0');
    expect(spec.title).toBe('Orders API');
    expect(spec.servers).toEqual([{ url: 'http://localhost:8080/shop', description: 'Generated server url' }]);
  });

  it('lists every operation with its method, path, tags and deprecation', () => {
    expect(spec.operations.map((o) => `${o.method} ${o.path} ${o.key}`)).toEqual([
      'GET /orders listOrders',
      'POST /orders createOrder',
      'GET /orders/{id} getOrder',
      'DELETE /orders/{id} DELETE /orders/{id}',
    ]);
    const get = spec.operations.find((o) => o.key === 'getOrder')!;
    expect(get.deprecated).toBe(true);
    expect(get.tags).toEqual(['orders']);
  });

  it('merges path-level parameters and resolves parameter, body and response references', () => {
    const list = spec.operations.find((o) => o.key === 'listOrders')!;
    expect(list.params.map((p) => `${p.in}:${p.name}`)).toEqual(['query:status', 'query:limit']);
    const get = spec.operations.find((o) => o.key === 'getOrder')!;
    const id = get.params.find((p) => p.name === 'id')!;
    expect(id).toMatchObject({ in: 'path', required: true, example: 42 });
    expect(get.params.find((p) => p.name === 'X-Tenant')).toMatchObject({ in: 'header', required: true });
    const create = spec.operations.find((o) => o.key === 'createOrder')!;
    expect(create.body?.required).toBe(true);
    expect(create.body?.contents[0]).toMatchObject({ type: 'application/json', schema: { $ref: '#/components/schemas/NewOrder' } });
    expect(create.responses[0]).toMatchObject({ status: '201', description: 'Created' });
    expect(create.security).toEqual(['bearerAuth']);
    expect(spec.securitySchemes).toEqual([{ name: 'bearerAuth', type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: '' }]);
  });

  it('collects the schemas that references point to, including self-references', () => {
    expect(Object.keys(spec.schemas).sort()).toEqual([
      '#/components/schemas/Customer',
      '#/components/schemas/NewOrder',
      '#/components/schemas/Order',
      '#/components/schemas/Person',
    ]);
    // The model stays plain JSON despite the cycle.
    expect(() => JSON.stringify(spec)).not.toThrow();
  });

  it('defaults to the spec’s own origin when no servers are listed, and warns for relative ones read from a file', () => {
    const none = parseSpec({ openapi: '3.1.0', info: { title: 't' }, paths: {} }, 'x', 'https://api.example.com/docs/openapi.json');
    expect(none.format).toBe('openapi-3.1');
    expect(none.servers).toEqual([{ url: 'https://api.example.com', description: '' }]);
    const file = parseSpec({ openapi: '3.0.0', info: {}, servers: [{ url: '/v1' }], paths: {} }, 'x', '/specs/a.json');
    expect(file.servers).toEqual([]);
    expect(file.warnings.join(' ')).toMatch(/relative/);
  });

  it('fills in server variables', () => {
    const s = parseSpec({ openapi: '3.0.0', info: {}, paths: {}, servers: [{ url: 'http://{host}:{port}/api', variables: { host: { default: 'localhost' }, port: { default: '8080' } } }] }, 'x', 'f.json');
    expect(s.servers[0].url).toBe('http://localhost:8080/api');
  });

  it('survives reference cycles between parameters and reports missing and external references', () => {
    const doc = {
      openapi: '3.0.0',
      info: {},
      paths: { '/a': { get: { parameters: [{ $ref: '#/components/parameters/A' }, { $ref: '#/components/parameters/Missing' }, { $ref: 'other.yaml#/X' }], responses: {} } } },
      components: { parameters: { A: { $ref: '#/components/parameters/B' }, B: { $ref: '#/components/parameters/A' } } },
    };
    const s = parseSpec(doc, 'x', 'f.json');
    expect(s.operations[0].params).toEqual([]);
    expect(s.warnings.join('\n')).toMatch(/Circular reference/);
    expect(s.warnings.join('\n')).toMatch(/Reference not found: #\/components\/parameters\/Missing/);
    expect(s.warnings.join('\n')).toMatch(/other files/);
  });

  it('rejects documents that are not specs', () => {
    expect(() => parseSpec({ hello: 1 }, 'x', 'f')).toThrow(SpecError);
    expect(() => parseSpec([], 'x', 'f')).toThrow(SpecError);
  });
});

describe('parseSpec: Swagger 2', () => {
  const spec = parseSpec(structuredClone(SWAGGER2), 'legacy', 'https://legacy.local:8443/v2/api-docs');

  it('builds servers from schemes, host and basePath, the spec’s own scheme first', () => {
    expect(spec.format).toBe('swagger-2.0');
    expect(spec.servers.map((s) => s.url)).toEqual(['https://legacy.local:8443/api', 'http://legacy.local:8443/api']);
  });

  it('turns inline parameter types into schemas', () => {
    const op = spec.operations.find((o) => o.key === 'getCustomer')!;
    const id = op.params.find((p) => p.name === 'id')!;
    expect(id.schema).toMatchObject({ type: 'string', format: 'uuid' });
    const expand = op.params.find((p) => p.name === 'expand')!;
    expect(enumOf(expand.schema, spec.schemas)).toEqual(['orders', 'notes']);
    expect(typeHint(expand.schema, spec.schemas)).toBe('string[]');
  });

  it('turns body and formData parameters into a request body', () => {
    const put = spec.operations.find((o) => o.key === 'updateCustomer')!;
    expect(put.params.map((p) => p.name)).toEqual(['id']);
    expect(put.body?.contents).toEqual([{ type: 'application/json', schema: { $ref: '#/definitions/Customer' } }]);
    const login = spec.operations.find((o) => o.key === 'login')!;
    expect(login.body?.contents[0].type).toBe('application/x-www-form-urlencoded');
    expect(exampleFromSchema(login.body?.contents[0].schema, spec.schemas)).toEqual({ user: 'string', remember: false });
    expect(spec.securitySchemes[0]).toMatchObject({ name: 'api_key', type: 'apiKey', in: 'header', paramName: 'X-Api-Key' });
  });

  it('defaults the host to where the spec was loaded from', () => {
    const s = parseSpec({ swagger: '2.0', info: {}, paths: {} }, 'x', 'http://localhost:8080/v2/api-docs');
    expect(s.servers.map((x) => x.url)).toEqual(['http://localhost:8080']);
  });
});

describe('parseSpecText', () => {
  it('reads JSON and YAML, and explains an HTML page', () => {
    expect(parseSpecText('{"openapi":"3.0.0"}')).toEqual({ openapi: '3.0.0' });
    expect(parseSpecText('openapi: 3.0.0\ninfo:\n  title: x\n')).toEqual({ openapi: '3.0.0', info: { title: 'x' } });
    expect(() => parseSpecText('<!doctype html><html>')).toThrow(/HTML page/);
    expect(() => parseSpecText('{"openapi": ')).toThrow(/Not valid JSON/);
  });
});

// ── Examples ────────────────────────────────────────────

describe('exampleFromSchema', () => {
  const spec = parseSpec(structuredClone(OPENAPI3), 'shop', 'http://localhost/v3/api-docs');
  const S = spec.schemas;

  it('merges allOf, uses examples and formats, and stops at a recursive reference', () => {
    const order = exampleFromSchema({ $ref: '#/components/schemas/Order' }, S, { for: 'response' }) as any;
    expect(order).toEqual({
      sku: 'A-100',
      qty: 1,
      customer: { id: '3fa85f64-5717-4562-b3fc-2c963f66afa6', kind: { email: 'user@example.com' } },
      tags: ['string'],
      id: 0,
      created: '2026-01-01T12:00:00Z',
    });
  });

  it('leaves out readOnly properties in request bodies', () => {
    const order = exampleFromSchema({ $ref: '#/components/schemas/Order' }, S, { for: 'request' }) as any;
    expect(order).not.toHaveProperty('id');
    expect(order).toHaveProperty('created');
  });

  it('prefers example, then default, then enum', () => {
    expect(exampleFromSchema({ type: 'string', example: 'x', default: 'y', enum: ['z'] }, {})).toBe('x');
    expect(exampleFromSchema({ type: 'integer', default: 5, enum: [7] }, {})).toBe(5);
    expect(exampleFromSchema({ type: 'string', enum: [null, 'b'] }, {})).toBe('b');
    expect(exampleFromSchema({ type: ['string', 'null'], format: 'date' }, {})).toBe('2026-01-01');
    expect(exampleFromSchema({ type: 'object', additionalProperties: { type: 'number' } }, {})).toEqual({ key: 0 });
    expect(exampleFromSchema({ anyOf: [{ type: 'null' }, { type: 'boolean' }] }, {})).toBe(true);
  });

  it('stops at the depth limit for very deep schemas', () => {
    let s: any = { type: 'string' };
    for (let i = 0; i < 30; i++) s = { type: 'object', properties: { next: s } };
    const out = JSON.stringify(exampleFromSchema(s, {}));
    expect(out.split('next').length - 1).toBeLessThan(12);
  });

  it('copes with a reference to itself only, and with nothing', () => {
    expect(exampleFromSchema({ $ref: '#/a' }, { '#/a': { $ref: '#/a' } })).toBeUndefined();
    expect(exampleFromSchema(null, {})).toBeNull();
  });
});

// ── YAML ────────────────────────────────────────────────

describe('parseYaml', () => {
  it('reads the block structures specs use', () => {
    const src = `
openapi: "3.0.0"   # a comment
info:
  title: Orders API
  version: 1.0
  description: |
    Line one
    Line two

    After a blank line
paths:
  /orders/{id}:
    get:
      tags: [orders, 'admin']
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: integer, format: int64 }
        - in: query
          name: q
      responses:
        '200':
          description: >-
            Folded
            text
        404: {description: "Not \\"found\\""}
servers:
- url: http://localhost:8080
empty:
nothing: ~
flag: TRUE
`;
    expect(parseYaml(src)).toEqual({
      openapi: '3.0.0',
      info: { title: 'Orders API', version: 1, description: 'Line one\nLine two\n\nAfter a blank line\n' },
      paths: {
        '/orders/{id}': {
          get: {
            tags: ['orders', 'admin'],
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer', format: 'int64' } },
              { in: 'query', name: 'q' },
            ],
            responses: { '200': { description: 'Folded text' }, '404': { description: 'Not "found"' } },
          },
        },
      },
      servers: [{ url: 'http://localhost:8080' }],
      empty: null,
      nothing: null,
      flag: true,
    });
  });

  it('handles scalars, quotes, multi-line plain text and flow collections over several lines', () => {
    expect(parseYaml(`a: 'it''s'\nb: "tab\\tnew\\u00e9"\nc: -1.5e3\nd: 0x1F\ne: .inf\nf: plain text\n  goes on\ng: [1, [2, 3],\n  {x: y}]\nh: "#not a comment" # but this is\ni: http://x:8080/a#b\n`)).toEqual({
      a: "it's",
      b: 'tab\tnewé',
      c: -1500,
      d: 31,
      e: Infinity,
      f: 'plain text goes on',
      g: [1, [2, 3], { x: 'y' }],
      h: '#not a comment',
      i: 'http://x:8080/a#b',
    });
  });

  it('keeps block scalar chomping and nested lists', () => {
    expect(parseYaml('keep: |+\n  a\n\nstrip: |-\n  b\n\nlist:\n  - - 1\n    - 2\n  - x: 1\n    y: [ ]\n')).toEqual({ keep: 'a\n\n', strip: 'b', list: [[1, 2], { x: 1, y: [] }] });
  });

  it('agrees with js-yaml on a full spec', async () => {
    let jsYaml: any;
    try {
      jsYaml = (await import('js-yaml' as string)).default;
    } catch {
      return; // not installed here: the other tests cover the parser
    }
    const text = jsYaml.dump(OPENAPI3, { lineWidth: 60 }) + jsYaml.dump({ extra: SWAGGER2 }, { flowLevel: 3 });
    expect(parseYaml(text)).toEqual(jsYaml.load(text));
  });

  it('says what it does not support, with the line', () => {
    expect(() => parseYaml('a: &x 1\nb: *x\n')).toThrow(/line 1: anchors/);
    expect(() => parseYaml('a:\n\t- 1\n')).toThrow(/tabs/);
    expect(() => parseYaml('a: 1\n b: 2\n')).toThrow(/line 2/);
    expect(() => parseYaml('a: [1, 2\n')).toThrow(/unclosed/);
  });
});

// ── URLs and variables ──────────────────────────────────

describe('building requests', () => {
  it('joins base and path with one slash', () => {
    expect(joinUrl('http://h/api/', '/orders')).toBe('http://h/api/orders');
    expect(joinUrl('http://h', 'orders')).toBe('http://h/orders');
  });

  it('substitutes and encodes path parameters and appends query parameters', () => {
    const r = buildUrl('http://h/orders/{id}/items/{item}', [
      { in: 'path', name: 'id', value: 'a b/c', enabled: true },
      { in: 'path', name: 'item', value: '7', enabled: true },
      { in: 'query', name: 'q', value: 'x&y=z ü', enabled: true },
      { in: 'query', name: 'flag', value: '', enabled: true },
      { in: 'query', name: 'off', value: '1', enabled: false },
    ]);
    expect(r).toEqual({ url: 'http://h/orders/a%20b%2Fc/items/7?q=x%26y%3Dz%20%C3%BC&flag', missing: [] });
    expect(buildUrl('http://h/a?x=1#frag', [{ in: 'query', name: 'y', value: '2', enabled: true }]).url).toBe('http://h/a?x=1&y=2#frag');
    expect(buildUrl('http://h/{id}', []).missing).toEqual(['id']);
  });

  it('puts header and cookie parameters into headers', () => {
    expect(paramHeaders([
      { in: 'header', name: 'X-Tenant', value: 't1', enabled: true },
      { in: 'cookie', name: 'a', value: '1 2', enabled: true },
      { in: 'cookie', name: 'b', value: '3', enabled: true },
    ])).toEqual([{ name: 'X-Tenant', value: 't1' }, { name: 'Cookie', value: 'a=1%202; b=3' }]);
  });

  it('substitutes {{variables}} and lists the missing ones once', () => {
    expect(substitute('{{a}}/{{ b }}/{{c}}/{{c}}', { a: '1', b: '2' })).toEqual({ text: '1/2/{{c}}/{{c}}', missing: ['c'] });
    expect(formEncode({ a: 'x y', b: [1, 2], c: { d: 1 } })).toBe('a=x%20y&b=1&b=2&c=%7B%22d%22%3A1%7D');
  });

  const draft = (over: Partial<RequestDraft> = {}): RequestDraft => ({
    method: 'post',
    url: '{{baseUrl}}/orders/{id}',
    params: [
      { in: 'path', name: 'id', value: '{{orderId}}', enabled: true },
      { in: 'query', name: 'tenant', value: '{{tenant}}', enabled: true },
    ],
    headers: [{ name: 'Authorization', value: 'Bearer {{token}}', enabled: true }, { name: 'X-Off', value: '1', enabled: false }],
    body: '{"sku":"{{sku}}"}',
    contentType: 'application/json',
    disabledDefaults: ['X-Default'],
    ...over,
  });

  it('resolves a draft into what is sent', () => {
    const vars = { baseUrl: 'http://localhost:8080/shop', orderId: '42', tenant: 't 1', token: 'abc', sku: 'A-1' };
    const { input, problems } = resolveDraft(draft(), vars);
    expect(problems).toEqual([]);
    expect(input).toEqual({
      method: 'POST',
      url: 'http://localhost:8080/shop/orders/42?tenant=t%201',
      headers: [{ name: 'Authorization', value: 'Bearer abc' }, { name: 'Content-Type', value: 'application/json' }],
      body: '{"sku":"A-1"}',
      disabledDefaults: ['X-Default'],
    });
  });

  it('reports unresolved variables and path parameters before sending', () => {
    const { problems } = resolveDraft(draft({ params: [] }), { orderId: '1' });
    expect(problems.join('\n')).toMatch(/\{\{baseUrl\}\} has no value/);
    expect(problems.join('\n')).toMatch(/\{\{token\}\} has no value/);
    expect(problems.join('\n')).toMatch(/\{\{sku\}\}/);
    expect(problems.join('\n')).toMatch(/Path parameter \{id\}/);
    expect(resolveDraft(draft({ url: 'localhost/x', params: [], headers: [], body: '' }), {}).problems).toEqual(['The URL must start with http:// or https://']);
  });

  it('form-encodes a JSON body for form content types', () => {
    const { input } = resolveDraft(draft({ url: 'http://h/login', params: [], headers: [], body: '{"user":"a b","remember":true}', contentType: 'application/x-www-form-urlencoded' }), {});
    expect(input.body).toBe('user=a%20b&remember=true');
    expect(input.headers).toEqual([{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }]);
  });
});

// ── Loading from a file ─────────────────────────────────

describe('ApiClient spec loading', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-spec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a YAML file, caches it, and reports errors per spec', async () => {
    const { ApiClient } = await import('../src/server/apiclient/client');
    const { DEFAULT_CONFIG } = await import('../src/server/config');
    writeFileSync(join(dir, 'a.yaml'), 'openapi: 3.0.0\ninfo:\n  title: From YAML\nservers:\n  - url: http://localhost:9/x\npaths:\n  /p:\n    get:\n      responses: {}\n');
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.api.specs = [{ name: 'a', url: join(dir, 'a.yaml') }, { name: 'b', url: join(dir, 'missing.json') }];
    const client = new ApiClient(cfg, () => undefined);
    const a = await client.spec('a');
    expect(a.title).toBe('From YAML');
    expect(await client.spec('a')).toBe(a);
    await expect(client.spec('b')).rejects.toThrow(/File not found/);
    expect(client.specs().map((s) => [s.name, s.state, s.operations])).toEqual([['a', 'loaded', 1], ['b', 'error', 0]]);
    await expect(client.spec('c')).rejects.toThrow(/No spec called c/);
  });
});
