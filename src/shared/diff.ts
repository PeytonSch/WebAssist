// Text diffing for the merge view: which lines differ between two versions of a config file,
// and inside a changed block, which words. Pure: no DOM, no Node.
//
// Lines are matched with a patience diff: lines that occur exactly once in both versions (in a
// config file, nearly every "key: value" line) are the anchors, and what lies between two anchors
// is diffed the same way again. Stretches without such a line fall back to Myers' algorithm. That
// keeps a new block of settings together as one insertion where a plain shortest-edit diff would
// pair up its braces, blank lines and closing tags with unrelated ones.

/** Lines [a0, a1) of the first version were replaced by lines [b0, b1) of the second. */
export interface Chunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export type ChunkKind = 'insert' | 'delete' | 'modify';

/** insert: only the second version has lines here; delete: only the first; modify: both. */
export function chunkKind(c: Chunk): ChunkKind {
  return c.a0 === c.a1 ? 'insert' : c.b0 === c.b1 ? 'delete' : 'modify';
}

export interface DiffOptions {
  /** Lines that differ only in spaces and tabs count as the same. */
  ignoreWhitespace?: boolean;
  /** Leave blocks of changed lines whole instead of pairing up their lines (see refine). */
  coarse?: boolean;
}

/** Past this many edits Myers gives up and reports the stretch as one changed block. */
const MAX_EDITS = 1200;

// ── Sequences of numbers ────────────────────────────────

type Seq = Int32Array | number[];

/** Positions of the values that occur once in both ranges, as the longest run that keeps their order in both. */
function anchors(A: Seq, a0: number, a1: number, B: Seq, b0: number, b1: number): [number, number][] {
  // value -> [count in A, count in B, position in A, position in B]
  const seen = new Map<number, [number, number, number, number]>();
  for (let i = a0; i < a1; i++) {
    const s = seen.get(A[i]);
    if (s) s[0]++;
    else seen.set(A[i], [1, 0, i, -1]);
  }
  for (let j = b0; j < b1; j++) {
    const s = seen.get(B[j]);
    if (s) {
      s[1]++;
      s[3] = j;
    }
  }
  const pairs: [number, number][] = [];
  for (const s of seen.values()) if (s[0] === 1 && s[1] === 1) pairs.push([s[2], s[3]]);
  if (pairs.length < 2) return pairs;
  // Map keeps insertion order, so pairs are sorted by position in A: take the longest increasing run in B.
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < pairs[i][1]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out: [number, number][] = [];
  for (let i = tails[tails.length - 1]; i !== -1; i = prev[i]) out.push(pairs[i]);
  return out.reverse();
}

/** Myers' shortest edit script on a range without anchors. Calls `push` for each changed block, in order. */
function myers(A: Seq, a0: number, a1: number, B: Seq, b0: number, b1: number, push: (a0: number, a1: number, b0: number, b1: number) => void): void {
  const N = a1 - a0;
  const M = b1 - b0;
  const limit = Math.min(N + M, MAX_EDITS);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= limit && !done; d++) {
    // Only the diagonals this round can reach are kept: -d-1 … d+1.
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[a0 + x] === B[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        done = true;
        break;
      }
    }
  }
  if (!done) return push(a0, a1, b0, b1);

  const delA = new Uint8Array(N);
  const insB = new Uint8Array(M);
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const t = trace[d];
    const at = (k: number) => t[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      x--;
      y--;
    }
    if (x === px) insB[py] = 1;
    else delA[px] = 1;
    x = px;
    y = py;
  }
  let i = 0;
  let j = 0;
  while (i < N || j < M) {
    if (!(i < N && delA[i]) && !(j < M && insB[j])) {
      i++;
      j++;
      continue;
    }
    const si = i;
    const sj = j;
    while ((i < N && delA[i]) || (j < M && insB[j])) {
      if (i < N && delA[i]) i++;
      else j++;
    }
    push(a0 + si, a0 + i, b0 + sj, b0 + j);
  }
}

/** The changed blocks between two sequences of numbers, in order. */
export function diffSeq(A: Seq, B: Seq): Chunk[] {
  const out: Chunk[] = [];
  const push = (a0: number, a1: number, b0: number, b1: number) => {
    if (a0 === a1 && b0 === b1) return;
    const last = out[out.length - 1];
    if (last && last.a1 === a0 && last.b1 === b0) {
      last.a1 = a1;
      last.b1 = b1;
    } else out.push({ a0, a1, b0, b1 });
  };
  // Ranges still to diff, the next one on top. A stack rather than recursion: a long file can nest deeply.
  const todo: [number, number, number, number][] = [[0, A.length, 0, B.length]];
  while (todo.length) {
    let [a0, a1, b0, b1] = todo.pop()!;
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) {
      a0++;
      b0++;
    }
    while (a1 > a0 && b1 > b0 && A[a1 - 1] === B[b1 - 1]) {
      a1--;
      b1--;
    }
    if (a0 === a1 || b0 === b1) {
      push(a0, a1, b0, b1);
      continue;
    }
    const found = anchors(A, a0, a1, B, b0, b1);
    if (!found.length) {
      myers(A, a0, a1, B, b0, b1, push);
      continue;
    }
    const parts: [number, number, number, number][] = [];
    let pa = a0;
    let pb = b0;
    for (const [ia, ib] of found) {
      parts.push([pa, ia, pb, ib]);
      pa = ia + 1;
      pb = ib + 1;
    }
    parts.push([pa, a1, pb, b1]);
    for (let i = parts.length - 1; i >= 0; i--) todo.push(parts[i]);
  }
  return out;
}

/**
 * An insertion or deletion among repeated lines (blank lines, closing braces and tags) can sit in
 * several places. Each is moved down as far as it goes, so a new block is shown from its first
 * line to its closing line, not from the closing line of the block before it.
 */
function slideDown(chunks: Chunk[], A: Seq, B: Seq): Chunk[] {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const next = chunks[i + 1];
    // At least one unchanged line stays between this block and the next.
    const room = next ? next.a0 - 1 : A.length;
    if (c.a0 === c.a1) {
      // The line after the block equals its first line: the block may start one line later.
      while (c.a0 < room && B[c.b0] === B[c.b1]) {
        c.a0++;
        c.a1++;
        c.b0++;
        c.b1++;
      }
    } else if (c.b0 === c.b1) {
      while (c.a1 < room && A[c.a0] === A[c.a1]) {
        c.a0++;
        c.a1++;
        c.b0++;
        c.b1++;
      }
    }
  }
  return chunks;
}

// ── Lines ───────────────────────────────────────────────

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The changed blocks between two lists of lines, in order. */
export function diffLines(a: readonly string[], b: readonly string[], opts: DiffOptions = {}): Chunk[] {
  const ids = new Map<string, number>();
  const idOf = (line: string): number => {
    const k = opts.ignoreWhitespace ? squash(line) : line;
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  };
  const A = Int32Array.from(a, idOf);
  const B = Int32Array.from(b, idOf);
  const chunks = slideDown(diffSeq(A, B), A, B);
  return opts.coarse ? chunks : refine(chunks, a, b, opts.ignoreWhitespace ?? false);
}

/**
 * What a line sets or opens, for pairing up the lines of a changed block: the key of
 * "key: value" and "key = value" lines (YAML, .properties, JSON, object literals), and the tag
 * and name of an XML element. Null for comments, blank lines and anything else.
 */
export function lineKey(line: string): string | null {
  const xml = /^\s*<(\/?[\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)/.exec(line);
  if (xml) {
    const id = /\s(?:name|id|key|ref)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(xml[2]);
    return `<${xml[1]}#${id ? (id[1] ?? id[2]) : ''}`;
  }
  const kv = /^\s*(?:-\s+)?(?:(?:var|let|const|export)\s+)*(?:"((?:[^"\\]|\\.)+)"|'((?:[^'\\]|\\.)+)'|([\p{L}\p{N}_$][\p{L}\p{N}_$.\-/@[\]]*))\s*(?::(?!\/)|=(?![=>]))/u.exec(line);
  if (!kv) return null;
  if (/^\s*(?:#|\/\/|!|;|\*)/.test(line)) return null;
  return `=${kv[1] ?? kv[2] ?? kv[3]}`;
}

const WORD = /\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu;

/** Words, runs of spaces, single punctuation marks and line breaks; joined they give the text back. */
export function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** How alike two lines are, 0 to 1, by the words they share in order. */
function likeness(x: string, y: string): number {
  const tx = words(x).filter((t) => /\S/.test(t)).slice(0, 120);
  const ty = words(y).filter((t) => /\S/.test(t)).slice(0, 120);
  if (!tx.length || !ty.length) return tx.length === ty.length ? 1 : 0;
  let row = new Uint16Array(ty.length + 1);
  for (let i = 1; i <= tx.length; i++) {
    const next = new Uint16Array(ty.length + 1);
    for (let j = 1; j <= ty.length; j++) next[j] = tx[i - 1] === ty[j - 1] ? row[j - 1] + 1 : Math.max(row[j], next[j - 1]);
    row = next;
  }
  return (2 * row[ty.length]) / (tx.length + ty.length);
}

/** A changed block bigger than this (lines × lines) is not taken apart. */
const MAX_REFINE = 40_000;

/**
 * Takes blocks where both versions have lines apart, by pairing the lines that set the same key
 * (or, without keys, read alike). "port: 9090" against "port: 8080" plus a new "timeout: 30"
 * becomes a changed line and an added line, so the added line can be taken on its own while the
 * local value stays. Each setting whose value changed is a block of its own; settings that have
 * no partner on the other side are a removed block and an added block, not one changed block.
 * Lines without a key (comments, prose) stay together as one changed block.
 */
function refine(chunks: Chunk[], a: readonly string[], b: readonly string[], ignoreWhitespace: boolean): Chunk[] {
  const out: Chunk[] = [];
  const same = ignoreWhitespace ? (x: string, y: string) => squash(x) === squash(y) : (x: string, y: string) => x === y;
  for (const c of chunks) {
    const n = c.a1 - c.a0;
    const m = c.b1 - c.b0;
    if (!n || !m || n * m > MAX_REFINE) {
      out.push(c);
      continue;
    }
    const ka = a.slice(c.a0, c.a1).map(lineKey);
    const kb = b.slice(c.b0, c.b1).map(lineKey);
    // How well line i of the first version pairs with line j of the second; 0 is no pair.
    const weight = (i: number, j: number): number => {
      const x = a[c.a0 + i];
      const y = b[c.b0 + j];
      if (same(x, y)) return 4;
      if (ka[i] || kb[j]) return ka[i] === kb[j] ? 3 : 0;
      if (!x.trim() || !y.trim()) return 0;
      const l = likeness(x, y);
      return l >= 0.6 ? 1 + l : 0;
    };
    // best[i][j]: the best total for lines i… and j…
    const best = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const w = Array.from({ length: n }, () => new Float64Array(m));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        w[i][j] = weight(i, j);
        best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], w[i][j] ? w[i][j] + best[i + 1][j + 1] : 0);
      }
    }
    // Walk the pairing: paired lines are changed blocks, what is left between them was added or removed.
    let i = 0;
    let j = 0;
    let run: Chunk | null = null;
    let runPaired = false;
    const flush = () => {
      const r = run;
      run = null;
      if (!r) return;
      const settings = ka.slice(r.a0 - c.a0, r.a1 - c.a0).some(Boolean) || kb.slice(r.b0 - c.b0, r.b1 - c.b0).some(Boolean);
      if (!runPaired && r.a1 > r.a0 && r.b1 > r.b0 && settings) {
        // Settings on both sides that are not the same setting: some were dropped, others added.
        // As two blocks, the added ones can be taken while the dropped ones stay.
        out.push({ a0: r.a0, a1: r.a1, b0: r.b0, b1: r.b0 }, { a0: r.a1, a1: r.a1, b0: r.b0, b1: r.b1 });
      } else out.push(r);
    };
    const extend = (paired: boolean, da: number, db: number) => {
      if (run && runPaired !== paired) flush();
      if (!run) run = { a0: c.a0 + i, a1: c.a0 + i, b0: c.b0 + j, b1: c.b0 + j };
      runPaired = paired;
      run.a1 += da;
      run.b1 += db;
      i += da;
      j += db;
    };
    while (i < n || j < m) {
      if (i < n && j < m && w[i][j] && best[i][j] === w[i][j] + best[i + 1][j + 1]) {
        if (w[i][j] === 4) {
          // The same line in both: not part of any block.
          flush();
          i++;
          j++;
        } else if (w[i][j] === 3) {
          // The same setting with another value: a block of its own, to decide on by itself.
          flush();
          extend(true, 1, 1);
          flush();
        } else extend(true, 1, 1);
      } else if (i < n && (j >= m || best[i][j] === best[i + 1][j])) extend(false, 1, 0);
      else extend(false, 0, 1);
    }
    flush();
  }
  return out;
}

// ── Words inside a changed block ────────────────────────

/** Characters [from, to) of a line, the line counted from the start of the block's side. */
export interface InlineRange {
  line: number;
  from: number;
  to: number;
}

export interface InlineDiff {
  a: InlineRange[];
  b: InlineRange[];
}

const MAX_INLINE_WORDS = 4000;

function toLineRanges(text: string, ranges: [number, number][]): InlineRange[] {
  const out: InlineRange[] = [];
  let line = 0;
  let lineStart = 0;
  let nextBreak = text.indexOf('\n');
  const advance = (pos: number) => {
    while (nextBreak !== -1 && nextBreak < pos) {
      line++;
      lineStart = nextBreak + 1;
      nextBreak = text.indexOf('\n', lineStart);
    }
  };
  for (const [from, to] of ranges) {
    let p = from;
    while (p < to) {
      advance(p);
      const end = nextBreak === -1 ? to : Math.min(to, nextBreak);
      if (end > p) {
        const last = out[out.length - 1];
        if (last && last.line === line && last.to === p - lineStart) last.to = end - lineStart;
        else out.push({ line, from: p - lineStart, to: end - lineStart });
      }
      p = end === nextBreak ? end + 1 : end;
    }
  }
  return out;
}

/**
 * The words that differ between the two sides of a changed block, for highlighting inside its
 * lines. Null when the sides have too little in common for that to say anything: the lines are
 * then simply shown as changed.
 */
export function diffInline(aLines: readonly string[], bLines: readonly string[]): InlineDiff | null {
  const at = aLines.join('\n');
  const bt = bLines.join('\n');
  const aw = words(at);
  const bw = words(bt);
  if (!aw.length || !bw.length || aw.length > MAX_INLINE_WORDS || bw.length > MAX_INLINE_WORDS) return null;
  const ids = new Map<string, number>();
  const idOf = (t: string) => {
    let id = ids.get(t);
    if (id === undefined) ids.set(t, (id = ids.size));
    return id;
  };
  const A = aw.map(idOf);
  const B = bw.map(idOf);
  const chunks = diffSeq(A, B);
  const solid = (list: string[], from: number, to: number) => {
    let n = 0;
    for (let i = from; i < to; i++) if (/\S/.test(list[i])) n++;
    return n;
  };
  const totalA = solid(aw, 0, aw.length);
  const totalB = solid(bw, 0, bw.length);
  let changedA = 0;
  for (const c of chunks) changedA += solid(aw, c.a0, c.a1);
  const shared = totalA - changedA;
  if (shared < 0.25 * Math.max(totalA, totalB)) return null;

  const startsA = offsets(aw);
  const startsB = offsets(bw);
  const ra: [number, number][] = [];
  const rb: [number, number][] = [];
  for (const c of chunks) {
    if (c.a1 > c.a0) ra.push([startsA[c.a0], startsA[c.a1]]);
    if (c.b1 > c.b0) rb.push([startsB[c.b0], startsB[c.b1]]);
  }
  return { a: toLineRanges(at, ra), b: toLineRanges(bt, rb) };
}

function offsets(list: string[]): number[] {
  const out = new Array<number>(list.length + 1);
  let p = 0;
  for (let i = 0; i < list.length; i++) {
    out[i] = p;
    p += list[i].length;
  }
  out[list.length] = p;
  return out;
}

/** Lines added and removed by a list of chunks. */
export function lineCounts(chunks: readonly Chunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of chunks) {
    added += c.b1 - c.b0;
    removed += c.a1 - c.a0;
  }
  return { added, removed };
}
