import { promises as fs } from 'node:fs';
import { join, parse } from 'node:path';
import { globToRegExp } from '../collectors/tail';

/**
 * Watches the folders where WARs are built and reports each new or rebuilt WAR once it is
 * complete. Polling, like the log tailer (see docs/decisions.md #3): file events are unreliable
 * on Windows and a build writes the WAR gradually anyway, so the real question is "has it
 * stopped changing", which only comparing two looks can answer.
 */

export interface WatchedWar {
  file: string;
  bytes: number;
  modifiedMs: number;
  /** Size and modification time; a rebuild changes it. */
  sig: string;
  /** Built while watching and not yet deployed or dismissed. */
  fresh: boolean;
}

interface Entry extends WatchedWar {
  /** The build last reported (or found at startup), so it is not reported twice. */
  reported: string | null;
}

export interface WarWatchOptions {
  pollMs: number;
  onNew: (war: WatchedWar) => void;
}

/** Stops a pattern such as C:/dev/* /target from walking a whole drive. */
const MAX_DIRS = 500;

/**
 * The folders and files a watch entry names: a folder, a file, or a pattern with * in any part,
 * e.g. C:/dev/* /target or C:/dev/shop/target/shop-*.war. Every part but the last must be a
 * folder; the last may also be a file. Also used to find the projects the WARs are built from.
 */
export async function expandWatchPattern(pattern: string): Promise<{ paths: string[]; problem: string | null }> {
  const { root } = parse(pattern);
  const parts = pattern.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let paths = [root || '.'];
  let dirsSeen = 0;
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    const next: string[] = [];
    for (const base of paths) {
      if (!part.includes('*') && !part.includes('?')) {
        next.push(join(base, part));
        continue;
      }
      const re = globToRegExp(part);
      let names: string[] = [];
      try {
        names = await fs.readdir(base);
      } catch {
        continue;
      }
      for (const n of names) if (re.test(n) && !n.startsWith('.')) next.push(join(base, n));
      if ((dirsSeen += 1) > MAX_DIRS) return { paths: [], problem: `Too many folders match ${pattern}` };
    }
    // Keep only folders until the last part, which may also be a file.
    paths = [];
    for (const p of next) {
      const st = await fs.stat(p).catch(() => null);
      if (st && (st.isDirectory() || (last && st.isFile()))) paths.push(p);
    }
    if (!paths.length) {
      const wild = parts.slice(0, i + 1).some((p) => p.includes('*'));
      return { paths: [], problem: wild ? `Nothing matches ${pattern}` : `Folder not found: ${root}${parts.slice(0, i + 1).join('/')}` };
    }
  }
  return { paths, problem: null };
}

/** The WARs a watch entry covers: the *.war files in the folders it names, or the WAR files themselves. */
export async function findWars(pattern: string): Promise<{ files: string[]; problem: string | null }> {
  const { paths, problem } = await expandWatchPattern(pattern);
  if (problem) return { files: [], problem };
  const files: string[] = [];
  for (const p of paths) {
    const st = await fs.stat(p).catch(() => null);
    if (st?.isFile()) {
      if (/\.war$/i.test(p)) files.push(p);
      continue;
    }
    const names = await fs.readdir(p).catch(() => [] as string[]);
    for (const n of names) if (/\.war$/i.test(n) && !n.startsWith('.')) files.push(join(p, n));
  }
  return { files: [...new Set(files)], problem: null };
}

/**
 * A complete WAR (a zip) ends with an "end of central directory" record, PK\x05\x06, in its last
 * 64 kB. A build that stalled halfway, or is writing slower than the poll, has none yet.
 */
export async function looksComplete(file: string): Promise<boolean> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const len = Math.min(size, 65_557);
    if (len < 22) return false;
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, size - len);
    return buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== -1;
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

export class WarWatcher {
  private known = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  /** The poll in progress; a second caller waits for it rather than starting another. */
  private polling: Promise<void> | null = null;
  private baseline = true;
  /** Builds a replaced watcher had reported and the user has not dealt with yet, by file. */
  private inherited = new Map<string, string>();
  problems: { pattern: string; problem: string }[] = [];

  constructor(private patterns: string[], private opts: WarWatchOptions) {}

  start(): void {
    if (this.timer || !this.patterns.length) return;
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Newest first. */
  list(): WatchedWar[] {
    return [...this.known.values()]
      .map(({ reported: _r, ...w }) => w)
      .sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  get(file: string): WatchedWar | undefined {
    return this.known.get(file);
  }

  /** The user dealt with this build: deployed or dismissed. */
  settle(file: string): void {
    const e = this.known.get(file);
    if (e) e.fresh = false;
  }

  /** Carries the fresh marks over from a watcher this one replaces, for builds that have not changed. */
  inherit(previous: WarWatcher): void {
    this.inherited = new Map(previous.list().filter((w) => w.fresh).map((w) => [w.file, w.sig]));
  }

  /**
   * One poll. The first one is the baseline: WARs already there are listed but not reported. After
   * that, a WAR is reported when its size and time differ from the last report and were the same
   * on two polls in a row, and the file is a complete zip.
   */
  tick(): Promise<void> {
    this.polling ??= this.poll().finally(() => (this.polling = null));
    return this.polling;
  }

  private async poll(): Promise<void> {
    const found = new Set<string>();
    const problems: WarWatcher['problems'] = [];
    for (const pattern of this.patterns) {
      const { files, problem } = await findWars(pattern);
      if (problem) problems.push({ pattern, problem });
      files.forEach((f) => found.add(f));
    }
    this.problems = problems;

    for (const file of found) {
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) continue;
      const sig = `${st.size}:${Math.round(st.mtimeMs)}`;
      const prev = this.known.get(file);
      if (!prev) {
        const fresh = this.inherited.get(file) === sig;
        this.known.set(file, { file, bytes: st.size, modifiedMs: st.mtimeMs, sig, fresh, reported: this.baseline ? sig : null });
        continue;
      }
      if (prev.sig !== sig) {
        // Still being written, or just rebuilt: wait for it to hold still.
        Object.assign(prev, { sig, bytes: st.size, modifiedMs: st.mtimeMs });
        continue;
      }
      if (prev.reported !== sig && st.size > 0 && (await looksComplete(file))) {
        prev.reported = sig;
        prev.fresh = true;
        const { reported: _r, ...war } = prev;
        this.opts.onNew(war);
      }
    }
    for (const file of [...this.known.keys()]) if (!found.has(file)) this.known.delete(file);
    this.baseline = false;
  }
}
