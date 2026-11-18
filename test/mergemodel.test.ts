import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/shared/diff';
import {
  applySplices, changes, computeFolds, ignoreKey, invertSplices, mapLine, MergeDoc, mergeOutcome, newSettingsSplices, restoreDeployed, shiftFolds, stepChange, takeBoth, takeFromBuild, validFolds,
  type Splice,
} from '../src/shared/mergemodel';

const L = (s: string) => s.split('\n');

const deployed = L(
  ['server:', '  port: 9090', '  host: 0.0.0.0', 'db:', '  url: jdbc:postgresql://localhost/shop', '  user: me', 'legacy:', '  mode: on', 'log: info', ''].join('\n'),
);
const build = L(
  ['server:', '  port: 8080', '  host: 0.0.0.0', '  timeout: 30', 'db:', '  url: jdbc:postgresql://db/shop', '  user: shop', 'mail:', '  smtp: smtp.shop', 'log: info', 'cache:', '  ttl: 60', ''].join('\n'),
);

/** The two diffs the merge view shows for a result. */
const diffs = (result: string[]) => ({ left: diffLines(deployed, result), right: diffLines(result, build) });

describe('splices', () => {
  it('apply together, in the coordinates of the lines before', () => {
    const lines = L('a\nb\nc\nd');
    const splices: Splice[] = [
      { at: 3, remove: 1, insert: ['D', 'E'] },
      { at: 0, remove: 0, insert: ['start'] },
      { at: 1, remove: 1, insert: [] },
    ];
    const out = applySplices(lines, splices);
    expect(out).toEqual(['start', 'a', 'c', 'D', 'E']);
    expect(lines).toEqual(L('a\nb\nc\nd'));
    expect(applySplices(out, invertSplices(lines, splices))).toEqual(lines);
  });
});

describe('taking blocks', () => {
  it('starts with every difference on the right and none on the left', () => {
    const { left, right } = diffs(deployed);
    expect(left).toEqual([]);
    expect(right.map((c) => `${deployed.slice(c.a0, c.a1).join('|')} => ${build.slice(c.b0, c.b1).join('|')}`)).toEqual([
      '  port: 9090 =>   port: 8080',
      ' =>   timeout: 30',
      '  url: jdbc:postgresql://localhost/shop =>   url: jdbc:postgresql://db/shop',
      '  user: me =>   user: shop',
      'legacy:|  mode: on => ',
      ' => mail:|  smtp: smtp.shop',
      ' => cache:|  ttl: 60',
    ]);
  });

  it('adds new settings from the build and leaves local values alone', () => {
    const { right } = diffs(deployed);
    const result = applySplices(deployed, newSettingsSplices(right, build));
    expect(result).toEqual(L(['server:', '  port: 9090', '  host: 0.0.0.0', '  timeout: 30', 'db:', '  url: jdbc:postgresql://localhost/shop', '  user: me', 'legacy:', '  mode: on', 'mail:', '  smtp: smtp.shop', 'log: info', 'cache:', '  ttl: 60', ''].join('\n')));
    // What was taken now shows on the left, as lines the deploy adds to the local file.
    const after = diffs(result);
    expect(after.left.map((c) => result.slice(c.b0, c.b1).join('|'))).toEqual(['  timeout: 30', 'mail:|  smtp: smtp.shop', 'cache:|  ttl: 60']);
    // Left on the right: the three local values, and the section the build no longer has.
    expect(after.right.map((c) => result.slice(c.a0, c.a1).join('|'))).toEqual(['  port: 9090', '  url: jdbc:postgresql://localhost/shop', '  user: me', 'legacy:|  mode: on']);
    expect(newSettingsSplices(after.right, build)).toEqual([]);
    // A block set aside is not added.
    expect(newSettingsSplices(right, build, (c) => c.b0 === 3)).toHaveLength(2);
  });

  it('takes one block, takes both, and puts the deployed lines back', () => {
    const { right } = diffs(deployed);
    const port = applySplices(deployed, [takeFromBuild(right[0], build)]);
    expect(port[1]).toBe('  port: 8080');
    expect(diffs(port).right).toHaveLength(6);

    const both = applySplices(deployed, [takeBoth(right[3], build)]);
    expect(both.slice(5, 7)).toEqual(['  user: me', '  user: shop']);

    const { left } = diffs(port);
    expect(applySplices(port, [restoreDeployed(left[0], deployed)])).toEqual(deployed);
    // Taking a block the build no longer has removes it; putting it back restores it.
    const gone = applySplices(deployed, [takeFromBuild(right[4], build)]);
    expect(gone).toEqual(deployed.filter((l) => l !== 'legacy:' && l !== '  mode: on'));
    expect(applySplices(gone, [restoreDeployed(diffs(gone).left[0], deployed)])).toEqual(deployed);
  });

  it('says what a finished merge amounts to', () => {
    expect(mergeOutcome(deployed, build, deployed)).toBe('deployed');
    expect(mergeOutcome(deployed, build, [...build])).toBe('build');
    expect(mergeOutcome(deployed, build, [...deployed, 'x'])).toBe('merged');
  });
});

describe('changes', () => {
  it('counts the differences from the build that were neither taken nor set aside', () => {
    const { left, right } = diffs(deployed);
    const all = changes(left, right, () => false);
    expect(all).toHaveLength(7);
    expect(all.every((c) => c.unresolved)).toBe(true);
    expect(all.map((c) => [c.r0, c.r1])).toEqual([[1, 2], [3, 3], [4, 5], [5, 6], [6, 8], [8, 8], [9, 9]]);

    // One taken, one set aside: both are still changes, neither is unresolved.
    const result = applySplices(deployed, [takeFromBuild(right[0], build)]);
    const d = diffs(result);
    const ignored = new Set([ignoreKey(d.right[1], result)]);
    const after = changes(d.left, d.right, (c) => ignored.has(ignoreKey(c, result)));
    expect(after).toHaveLength(7);
    expect(after.map((c) => c.unresolved)).toEqual([false, true, false, true, true, true, true]);
    expect(after[0]).toMatchObject({ left: [0], right: [] });
  });

  it('joins a left and a right block at the same result lines: a value edited by hand', () => {
    const result = [...deployed];
    result[1] = '  port: 7070';
    const { left, right } = diffs(result);
    const all = changes(left, right, () => false);
    expect(all[0]).toMatchObject({ r0: 1, r1: 2, left: [0], right: [0], unresolved: true });
    expect(all).toHaveLength(7);
  });

  it('forgets a set-aside block when its lines are edited', () => {
    const { right } = diffs(deployed);
    const key = ignoreKey(right[0], deployed);
    const edited = [...deployed];
    edited[1] = '  port: 9091';
    expect(ignoreKey(diffs(edited).right[0], edited)).not.toBe(key);
    // An edit elsewhere does not.
    const other = ['# note', ...deployed];
    expect(ignoreKey(diffs(other).right[1], other)).toBe(key);
  });

  it('steps round the list', () => {
    const list = changes([], diffs(deployed).right, () => false);
    expect(stepChange(list, -1, 1)).toBe(0);
    expect(stepChange(list, -1, -1)).toBe(6);
    expect(stepChange(list, 2, 1)).toBe(3);
    expect(stepChange(list, 6, 1)).toBe(0);
    expect(stepChange(list, 0, -1)).toBe(6);
    expect(stepChange([], -1, 1)).toBe(-1);
  });
});

describe('mapLine', () => {
  it('follows a line from one side of a diff to the other', () => {
    const chunks = [{ a0: 2, a1: 3, b0: 2, b1: 6 }, { a0: 10, a1: 10, b0: 13, b1: 15 }, { a0: 12, a1: 14, b0: 17, b1: 17 }];
    expect(mapLine(chunks, 0, true)).toBe(0);
    expect(mapLine(chunks, 1.5, true)).toBe(1.5);
    expect(mapLine(chunks, 2, true)).toBe(2);
    expect(mapLine(chunks, 2.5, true)).toBe(4);
    expect(mapLine(chunks, 3, true)).toBe(6);
    expect(mapLine(chunks, 9, true)).toBe(12);
    expect(mapLine(chunks, 10, true)).toBe(15);
    expect(mapLine(chunks, 13, true)).toBe(17);
    expect(mapLine(chunks, 20, true)).toBe(23);
    // And back.
    expect(mapLine(chunks, 4, false)).toBe(2.5);
    expect(mapLine(chunks, 14, false)).toBe(10);
    expect(mapLine(chunks, 17, false)).toBe(14);
    expect(mapLine(chunks, 23, false)).toBe(20);
    expect(mapLine([], 7.25, true)).toBe(7.25);
  });
});

describe('folds', () => {
  const head = Array.from({ length: 20 }, (_, i) => `a${i}: ${i}`);
  const mid = Array.from({ length: 30 }, (_, i) => `m${i}: ${i}`);
  const tail = Array.from({ length: 15 }, (_, i) => `z${i}: ${i}`);
  const dep = [...head, 'port: 9090', ...mid, ...tail];
  const bld = [...head, 'port: 8080', 'timeout: 30', ...mid, 'new: 1', ...tail];

  it('collapses the unchanged stretches, less a few lines around each change', () => {
    const left = diffLines(dep, dep);
    const right = diffLines(dep, bld);
    const folds = computeFolds(left, right, dep.length);
    expect(folds).toEqual([
      { deployed: 0, result: 0, build: 0, len: 17 },
      { deployed: 24, result: 24, build: 25, len: 24 },
      { deployed: 54, result: 54, build: 56, len: 12 },
    ]);
    for (const f of folds) expect(dep.slice(f.result, f.result + f.len)).toEqual(bld.slice(f.build, f.build + f.len));
    expect(validFolds(folds, left, right)).toEqual(folds);
    expect(computeFolds(left, right, dep.length, { context: 3, min: 30 })).toEqual([]);
  });

  it('opens a fold that is edited, moves those below an edit, and drops what no longer lines up', () => {
    const right = diffLines(dep, bld);
    const folds = computeFolds([], right, dep.length);
    expect(shiftFolds(folds, { at: 21, remove: 0, insert: ['x', 'y'] }).map((f) => f.result)).toEqual([0, 26, 56]);
    expect(shiftFolds(folds, { at: 30, remove: 1, insert: ['changed'] }).map((f) => f.result)).toEqual([0, 54]);
    expect(shiftFolds(folds, { at: 17, remove: 0, insert: ['at the end of the first'] }).map((f) => f.result)).toEqual([0, 25, 55]);

    // The result takes the build's two lines: the stretches still match, one line further down.
    const result = applySplices(dep, [takeFromBuild(right[0], bld), takeFromBuild(right[1], bld)]);
    let moved = folds;
    for (const s of [takeFromBuild(right[1], bld), takeFromBuild(right[0], bld)]) moved = shiftFolds(moved, s);
    const l2 = diffLines(dep, result);
    const r2 = diffLines(result, bld);
    expect(validFolds(moved, l2, r2).map((f) => [f.deployed, f.result, f.build])).toEqual([[0, 0, 0], [24, 25, 25], [54, 55, 56]]);
    // A line typed inside a stretch without telling the folds: that fold goes.
    const typed = [...dep];
    typed[30] = 'typed';
    expect(validFolds(folds, diffLines(dep, typed), diffLines(typed, bld)).map((f) => f.result)).toEqual([0, 54]);
  });
});

describe('MergeDoc', () => {
  const sel = (n: number) => ({ at: n });

  it('undoes and redoes edits with the selection they had', () => {
    const doc = new MergeDoc<{ at: number }>(['a', 'b']);
    doc.edit([{ at: 1, remove: 1, insert: ['B', 'c'] }], { selBefore: sel(1), selAfter: sel(2) });
    doc.edit([{ at: 0, remove: 0, insert: ['top'] }], { selBefore: sel(2), selAfter: sel(0) });
    expect(doc.lines).toEqual(['top', 'a', 'B', 'c']);
    expect(doc.undo()).toMatchObject({ sel: sel(2) });
    expect(doc.lines).toEqual(['a', 'B', 'c']);
    expect(doc.undo()).toMatchObject({ sel: sel(1) });
    expect(doc.lines).toEqual(['a', 'b']);
    expect(doc.undo()).toBeNull();
    expect(doc.canUndo).toBe(false);
    expect(doc.redo()).toMatchObject({ sel: sel(2) });
    expect(doc.redo()).toMatchObject({ sel: sel(0) });
    expect(doc.lines).toEqual(['top', 'a', 'B', 'c']);
    expect(doc.canRedo).toBe(false);
    // A new edit after an undo drops what could have been redone.
    doc.undo();
    doc.edit([{ at: 0, remove: 1, insert: ['A'] }], { selBefore: sel(0), selAfter: sel(0) });
    expect(doc.canRedo).toBe(false);
    expect(doc.lines).toEqual(['A', 'B', 'c']);
  });

  it('undoes typing a word at a time, not a letter at a time', () => {
    const doc = new MergeDoc<{ at: number }>(['']);
    let text = '';
    const type = (ch: string, now: number, tag = 'type') => {
      text += ch;
      doc.edit([{ at: 0, remove: 1, insert: [text] }], { selBefore: sel(text.length - 1), selAfter: sel(text.length), tag, now });
    };
    type('a', 1000);
    type('b', 1200);
    type('c', 1400);
    type(' ', 1500, 'space');
    type('d', 5000);
    type('e', 5100);
    doc.breakTyping();
    type('f', 5200);
    expect(doc.lines).toEqual(['abc def']);
    doc.undo();
    expect(doc.lines).toEqual(['abc de']);
    doc.undo();
    expect(doc.lines).toEqual(['abc ']);
    doc.undo();
    expect(doc.lines).toEqual(['abc']);
    expect(doc.undo()).toMatchObject({ sel: sel(0) });
    expect(doc.lines).toEqual(['']);
    doc.redo();
    expect(doc.lines).toEqual(['abc']);
  });

  it('undoes setting a difference aside', () => {
    const doc = new MergeDoc<null>(['a']);
    doc.edit([], { selBefore: null, selAfter: null, ignored: new Set(['k']) });
    expect([...doc.ignored]).toEqual(['k']);
    doc.edit([{ at: 0, remove: 1, insert: ['b'] }], { selBefore: null, selAfter: null });
    expect([...doc.ignored]).toEqual(['k']);
    doc.undo();
    doc.undo();
    expect([...doc.ignored]).toEqual([]);
    doc.redo();
    expect([...doc.ignored]).toEqual(['k']);
  });
});
