import { describe, expect, it } from 'vitest';
import {
  canTable, cellAt, cellOf, compareNodes, inlinePreview, isRecordTable, keyValueTable, findJsonIn, findTable, jsonPath, jsPath, lossyNumber, parseJson, preview, QueryError, runQuery,
  search, stringify, stringifyCapped, tableOf, toPlain, walk, type JNode, type JObj,
} from '../src/ui/jsonmodel';

const SAMPLES = [
  JSON.stringify({
    data: {
      items: [
        { id: 1, name: 'Widget "A"', price: 9.5, tags: ['a', 'b'], ok: true, note: null },
        { id: 2, name: 'Gadget\nB', price: -12e3, tags: [], ok: false, extra: { deep: [1, [2, [3]]] } },
      ],
      total: 2,
    },
    'a-b': 'dash',
    emoji: '😀 \u00e9 \u0001',
    empty: {},
  }),
  // Pretty-printed with escapes, unicode escapes and odd spacing.
  '{\n  "s": "tab\\there \\u00e9\\ud83d\\ude00 \\"q\\" \\\\ \\/",\n  "n": [0, -0.5, 1E+2, 123456789012345678901234],\n  "x" : [ true , false , null ]\n}',
  '[{"a":1},{"b":[{"c":"d"}]},[],{},"",0]',
];

/**
 * True when `p` (parsed from a prefix of the text) agrees with `f` (parsed from all of it):
 * complete values are equal, and a `cut` value is a prefix of the full one.
 */
function consistent(p: JNode, f: JNode): boolean {
  if (p.t !== f.t) return false;
  switch (p.t) {
    case 'str': return p.cut ? (f as typeof p).v.startsWith(p.v) : p.v === (f as typeof p).v;
    case 'num': return p.cut ? (f as typeof p).raw.startsWith(p.raw) : p.raw === (f as typeof p).raw;
    case 'bool': return p.v === (f as typeof p).v;
    case 'null': return true;
    default: {
      const pk = p.t === 'obj' ? p.vals : p.items;
      const fk = f.t === 'obj' ? f.vals : (f as typeof p & { items: JNode[] }).items;
      if (pk.length > fk.length || (!p.cut && pk.length !== fk.length)) return false;
      if (p.t === 'obj' && p.keys.some((k, i) => k !== (f as typeof p).keys[i])) return false;
      // Only the last value of a cut container can itself be cut.
      return pk.every((v, i) => (!isCut(v) || (p.cut && i === pk.length - 1)) && consistent(v, fk[i]));
    }
  }
}
const isCut = (n: JNode) => 'cut' in n && !!n.cut;

describe('parseJson', () => {
  it('matches JSON.parse on complete input', () => {
    for (const text of SAMPLES) {
      const r = parseJson(text);
      expect(r.error).toBeNull();
      expect(r.partial).toBe(false);
      expect(toPlain(r.root!)).toEqual(JSON.parse(text));
    }
  });

  it('never throws on any prefix, and every prefix agrees with the full parse', () => {
    for (const text of SAMPLES) {
      const full = parseJson(text).root!;
      for (let i = 0; i < text.length; i++) {
        const r = parseJson(text.slice(0, i));
        expect(r.error, `prefix ${i}: ${text.slice(0, i)}`).toBeNull();
        expect(r.partial, `prefix ${i}`).toBe(true);
        if (r.root) expect(consistent(r.root, full), `prefix ${i}: ${text.slice(0, i)}`).toBe(true);
      }
    }
  });

  it('marks open containers and the value cut mid-way', () => {
    const r = parseJson('{"items":[{"id":1,"name":"Wid');
    expect(r.partial).toBe(true);
    const root = r.root as Extract<JNode, { t: 'obj' }>;
    expect(root.cut).toBe(true);
    const items = root.vals[0] as Extract<JNode, { t: 'arr' }>;
    expect(items.cut).toBe(true);
    const item = items.items[0] as Extract<JNode, { t: 'obj' }>;
    expect(item.keys).toEqual(['id', 'name']);
    expect(item.vals[1]).toEqual({ t: 'str', v: 'Wid', cut: true });
    // A key without its value is dropped; a complete earlier sibling stays complete.
    const r2 = parseJson('{"a":1,"b"');
    expect(toPlain(r2.root!)).toEqual({ a: 1 });
    expect((r2.root as { vals: JNode[] }).vals[0]).toEqual({ t: 'num', raw: '1' });
    // A number at the very end of a cut body may have had more digits.
    expect(parseJson('[1,23').root).toEqual({ t: 'arr', items: [{ t: 'num', raw: '1' }, { t: 'num', raw: '23', cut: true }], cut: true });
    // Half an escape is left out rather than shown wrongly.
    expect(parseJson('["ab\\u00').root).toEqual({ t: 'arr', items: [{ t: 'str', v: 'ab', cut: true }], cut: true });
  });

  it('keeps numbers as written', () => {
    const text = '{"id": 12345678901234567890, "small": 1.50, "exp": 1e400}';
    const r = parseJson(text);
    expect(stringify(r.root!, 0)).toBe('{"id":12345678901234567890,"small":1.50,"exp":1e400}');
    expect(lossyNumber('12345678901234567890')).toBe('12345678901234567000');
    expect(lossyNumber('9007199254740993')).toBe('9007199254740992');
    expect(lossyNumber('9007199254740991')).toBeNull();
    expect(lossyNumber('1.5')).toBeNull();
  });

  it('reports syntax errors with line and column', () => {
    const r = parseJson('{\n  "a": 1,\n  "b": tru e\n}');
    expect(r.root).toBeNull();
    expect(r.error).toMatchObject({ line: 3, col: 8 });
    expect(parseJson('{"a" 1}').error?.message).toMatch(/Expected ':'/);
    expect(parseJson('[1,]').error?.message).toMatch(/Unexpected/);
    expect(parseJson('[1] x').error?.message).toMatch(/after the end/);
    expect(parseJson('["\\x"]').error?.message).toMatch(/Invalid escape/);
    expect(parseJson('[01]').error?.message).toMatch(/Invalid number/);
    expect(parseJson('<html>').error).not.toBeNull();
  });

  it('skips a BOM and an anti-hijacking prefix', () => {
    expect(toPlain(parseJson('\ufeff{"a":1}').root!)).toEqual({ a: 1 });
    expect(toPlain(parseJson(")]}',\n[1]").root!)).toEqual([1]);
  });

  it('does not overflow the stack on deep nesting', () => {
    const deep = '['.repeat(50_000) + ']'.repeat(50_000);
    expect(parseJson(deep).error).toBeNull();
  });

  it('is quick on large bodies', () => {
    const big = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['x', 'y'], price: i / 7 })));
    const t = performance.now();
    const r = parseJson(big);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(r.nodes).toBe(1 + 50_000 * 7);
    expect(stringify(r.root!, 0)).toBe(big);
  });
});

describe('paths', () => {
  it('formats JS and JSONPath paths, quoting keys that need it', () => {
    expect(jsPath([])).toBe('');
    expect(jsPath(['data', 'items', 3, 'price'])).toBe('data.items[3].price');
    expect(jsPath(['a-b', 'c'])).toBe('["a-b"].c');
    expect(jsPath(['x', 'with space', '$ok', '1st', 'q"uote'])).toBe('x["with space"].$ok["1st"]["q\\"uote"]');
    expect(jsonPath([])).toBe('$');
    expect(jsonPath(['data', 'items', 3, 'price'])).toBe('$.data.items[3].price');
    expect(jsonPath(['a-b'])).toBe('$["a-b"]');
  });

  it('round-trips through the query language', () => {
    const root = parseJson('{"a-b": {"c d": [{"x.y": 1}, {"x.y": 2}]}, "ok": true}').root!;
    const path = ['a-b', 'c d', 1, 'x.y'];
    for (const expr of [jsPath(path), jsonPath(path)]) {
      const hits = runQuery(root, expr);
      expect(hits.map((h) => h.path)).toEqual([path]);
      expect(hits[0].node).toEqual({ t: 'num', raw: '2' });
    }
    expect(walk(root, path)?.at(-1)).toEqual({ t: 'num', raw: '2' });
    expect(walk(root, ['nope'])).toBeNull();
  });
});

describe('runQuery', () => {
  const root = parseJson(JSON.stringify({
    data: {
      items: [
        { id: 1, name: 'pen', price: 2, status: 'open', tags: ['red'] },
        { id: 2, name: 'book', price: 15, status: 'closed' },
        { id: 3, name: 'lamp', price: 40, status: 'open', tags: [] },
      ],
      owner: { id: 99 },
    },
  })).root!;
  const values = (expr: string) => runQuery(root, expr).map((h) => toPlain(h.node));
  const paths = (expr: string) => runQuery(root, expr).map((h) => jsPath(h.path));

  it('walks names and indexes', () => {
    expect(values('data.items[0].name')).toEqual(['pen']);
    expect(values('$.data.items[0].name')).toEqual(['pen']);
    expect(values('data.items.1.name')).toEqual(['book']);
    expect(values('data.items[-1].id')).toEqual([3]);
    expect(values('data["owner"]')).toEqual([{ id: 99 }]);
    expect(values("data['owner'].id")).toEqual([99]);
    expect(values('$')).toHaveLength(1);
    expect(values('')).toHaveLength(1);
    expect(values('data.missing')).toEqual([]);
    expect(values('data.items[7]')).toEqual([]);
  });

  it('supports wildcards, slices, unions and recursive descent', () => {
    expect(values('data.items[*].price')).toEqual([2, 15, 40]);
    expect(values('data.items.*.id')).toEqual([1, 2, 3]);
    expect(values('data.items[1:].id')).toEqual([2, 3]);
    expect(values('data.items[:-1].id')).toEqual([1, 2]);
    expect(values('data.items[0,2].id')).toEqual([1, 3]);
    expect(values('data.items[0]["id","name"]')).toEqual([1, 'pen']);
    expect(paths('..id')).toEqual(['data.items[0].id', 'data.items[1].id', 'data.items[2].id', 'data.owner.id']);
    expect(values('..tags[0]')).toEqual(['red']);
    expect(values('data..[0].name')).toEqual(['pen']);
  });

  it('filters', () => {
    expect(values('data.items[?(@.price > 10)].name')).toEqual(['book', 'lamp']);
    expect(values('data.items[?(@.status == "open" && @.price < 10)].name')).toEqual(['pen']);
    expect(values("data.items[?(@.status != 'open' || @.id == 3)].id")).toEqual([2, 3]);
    expect(values('data.items[?(@.tags)].id')).toEqual([1, 3]);
    expect(values('data.items[?(!@.tags)].id')).toEqual([2]);
    expect(values('data.items[?@.name >= "lamp"].id')).toEqual([1, 3]);
  });

  it('rejects invalid expressions with a position', () => {
    for (const [expr, pos] of [['data.', 5], ['data.items[', 11], ['data.items[0', 12], ['data items', 5], ['a[?(@.x ==)]', 10], ['a["x', 2]] as const) {
      let err: unknown;
      try {
        runQuery(root, expr);
      } catch (e) {
        err = e;
      }
      expect(err, expr).toBeInstanceOf(QueryError);
      expect((err as QueryError).pos, expr).toBe(pos);
    }
  });
});

describe('search', () => {
  it('finds keys and values case-insensitively, one match per node, with ancestors', () => {
    const root = parseJson('{"Name": "x", "list": [{"name": "NAMED"}, 5], "n": 15, "flag": null}').root!;
    const { matches, total } = search([root], 'name');
    expect(total).toBe(2);
    expect(matches.map((m) => [jsPath(m.path), m.key, m.value])).toEqual([
      ['Name', true, false],
      ['list[0].name', true, true],
    ]);
    expect(matches[1].ancestors.length).toBe(3);
    expect(search([root], '5').matches.map((m) => jsPath(m.path))).toEqual(['list[1]', 'n']);
    expect(search([root], 'null').total).toBe(1);
    expect(search([root], '').total).toBe(0);
  });
});

describe('tables', () => {
  it('takes columns from the union of keys in first-seen order', () => {
    const t = tableOf(parseJson('[{"id":1,"a":2},{"id":2,"b":{"x":1}},3]').root!)!;
    expect(t.columns).toEqual(['id', 'a', 'b']);
    expect(t.valueColumn).toBe(true);
    expect(t.rows.map((r) => r.seg)).toEqual([0, 1, 2]);
    expect(cellOf(t.rows[1].node, 'b')?.t).toBe('obj');
    expect(cellOf(t.rows[0].node, 'b')).toBeUndefined();
  });

  it('tabulates a map of records by key, but not plain values', () => {
    const t = tableOf(parseJson('{"u1":{"name":"a"},"u2":{"name":"b","age":3}}').root!)!;
    expect(t.rows.map((r) => r.seg)).toEqual(['u1', 'u2']);
    expect(t.columns).toEqual(['name', 'age']);
    expect(tableOf(parseJson('{"a":1}').root!)).toBeNull();
    expect(tableOf(parseJson('[]').root!)).toBeNull();
    // An envelope of unrelated objects is not a table.
    expect(tableOf(parseJson('{"meta":{"count":1,"page":2},"data":{"items":[]}}').root!)).toBeNull();
  });

  it('tabulates arrays of plain values and of arrays too', () => {
    const values = tableOf(parseJson('["a","b",3]').root!)!;
    expect(values).toMatchObject({ columns: [], indexColumns: 0, valueColumn: true });
    expect(values.rows).toHaveLength(3);

    const tuples = tableOf(parseJson('[["2026-11-01", 3], ["2026-11-02", 5, "late"]]').root!)!;
    expect(tuples).toMatchObject({ columns: [], indexColumns: 3, valueColumn: false });
    expect(cellAt(tuples.rows[1].node, 2)).toMatchObject({ t: 'str', v: 'late' });
    expect(cellAt(tuples.rows[0].node, 2)).toBeUndefined();

    // Arrays wider than the column cap still show whole, in the value column.
    const wide = tableOf(parseJson(JSON.stringify([Array.from({ length: 30 }, (_, i) => i)])).root!, 10)!;
    expect(wide).toMatchObject({ indexColumns: 10, valueColumn: true, hiddenColumns: 20 });

    expect(tableOf(parseJson('[{}, {}]').root!)).toMatchObject({ columns: [], valueColumn: true });
    expect(keyValueTable(parseJson('{"id":7,"address":{"city":"London"}}').root as JObj).rows.map((r) => r.seg)).toEqual(['id', 'address']);
    expect(canTable(parseJson('[1]').root!)).toBe(true);
    expect(isRecordTable(parseJson('[1]').root!)).toBe(false);
    expect(isRecordTable(parseJson('[{"a":1}]').root!)).toBe(true);
  });

  it('caps the columns', () => {
    const obj = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const t = tableOf(parseJson(JSON.stringify([obj])).root!, 10)!;
    expect(t.columns).toHaveLength(10);
    expect(t.hiddenColumns).toBe(20);
  });

  it('sorts numbers by value and strings naturally, missing last', () => {
    const nodes = parseJson('[10, 9, "item 10", "item 9", null, true]').root as { items: JNode[] };
    const sorted = [...nodes.items, undefined].sort(compareNodes).map((n) => (n ? toPlain(n) : 'missing'));
    expect(sorted).toEqual([9, 10, 'item 9', 'item 10', true, null, 'missing']);
  });

  it('finds the first array of objects breadth first', () => {
    const hit = findTable(parseJson('{"meta":{"tags":["a"]},"data":{"items":[{"id":1}]}}').root!);
    expect(hit && jsPath(hit.path)).toBe('data.items');
  });
});

describe('helpers', () => {
  it('prints only the start of big values when capped', () => {
    const root = parseJson(JSON.stringify({ items: Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `n${i}` })) })).root!;
    const capped = stringifyCapped(root, 2, 1000);
    expect(capped.cut).toBe(true);
    expect(capped.text.length).toBe(1000);
    expect(stringify(root).startsWith(capped.text)).toBe(true);
    const small = parseJson('{"a":[1,{"b":null}]}').root!;
    expect(stringifyCapped(small, 2, 1000)).toEqual({ text: stringify(small), cut: false });
    expect(canTable(root)).toBe(false);
    expect(canTable((root as { vals: JNode[] }).vals[0])).toBe(true);
  });

  it('previews nested values in table cells, looking inside them', () => {
    const order = parseJson('{"address":{"city":"London","postCode":"NW1"},"items":[{"sku":"S-1","price":9.99},{"sku":"T-1","price":19.5}],"tags":["a","b"],"empty":{}}').root as { vals: JNode[] };
    expect(inlinePreview(order.vals[0])).toBe('{city: "London", postCode: "NW1"}');
    expect(inlinePreview(order.vals[1])).toBe('(2) [{sku: "S-1", price: 9.99}, {sku: "T-1", price: 19.5}]');
    expect(inlinePreview(order.vals[2])).toBe('(2) ["a", "b"]');
    expect(inlinePreview(order.vals[3])).toBe('{}');
    const long = inlinePreview(order.vals[1], 30);
    expect(long.length).toBeLessThanOrEqual(30 + '(2) '.length);
    expect(long).toMatch(/^\(2\) \[\{sku: "S-1", .*…$/);
    // Deep nesting is summarised rather than followed forever.
    const deep = parseJson('{"a":{"b":{"c":{"d":{"e":1,"f":2}}}}}').root!;
    expect(inlinePreview(deep)).toBe('{a: {b: {c: {d: {2 keys}}}}}');
  });

  it('previews values on one line', () => {
    const root = parseJson('{"id":1,"name":"Ada","tags":["x"],"o":{}}').root!;
    expect(preview(root)).toBe('{id: 1, name: "Ada", tags: […], o: {}}');
    expect(preview(root, 20)).toBe('{id: 1, name: "Ada", …}');
  });

  it('finds JSON embedded in log messages', () => {
    expect(findJsonIn('Loaded [3] items for {"order": {"id": 7}} done')?.text).toBe('{"order": {"id": 7}}');
    expect(findJsonIn('[INFO] payload=[{"a":1}]')?.text).toBe('[{"a":1}]');
    expect(findJsonIn('Map {} and [1, 2]')).toBeNull();
    expect(findJsonIn('cut {"a": 1')).toBeNull();
  });
});
