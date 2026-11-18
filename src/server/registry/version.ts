/**
 * Maven version ordering, as Maven itself does it (ComparableVersion), because comparing versions
 * as text puts 1.10 before 1.9 and 2.0 before 2.0-RC1's release.
 *
 * A version is split at dots, dashes and wherever digits and letters meet. Numbers compare as
 * numbers; qualifiers in the order alpha < beta < milestone < rc < snapshot < (release) < sp,
 * with unknown qualifiers after those, alphabetically; a number is newer than any qualifier.
 * Trailing zeros do not count, so 1.0 equals 1 and 1.0-ga.
 */

type Item = number | string | Item[];

const QUALIFIERS = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp'];
const ALIASES: Record<string, string> = { ga: '', final: '', release: '', cr: 'rc' };

/** A qualifier's rank as text that sorts right: known ones by position, unknown ones after them. */
function rank(q: string): string {
  const i = QUALIFIERS.indexOf(q);
  return i === -1 ? `${QUALIFIERS.length}-${q}` : String(i);
}
const RELEASE_RANK = rank('');
/** Plain code-unit order, as Java's String.compareTo: a locale's collation would reorder the ranks. */
const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function qualifier(text: string, followedByDigit: boolean): string {
  // 1.0a1, 1.0b2 and 1.0m3 are short for alpha, beta and milestone.
  if (followedByDigit && text.length === 1) {
    const long = { a: 'alpha', b: 'beta', m: 'milestone' }[text];
    if (long) return long;
  }
  return ALIASES[text] ?? text;
}

const isNull = (item: Item): boolean => (typeof item === 'number' ? item === 0 : typeof item === 'string' ? item === '' : item.length === 0);

/** Drops trailing zeros, empty qualifiers and empty lists: 1.0.0 is 1. */
function trim(list: Item[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (isNull(list[i])) list.splice(i, 1);
    else if (!Array.isArray(list[i])) break;
  }
}

function parse(version: string): Item[] {
  const text = version.toLowerCase();
  const root: Item[] = [];
  let list = root;
  const stack: Item[][] = [root];
  let isDigit = false;
  let start = 0;

  const token = (end: number, digit: boolean, followedByDigit: boolean): Item =>
    digit ? Number(text.slice(start, end)) : qualifier(text.slice(start, end), followedByDigit);
  const sublist = () => {
    const next: Item[] = [];
    list.push(next);
    list = next;
    stack.push(next);
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '.') {
      list.push(i === start ? 0 : token(i, isDigit, false));
      start = i + 1;
    } else if (c === '-') {
      list.push(i === start ? 0 : token(i, isDigit, false));
      start = i + 1;
      sublist();
    } else if (c >= '0' && c <= '9') {
      if (!isDigit && i > start) {
        // Letters then a digit: 1.0alpha1 is 1.0-alpha-1.
        list.push(token(i, false, true));
        start = i;
        sublist();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.push(token(i, true, false));
        start = i;
        sublist();
      }
      isDigit = false;
    }
  }
  if (text.length > start) list.push(token(text.length, isDigit, false));
  // Innermost first, so a list emptied by trimming is itself trimmed from its parent.
  for (let i = stack.length - 1; i >= 0; i--) trim(stack[i]);
  return root;
}

function compareItems(a: Item | undefined, b: Item | undefined): number {
  if (a === undefined) return b === undefined ? 0 : -compareItems(b, undefined);
  if (typeof a === 'number') {
    if (b === undefined) return a === 0 ? 0 : 1;
    if (typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    // 1.1 is newer than 1-sp and than 1-1.
    return 1;
  }
  if (typeof a === 'string') {
    if (b === undefined) return cmpText(rank(a), RELEASE_RANK);
    if (typeof b === 'number') return -1;
    if (typeof b === 'string') return cmpText(rank(a), rank(b));
    // 1-xxx is older than 1-1.
    return -1;
  }
  if (b === undefined) {
    // 1-0 equals 1; otherwise the first part that differs from nothing decides.
    for (const item of a) {
      const c = compareItems(item, undefined);
      if (c !== 0) return c;
    }
    return 0;
  }
  if (typeof b === 'number') return -1;
  if (typeof b === 'string') return 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareItems(a[i], b[i]);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** Negative when `a` is the older version, positive when it is the newer, 0 when they are equal. */
export function compareVersions(a: string, b: string): number {
  return Math.sign(compareItems(parse(a), parse(b)));
}

/** Newest first. Versions Maven considers equal keep their order. */
export function sortNewestFirst<T>(items: T[], version: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((x, y) => compareVersions(version(y.item), version(x.item)) || x.i - y.i)
    .map((x) => x.item);
}

/** 1.4.0-SNAPSHOT, or one of its builds: 1.4.0-20260114.101502-3. */
export function isSnapshot(version: string): boolean {
  return /-SNAPSHOT$/i.test(version) || /-\d{8}\.\d{6}-\d+$/.test(version);
}

/** The -SNAPSHOT version a timestamped build belongs to; other versions as they are. */
export function baseVersion(version: string): string {
  return version.replace(/-\d{8}\.\d{6}-\d+$/, '-SNAPSHOT');
}

/**
 * A version pattern from the settings as a test: `2.*` (with * and ?, the whole version, case
 * ignored) or `/^2\.\d+$/` (a regular expression). Empty matches everything. Throws on a broken
 * regular expression.
 */
export function versionMatcher(pattern: string): (version: string) => boolean {
  const p = pattern.trim();
  if (!p) return () => true;
  const re = /^\/(.+)\/([a-z]*)$/.exec(p);
  if (re) {
    const compiled = new RegExp(re[1], re[2].replace(/[gy]/g, ''));
    return (v) => compiled.test(v);
  }
  const glob = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (v) => glob.test(v);
}
