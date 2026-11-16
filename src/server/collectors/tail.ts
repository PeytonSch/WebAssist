import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

interface Tracked {
  offset: number;
  ino: number;
  decoder: StringDecoder;
  partial: string;
  /** Not written for a while (an old rotated file): checked every STALE_POLL_MS, not every poll. */
  stale: boolean;
  nextCheck: number;
}

/** A pattern plus rules for which of its matches to follow. A plain string follows every match. */
export interface TailSource {
  pattern: string;
  /** Shown instead of the pattern when nothing matches. */
  label?: string;
  /** Called with each matching path; false leaves the file alone. */
  accept?: (file: string) => boolean;
  /**
   * Files last written longer ago than this are followed from their end even with fromStart,
   * so pointing at a folder of old logs does not replay months of history.
   */
  historyMaxAgeMs?: number;
}

export interface TailOptions {
  /** Read files that already exist from the beginning instead of from their current end. */
  fromStart: boolean;
  pollMs: number;
  onLine: (file: string, line: string) => void;
  onFilesChanged?: (files: string[]) => void;
}

const RESCAN_EVERY_MS = 1500;
const CHUNK = 256 * 1024;
/** Files not written for this long are polled slowly; a rotated-away file is never written again. */
const STALE_AFTER_MS = 60 * 60_000;
const STALE_POLL_MS = 2000;

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  // Windows file names are case-insensitive, so a pattern typed in another case still matches.
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
}

/** Whether a path is one the pattern matches, the way the tailer resolves it. */
export function matchesPattern(pattern: string, file: string): boolean {
  const sameDir = process.platform === 'win32'
    ? dirname(pattern).toLowerCase() === dirname(file).toLowerCase()
    : dirname(pattern) === dirname(file);
  return sameDir && globToRegExp(basename(pattern)).test(basename(file));
}

export interface PatternMatch {
  /** Files that match, newest first. */
  files: { path: string; bytes: number; modified: string }[];
  /** Why nothing could match, e.g. the folder does not exist. */
  problem: string | null;
}

/** What a log pattern matches right now, the same way the tailer resolves it. */
export async function matchPattern(pattern: string): Promise<PatternMatch> {
  const dir = dirname(pattern);
  const re = globToRegExp(basename(pattern));
  let names: string[];
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return { files: [], problem: `Not a folder: ${dir}` };
    names = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { files: [], problem: `Folder not found: ${dir}` };
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return { files: [], problem: `No permission to read ${dir}` };
    return { files: [], problem: err?.message ?? String(err) };
  }
  const files: PatternMatch['files'] = [];
  for (const name of names) {
    if (!re.test(name)) continue;
    try {
      const st = await fs.stat(join(dir, name));
      if (st.isFile()) files.push({ path: join(dir, name), bytes: st.size, modified: st.mtime.toISOString() });
    } catch {
      /* vanished */
    }
  }
  files.sort((a, b) => (a.modified < b.modified ? 1 : -1));
  return { files, problem: null };
}

/**
 * Follows a set of log files by polling. Polling (rather than fs events) is deliberate: it behaves
 * the same on Windows, macOS and Linux and copes with files the writer keeps open.
 *
 * Rotation is handled three ways: date-stamped files are picked up by re-scanning the glob,
 * truncation is detected by the file shrinking, and rename-and-recreate by the inode changing.
 * When the renamed file is itself matched (myapp.log → myapp.2026-11-15.log in a followed
 * folder), it keeps its read position instead of being replayed from the top.
 *
 * Files that have not been written for an hour (old rotated logs) are checked every few seconds
 * rather than on every poll, so following a folder with months of logs stays cheap.
 */
export class Tailer {
  private files = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private firstScan = true;
  private lastScan = 0;
  /** Read positions of files that left their path since the last scan, by inode (see scan). */
  private retired = new Map<number, { offset: number; partial: string }>();
  private sources: TailSource[];

  constructor(sources: (string | TailSource)[], private opts: TailOptions) {
    this.sources = sources.map((s) => (typeof s === 'string' ? { pattern: s } : s));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tick(true);
  }

  get watched(): string[] {
    return [...this.files.keys()];
  }

  /** One poll cycle. Exposed so tests can drive the tailer deterministically. */
  async tick(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      if (force || now - this.lastScan >= RESCAN_EVERY_MS) {
        this.lastScan = now;
        await this.scan();
      }
      for (const [file, t] of this.files) {
        if (!force && t.stale && now < t.nextCheck) continue;
        await this.read(file, t);
      }
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    const found = new Map<string, TailSource>();
    for (const source of this.sources) {
      const dir = dirname(source.pattern);
      const re = globToRegExp(basename(source.pattern));
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(dir, name);
        // The first source to claim a file decides how it is read.
        if (re.test(name) && !found.has(file) && (source.accept?.(file) ?? true)) found.set(file, source);
      }
    }

    let changed = false;
    for (const [file, t] of this.files) {
      if (found.has(file)) continue;
      if (t.ino) this.retired.set(t.ino, { offset: t.offset, partial: t.partial });
      this.files.delete(file);
      changed = true;
    }
    const now = Date.now();
    // Inodes of the files already followed: a new path with one of them is that file, renamed.
    let byIno: Map<number, Tracked> | null = null;
    for (const [file, source] of found) {
      if (this.files.has(file)) continue;
      try {
        const st = await fs.stat(file);
        if (!st.isFile()) continue;
        // Files that appear after startup are new, so read them from the top, unless this is a
        // file that was renamed by log rotation: then carry on where its old name left off.
        byIno ??= new Map([...this.files.values()].filter((t) => t.ino).map((t) => [t.ino, t]));
        const moved = st.ino ? this.retired.get(st.ino) ?? byIno.get(st.ino) : undefined;
        const tooOld = source.historyMaxAgeMs !== undefined && now - st.mtimeMs > source.historyMaxAgeMs;
        const skipHistory = tooOld || (this.firstScan && !this.opts.fromStart);
        const offset = moved && moved.offset <= st.size ? moved.offset : skipHistory ? st.size : 0;
        const stale = now - st.mtimeMs > STALE_AFTER_MS;
        this.files.set(file, {
          offset,
          ino: st.ino,
          decoder: new StringDecoder('utf8'),
          partial: moved && moved.offset <= st.size ? moved.partial : '',
          stale,
          nextCheck: now + STALE_POLL_MS,
        });
        changed = true;
      } catch {
        /* vanished between readdir and stat */
      }
    }
    this.retired.clear();
    this.firstScan = false;
    if (changed) this.opts.onFilesChanged?.(this.watched);
  }

  private async read(file: string, t: Tracked): Promise<void> {
    // A stat by path is much cheaper than open, read and close, and most files have not changed.
    try {
      const pre = await fs.stat(file);
      const now = Date.now();
      t.stale = now - pre.mtimeMs > STALE_AFTER_MS;
      t.nextCheck = now + STALE_POLL_MS;
      const sameFile = pre.ino === t.ino || pre.ino === 0 || t.ino === 0;
      if (sameFile && pre.size === t.offset) return;
    } catch {
      return;
    }
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, 'r');
    } catch {
      return;
    }
    try {
      const st = await handle.stat();
      const replaced = st.ino !== 0 && t.ino !== 0 && st.ino !== t.ino;
      if (replaced || st.size < t.offset) {
        // A replaced file may reappear under a rotated name; scan() picks up from here then.
        if (replaced) this.retired.set(t.ino, { offset: t.offset, partial: t.partial });
        t.offset = 0;
        t.partial = '';
        t.decoder = new StringDecoder('utf8');
      }
      t.ino = st.ino;
      const buf = Buffer.allocUnsafe(CHUNK);
      while (t.offset < st.size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, st.size - t.offset), t.offset);
        if (bytesRead === 0) break;
        t.offset += bytesRead;
        const parts = (t.partial + t.decoder.write(buf.subarray(0, bytesRead))).split('\n');
        t.partial = parts.pop() ?? '';
        for (const part of parts) {
          this.opts.onLine(file, part.endsWith('\r') ? part.slice(0, -1) : part);
        }
      }
    } catch {
      /* transient read error; retry next tick */
    } finally {
      await handle.close();
    }
  }
}
