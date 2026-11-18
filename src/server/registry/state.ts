import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * What the hub remembers about packages between restarts, in registry-state.json next to the
 * settings file: which version of each package the user has already dealt with (so a version is
 * announced once, also when it appeared while Debug Hub was not running), what was deployed
 * from it, and which downloads are in the cache. Written through a temporary file, like the
 * settings, so a crash never leaves half a file. No logins are stored here.
 */

export const STATE_FILE = 'registry-state.json';
export const CACHE_DIR = 'registry-cache';

export interface BuildRef {
  version: string;
  /** Tells apart builds of one version: a rebuilt SNAPSHOT, a rebuilt file behind a fixed URL. */
  build: string;
}

export interface CachedDownload extends BuildRef {
  /** Absolute path in the cache folder. */
  file: string;
  bytes: number;
  /** "sha256:ab12…" when the registry's checksum matched; null when it publishes none. */
  checksum: string | null;
  /** When the registry says it was published. */
  modified: string | null;
  downloadedAt: string;
}

export interface PackageState {
  /** The latest build the user has dealt with: there at the first check, dismissed, or deployed. */
  seen: BuildRef | null;
  /** The latest build a notice went out for, so it is not announced again after a restart. */
  announced: BuildRef | null;
  /** What was last deployed from this package through Debug Hub. */
  deployed: (BuildRef & { as: string; at: string }) | null;
  downloads: CachedDownload[];
  /**
   * Which versions the settings let through when `seen` was set. When that changes, what is latest
   * changes with it, and is not news.
   */
  filter?: string;
  /** For forgetting packages that are no longer in the settings. */
  touchedAt: string;
}

interface StateFile {
  version: 1;
  packages: Record<string, PackageState>;
}

/** Packages not seen in a check for this long are forgotten. */
const FORGET_AFTER_MS = 180 * 24 * 60 * 60_000;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const ref = (v: unknown): BuildRef | null => (isObj(v) && typeof v.version === 'string' && typeof v.build === 'string' ? { version: v.version, build: v.build } : null);

/** One package's state from whatever the file holds; anything malformed is dropped rather than trusted. */
function clean(v: unknown): PackageState | null {
  if (!isObj(v)) return null;
  const deployed = ref(v.deployed);
  const downloads: CachedDownload[] = (Array.isArray(v.downloads) ? v.downloads : []).flatMap((d: unknown) => {
    const r = ref(d);
    if (!r || !isObj(d) || typeof d.file !== 'string' || typeof d.bytes !== 'number') return [];
    return [{
      ...r,
      file: d.file,
      bytes: d.bytes,
      checksum: typeof d.checksum === 'string' ? d.checksum : null,
      modified: typeof d.modified === 'string' ? d.modified : null,
      downloadedAt: typeof d.downloadedAt === 'string' ? d.downloadedAt : new Date(0).toISOString(),
    }];
  });
  return {
    seen: ref(v.seen),
    announced: ref(v.announced),
    deployed: deployed && typeof v.deployed.as === 'string' ? { ...deployed, as: v.deployed.as, at: typeof v.deployed.at === 'string' ? v.deployed.at : new Date(0).toISOString() } : null,
    downloads,
    ...(typeof v.filter === 'string' ? { filter: v.filter } : {}),
    touchedAt: typeof v.touchedAt === 'string' ? v.touchedAt : new Date().toISOString(),
  };
}

export class RegistryStateStore {
  private packages = new Map<string, PackageState>();
  /** Why the file could not be read; it is replaced on the next change. */
  problem: string | null = null;

  /** Without a file (tests, or before the settings folder is known), nothing is kept. */
  constructor(private file: string | null) {
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (!isObj(raw) || !isObj(raw.packages)) throw new Error('not a registry state file');
      for (const [key, value] of Object.entries(raw.packages)) {
        const state = clean(value);
        if (state) this.packages.set(key, state);
      }
    } catch (err) {
      // Starting over only costs the notices already dismissed; the file is rewritten on the next change.
      this.problem = `Could not read ${file}: ${(err as Error).message}`;
    }
  }

  get(key: string): PackageState | undefined {
    return this.packages.get(key);
  }

  keys(): string[] {
    return [...this.packages.keys()];
  }

  /** The state of a package, created empty the first time. Change it, then call save(). */
  touch(key: string, now = Date.now()): PackageState {
    let state = this.packages.get(key);
    if (!state) {
      state = { seen: null, announced: null, deployed: null, downloads: [], touchedAt: new Date(now).toISOString() };
      this.packages.set(key, state);
    }
    state.touchedAt = new Date(now).toISOString();
    return state;
  }

  /** Every cached download, with the package it belongs to. */
  downloads(): { key: string; download: CachedDownload }[] {
    return [...this.packages].flatMap(([key, s]) => s.downloads.map((download) => ({ key, download })));
  }

  /** Forgets packages not checked for a long time, and returns their cached files for removal. */
  forgetStale(now = Date.now()): CachedDownload[] {
    const gone: CachedDownload[] = [];
    for (const [key, state] of this.packages) {
      if (now - Date.parse(state.touchedAt) > FORGET_AFTER_MS) {
        gone.push(...state.downloads);
        this.packages.delete(key);
      }
    }
    return gone;
  }

  save(): void {
    if (!this.file) return;
    const data: StateFile = { version: 1, packages: Object.fromEntries([...this.packages].sort(([a], [b]) => (a < b ? -1 : 1))) };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, this.file);
    this.problem = null;
  }
}

export const sameBuild = (a: BuildRef | null | undefined, b: BuildRef | null | undefined): boolean => !!a && !!b && a.version === b.version && a.build === b.build;
