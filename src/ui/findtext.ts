// Text matching for the find bar in the detail panel (see find.ts).
//
// Pure functions over strings and offsets, with no DOM, so they can be unit tested in node.
// find.ts reads the text of each block in the panel, finds matches here, then maps the match
// offsets back onto the text nodes the block is split into (syntax highlighting splits a body
// into thousands of spans).

export interface FindOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export type Compiled = { re: RegExp } | { error: string };

export interface Match {
  start: number;
  end: number;
}

/** Stop highlighting after this many matches; the count then reads "5,000+". */
export const MAX_MATCHES = 5_000;

/**
 * Turns what was typed into a global regex. Plain text is escaped, so only regex mode can fail;
 * a bad pattern comes back as an error message rather than a throw. Returns null for an empty
 * query. In regex mode `^` and `$` match at line breaks, which is what you want in a log.
 */
export function compileQuery(query: string, opts: FindOptions): Compiled | null {
  if (query === '') return null;
  const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = `g${opts.caseSensitive ? '' : 'i'}${opts.regex ? 'm' : ''}`;
  try {
    return { re: new RegExp(source, flags) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * All non-empty matches of `re` (a global regex) in `text`, at most `limit` of them. `more` is set
 * when there were further matches, or when scanning took longer than `budgetMs` (a pattern like
 * `x*` matches the empty string at every position of a multi-megabyte body). Empty matches are
 * stepped over rather than returned: there is nothing to highlight, and not advancing past them
 * would loop forever.
 */
export function findAll(
  text: string,
  re: RegExp,
  limit = MAX_MATCHES,
  budgetMs = Infinity,
  now: () => number = Date.now,
): { matches: Match[]; more: boolean } {
  const matches: Match[] = [];
  const deadline = budgetMs === Infinity ? Infinity : now() + budgetMs;
  re.lastIndex = 0;
  for (let n = 1; ; n++) {
    const m = re.exec(text);
    if (!m) return { matches, more: false };
    const start = m.index;
    const end = start + m[0].length;
    if (end === start) {
      re.lastIndex = start + 1;
      if (re.lastIndex > text.length) return { matches, more: false };
    } else {
      if (matches.length === limit) return { matches, more: true };
      matches.push({ start, end });
    }
    // Checking the clock every time would cost more than the matching.
    if ((n & 1023) === 0 && now() > deadline) return { matches, more: true };
  }
}

/**
 * Where offset `offset` of a block falls, given the offset each of its pieces starts at
 * (ascending, the first being 0): the piece's index and the offset within it. An offset on a
 * boundary belongs to the piece that starts there, or with `atEnd` (for the end of a match) to
 * the piece that ends there, so a range never starts at the end of one piece or ends at the
 * start of the next. Empty pieces are skipped either way.
 */
export function locate(starts: readonly number[], offset: number, atEnd = false): [number, number] {
  // The last piece whose start is < offset (atEnd) or <= offset (otherwise).
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (atEnd ? starts[mid] < offset : starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return [lo, offset - starts[lo]];
}

/** The offset each piece starts at, for `locate`. */
export function pieceStarts(lengths: readonly number[]): number[] {
  const starts = new Array<number>(lengths.length);
  let at = 0;
  for (let i = 0; i < lengths.length; i++) {
    starts[i] = at;
    at += lengths[i];
  }
  return starts;
}

/** Steps `delta` matches from `current`, wrapping around at either end. */
export function step(current: number, delta: number, total: number): number {
  if (total === 0) return -1;
  return (((current + delta) % total) + total) % total;
}

/** The count shown in the find bar: "3 of 17", "1 of 5,000+", "No matches". */
export function countLabel(current: number, total: number, more: boolean): string {
  if (total === 0) return 'No matches';
  const fmt = (n: number) => n.toLocaleString('en-US');
  return `${fmt(current + 1)} of ${fmt(total)}${more ? '+' : ''}`;
}
