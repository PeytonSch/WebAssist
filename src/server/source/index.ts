import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findProjects, isInside, type ProjectRoot } from './roots';
import { classesOf, findSourceDirs, readJavaPackage, SKIP_DIRS, SOURCE_EXT, yieldNow, type SourceDir } from './scan';

/**
 * Which source file defines a class, for "Go to source" on stack frames, logger names and
 * exception classes. Built in the background from the projects behind the WAR watch folders and
 * the extra source folders, and kept current by polling folder times (cheap: a folder's time
 * changes when a file is added, removed or renamed in it). Lookups never touch the disk except
 * to confirm a guess (see resolve).
 */

export interface IndexedProject {
  root: string;
  /** The root folder's name. */
  name: string;
  from: string[];
  names: string[];
  /** Modules with sources, relative to the root ("" is the root itself). */
  modules: string[];
  sourceDirs: string[];
  classes: number;
}

export interface Candidate {
  file: string;
  /** 0 when the caller gave no line. */
  line: number;
  project: string;
  /** The project root. */
  root: string;
  module: string;
}

export interface ResolveOptions {
  /** The file name a stack frame names, e.g. OrderService.java. */
  file?: string;
  line?: number;
  /** The Tomcat webapp the event came from, to pick between projects defining the same class. */
  webapp?: string;
}

export interface IndexStatus {
  state: 'idle' | 'building' | 'ready';
  builtAt: string | null;
  buildMs: number | null;
  classes: number;
  files: number;
  /** Set when the file cap was reached, so some sources are missing. */
  truncated: boolean;
  projects: IndexedProject[];
  problems: string[];
}

interface Entry {
  file: string;
  project: number;
  module: string;
}

interface DirRec {
  mtimeMs: number;
  sourceDir: string;
  project: number;
  module: string;
}

/** Stops a source folder pointed at a whole drive from filling memory. */
export const MAX_FILES = 300_000;
export const POLL_MS = 10_000;
/** A lookup that misses rebuilds the index (in the background) when it is at least this old. */
const STALE_MS = 60_000;

/** The class a JVM name refers to: Foo$Bar, Foo$1 and Foo$$Lambda/0x… all live in Foo's file. */
export function outerClass(name: string): string {
  const i = name.indexOf('$');
  return i > 0 ? name.slice(0, i) : name;
}

class Tables {
  classes = new Map<string, Entry[]>();
  /** Simple name → fully qualified names, for abbreviated logger names and moved Java files. */
  simple = new Map<string, Set<string>>();
  /** File → the classes it defines, so a removed file can be taken out. */
  files = new Map<string, { classes: string[]; project: number; module: string }>();
  dirs = new Map<string, DirRec>();
  truncated = false;

  addFile(file: string, classes: string[], project: number, module: string): void {
    this.removeFile(file);
    this.files.set(file, { classes, project, module });
    for (const c of classes) {
      const list = this.classes.get(c) ?? [];
      list.push({ file, project, module });
      this.classes.set(c, list);
      const s = c.slice(c.lastIndexOf('.') + 1);
      const set = this.simple.get(s) ?? new Set();
      set.add(c);
      this.simple.set(s, set);
    }
  }

  removeFile(file: string): void {
    const rec = this.files.get(file);
    if (!rec) return;
    this.files.delete(file);
    for (const c of rec.classes) {
      const list = (this.classes.get(c) ?? []).filter((e) => e.file !== file);
      if (list.length) this.classes.set(c, list);
      else {
        this.classes.delete(c);
        this.simple.get(c.slice(c.lastIndexOf('.') + 1))?.delete(c);
      }
    }
  }
}

export class SourceIndex {
  private t = new Tables();
  private projects: IndexedProject[] = [];
  private problems: string[] = [];
  private state: IndexStatus['state'] = 'idle';
  private builtAt = 0;
  private buildMs: number | null = null;
  private building: Promise<void> | null = null;
  private again = false;
  private refreshing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Bumped whenever the classes change, so the UI knows its cached lookups are stale. */
  generation = 0;

  constructor(private warWatch: string[], private sourceDirs: string[], private opts: { pollMs?: number; maxFiles?: number } = {}) {}

  start(): void {
    this.stopped = false;
    void this.build();
    this.timer ??= setInterval(() => void this.refresh(), this.opts.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** New folders to index: rebuilt only when they changed. */
  reconfigure(warWatch: string[], sourceDirs: string[]): void {
    const same = JSON.stringify([warWatch, sourceDirs]) === JSON.stringify([this.warWatch, this.sourceDirs]);
    this.warWatch = warWatch;
    this.sourceDirs = sourceDirs;
    if (!same && !this.stopped) void this.build();
  }

  /** Resolves when the build in progress (if any) is done. */
  async ready(): Promise<void> {
    while (this.building) await this.building;
  }

  /**
   * Builds the whole index from scratch, then swaps it in, so lookups keep working meanwhile. A
   * call during a build makes it run once more afterwards with the latest folders.
   */
  build(): Promise<void> {
    if (this.building) {
      this.again = true;
      return this.building;
    }
    this.state = 'building';
    this.building = (async () => {
      do {
        this.again = false;
        await this.buildOnce();
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.building = null;
      this.state = 'ready';
    });
    return this.building;
  }

  private async buildOnce(): Promise<void> {
    const started = Date.now();
    const { projects: roots, problems } = await findProjects(this.warWatch, this.sourceDirs);
    const t = new Tables();
    const projects: IndexedProject[] = [];
    for (const [i, root] of roots.entries()) {
      const dirs = await findSourceDirs(root.root);
      projects.push(projectOf(root, dirs));
      for (const sd of dirs) await this.scanDir(t, sd.dir, sd.dir, i, sd.module);
      if (!dirs.length) problems.push(`No source folders (src/main/java and the like) in ${root.root}`);
    }
    if (t.truncated) problems.push(`Stopped after ${(this.opts.maxFiles ?? MAX_FILES).toLocaleString('en-US')} source files; some classes are not linked`);
    this.t = t;
    this.projects = projects;
    this.problems = problems;
    this.count();
    this.builtAt = Date.now();
    this.buildMs = this.builtAt - started;
    this.generation++;
  }

  /** Adds the sources in `dir` and below. Each folder's time is remembered for refresh(). */
  private async scanDir(t: Tables, dir: string, sourceDir: string, project: number, module: string): Promise<boolean> {
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return false;
    t.dirs.set(dir, { mtimeMs: st.mtimeMs, sourceDir, project, module });
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    let changed = false;
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isFile() && SOURCE_EXT.test(e.name)) {
        if (t.files.size >= (this.opts.maxFiles ?? MAX_FILES)) {
          t.truncated = true;
          break;
        }
        t.addFile(path, await classesOf(sourceDir, path), project, module);
        changed = true;
      }
    }
    await yieldNow();
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (await this.scanDir(t, join(dir, e.name), sourceDir, project, module)) changed = true;
    }
    return changed;
  }

  /**
   * Picks up added, removed and renamed files: only folders whose time changed are read again.
   * New modules and edits that rename a Kotlin class inside a file wait for the next full build
   * (on a settings change, or a lookup that misses).
   */
  refresh(): Promise<void> {
    if (this.building || this.stopped) return Promise.resolve();
    this.refreshing ??= this.refreshOnce().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refreshOnce(): Promise<void> {
    const t = this.t;
    let changed = false;
    let n = 0;
    for (const [dir, rec] of [...t.dirs]) {
      if (++n % 200 === 0) await yieldNow();
      if (t !== this.t) return; // a build replaced the tables meanwhile
      const st = await fs.stat(dir).catch(() => null);
      if (st?.isDirectory() && st.mtimeMs === rec.mtimeMs) continue;
      if (!t.dirs.has(dir)) continue; // removed along with a parent already
      changed = true;
      // Forget the folder and everything below it, then read it again if it is still there.
      for (const d of [...t.dirs.keys()]) if (d === dir || isInside(d, dir)) t.dirs.delete(d);
      for (const f of [...t.files.keys()]) if (dirname(f) === dir || isInside(f, dir)) t.removeFile(f);
      if (st?.isDirectory()) await this.scanDir(t, dir, rec.sourceDir, rec.project, rec.module);
    }
    if (changed && t === this.t) {
      this.count();
      this.generation++;
    }
  }

  private count(): void {
    const per = new Map<number, number>();
    for (const rec of this.t.files.values()) per.set(rec.project, (per.get(rec.project) ?? 0) + rec.classes.length);
    this.projects.forEach((p, i) => (p.classes = per.get(i) ?? 0));
  }

  status(): IndexStatus {
    return {
      state: this.state,
      builtAt: this.builtAt ? new Date(this.builtAt).toISOString() : null,
      buildMs: this.buildMs,
      classes: this.t.classes.size,
      files: this.t.files.size,
      truncated: this.t.truncated,
      projects: this.projects,
      problems: this.problems,
    };
  }

  /** Any one indexed class, for the Test button in Settings. */
  sampleClass(): string | null {
    for (const [name, entries] of this.t.classes) if (/\.java$/i.test(entries[0].file)) return name;
    return this.t.classes.keys().next().value ?? null;
  }

  /**
   * Cheap check for many names at once (the classes in view in the detail panel): how many source
   * files each one could open, without reading any file. Names not in the sources are left out.
   */
  known(names: string[], webapp?: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of names) {
      const hits = this.pick(this.lookup(name), webapp);
      if (hits.length) out[name] = new Set(hits.map((e) => e.file)).size;
    }
    return out;
  }

  /**
   * The source files that may define `name`. Several when projects or modules define the same
   * class; the event's webapp narrows that down to its project when one matches. When nothing
   * matches by name, Java files with the same simple name are checked by their package line,
   * since a Java file may sit in a folder that does not match its package.
   */
  async resolve(name: string, opts: ResolveOptions = {}): Promise<Candidate[]> {
    let hits = this.lookup(name);
    if (!hits.length) hits = await this.byPackageLine(name);
    if (!hits.length && Date.now() - this.builtAt > STALE_MS && !this.building) {
      // New since the last build: check the folders for added files, then look once more.
      await this.refresh();
      hits = this.lookup(name);
      if (!hits.length) void this.build();
    }
    hits = this.pick(hits, opts.webapp);
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const e of hits) {
      let file = e.file;
      // A frame names the file: a second top-level class compiled from a neighbouring file.
      if (opts.file && basename(file) !== opts.file) {
        const sibling = join(dirname(file), opts.file);
        if (this.t.files.has(sibling)) file = sibling;
      }
      if (seen.has(file)) continue;
      seen.add(file);
      const p = this.projects[e.project];
      out.push({ file, line: opts.line && opts.line > 0 ? Math.floor(opts.line) : 0, project: p?.name ?? '', root: p?.root ?? '', module: e.module });
    }
    return out;
  }

  /** Whether `file` is a source file in the index; nothing else is ever opened. */
  has(file: string): boolean {
    return this.t.files.has(file);
  }

  private lookup(raw: string): Entry[] {
    const name = raw.trim();
    if (!name || name.length > 500) return [];
    const tries = [name, outerClass(name)];
    // JUL loggers and some layouts print Class.method; the method starts lower case.
    const lastDot = name.lastIndexOf('.');
    if (lastDot > 0 && /^[a-z_<]/.test(name.slice(lastDot + 1))) tries.push(outerClass(name.slice(0, lastDot)));
    for (const n of tries) {
      const hit = this.t.classes.get(n);
      if (hit?.length) return hit;
    }
    for (const n of tries) {
      const hit = this.abbreviated(n);
      if (hit.length) return hit;
    }
    return [];
  }

  /** Logback's shortened logger names: c.e.o.OrderService or com.example.o.OrderService. */
  private abbreviated(name: string): Entry[] {
    const parts = name.split('.');
    if (parts.length < 2 || !parts.slice(0, -1).some((p) => p.length <= 2)) return [];
    const simple = parts[parts.length - 1];
    const out: Entry[] = [];
    for (const full of this.t.simple.get(simple) ?? []) {
      const fp = full.split('.');
      if (fp.length === parts.length && parts.every((p, i) => fp[i].startsWith(p))) out.push(...(this.t.classes.get(full) ?? []));
    }
    return out;
  }

  private async byPackageLine(name: string): Promise<Entry[]> {
    const full = outerClass(name);
    const dot = full.lastIndexOf('.');
    if (dot <= 0) return [];
    const pkg = full.slice(0, dot);
    const out: Entry[] = [];
    for (const other of this.t.simple.get(full.slice(dot + 1)) ?? []) {
      for (const e of this.t.classes.get(other) ?? []) {
        if (/\.java$/i.test(e.file) && (await readJavaPackage(e.file)) === pkg) out.push(e);
      }
    }
    return out;
  }

  /** Narrows hits in several projects to the project the webapp was built from, if one matches. */
  private pick(hits: Entry[], webapp?: string): Entry[] {
    if (!webapp || new Set(hits.map((e) => e.project)).size < 2) return hits;
    const w = webapp.replace(/##.*$/, '').toLowerCase();
    const mine = hits.filter((e) => {
      const names = this.projects[e.project]?.names ?? [];
      return names.includes(w) || names.includes(w.replace(/#/g, '-'));
    });
    return mine.length ? mine : hits;
  }
}

function projectOf(root: ProjectRoot, dirs: SourceDir[]): IndexedProject {
  return {
    root: root.root,
    name: basename(root.root),
    from: root.from,
    names: root.names,
    modules: [...new Set(dirs.map((d) => d.module))],
    sourceDirs: dirs.map((d) => d.dir),
    classes: 0,
  };
}
