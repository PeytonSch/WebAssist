import { describe, expect, it } from 'vitest';
import { brief, jsonChanges, parseJson, pathStep, prettyJson } from '../src/shared/jsondiff';

describe('JSON compare model', () => {
  it('pretty-prints like JSON.stringify, noting the line of each value', () => {
    const v = { b: 1, a: [1, { 'x y': null }, []], c: {}, s: 'é' };
    const p = prettyJson(v);
    expect(p.lines.join('\n')).toBe(JSON.stringify(v, null, 2));
    expect(p.lineOf.get('$')).toBe(0);
    expect(p.lineOf.get('$.a[1]["x y"]')).toBe(5);
    expect(p.lineOf.get('$.c')).toBe(p.lines.indexOf('  "c": {},'));
  });

  it('sorts keys when asked, at every level', () => {
    const p = prettyJson({ b: { z: 1, y: 2 }, a: 1 }, { sortKeys: true });
    expect(p.lines).toEqual(['{', '  "a": 1,', '  "b": {', '    "y": 2,', '    "z": 1', '  }', '}']);
    expect(prettyJson('text').lines).toEqual(['"text"']);
  });

  it('writes paths as they are read', () => {
    expect(pathStep('name')).toBe('.name');
    expect(pathStep('odd key')).toBe('["odd key"]');
    expect(pathStep(3)).toBe('[3]');
  });

  it('lists what was added, removed and changed, by path', () => {
    const { changes } = jsonChanges({ n: 1, o: { k: 1 }, t: 'x', same: [1, 2] }, { n: 2, o: { j: 1 }, t: 5, same: [1, 2] });
    // In document order: inside o, what went before what came.
    expect(changes).toEqual([
      { path: '$.n', kind: 'changed', before: '1', after: '2' },
      { path: '$.o.k', kind: 'removed', before: '1' },
      { path: '$.o.j', kind: 'added', after: '1' },
      { path: '$.t', kind: 'changed', before: '"x"', after: '5' },
    ]);
    expect(jsonChanges({ a: [1] }, { a: [1] }).changes).toEqual([]);
  });

  it('matches array elements up, so an insertion is one addition', () => {
    const a = { items: [{ id: 1 }, { id: 2 }, { id: 3, qty: 1 }] };
    const b = { items: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3, qty: 2 }] };
    expect(jsonChanges(a, b).changes).toEqual([
      { path: '$.items[0]', kind: 'added', after: '{… 1 key}' },
      { path: '$.items[3].qty', kind: 'changed', before: '1', after: '2' },
    ]);
    expect(jsonChanges([1, 2, 3], [1, 3]).changes).toEqual([{ path: '$[1]', kind: 'removed', before: '2' }]);
  });

  it('stops listing at the limit, and says so', () => {
    const a = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    const r = jsonChanges(a, {}, 10);
    expect(r.changes).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('shortens values for the list', () => {
    expect(brief([1, 2])).toBe('[… 2 items]');
    expect(brief({})).toBe('{}');
    expect(brief('x'.repeat(100), 10)).toBe('"xxxxxxxx…');
  });

  it('parses, and says why not', () => {
    expect(parseJson(' {"a":1} ')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson('  ')).toEqual({ ok: false, error: 'Empty' });
    const bad = parseJson('{"a": 1,\n "b": }');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Not valid JSON: /);
    if (!bad.ok) expect(bad.error).not.toContain('"b"');
  });
});
