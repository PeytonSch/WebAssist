import { describe, expect, it } from 'vitest';
import { chunkKind, diffInline, diffLines, diffSeq, lineCounts, lineKey, words, type Chunk } from '../src/shared/diff';

const L = (s: string) => s.split('\n');

/** Applies the chunks to `a`: the result must be `b` whatever the alignment. */
function patch(a: string[], b: string[], chunks: Chunk[]): string[] {
  const out: string[] = [];
  let at = 0;
  for (const c of chunks) {
    out.push(...a.slice(at, c.a0), ...b.slice(c.b0, c.b1));
    at = c.a1;
  }
  return [...out, ...a.slice(at)];
}

/** "2-3>2-5": lines 2..3 of a replaced by lines 2..5 of b (end exclusive). */
const show = (chunks: Chunk[]) => chunks.map((c) => `${c.a0}-${c.a1}>${c.b0}-${c.b1}`);

describe('diffLines', () => {
  it('finds nothing in equal texts and everything in unrelated ones', () => {
    expect(diffLines(L('a\nb\nc'), L('a\nb\nc'))).toEqual([]);
    expect(diffLines([], [])).toEqual([]);
    expect(show(diffLines([], L('a\nb')))).toEqual(['0-0>0-2']);
    expect(show(diffLines(L('a\nb'), []))).toEqual(['0-2>0-0']);
    expect(show(diffLines(L('a\nb'), L('x\ny'), { coarse: true }))).toEqual(['0-2>0-2']);
  });

  it('reports added, removed and changed lines', () => {
    const a = L('one\ntwo\nthree\nfour');
    expect(show(diffLines(a, L('one\ntwo\nnew\nthree\nfour')))).toEqual(['2-2>2-3']);
    expect(show(diffLines(a, L('one\nthree\nfour')))).toEqual(['1-2>1-1']);
    expect(show(diffLines(a, L('one\nTWO\nthree\nfour')))).toEqual(['1-2>1-2']);
    expect(diffLines(a, L('one\ntwo\nnew\nthree\nfour')).map(chunkKind)).toEqual(['insert']);
    expect(lineCounts(diffLines(a, L('zero\none\nthree\nFOUR')))).toEqual({ added: 2, removed: 2 });
  });

  it('keeps a new block of settings together instead of pairing up its repeated lines', () => {
    const a = L('server:\n  port: 8080\n\ndb:\n  url: x\n\nlog:\n  level: info');
    const b = L('server:\n  port: 8080\n\nmail:\n  host: smtp\n  port: 25\n\ndb:\n  url: x\n\nlog:\n  level: info');
    const chunks = diffLines(a, b);
    expect(show(chunks)).toEqual(['3-3>3-7']);
    expect(b.slice(3, 7)).toEqual(['mail:', '  host: smtp', '  port: 25', '']);
  });

  it('shows a new element from its opening to its closing tag, not from the tag before it', () => {
    const a = L('<Appenders>\n  <File name="a">\n    <P/>\n  </File>\n</Appenders>');
    const b = L('<Appenders>\n  <File name="a">\n    <P/>\n  </File>\n  <File name="b">\n    <P/>\n  </File>\n</Appenders>');
    const [c] = diffLines(a, b);
    expect(b.slice(c.b0, c.b1)).toEqual(['  <File name="b">', '    <P/>', '  </File>']);
    // The same for a removed one.
    const [d] = diffLines(b, a);
    expect(b.slice(d.a0, d.a1)).toEqual(['  <File name="b">', '    <P/>', '  </File>']);
  });

  it('moves an insertion among repeated lines down, next to the line that follows it', () => {
    expect(show(diffLines(L('x\nx\nend'), L('x\nx\nx\nend')))).toEqual(['2-2>2-3']);
    expect(show(diffLines(L('x\nx\nend'), L('x\nend')))).toEqual(['1-2>1-1']);
    // Next to a changed line it stays a block of its own.
    expect(show(diffLines(L('}\n}\nlast: 1'), L('}\n}\n}\nlast: 2')))).toEqual(['2-2>2-3', '2-3>3-4']);
    expect(show(diffLines(L('a\n}\nb\n}\nc'), L('a\n}\nb\n}\n}\nc')))).toEqual(['4-4>4-5']);
  });

  it('takes a changed block apart into the changed line and the added one', () => {
    const a = L('server:\n  port: 9090\nend: 1');
    const b = L('server:\n  port: 8080\n  timeout: 30\nend: 1');
    expect(show(diffLines(a, b, { coarse: true }))).toEqual(['1-2>1-3']);
    const chunks = diffLines(a, b);
    expect(show(chunks)).toEqual(['1-2>1-2', '2-2>2-3']);
    expect(chunks.map(chunkKind)).toEqual(['modify', 'insert']);
  });

  it('pairs lines by key, so values that changed and keys that are new or gone come apart', () => {
    const a = L('a: 1\nold: x\nb: 2\nz: 0');
    const b = L('a: 10\nnew: 5\nb: 20\nz: 0');
    const chunks = diffLines(a, b);
    // old and new are different settings: one removed, one added, not one changed.
    expect(show(chunks)).toEqual(['0-1>0-1', '1-2>1-1', '2-2>1-2', '2-3>2-3']);
    expect(chunks.map(chunkKind)).toEqual(['modify', 'delete', 'insert', 'modify']);
    // Each setting whose value changed is a block of its own, also when they are neighbours.
    expect(show(diffLines(L('a: 1\nb: 2\nc: 3\nz: 0'), L('a: 10\nb: 20\nc: 30\nz: 0')))).toEqual(['0-1>0-1', '1-2>1-2', '2-3>2-3']);
    expect(show(diffLines(L('k: 1\nold: x'), L('k: 1\nnew: y')))).toEqual(['1-2>1-1', '2-2>1-2']);
    // Comments and prose are text, not settings: rewritten lines stay one changed block.
    expect(show(diffLines(L('k: 1\n# the old note\n# about this'), L('k: 1\n# something else entirely\n# was written here\n# in three lines')))).toEqual(['1-3>1-4']);
    expect(show(diffLines(L('# see the wiki for details\n# and ask ops'), L('# see the wiki for the details\n# and ask the ops team')))).toEqual(['0-2>0-2']);
    const c = L('a: 1\nb: 2\nz: 0');
    expect(show(diffLines(c, L('a: 10\nnew: 5\nb: 20\nz: 0')))).toEqual(['0-1>0-1', '1-1>1-2', '1-2>2-3']);
    expect(show(diffLines(L('a: 10\nnew: 5\nb: 20\nz: 0'), c))).toEqual(['0-1>0-1', '1-2>1-1', '2-3>1-2']);
  });

  it('pairs XML elements by tag and name', () => {
    const a = L('<Loggers>\n  <Logger name="a" level="info"/>\n  <Root level="info"/>\n</Loggers>');
    const b = L('<Loggers>\n  <Logger name="a" level="debug"/>\n  <Logger name="b" level="warn"/>\n  <Root level="warn"/>\n</Loggers>');
    expect(show(diffLines(a, b))).toEqual(['1-2>1-2', '2-2>2-3', '2-3>3-4']);
  });

  it('can ignore whitespace', () => {
    const a = L('a: 1\n  b:   2\nc: 3');
    const b = L('a: 1\n    b: 2\nc: 4');
    expect(show(diffLines(a, b))).toEqual(['1-2>1-2', '2-3>2-3']);
    expect(show(diffLines(a, b, { ignoreWhitespace: true }))).toEqual(['2-3>2-3']);
    expect(show(diffLines(a, b, { coarse: true }))).toEqual(['1-3>1-3']);
  });

  it('always gives chunks that turn the first text into the second', () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const pool = ['a: 1', 'b: 2', '', '}', '  x: y', '# note', 'port: 80', 'port: 81', '</a>', 'k = v'];
    for (let round = 0; round < 300; round++) {
      const a = Array.from({ length: rnd(30) }, () => pool[rnd(pool.length)]);
      const b = a.filter(() => rnd(5) > 0).flatMap((l) => (rnd(4) === 0 ? [l, pool[rnd(pool.length)]] : rnd(6) === 0 ? [`${l}!`] : [l]));
      for (const opts of [{}, { coarse: true }]) {
        const chunks = diffLines(a, b, opts);
        expect(patch(a, b, chunks)).toEqual(b);
        for (let i = 0; i < chunks.length; i++) {
          const c = chunks[i];
          expect(c.a1 > c.a0 || c.b1 > c.b0).toBe(true);
          if (i) expect(c.a0 >= chunks[i - 1].a1 && c.b0 >= chunks[i - 1].b1).toBe(true);
        }
      }
    }
  });

  it('copes with long files and long stretches without a unique line', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `key${i}: ${i}`);
    const b = [...a];
    b.splice(100, 0, 'new: 1');
    b[3000] = 'key2999: changed';
    b.splice(5000, 2);
    const t = Date.now();
    expect(show(diffLines(a, b))).toEqual(['100-100>100-101', '2999-3000>3000-3001', '4999-5001>5000-5000']);
    expect(Date.now() - t).toBeLessThan(1000);
    // Nothing but repeated lines: Myers. Too many edits: one block, still correct.
    const x = Array.from({ length: 400 }, (_, i) => (i % 2 ? '}' : '{'));
    const y = Array.from({ length: 380 }, (_, i) => (i % 3 ? '}' : '{'));
    expect(patch(x, y, diffLines(x, y))).toEqual(y);
    const p = Array.from({ length: 3000 }, (_, i) => String(i % 7));
    const q = Array.from({ length: 3000 }, (_, i) => String(i % 5));
    expect(patch(p, q, diffLines(p, q))).toEqual(q);
  });
});

describe('diffSeq', () => {
  it('works on numbers', () => {
    expect(show(diffSeq([1, 2, 3, 4], [1, 3, 4, 5]))).toEqual(['1-2>1-1', '4-4>3-4']);
    expect(show(diffSeq([1, 1, 1], [1, 1]))).toEqual(['2-3>2-2']);
  });
});

describe('lineKey', () => {
  it('names what a line sets', () => {
    expect(lineKey('  port: 8080')).toBe('=port');
    expect(lineKey('mail.smtp.host = x')).toBe('=mail.smtp.host');
    expect(lineKey('  "apiUrl": "http://x",')).toBe('=apiUrl');
    expect(lineKey("  - name: 'a'")).toBe('=name');
    expect(lineKey('const timeout = 30;')).toBe('=timeout');
    expect(lineKey('  <Logger name="com.shop" level="info">')).toBe('<Logger#com.shop');
    expect(lineKey('  </Loggers>')).toBe('</Loggers#');
    expect(lineKey('# port: 1')).toBeNull();
    expect(lineKey('http://example.com/x')).toBeNull();
    expect(lineKey('a == b')).toBeNull();
    expect(lineKey('')).toBeNull();
  });
});

describe('diffInline', () => {
  it('splits text into words that join back to it', () => {
    const text = 'url: "http://x:80/a"\n\tnext_line = 1';
    expect(words(text).join('')).toBe(text);
    expect(words('a.b = 12')).toEqual(['a', '.', 'b', ' ', '=', ' ', '12']);
  });

  it('marks the words that changed in a line', () => {
    const d = diffInline(['  port: 9090'], ['  port: 8080'])!;
    expect(d.a).toEqual([{ line: 0, from: 8, to: 12 }]);
    expect(d.b).toEqual([{ line: 0, from: 8, to: 12 }]);
    const e = diffInline(['url: jdbc:postgresql://localhost/shop'], ['url: jdbc:postgresql://db.internal/shop'])!;
    expect('url: jdbc:postgresql://localhost/shop'.slice(e.a[0].from, e.a[0].to)).toBe('localhost');
    expect('url: jdbc:postgresql://db.internal/shop'.slice(e.b[0].from, e.b[0].to)).toBe('db.internal');
  });

  it('marks only one side when words were only added', () => {
    const d = diffInline(['<Root level="info"/>'], ['<Root level="info" additivity="false"/>'])!;
    expect(d.a).toEqual([]);
    expect(d.b).toHaveLength(1);
    expect('<Root level="info" additivity="false"/>'.slice(d.b[0].from, d.b[0].to)).toBe(' additivity="false"');
  });

  it('works across the lines of a block, by line', () => {
    const a = ['a: 1', 'b: 2', 'c: 3'];
    const b = ['a: 1', 'b: 20', 'c: 30'];
    const d = diffInline(a, b)!;
    expect(d.a).toEqual([{ line: 1, from: 3, to: 4 }, { line: 2, from: 3, to: 4 }]);
    expect(d.b).toEqual([{ line: 1, from: 3, to: 5 }, { line: 2, from: 3, to: 5 }]);
  });

  it('says nothing when the two sides have little in common', () => {
    expect(diffInline(['# the old comment here'], ['timeout: 30'])).toBeNull();
    expect(diffInline([''], ['x'])).toBeNull();
  });
});
