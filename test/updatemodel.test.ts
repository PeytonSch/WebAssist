import { describe, expect, it } from 'vitest';
import { changedRanges, commitTag, groupByDir, initials, parseDiff, reflow, statBlocks } from '../src/shell/updatemodel';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function main() {
 const a = 1;
-const name = 'old value';
+const name = 'new value';
+const extra = true;
 return a;
\\ No newline at end of file
`;

describe('parseDiff', () => {
  it('numbers lines on both sides and keeps the hunk context', () => {
    const d = parseDiff(DIFF);
    expect(d.binary).toBe(false);
    expect(d.hunks).toHaveLength(1);
    const hk = d.hunks[0];
    expect(hk.context).toBe('export function main() {');
    expect(hk.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['ctx', 10, 10], ['del', 11, undefined], ['add', undefined, 11], ['add', undefined, 12], ['ctx', 12, 13], ['note', undefined, undefined],
    ]);
  });

  it('marks the changed words of a replaced line, not the unpaired addition', () => {
    const [, del, add, extra] = parseDiff(DIFF).hunks[0].lines;
    expect(del.text.slice(...del.changed!)).toBe('old');
    expect(add.text.slice(...add.changed!)).toBe('new');
    expect(extra.changed).toBeUndefined();
  });

  it('recognises binary, new and deleted files', () => {
    expect(parseDiff('diff --git a/x.png b/x.png\nnew file mode 100644\nBinary files /dev/null and b/x.png differ').binary).toBe(true);
    expect(parseDiff('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi').status).toBe('new');
    expect(parseDiff('diff --git a/x b/x\ndeleted file mode 100644\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-hi').status).toBe('deleted');
  });
});

describe('changedRanges', () => {
  it('skips lines that were mostly rewritten', () => {
    expect(changedRanges('abcdef', 'uvwxyz')).toEqual([null, null]);
  });
  it('marks a pure insertion only on the new side', () => {
    expect(changedRanges('foo(a, b)', 'foo(a, x, b)')).toEqual([null, [7, 10]]);
  });
});

describe('statBlocks', () => {
  it('fills fewer blocks for small changes and splits by share', () => {
    expect(statBlocks(1, 0)).toEqual(['add', 'none', 'none', 'none', 'none']);
    const big = statBlocks(900, 100);
    expect(big.filter((k) => k !== 'none')).toHaveLength(5);
    expect(big).toContain('del');
    expect(statBlocks(null, null)).toEqual(['none', 'none', 'none', 'none', 'none']);
  });
});

describe('groupByDir', () => {
  it('puts top-level files first, then folders in order', () => {
    const g = groupByDir([{ path: 'src/ui/b.ts' }, { path: 'README.md' }, { path: 'src/a.ts' }, { path: 'src/ui/a.ts' }]);
    expect(g.map((x) => [x.dir, x.files.map((f) => f.name)])).toEqual([['', ['README.md']], ['src', ['a.ts']], ['src/ui', ['b.ts', 'a.ts']]]);
  });
});

describe('commitTag', () => {
  it('reads conventional prefixes and leading verbs', () => {
    expect(commitTag('feat(ui): metrics screen')).toBe('new');
    expect(commitTag('Fix the latency chart scale')).toBe('fix');
    expect(commitTag('Add a Metrics screen')).toBe('new');
    expect(commitTag('README: screenshots')).toBe('docs');
    expect(commitTag('Updater: retry through the proxy')).toBe('improved');
  });
  it('initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('claude')).toBe('CL');
  });
});

describe('reflow', () => {
  it('joins wrapped lines into paragraphs and list items, and keeps indented code', () => {
    const body = 'The owner asked for a page showing\nhow often each endpoint is hit.\n\n- Tiles: requests,\n  error rate\n- Charts\nAfter the list.\n\n    npm run app\n    git pull';
    expect(reflow(body)).toEqual([
      { kind: 'p', text: 'The owner asked for a page showing how often each endpoint is hit.' },
      { kind: 'list', items: ['Tiles: requests, error rate', 'Charts'] },
      { kind: 'p', text: 'After the list.' },
      { kind: 'pre', text: '    npm run app\n    git pull' },
    ]);
  });
});
