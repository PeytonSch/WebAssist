// The merge view's model: a result that starts as the deployed copy of a config file and is
// edited, by hand or by taking blocks from the new build, into what gets deployed. Pure: no DOM.
//
// Nothing here tracks where blocks came from. The result is always diffed afresh against both
// versions: `left` is deployed → result (what the deploy will change in the local file) and
// `right` is result → build (what the build has that the result does not take). Taking a block
// from the build makes it disappear on the right and appear on the left, and typing in the
// result is shown the same way as a block taken with a button.

import { chunkKind, type Chunk } from './diff';

/** Replace `remove` lines at line `at` with `insert`. */
export interface Splice {
  at: number;
  remove: number;
  insert: string[];
}

/** Applies splices that do not overlap, given in the coordinates of `lines` as it is now. */
export function applySplices(lines: readonly string[], splices: readonly Splice[]): string[] {
  const sorted = [...splices].sort((x, y) => x.at - y.at);
  const out: string[] = [];
  let at = 0;
  for (const s of sorted) {
    for (let i = at; i < s.at; i++) out.push(lines[i]);
    for (const l of s.insert) out.push(l);
    at = s.at + s.remove;
  }
  for (let i = at; i < lines.length; i++) out.push(lines[i]);
  return out;
}

/** The splices that undo `splices`, in the coordinates of the lines after they were applied. */
export function invertSplices(lines: readonly string[], splices: readonly Splice[]): Splice[] {
  const sorted = [...splices].sort((x, y) => x.at - y.at);
  let shift = 0;
  return sorted.map((s) => {
    const inv = { at: s.at + shift, remove: s.insert.length, insert: lines.slice(s.at, s.at + s.remove) };
    shift += s.insert.length - s.remove;
    return inv;
  });
}

// ── What the buttons do ─────────────────────────────────
// A "right" chunk is result → build (a: result lines, b: build lines); a "left" chunk is
// deployed → result (a: deployed lines, b: result lines).

/** « on a right chunk: the result gets the build's lines there. */
export function takeFromBuild(c: Chunk, build: readonly string[]): Splice {
  return { at: c.a0, remove: c.a1 - c.a0, insert: build.slice(c.b0, c.b1) };
}

/** Both: the build's lines are added below the result's own. */
export function takeBoth(c: Chunk, build: readonly string[]): Splice {
  return { at: c.a1, remove: 0, insert: build.slice(c.b0, c.b1) };
}

/** » on a left chunk: the result gets the deployed copy's lines back there. */
export function restoreDeployed(c: Chunk, deployed: readonly string[]): Splice {
  return { at: c.b0, remove: c.b1 - c.b0, insert: deployed.slice(c.a0, c.a1) };
}

/**
 * "Add new settings from the build": every block of lines that only the build has, and nothing
 * else. Lines the result has are left as they are, so local values stay.
 */
export function newSettingsSplices(right: readonly Chunk[], build: readonly string[], skip: (c: Chunk) => boolean = () => false): Splice[] {
  return right.filter((c) => chunkKind(c) === 'insert' && !skip(c)).map((c) => takeFromBuild(c, build));
}

/**
 * Identifies a right chunk the user chose to leave as it is: the build's lines it is about and
 * the result's lines there. Editing those lines makes it a new, undecided difference again.
 */
export function ignoreKey(c: Chunk, result: readonly string[]): string {
  return `${c.b0}:${c.b1}|${result.slice(c.a0, c.a1).join('\n')}`;
}

// ── Changes, for the counter and for stepping through ───

export interface Change {
  /** The result lines it covers; empty (r0 = r1) where the result has nothing. */
  r0: number;
  r1: number;
  /** Indexes into the left and right chunks that make it up. */
  left: number[];
  right: number[];
  /** A difference from the build that was neither taken nor set aside. */
  unresolved: boolean;
}

function touches(s1: number, e1: number, s2: number, e2: number): boolean {
  if (s1 === e1 || s2 === e2) return s1 <= e2 && s2 <= e1;
  return s1 < e2 && s2 < e1;
}

/**
 * The places where the three versions differ, in result order. A left and a right chunk at the
 * same result lines are one change (a value edited by hand differs from both versions).
 */
export function changes(left: readonly Chunk[], right: readonly Chunk[], ignored: (c: Chunk) => boolean): Change[] {
  // group[i]: which change left chunk i belongs to; right chunks likewise, after the left ones.
  const parent = Array.from({ length: left.length + right.length }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  let from = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    while (from < right.length && right[from].a1 < l.b0) from++;
    for (let j = from; j < right.length && right[j].a0 <= l.b1; j++) {
      if (touches(l.b0, l.b1, right[j].a0, right[j].a1)) parent[find(left.length + j)] = find(i);
    }
  }
  const byRoot = new Map<number, Change>();
  const add = (root: number, r0: number, r1: number): Change => {
    let c = byRoot.get(root);
    if (!c) byRoot.set(root, (c = { r0, r1, left: [], right: [], unresolved: false }));
    c.r0 = Math.min(c.r0, r0);
    c.r1 = Math.max(c.r1, r1);
    return c;
  };
  left.forEach((l, i) => add(find(i), l.b0, l.b1).left.push(i));
  right.forEach((r, j) => {
    const c = add(find(left.length + j), r.a0, r.a1);
    c.right.push(j);
    if (!ignored(r)) c.unresolved = true;
  });
  return [...byRoot.values()].sort((x, y) => x.r0 - y.r0 || x.r1 - y.r1);
}

/** The change to step to from result line `line`: the next one after it, or the previous one before it. */
export function stepChange(list: readonly Change[], current: number, dir: 1 | -1): number {
  if (!list.length) return -1;
  if (current < 0) return dir === 1 ? 0 : list.length - 1;
  return (current + dir + list.length) % list.length;
}

// ── Following a line from one version to the other ──────

/**
 * Where line position `pos` of one side of a diff is on the other side. Positions are lines with
 * a fraction (2.5 is the middle of the third line). Unchanged lines map one to one; inside a
 * changed block the position is taken in proportion, so the two sides scroll through it together.
 */
export function mapLine(chunks: readonly Chunk[], pos: number, fromA: boolean): number {
  let lo = 0;
  let hi = chunks.length;
  // The last chunk that starts at or before pos.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((fromA ? chunks[mid].a0 : chunks[mid].b0) <= pos) lo = mid + 1;
    else hi = mid;
  }
  const c = chunks[lo - 1];
  if (!c) return pos;
  const [s, e, os, oe] = fromA ? [c.a0, c.a1, c.b0, c.b1] : [c.b0, c.b1, c.a0, c.a1];
  if (pos >= e) return oe + (pos - e);
  return os + ((pos - s) / (e - s)) * (oe - os);
}

// ── Unchanged stretches ─────────────────────────────────

/** `len` lines that are the same in all three versions, starting at these lines of each. */
export interface Fold {
  deployed: number;
  result: number;
  build: number;
  len: number;
}

export interface FoldOptions {
  /** Unchanged lines left showing around each change. */
  context: number;
  /** A stretch shorter than this is not worth collapsing. */
  min: number;
}

/**
 * The stretches to collapse: lines no chunk touches on either side, less `context` lines next to
 * each change. A stretch at the very start or end of the file collapses up to the edge.
 */
export function computeFolds(left: readonly Chunk[], right: readonly Chunk[], resultLines: number, opts: FoldOptions = { context: 3, min: 6 }): Fold[] {
  // Result lines where something changes: the lines of each chunk, and the gap an empty one sits in.
  const marks: [number, number][] = [];
  for (const c of left) marks.push([c.b0, c.b1]);
  for (const c of right) marks.push([c.a0, c.a1]);
  marks.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const folds: Fold[] = [];
  let li = 0;
  let ri = 0;
  let dShift = 0; // deployed line = result line + dShift, for unchanged lines
  let bShift = 0;
  const stretch = (s: number, e: number) => {
    const from = s === 0 ? 0 : s + opts.context;
    const to = e === resultLines ? e : e - opts.context;
    if (to - from < opts.min) return;
    while (li < left.length && left[li].b1 <= from) {
      dShift += left[li].a1 - left[li].a0 - (left[li].b1 - left[li].b0);
      li++;
    }
    while (ri < right.length && right[ri].a1 <= from) {
      bShift += right[ri].b1 - right[ri].b0 - (right[ri].a1 - right[ri].a0);
      ri++;
    }
    folds.push({ deployed: from + dShift, result: from, build: from + bShift, len: to - from });
  };
  let at = 0;
  for (const [s, e] of marks) {
    if (s > at) stretch(at, s);
    at = Math.max(at, e);
  }
  if (resultLines > at) stretch(at, resultLines);
  return folds;
}

/** The folds that still hide only unchanged lines after the result was edited and diffed again. */
export function validFolds(folds: readonly Fold[], left: readonly Chunk[], right: readonly Chunk[]): Fold[] {
  // Whether result lines [s, e) are free of changes, and how far the other version's lines are shifted there.
  const check = (s: number, e: number, ranges: [number, number, number][]): number | null => {
    let shift = 0;
    for (const [r0, r1, grow] of ranges) {
      if (r1 <= s) shift += grow;
      else if (r0 < e) return null;
      else break;
    }
    return shift;
  };
  const l = left.map((c): [number, number, number] => [c.b0, c.b1, c.a1 - c.a0 - (c.b1 - c.b0)]);
  const r = right.map((c): [number, number, number] => [c.a0, c.a1, c.b1 - c.b0 - (c.a1 - c.a0)]);
  return folds.filter((f) => {
    const d = check(f.result, f.result + f.len, l);
    const b = check(f.result, f.result + f.len, r);
    return d !== null && b !== null && f.result + d === f.deployed && f.result + b === f.build;
  });
}

/** Folds after a splice of the result: those it touches open, those below it move. */
export function shiftFolds(folds: readonly Fold[], s: Splice): Fold[] {
  const delta = s.insert.length - s.remove;
  const out: Fold[] = [];
  for (const f of folds) {
    if (f.result + f.len <= s.at) out.push(f);
    else if (f.result >= s.at + s.remove) out.push({ ...f, result: f.result + delta });
  }
  return out;
}

// ── The document, with undo ─────────────────────────────

interface Step<S> {
  /** Each part's splices, in the coordinates of the lines before that part. */
  parts: { splices: Splice[]; inverse: Splice[] }[];
  ignoredBefore: Set<string>;
  ignoredAfter: Set<string>;
  selBefore: S;
  selAfter: S;
  tag: string | null;
  at: number;
}

export interface EditOptions<S> {
  selBefore: S;
  selAfter: S;
  /** Edits with the same tag made in quick succession (typing) undo as one. */
  tag?: string;
  /** The ignored differences after the edit, if it changes them. */
  ignored?: Set<string>;
  now?: number;
}

const COALESCE_MS = 1200;

/** The result being edited: its lines, the differences set aside, and the undo history. `S` is the selection. */
export class MergeDoc<S> {
  lines: string[];
  ignored = new Set<string>();
  private undone: Step<S>[] = [];
  private done: Step<S>[] = [];

  constructor(lines: readonly string[]) {
    this.lines = [...lines];
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Applies splices (in the coordinates of the lines as they are) as one undoable step. */
  edit(splices: Splice[], opts: EditOptions<S>): void {
    const inverse = invertSplices(this.lines, splices);
    const now = opts.now ?? Date.now();
    const last = this.done[this.done.length - 1];
    const ignoredAfter = opts.ignored ?? this.ignored;
    if (last && opts.tag && last.tag === opts.tag && now - last.at < COALESCE_MS && !opts.ignored) {
      last.parts.push({ splices, inverse });
      last.selAfter = opts.selAfter;
      last.at = now;
    } else {
      this.done.push({ parts: [{ splices, inverse }], ignoredBefore: this.ignored, ignoredAfter, selBefore: opts.selBefore, selAfter: opts.selAfter, tag: opts.tag ?? null, at: now });
      if (this.done.length > 500) this.done.shift();
    }
    this.undone = [];
    this.lines = applySplices(this.lines, splices);
    this.ignored = ignoredAfter;
  }

  /** Stops the next edit from joining the previous one (the caret moved, a button was used). */
  breakTyping(): void {
    const last = this.done[this.done.length - 1];
    if (last) last.tag = null;
  }

  /** Undoes the last step. Returns the splices applied (for moving folds) and the selection to restore. */
  undo(): { splices: Splice[][]; sel: S } | null {
    const step = this.done.pop();
    if (!step) return null;
    const applied: Splice[][] = [];
    for (let i = step.parts.length - 1; i >= 0; i--) {
      this.lines = applySplices(this.lines, step.parts[i].inverse);
      applied.push(step.parts[i].inverse);
    }
    this.ignored = step.ignoredBefore;
    step.tag = null;
    this.undone.push(step);
    return { splices: applied, sel: step.selBefore };
  }

  redo(): { splices: Splice[][]; sel: S } | null {
    const step = this.undone.pop();
    if (!step) return null;
    const applied: Splice[][] = [];
    for (const part of step.parts) {
      this.lines = applySplices(this.lines, part.splices);
      applied.push(part.splices);
    }
    this.ignored = step.ignoredAfter;
    this.done.push(step);
    return { splices: applied, sel: step.selAfter };
  }
}

/** What a finished merge amounts to: the deployed copy untouched, the build's file, or something of its own. */
export function mergeOutcome(deployed: readonly string[], build: readonly string[], result: readonly string[]): 'deployed' | 'build' | 'merged' {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((l, i) => l === y[i]);
  return same(result, deployed) ? 'deployed' : same(result, build) ? 'build' : 'merged';
}
