import { describe, expect, it } from 'vitest';
import { compileQuery, countLabel, findAll, locate, MAX_MATCHES, pieceStarts, step, type Compiled } from '../src/ui/findtext';

const re = (c: Compiled | null) => {
  if (!c || !('re' in c)) throw new Error('expected a regex');
  return c.re;
};
const plain = (q: string, caseSensitive = false) => re(compileQuery(q, { caseSensitive, regex: false }));
const regex = (q: string, caseSensitive = false) => re(compileQuery(q, { caseSensitive, regex: true }));
const texts = (text: string, r: RegExp) => findAll(text, r).matches.map((m) => text.slice(m.start, m.end));

describe('compileQuery', () => {
  it('is null for an empty query', () => {
    expect(compileQuery('', { caseSensitive: false, regex: true })).toBeNull();
  });

  it('treats plain text literally, regex characters included', () => {
    expect(texts('a.b axb (a.b) [1] $x', plain('a.b'))).toEqual(['a.b', 'a.b']);
    expect(texts('total: $1.50 (est.)', plain('$1.50 (est.)'))).toEqual(['$1.50 (est.)']);
    expect(texts('x[1] x1', plain('[1]'))).toEqual(['[1]']);
    expect(texts('a\\b', plain('\\'))).toEqual(['\\']);
  });

  it('ignores case unless asked not to', () => {
    expect(texts('Error error ERROR', plain('error'))).toEqual(['Error', 'error', 'ERROR']);
    expect(texts('Error error ERROR', plain('error', true))).toEqual(['error']);
    expect(texts('Error error ERROR', regex('E\\w+', true))).toEqual(['Error', 'ERROR']);
  });

  it('matches ^ and $ per line in regex mode', () => {
    expect(texts('one\ntwo\nthree', regex('^t\\w+$'))).toEqual(['two', 'three']);
  });

  it('reports a bad pattern instead of throwing', () => {
    const c = compileQuery('(unclosed', { caseSensitive: false, regex: true });
    expect(c && 'error' in c && c.error).toBeTruthy();
    expect(compileQuery('[', { caseSensitive: false, regex: true })).toHaveProperty('error');
    // The same text is fine as plain text.
    expect(compileQuery('(unclosed', { caseSensitive: false, regex: false })).toHaveProperty('re');
  });
});

describe('findAll', () => {
  it('finds every match with its offsets', () => {
    expect(findAll('abcabc', plain('bc')).matches).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
    ]);
  });

  it('does not overlap matches', () => {
    expect(texts('aaaa', plain('aa'))).toEqual(['aa', 'aa']);
  });

  it('can be run again with the same regex', () => {
    const r = plain('x');
    expect(findAll('x x', r).matches).toHaveLength(2);
    expect(findAll('x', r).matches).toHaveLength(1);
  });

  it('steps over empty matches instead of looping', () => {
    expect(findAll('abc', regex('x*')).matches).toEqual([]);
    expect(findAll('', regex('.*')).matches).toEqual([]);
    expect(texts('ab\n\ncd', regex('.*'))).toEqual(['ab', 'cd']);
    expect(texts('baab', regex('a*'))).toEqual(['aa']);
    expect(findAll('one\ntwo', regex('^')).matches).toEqual([]);
    expect(findAll('one two', regex('\\b')).matches).toEqual([]);
  });

  it('stops at the limit and says there is more', () => {
    const text = 'x'.repeat(MAX_MATCHES + 10);
    const all = findAll(text, plain('x'));
    expect(all.matches).toHaveLength(MAX_MATCHES);
    expect(all.more).toBe(true);
    expect(findAll('x x x', plain('x'), 3).more).toBe(false);
    expect(findAll('x x x', plain('x'), 2)).toEqual({ matches: [{ start: 0, end: 1 }, { start: 2, end: 3 }], more: true });
    expect(findAll('x x', plain('x'), 0)).toEqual({ matches: [], more: true });
  });

  it('gives up when out of time and says there is more', () => {
    let t = 0;
    const now = () => (t += 10);
    const found = findAll('a'.repeat(100_000), regex('b*'), MAX_MATCHES, 50, now);
    expect(found.more).toBe(true);
  });

  it('copes with a multi-megabyte body quickly', () => {
    const body = JSON.stringify(
      Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `item ${i}`, status: i % 13 ? 'open' : 'closed' })),
      null,
      2,
    );
    expect(body.length).toBeGreaterThan(3_000_000);
    const t0 = Date.now();
    const closed = findAll(body, plain('"closed"'));
    const any = findAll(body, regex('.*'));
    const empty = findAll(body, regex('z*'), MAX_MATCHES, 2000);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(closed.matches).toHaveLength(Math.ceil(50_000 / 13));
    expect(closed.more).toBe(false);
    expect(any.matches).toHaveLength(MAX_MATCHES);
    expect(any.more).toBe(true);
    expect(empty.matches).toHaveLength(0);
  });
});

describe('locate', () => {
  // "ab" + "" + "cde" + "f": how a highlighted line is split into text nodes.
  const starts = pieceStarts([2, 0, 3, 1]);

  it('computes where each piece starts', () => {
    expect(starts).toEqual([0, 2, 2, 5]);
    expect(pieceStarts([])).toEqual([]);
  });

  it('finds the piece and the offset inside it', () => {
    expect(locate(starts, 0)).toEqual([0, 0]);
    expect(locate(starts, 1)).toEqual([0, 1]);
    expect(locate(starts, 3)).toEqual([2, 1]);
    expect(locate(starts, 5)).toEqual([3, 0]);
  });

  it('puts a start on a boundary in the next piece, skipping empty ones', () => {
    expect(locate(starts, 2)).toEqual([2, 0]);
  });

  it('puts an end on a boundary in the previous piece', () => {
    expect(locate(starts, 2, true)).toEqual([0, 2]);
    expect(locate(starts, 5, true)).toEqual([2, 3]);
    expect(locate(starts, 6, true)).toEqual([3, 1]);
    expect(locate(starts, 0, true)).toEqual([0, 0]);
  });

  it('maps a match that crosses pieces back to the right text', () => {
    const pieces = ['{"', 'name', '": "', 'Ada', '"}'];
    const text = pieces.join('');
    const s = pieceStarts(pieces.map((p) => p.length));
    const [m] = findAll(text, plain('me": "Ad')).matches;
    const [si, so] = locate(s, m.start);
    const [ei, eo] = locate(s, m.end, true);
    expect([si, so, ei, eo]).toEqual([1, 2, 3, 2]);
    expect(pieces[si].slice(so) + pieces.slice(si + 1, ei).join('') + pieces[ei].slice(0, eo)).toBe('me": "Ad');
  });
});

describe('step and countLabel', () => {
  it('wraps around both ends', () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, 1, 3)).toBe(0);
    expect(step(0, -1, 3)).toBe(2);
    expect(step(0, 1, 0)).toBe(-1);
  });

  it('reads like a find bar', () => {
    expect(countLabel(2, 17, false)).toBe('3 of 17');
    expect(countLabel(0, 5000, true)).toBe('1 of 5,000+');
    expect(countLabel(-1, 0, false)).toBe('No matches');
  });
});
