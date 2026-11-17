// The parts of the update window (update.html, updateview.ts) that are plain data: reading a
// unified diff, marking what changed within a line, diffstat blocks and commit tags. No DOM here,
// so it is tested directly (test/updatemodel.test.ts).

// Type-only: the window's script must not pull node or electron in.
import type { GitCommit, UpdateDetails } from './gitupdate';

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  /** Line numbers in the old and new file; absent where the line is not in that side. */
  old?: number;
  new?: number;
  text: string;
  /** For a changed line paired with its counterpart: the [start, end) that differs. */
  changed?: [number, number];
}

export interface DiffHunk {
  /** The "@@ -1,4 +1,6 @@ function name" line. */
  header: string;
  /** Text after the second @@: the enclosing function or section, when git found one. */
  context: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  binary: boolean;
  /** "new file", "deleted file", or null. */
  status: 'new' | 'deleted' | null;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/** Reads `git diff` / `git show` output for one file. */
export function parseDiff(text: string): ParsedDiff {
  const out: ParsedDiff = { binary: false, status: null, hunks: [] };
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, context: h[3].trim(), lines: [] };
      out.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) out.binary = true;
      else if (line.startsWith('new file mode')) out.status = 'new';
      else if (line.startsWith('deleted file mode')) out.status = 'deleted';
      continue;
    }
    const c = line[0];
    if (c === '+') hunk.lines.push({ kind: 'add', new: newNo++, text: line.slice(1) });
    else if (c === '-') hunk.lines.push({ kind: 'del', old: oldNo++, text: line.slice(1) });
    else if (c === ' ') hunk.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) });
    else if (c === '\\') hunk.lines.push({ kind: 'note', text: line.slice(2) });
    else if (line === '') continue;
  }
  for (const hk of out.hunks) markChanges(hk.lines);
  return out;
}

/**
 * Pairs each run of deleted lines with the added lines right after it, line by line, and marks
 * the part of each pair that differs, so a one-word edit stands out in a long line.
 */
function markChanges(lines: DiffLine[]): void {
  for (let i = 0; i < lines.length;) {
    if (lines[i].kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === 'del') d++;
    let a = d;
    while (a < lines.length && lines[a].kind === 'add') a++;
    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      const [x, y] = changedRanges(lines[i + k].text, lines[d + k].text);
      if (x) lines[i + k].changed = x;
      if (y) lines[d + k].changed = y;
    }
    i = a;
  }
}

/**
 * The differing middle of two lines (after their common start and end), for each. Null when the
 * lines share too little for a highlight to help, or when nothing differs.
 */
export function changedRanges(a: string, b: string): [[number, number] | null, [number, number] | null] {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const shared = p + s;
  // Mostly rewritten: highlighting nearly the whole line adds noise, not information.
  if (shared < 3 || shared < Math.min(a.length, b.length) * 0.3) return [null, null];
  const ra: [number, number] | null = a.length - s > p ? [p, a.length - s] : null;
  const rb: [number, number] | null = b.length - s > p ? [p, b.length - s] : null;
  return [ra, rb];
}

/** GitHub-style five blocks: how much of the change is additions and deletions. */
export function statBlocks(added: number | null, deleted: number | null, blocks = 5): ('add' | 'del' | 'none')[] {
  const a = added ?? 0;
  const d = deleted ?? 0;
  const total = a + d;
  if (!total) return Array(blocks).fill('none');
  // Small changes fill fewer blocks, so a one-line fix does not look like a rewrite.
  const filled = Math.min(blocks, Math.max(1, Math.ceil(Math.log10(total + 1) * 2)));
  let adds = Math.round((a / total) * filled);
  if (a && !adds) adds = 1;
  if (d && adds === filled) adds = filled - 1 > 0 ? filled - 1 : filled;
  const out: ('add' | 'del' | 'none')[] = [];
  for (let i = 0; i < blocks; i++) out.push(i < adds ? 'add' : i < filled ? 'del' : 'none');
  return out;
}

export interface FileGroup<T extends { path: string }> {
  /** The folder, e.g. "src/ui"; '' for files at the top. */
  dir: string;
  files: (T & { name: string })[];
}

/** Files grouped by folder, folders in path order, top-level files first. */
export function groupByDir<T extends { path: string }>(files: T[]): FileGroup<T>[] {
  const groups = new Map<string, FileGroup<T>>();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    const dir = cut < 0 ? '' : f.path.slice(0, cut);
    let g = groups.get(dir);
    if (!g) groups.set(dir, (g = { dir, files: [] }));
    g.files.push({ ...f, name: f.path.slice(cut + 1) });
  }
  return [...groups.values()].sort((x, y) => (x.dir === '' ? -1 : y.dir === '' ? 1 : x.dir.localeCompare(y.dir)));
}

export type CommitTag = 'new' | 'fix' | 'docs' | 'tests' | 'improved';

export const TAG_LABEL: Record<CommitTag, string> = { new: 'New', fix: 'Fix', docs: 'Docs', tests: 'Tests', improved: 'Improved' };

/** A rough kind for a commit, from its subject (conventional-commit prefixes or a leading verb). */
export function commitTag(subject: string): CommitTag {
  const s = subject.trim();
  const conv = /^(\w+)(?:\([^)]*\))?!?:/.exec(s);
  if (conv) {
    const t = conv[1].toLowerCase();
    if (t === 'feat') return 'new';
    if (t === 'fix') return 'fix';
    if (t === 'docs') return 'docs';
    if (t === 'test') return 'tests';
  }
  if (/^(fix(e[sd])?|correct|repair|resolve|handle|prevent|stop|avoid)\b/i.test(s) || /\bfix(es|ed)?\b|\bbug\b/i.test(s)) return 'fix';
  if (/^(readme|docs?)\b/i.test(s) || /\b(readme|documentation)\b/i.test(s)) return 'docs';
  if (/^tests?\b/i.test(s)) return 'tests';
  if (/^(add|adds|added|new|introduce|support|build|create|implement|allow|enable|show)\b/i.test(s) || /\bnew\b/i.test(s)) return 'new';
  return 'improved';
}

/** "Peyton Scherschel" → "PS"; one name → its first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable hue for a name, so each author keeps their colour. */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

export const fmt = (n: number) => n.toLocaleString('en-US');

// ── What the window is shown ────────────────────────────

export interface UpdateAction {
  id: string;
  label: string;
  primary?: boolean;
}

export type UpdateView =
  | {
      mode: 'available';
      head: string;
      target: string;
      behind: number;
      /** e.g. "origin/main". */
      source: string;
      /** The short list from the check; details replaces it when it could be read. */
      commits: GitCommit[];
      details: UpdateDetails | null;
      /** Why it cannot be applied automatically, or null. */
      blocked: string | null;
      /** Set when fetching failed: what the list is based on instead. */
      fetchNote: string;
      actions: UpdateAction[];
      /** The action Escape and the close button mean. */
      cancel: string;
    }
  | {
      mode: 'message';
      tone: 'ok' | 'warn' | 'error';
      title: string;
      detail: string;
      /** A short commit to show as a chip, e.g. where the checkout is. */
      head?: string;
      actions: UpdateAction[];
      cancel: string;
    };

export interface DiffAnswer {
  text: string;
  truncated: boolean;
  error?: string;
}

export type BodyBlock = { kind: 'p'; text: string } | { kind: 'list'; items: string[] } | { kind: 'pre'; text: string };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * A commit message body as paragraphs and lists, with the hard wraps at ~72 columns joined, so
 * it reads at the window's width. Indented blocks (code) keep their lines.
 */
export function reflow(body: string): BodyBlock[] {
  const out: BodyBlock[] = [];
  for (const para of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = para.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (lines.every((l) => /^( {4}|\t)/.test(l))) {
      out.push({ kind: 'pre', text: lines.join('\n') });
      continue;
    }
    let text: string[] = [];
    let list: string[] | null = null;
    const flushText = () => {
      if (text.length) out.push({ kind: 'p', text: text.join(' ') });
      text = [];
    };
    const flushList = () => {
      if (list?.length) out.push({ kind: 'list', items: list });
      list = null;
    };
    for (const line of lines) {
      if (BULLET.test(line)) {
        flushText();
        (list ??= []).push(line.replace(BULLET, '').trim());
      } else if (list && /^\s/.test(line)) {
        list[list.length - 1] += ` ${line.trim()}`;
      } else {
        flushList();
        text.push(line.trim());
      }
    }
    flushText();
    flushList();
  }
  return out;
}
