import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

interface Tracked {
  offset: number;
  ino: number;
  decoder: StringDecoder;
  partial: string;
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

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  // Windows file names are case-insensitive, so a pattern typed in another case still matches.
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
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
 */
export class Tailer {
  private files = new Map<string, Tracked>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private firstScan = true;
  private lastScan = 0;

  constructor(private patterns: string[], private opts: TailOptions) {}

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
      for (const [file, t] of this.files) await this.read(file, t);
    } finally {
      this.busy = false;
    }
  }

  private async scan(): Promise<void> {
    const found = new Set<string>();
    for (const pattern of this.patterns) {
      const dir = dirname(pattern);
      const re = globToRegExp(basename(pattern));
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) if (re.test(name)) found.add(join(dir, name));
    }

    let changed = false;
    for (const file of found) {
      if (this.files.has(file)) continue;
      try {
        const st = await fs.stat(file);
        if (!st.isFile()) continue;
        // Files that appear after startup are new, so read them from the top.
        const offset = this.firstScan && !this.opts.fromStart ? st.size : 0;
        this.files.set(file, { offset, ino: st.ino, decoder: new StringDecoder('utf8'), partial: '' });
        changed = true;
      } catch {
        /* vanished between readdir and stat */
      }
    }
    for (const file of this.files.keys()) {
      if (!found.has(file)) {
        this.files.delete(file);
        changed = true;
      }
    }
    this.firstScan = false;
    if (changed) this.opts.onFilesChanged?.(this.watched);
  }

  private async read(file: string, t: Tracked): Promise<void> {
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
