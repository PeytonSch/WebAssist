import { describe, expect, it } from 'vitest';
import { completions, nestedFallback, splitForCompletion } from '../src/ui/jsoncomplete';
import { parseJson, runQuery, type JNode } from '../src/ui/jsonmodel';

const doc = (v: unknown): JNode => parseJson(JSON.stringify(v)).root!;

const ORDERS = doc({
  data: {
    customer: { name: 'Ada', userName: 'ada' },
    items: [
      { id: 1, price: 9.5, sku: 'A-1', 'unit-cost': 4 },
      { id: 2, price: 12, sku: 'B-2', tags: ['x'] },
    ],
    total: 21.5,
  },
  meta: { page: 1, priceList: 'retail' },
});

const texts = (expr: string, root = ORDERS) => completions(root, expr).map((s) => s.text);

describe('splitForCompletion', () => {
  it('finds the step being typed', () => {
    expect(splitForCompletion('')).toEqual({ context: '', partial: '', opener: '' });
    expect(splitForCompletion('da')).toEqual({ context: '', partial: 'da', opener: '' });
    expect(splitForCompletion('data.it')).toEqual({ context: 'data', partial: 'it', opener: '.' });
    expect(splitForCompletion('data.items[*].')).toEqual({ context: 'data.items[*]', partial: '', opener: '.' });
    expect(splitForCompletion('data..pr')).toEqual({ context: 'data', partial: 'pr', opener: '..' });
    expect(splitForCompletion('..pr')).toEqual({ context: '', partial: 'pr', opener: '..' });
    expect(splitForCompletion('$')).toEqual({ context: '$', partial: '', opener: '.' });
    expect(splitForCompletion('$.da')).toEqual({ context: '$', partial: 'da', opener: '.' });
    expect(splitForCompletion('items[')).toEqual({ context: 'items', partial: '', opener: '[' });
    expect(splitForCompletion('items["un')).toEqual({ context: 'items', partial: 'un', opener: '["' });
    expect(splitForCompletion('a["x.y"].b')).toEqual({ context: 'a["x.y"]', partial: 'b', opener: '.' });
  });

  it('declines where no name can go', () => {
    expect(splitForCompletion('items[0')).toBeNull();
    expect(splitForCompletion('items[?(@.price > ')).toBeNull();
    expect(splitForCompletion('items]')).toBeNull();
    expect(splitForCompletion('items[0] ')).toBeNull();
  });
});

describe('completions', () => {
  it('offers the keys at the top, ranked by how well they match', () => {
    expect(texts('')).toEqual(['data', 'meta']);
    expect(texts('me')).toEqual(['meta']);
  });

  it('offers keys after a dot, and quotes keys that need it', () => {
    expect(texts('data.')).toEqual(expect.arrayContaining(['data.customer', 'data.items', 'data.total']));
    expect(texts('data.items[*].un')).toContain('data.items[*]["unit-cost"]');
    expect(texts('data.items["un')).toEqual([]); // items is an array: no keys right there
  });

  it('offers [*], [0] and [-1] for arrays, and the keys of their items', () => {
    const t = texts('data.items');
    expect(t).not.toContain('data.items'); // the text itself is not a suggestion
    const after = texts('data.items.');
    expect(after).toEqual(expect.arrayContaining(['data.items[*].id', 'data.items[*].price']));
    const s = completions(ORDERS, 'data.items[');
    expect(s.map((x) => x.text)).toEqual(expect.arrayContaining(['data.items[*]', 'data.items[0]', 'data.items[-1]']));
  });

  it('matches nested paths for a name that is not at this level', () => {
    const s = completions(ORDERS, 'price');
    const t = s.map((x) => x.text);
    expect(t).toContain('data.items[*].price');
    expect(t).toContain('..price');
    expect(t).toContain('meta.priceList');
    expect(s.find((x) => x.text === 'data.items[*].price')).toMatchObject({ kind: 'nested', detail: 'number · 2 values' });
    expect(s.find((x) => x.text === '..price')?.kind).toBe('any-depth');
    // Exact names come before longer ones.
    expect(t.indexOf('data.items[*].price')).toBeLessThan(t.indexOf('meta.priceList'));
  });

  it('matches anywhere in a key, preferring word starts', () => {
    const t = texts('name');
    expect(t[0]).toBe('data.customer.name');
    expect(t).toContain('data.customer.userName');
  });

  it('every suggestion is a valid query that finds something', () => {
    for (const expr of ['', 'd', 'data.', 'price', 'data.items.', 'data.items[', 'cust', '..s', 'meta.p', 'name', 'cost', '..unit']) {
      for (const s of completions(ORDERS, expr)) {
        expect(() => runQuery(ORDERS, s.text), `${expr} → ${s.text}`).not.toThrow();
        expect(runQuery(ORDERS, s.text).length, `${expr} → ${s.text}`).toBeGreaterThan(0);
      }
    }
  });

  it('completes under a name further down when the start is not at the top', () => {
    expect(texts('customer.na')).toEqual(expect.arrayContaining(['..customer.name']));
  });

  it('offers what follows a finished path', () => {
    expect(texts('data.customer')).toEqual(['data.customer.name', 'data.customer.userName']);
    expect(texts('data.items')).toEqual(expect.arrayContaining(['data.items[*]', 'data.items[*].price']));
    expect(texts('data.total')).toEqual([]);
  });

  it('offers any-depth keys after ..', () => {
    expect(texts('..pr')).toEqual(['..price', '..priceList']);
  });

  it('stays quick on a big document', () => {
    const big = doc({ rows: Array.from({ length: 20_000 }, (_, i) => ({ id: i, user: { name: `u${i}`, roles: ['a', 'b'] }, amount: i * 1.5 })) });
    const t0 = performance.now();
    completions(big, 'na');
    completions(big, 'nam');
    completions(big, 'rows[*].user.');
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(texts('nam', big)).toEqual(expect.arrayContaining(['rows[*].user.name', '..name']));
  });
});

describe('nestedFallback', () => {
  it('finds a path typed from the wrong level', () => {
    const f = nestedFallback(ORDERS, 'price');
    expect(f?.expr).toBe('..price');
    expect(f?.hits.map((h) => h.path)).toEqual([['data', 'items', 0, 'price'], ['data', 'items', 1, 'price']]);
    expect(nestedFallback(ORDERS, 'customer.name')?.hits).toHaveLength(1);
  });

  it('leaves paths that say where they start, and misses, alone', () => {
    expect(nestedFallback(ORDERS, '$.price')).toBeNull();
    expect(nestedFallback(ORDERS, '..price')).toBeNull();
    expect(nestedFallback(ORDERS, 'nothing')).toBeNull();
    expect(nestedFallback(ORDERS, 'items[')).toBeNull();
  });
});
