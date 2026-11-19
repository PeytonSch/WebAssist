import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  MAX_LISTED_VERSIONS,
  type DownloadInfo,
  type DownloadResult,
  type PackageInfo,
  type RegistryConfig,
  type RegistryInfo,
  type RegistryMessage,
  type RegistryPackage,
  type RegistryState,
  type TestLine,
  type TestResult,
} from '../../shared/registry';
import { REGISTRY_FORMS } from '../../shared/registry-forms';
import type { WarInfo } from '../../shared/tomcat';
import type { HubEvent, Level } from '../../shared/types';
import type { Config, FieldError } from '../config';
import { makeEvent } from '../normalize';
import { looksComplete } from '../tomcat/warwatch';
import { checkName, guessTarget } from '../tomcat/webapps';
import { resolveRegistryPaths, validateRegistries } from './config';
import { KINDS } from './kinds';
import { CACHE_DIR, RegistryStateStore, sameBuild, STATE_FILE, type BuildRef, type CachedDownload, type PackageState } from './state';
import { buildTransport, displayUrl, downloadTo, RegistryError, scrub, type HashName, type Transport } from './transport';
import { httpTime, type Artifact, type FoundPackage, type FoundVersion, type RegistryContext, type RegistryKind } from './types';
import { compareVersions, sortNewestFirst, versionMatcher } from './version';

export interface RegistryHooks {
  /** Puts an event on the timeline. */
  emit: (ev: HubEvent) => void;
  /** Tells the UI: something changed, a new version, a download's progress. */
  notify: (msg: RegistryMessage) => void;
  /** The webapps Tomcat has (in webapps) and all that are known (also the disabled ones). */
  webappNames: () => Promise<{ deployed: string[]; all: string[] }>;
  /** Hands a downloaded WAR to the Tomcat page, which deploys it like one from a build folder. */
  adoptWar: (file: string) => Promise<WarInfo>;
}

export interface RegistryServiceOptions {
  /** Stands in for the hub's environment when resolving ${env:NAME}. */
  env?: Record<string, string | undefined>;
  /** Cached downloads kept per package, besides the one that is deployed. Default 3. */
  keepDownloads?: number;
}

/** A problem with a status for the API, like TomcatError. */
export class RegistryProblem extends Error {
  constructor(message: string, public status = 400, public hint?: string) {
    super(message);
  }
}

/** A package found in a registry, as of the last check. */
interface Tracked {
  key: string;
  entry: RegistryPackage;
  found: FoundPackage;
  /** As the entry filters them, newest first. */
  versions: FoundVersion[];
  /** The newest version with the build it currently is. */
  latest: (BuildRef & { artifact: Artifact | null }) | null;
}

interface Runtime {
  cfg: RegistryConfig;
  /** The settings as text: a registry whose settings did not change is left running on a save. */
  json: string;
  kind: RegistryKind;
  transport: Transport | null;
  /** Why it cannot be used at all. */
  error: string | null;
  problems: RegistryInfo['problems'];
  packages: Map<string, Tracked>;
  timer: NodeJS.Timeout | null;
  checking: Promise<void> | null;
  checkedAt: number | null;
  nextCheckAt: number | null;
  /** Ends requests in flight when the registry is removed or the hub stops. */
  abort: AbortController;
  /** What the last check's problems were, so the timeline is told once, not every check. */
  lastTrouble: string;
}

const PROGRESS_EVERY_MS = 150;
/** Strongest first. */
const HASHES: HashName[] = ['sha512', 'sha256', 'sha1', 'md5'];
const HASH_LABEL: Record<HashName, string> = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1', md5: 'MD5' };

const fmtMb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Text as part of a path: nothing a file system or a registry could turn into another folder. */
function slug(text: string, max = 60): string {
  const s = text.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, max);
  return s || '_';
}

/** A file name from a registry, made safe to write: no folders, nothing hidden, nothing Windows refuses. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\p{L}\p{N}._#~+@()\- ]+/gu, '_').replace(/^[. ]+|[. ]+$/g, '').slice(-120);
  return cleaned && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? cleaned : 'download.war';
}

const describe = (err: unknown, t: Transport | null): { message: string; hint?: string } => {
  const message = err instanceof Error ? err.message : String(err);
  return { message: t ? scrub(message, t.secrets) : message, hint: err instanceof RegistryError ? err.hint : undefined };
};

/**
 * Package registries as a source of WARs. Each registry is checked on its own timer; a version
 * that was not there before raises the same kind of notice a freshly built local WAR does.
 * Download & deploy fetches a version into the cache folder next to the settings file, checks
 * it against the registry's checksum, and hands the file to the Tomcat page's deploy, which
 * then treats it like any WAR from a build folder.
 */
export class RegistryService {
  private runtimes: Runtime[] = [];
  private store = new RegistryStateStore(null);
  private dataDir: string | null = null;
  private started = false;
  private downloads = new Map<string, { info: DownloadInfo; abort: AbortController }>();

  constructor(private cfg: Config, private hooks: RegistryHooks, private opts: RegistryServiceOptions = {}) {
    this.build();
  }

  // ── Lifecycle ─────────────────────────────────────────

  /**
   * Where the state file and the download cache live: the settings file's folder. Set by the HTTP
   * server, which knows it. Until then nothing is remembered and nothing can be downloaded.
   */
  useDataDir(dir: string): void {
    this.dataDir = dir;
    this.store = new RegistryStateStore(join(dir, STATE_FILE));
    void this.tidyCache();
  }

  start(): void {
    this.started = true;
    // Not in this turn: the hub is started before the HTTP server says where the state file is,
    // and the first check must compare against what that file remembers.
    setTimeout(() => {
      if (this.started) for (const r of this.runtimes) void this.check(r);
    }, 0).unref();
  }

  stop(): void {
    this.started = false;
    for (const r of this.runtimes) this.retire(r);
    for (const d of this.downloads.values()) d.abort.abort();
  }

  /** New settings. Registries whose settings did not change keep what they found and their timers. */
  reconfigure(cfg: Config): void {
    this.cfg = cfg;
    const old = this.runtimes;
    this.build(old);
    for (const r of old) if (!this.runtimes.includes(r)) this.retire(r);
    if (this.started) for (const r of this.runtimes) if (!old.includes(r)) void this.check(r);
    this.changed();
  }

  private retire(r: Runtime): void {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    r.nextCheckAt = null;
    r.abort.abort();
  }

  /**
   * The settings file is not checked when it is read (it may be written by hand), so each
   * registry is checked here: one with a mistake is listed with what is wrong, and the others
   * work.
   */
  private build(previous: Runtime[] = []): void {
    const raw: unknown[] = Array.isArray(this.cfg.registries) ? this.cfg.registries : [];
    const names = new Set<string>();
    this.runtimes = raw.flatMap((item): Runtime[] => {
      const json = JSON.stringify(item);
      const errors: FieldError[] = [];
      const [cfg] = validateRegistries([item], errors);
      if (!cfg) return [];
      const kept = previous.find((p) => p.json === json && p.cfg.name === cfg.name && !names.has(cfg.name.toLowerCase()));
      if (kept && !kept.error) {
        names.add(cfg.name.toLowerCase());
        return [kept];
      }
      const r: Runtime = {
        cfg,
        json,
        kind: KINDS[cfg.type],
        transport: null,
        error: null,
        problems: [],
        packages: new Map(),
        timer: null,
        checking: null,
        checkedAt: null,
        nextCheckAt: null,
        abort: new AbortController(),
        lastTrouble: '',
      };
      if (errors.length) r.error = `Its settings need fixing: ${errors[0].message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''}.`;
      else if (names.has(cfg.name.toLowerCase())) r.error = `Another registry is already called ${cfg.name}.`;
      else {
        try {
          r.transport = buildTransport(cfg, this.opts.env);
        } catch (err) {
          const d = describe(err, null);
          r.error = [d.message, d.hint].filter(Boolean).join(' ');
        }
      }
      names.add(cfg.name.toLowerCase());
      return [r];
    });
  }

  // ── Timeline and UI ───────────────────────────────────

  private note(level: Level, summary: string, data: Record<string, unknown> = {}): void {
    this.hooks.emit(makeEvent({ tsMs: Date.now(), source: 'tomcat', kind: 'log', level, summary, data: { message: summary, ...data } }));
  }

  private changed(): void {
    this.hooks.notify({ type: 'registry', change: 'state' });
  }

  // ── Checking ──────────────────────────────────────────

  /** One check of a registry; a second caller waits for the one under way. */
  private check(r: Runtime): Promise<void> {
    r.checking ??= this.runCheck(r).finally(() => {
      r.checking = null;
      if (r.abort.signal.aborted) return;
      this.schedule(r);
      this.changed();
    });
    return r.checking;
  }

  private schedule(r: Runtime): void {
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    r.nextCheckAt = null;
    if (!this.started || !r.transport || r.cfg.checkMinutes <= 0) return;
    const ms = Math.max(1, r.cfg.checkMinutes) * 60_000;
    r.nextCheckAt = Date.now() + ms;
    r.timer = setTimeout(() => void this.check(r), ms);
    r.timer.unref();
  }

  private async runCheck(r: Runtime): Promise<void> {
    if (!r.transport) return;
    const ctx: RegistryContext = { registry: r.cfg, transport: r.transport, signal: r.abort.signal };
    const problems: RegistryInfo['problems'] = [];
    const packages = new Map<string, Tracked>();
    const announce: Tracked[] = [];
    let touched = false;
    this.changed();
    for (const entry of r.cfg.packages) {
      const label = r.kind.describe(entry);
      try {
        const listing = await r.kind.list(ctx, entry);
        if (r.abort.signal.aborted) return;
        if (listing.hint) problems.push({ entry: label, message: listing.hint, quiet: true });
        if (!listing.packages.length) problems.push({ entry: label, message: 'Nothing found.', quiet: true });
        for (const found of listing.packages) {
          // Two entries that find the same package (one names it, one searches its group): the first has it.
          if (packages.has(`${r.cfg.name}::${found.id}`)) continue;
          const tracked = await this.track(r, ctx, entry, found, problems);
          packages.set(tracked.key, tracked);
          if (this.settle(r, tracked)) announce.push(tracked);
          touched = true;
        }
      } catch (err) {
        if (r.abort.signal.aborted) return;
        // What this entry found last time stays listed; the problem says the listing may be old.
        for (const [key, old] of r.packages) if (old.entry === entry && !packages.has(key)) packages.set(key, old);
        problems.push({ entry: label, ...describe(err, r.transport) });
      }
    }
    r.packages = packages;
    r.problems = problems;
    r.checkedAt = Date.now();
    if (touched) this.save();

    const trouble = problems.filter((p) => !p.quiet).map((p) => `${p.entry}: ${p.message}`).join(' · ');
    if (trouble && trouble !== r.lastTrouble) this.note('warn', `Package registry ${r.cfg.name}: ${trouble}`, { registry: r.cfg.name });
    r.lastTrouble = trouble;

    const names = announce.length ? await this.names() : null;
    for (const t of announce) {
      const version = t.latest!.version;
      this.note('info', `New package version: ${t.found.name} ${version} (${t.found.coordinates}, ${r.cfg.name})`, { registry: r.cfg.name, package: t.found.coordinates, version });
      this.hooks.notify({
        type: 'registry',
        change: 'new',
        notice: { key: t.key, registry: r.cfg.name, name: t.found.name, coordinates: t.found.coordinates, version, target: this.target(t, names!.all) },
      });
    }
  }

  /** Filters and orders a found package's versions, and finds out which build the newest one is. */
  private async track(r: Pick<Runtime, 'cfg' | 'kind' | 'transport'>, ctx: RegistryContext, entry: RegistryPackage, found: FoundPackage, problems: RegistryInfo['problems']): Promise<Tracked> {
    const matches = versionMatcher(entry.versionPattern ?? '');
    const kinds = entry.versions ?? 'all';
    const versions = sortNewestFirst(
      found.versions.filter((v) => (kinds === 'all' || (kinds === 'snapshots') === v.snapshot) && matches(v.version)),
      (v) => v.version,
    );
    const tracked: Tracked = { key: `${r.cfg.name}::${found.id}`, entry, found, versions, latest: null };
    const newest = versions[0];
    if (!newest) {
      if (found.versions.length) problems.push({ entry: found.coordinates, message: `None of its ${found.versions.length} versions pass the version settings.` });
      return tracked;
    }
    let artifact = newest.artifact;
    // A SNAPSHOT is rebuilt under the same version: only the registry knows which build it is now.
    if (!artifact && newest.snapshot) {
      try {
        artifact = await r.kind.locate(ctx, entry, found, newest);
      } catch (err) {
        problems.push({ entry: `${found.coordinates} ${newest.version}`, ...describe(err, r.transport) });
      }
    }
    tracked.latest = { version: newest.version, build: artifact?.build ?? newest.version, artifact };
    return tracked;
  }

  /**
   * Records what a check found for a package. Returns whether its latest version should be
   * announced: it is newer than what the user has dealt with, and was not announced before.
   */
  private settle(r: Runtime, t: Tracked): boolean {
    const st = this.store.touch(t.key);
    // Other version settings give another latest version: start over rather than call it new,
    // or (after narrowing them) never call anything new again until it tops what was seen.
    const filter = `${t.entry.versions ?? 'all'}|${t.entry.versionPattern ?? ''}`;
    if (st.filter !== undefined && st.filter !== filter) st.seen = null;
    st.filter = filter;
    if (!t.latest) return false;
    const latest: BuildRef = { version: t.latest.version, build: t.latest.build };
    // The first look at a package: what is there now is not news.
    if (!st.seen) {
      st.seen = latest;
      return false;
    }
    if (!this.isNews(r.kind, latest, st.seen) || sameBuild(latest, st.announced)) return false;
    st.announced = latest;
    return true;
  }

  private isNews(kind: RegistryKind, latest: BuildRef, seen: BuildRef | null): boolean {
    if (!seen || sameBuild(latest, seen)) return false;
    return !kind.ordered || compareVersions(latest.version, seen.version) >= 0;
  }

  private save(): void {
    try {
      this.store.save();
    } catch (err) {
      this.note('warn', `Could not save what is known about packages: ${(err as Error).message}`);
    }
  }

  /** Checks every registry, or one, now, and waits for it. */
  async checkNow(name?: string): Promise<void> {
    const which = this.runtimes.filter((r) => (name === undefined || r.cfg.name === name) && r.transport);
    if (name !== undefined && !which.length) throw new RegistryProblem(`There is no usable registry called ${name}.`, 404);
    await Promise.all(which.map((r) => this.check(r)));
  }

  // ── State ─────────────────────────────────────────────

  private find(key: string): { r: Runtime; t: Tracked } {
    for (const r of this.runtimes) {
      const t = r.packages.get(key);
      if (t) return { r, t };
    }
    throw new RegistryProblem('That package is not in the registries any more. Check again.', 404);
  }

  /** The webapps there are; none when the webapps folder cannot be read. */
  private names(): Promise<{ deployed: string[]; all: string[] }> {
    return this.hooks.webappNames().catch(() => ({ deployed: [], all: [] }));
  }

  /** What a package deploys as unless it is told otherwise: the settings' Deploy as, or a guess. */
  private defaultTarget(t: Tracked, names: string[]): { target: string; from: 'settings' | 'guess' } {
    return t.entry.deployAs ? { target: t.entry.deployAs, from: 'settings' } : { target: guessTarget(`${t.found.name}.war`, names), from: 'guess' };
  }

  private targetOf(t: Tracked, names: string[]): { target: string; from: PackageInfo['targetFrom'] } {
    const own = this.store.get(t.key)?.deployAs;
    return own ? { target: own, from: 'package' } : this.defaultTarget(t, names);
  }

  private target(t: Tracked, names: string[]): string {
    return this.targetOf(t, names).target;
  }

  /** Remembers the name a package deploys as, unless it is the one it would have anyway. */
  private keepTarget(st: PackageState, t: Tracked, name: string, names: string[]): void {
    const d = this.defaultTarget(t, names);
    const same = d.from === 'settings' ? name === d.target : name.toLowerCase() === d.target.toLowerCase();
    // The default is not remembered, so a later change in Settings still counts.
    if (same) delete st.deployAs;
    else st.deployAs = name;
  }

  /** Sets the webapp name a package deploys as; empty goes back to the settings' or the guess. */
  async setTarget(key: string, deployAs: string): Promise<void> {
    const { t } = this.find(key);
    const name = deployAs.trim();
    const problem = name ? checkName(name) : null;
    if (problem) throw new RegistryProblem(`${problem}.`);
    const st = this.store.touch(key);
    if (name) this.keepTarget(st, t, name, (await this.names()).all);
    else delete st.deployAs;
    this.save();
    this.changed();
  }

  async snapshot(): Promise<RegistryState> {
    const names = await this.names();
    const registries: RegistryInfo[] = this.runtimes.map((r) => ({
      name: r.cfg.name,
      type: r.cfg.type,
      url: displayUrl(r.cfg.url),
      checking: !!r.checking,
      checkedAt: r.checkedAt ? new Date(r.checkedAt).toISOString() : null,
      nextCheckAt: r.nextCheckAt ? new Date(r.nextCheckAt).toISOString() : null,
      error: r.error,
      problems: r.problems,
      packages: [...r.packages.values()]
        .map((t): PackageInfo => {
          const st = this.store.get(t.key);
          const cached = new Set((st?.downloads ?? []).map((d) => d.version));
          const latestBuild = t.latest ? `${t.latest.version}\n${t.latest.build}` : '';
          return {
            key: t.key,
            registry: r.cfg.name,
            name: t.found.name,
            coordinates: t.found.coordinates,
            versions: t.versions.slice(0, MAX_LISTED_VERSIONS).map((v) => ({
              version: v.version,
              snapshot: v.snapshot,
              modified: v.artifact?.modified ?? (v.version === t.latest?.version ? (t.latest.artifact?.modified ?? null) : null),
              bytes: v.artifact?.bytes ?? null,
              // The latest version counts as downloaded only if it is the build that is current now.
              cached: v.version === t.latest?.version ? !!st?.downloads.some((d) => `${d.version}\n${d.build}` === latestBuild) : cached.has(v.version),
            })),
            versionCount: t.versions.length,
            latest: t.latest?.version ?? null,
            fresh: !!t.latest && !!st && this.isNews(r.kind, t.latest, st.seen),
            ...(({ target, from }) => ({ target, targetFrom: from }))(this.targetOf(t, names.all)),
            deployed: st?.deployed && names.deployed.includes(st.deployed.as) ? { version: st.deployed.version, as: st.deployed.as, at: st.deployed.at } : null,
            download: this.downloads.get(t.key)?.info ?? null,
          };
        })
        .sort((a, b) => a.coordinates.localeCompare(b.coordinates)),
    }));
    return { registries };
  }

  /** The user has seen the latest version and does not want it now. */
  dismiss(key: string): void {
    const { t } = this.find(key);
    if (!t.latest) return;
    this.store.touch(key).seen = { version: t.latest.version, build: t.latest.build };
    this.save();
    this.changed();
  }

  /**
   * Called for every deploy on the Tomcat page. A WAR from the cache is remembered as what is
   * deployed from its package; any other WAR deployed under the same name replaces that.
   */
  deployed(file: string, name: string): void {
    const hit = this.store.downloads().find((d) => d.download.file === file);
    let touched = false;
    for (const key of this.store.keys()) {
      const st = this.store.get(key)!;
      if (hit?.key !== key && st.deployed?.as === name) {
        st.deployed = null;
        touched = true;
      }
    }
    if (hit) {
      const st = this.store.touch(hit.key);
      st.deployed = { version: hit.download.version, build: hit.download.build, as: name, at: new Date().toISOString() };
      const tracked = this.runtimes.map((r) => r.packages.get(hit.key)).find(Boolean);
      const latest = tracked?.latest;
      if (latest && sameBuild(latest, hit.download)) st.seen = { version: latest.version, build: latest.build };
      // Deployed under another name than it would have been: that is its name from now on.
      if (tracked) this.keepTarget(st, tracked, name, []);
      touched = true;
    }
    if (!touched) return;
    this.save();
    this.changed();
  }

  // ── Download ──────────────────────────────────────────

  private cachedFile(key: string, build: BuildRef): CachedDownload | undefined {
    return this.store.get(key)?.downloads.find((d) => sameBuild(d, build));
  }

  private progress(key: string, info: DownloadInfo | null): void {
    this.hooks.notify({ type: 'registry', change: 'download', key, download: info });
  }

  cancel(key: string): void {
    this.downloads.get(key)?.abort.abort();
  }

  /**
   * Fetches one version of a package into the cache (unless that build is there already) and
   * hands it to the Tomcat page. Resolves when the file is ready to deploy.
   */
  async download(key: string, version?: string): Promise<DownloadResult> {
    const { r, t } = this.find(key);
    if (!this.dataDir) throw new RegistryProblem('Downloads need a settings folder, which this Debug Hub was started without.', 500);
    if (this.downloads.has(key)) throw new RegistryProblem(`${t.found.coordinates} is already being downloaded.`, 409);
    const wanted = version ?? t.latest?.version;
    const found = t.versions.find((v) => v.version === wanted);
    if (!found) throw new RegistryProblem(`${t.found.coordinates} has no version ${wanted ?? ''} any more. Check again.`.replace(/\s+any/, ' any'), 404);

    const abort = new AbortController();
    const info: DownloadInfo = { key, version: found.version, phase: 'starting', received: 0, total: null };
    this.downloads.set(key, { info, abort });
    this.progress(key, info);
    const ctx: RegistryContext = { registry: r.cfg, transport: r.transport!, signal: abort.signal };
    let tmp: string | null = null;
    try {
      const artifact = await r.kind.locate(ctx, t.entry, t.found, found);
      const build: BuildRef = { version: found.version, build: artifact.build };
      const names = await this.names();
      const ready = async (file: string, note: string): Promise<DownloadResult> => {
        const war = await this.hooks.adoptWar(file);
        return { war: { ...war, target: this.target(t, names.all) }, note };
      };

      const have = this.cachedFile(key, build);
      if (have) {
        const st = await fs.stat(have.file).catch(() => null);
        if (st?.isFile() && st.size === have.bytes) return await ready(have.file, 'Already downloaded.');
        this.forget(key, have);
      }

      // The registry's checksum first: without one that can be fetched, nothing is verified, and the note says so.
      let sums = artifact.checksums;
      if (!Object.keys(sums).length && r.kind.checksums) sums = await r.kind.checksums(ctx, artifact);
      const hash = HASHES.find((h) => sums[h]);

      const fileName = safeFileName(artifact.fileName);
      const dir = join(this.dataDir, CACHE_DIR, `${slug(t.found.name, 40)}-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`, slug(artifact.build));
      await fs.mkdir(dir, { recursive: true });
      tmp = join(dir, `.${fileName}.${randomBytes(4).toString('hex')}.part`);
      info.phase = 'downloading';
      let last = 0;
      const got = await downloadTo(r.transport!, artifact.url, tmp, {
        signal: abort.signal,
        hashes: hash ? [hash] : [],
        onProgress: (received, total) => {
          info.received = received;
          info.total = total ?? artifact.bytes;
          const now = Date.now();
          if (now - last < PROGRESS_EVERY_MS) return;
          last = now;
          this.progress(key, { ...info });
        },
      });
      info.phase = 'verifying';
      this.progress(key, { ...info });

      if (hash && got.digests[hash] !== sums[hash]) {
        throw new RegistryError(
          `${fileName} does not match the registry’s ${HASH_LABEL[hash]} checksum (the registry says ${sums[hash]!.slice(0, 12)}…, the download has ${got.digests[hash]!.slice(0, 12)}…). It was not kept.`,
          'checksum',
          0,
          'The download was damaged on the way, or the file in the registry is. Try again; if it keeps happening, tell whoever runs the registry.',
        );
      }
      if (!(await looksComplete(tmp))) {
        const html = /^text\/html/i.test(got.headers['content-type'] ?? '');
        throw new RegistryError(
          `What ${got.url} sent is not a WAR (a zip archive)${html ? ' but a web page' : ''}. It was not kept.`,
          'content',
          0,
          html ? 'It may be a login page: check the registry’s login.' : undefined,
        );
      }
      const file = join(dir, fileName);
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
      tmp = null;
      // The registry's date, so the deploy dialog says when it was built rather than when it was fetched.
      const modified = artifact.modified ?? httpTime(got.headers['last-modified']);
      if (modified) await fs.utimes(file, new Date(), new Date(modified)).catch(() => undefined);

      const checked = hash ? `${HASH_LABEL[hash]} verified` : 'the registry publishes no checksum for it, so it was not verified';
      const st = this.store.touch(key);
      st.downloads = st.downloads.filter((d) => d.file !== file);
      st.downloads.push({ ...build, file, bytes: got.bytes, checksum: hash ? `${hash}:${sums[hash]}` : null, modified, downloadedAt: new Date().toISOString() });
      await this.prune(key);
      this.save();
      this.note('info', `Downloaded ${fileName} from ${r.cfg.name} (${fmtMb(got.bytes)}, ${checked})`, { registry: r.cfg.name, package: t.found.coordinates, version: found.version, file });
      return await ready(file, `Downloaded ${fmtMb(got.bytes)}; ${checked}.`);
    } catch (err) {
      if (err instanceof RegistryProblem) throw err;
      const d = describe(err, r.transport);
      const canceled = err instanceof RegistryError && err.kind === 'canceled';
      if (!canceled) this.note('warn', `Could not download ${t.found.coordinates} ${found.version} from ${r.cfg.name}: ${d.message}`, { registry: r.cfg.name });
      throw new RegistryProblem(canceled ? 'The download was canceled.' : d.message, canceled ? 499 : err instanceof RegistryError && err.kind === 'not-found' ? 404 : 502, d.hint);
    } finally {
      if (tmp) {
        await fs.rm(tmp, { force: true }).catch(() => undefined);
        // The build's folder too, if the download was all that was in it.
        await fs.rmdir(dirname(tmp)).catch(() => undefined);
      }
      this.downloads.delete(key);
      this.progress(key, null);
      this.changed();
    }
  }

  // ── Cache ─────────────────────────────────────────────

  private inCache(file: string): boolean {
    if (!this.dataDir) return false;
    const root = resolve(this.dataDir, CACHE_DIR);
    const rel = resolve(file).slice(root.length);
    return resolve(file).startsWith(root) && /^[\\/]/.test(rel);
  }

  /** Deletes a cached file (only ever inside the cache folder) and its folder if that is now empty. */
  private async remove(file: string): Promise<void> {
    if (!this.inCache(file)) return;
    await fs.rm(file, { force: true }).catch(() => undefined);
    for (let dir = dirname(file); this.inCache(dir); dir = dirname(dir)) {
      if (!(await fs.rmdir(dir).then(() => true, () => false))) break;
    }
  }

  private forget(key: string, d: CachedDownload): void {
    const st = this.store.get(key);
    if (st) st.downloads = st.downloads.filter((x) => x !== d);
  }

  /** Keeps a package's newest few downloads and the one that is deployed; the rest are deleted. */
  private async prune(key: string): Promise<void> {
    const st = this.store.get(key);
    if (!st) return;
    const keep = this.opts.keepDownloads ?? 3;
    const newest = [...st.downloads].sort((a, b) => (a.downloadedAt < b.downloadedAt ? 1 : -1));
    const kept = new Set(newest.slice(0, keep));
    for (const d of newest) if (sameBuild(d, st.deployed)) kept.add(d);
    for (const d of newest) if (!kept.has(d)) await this.remove(d.file);
    st.downloads = st.downloads.filter((d) => kept.has(d));
  }

  /**
   * At startup: forgets downloads whose file is gone and packages not seen for months, and
   * deletes what is in the cache folder but not on record (a download cut off by a crash).
   */
  private async tidyCache(): Promise<void> {
    if (!this.dataDir) return;
    const root = join(this.dataDir, CACHE_DIR);
    let touched = false;
    for (const d of this.store.forgetStale()) {
      await this.remove(d.file);
      touched = true;
    }
    const known = new Set<string>();
    for (const { key, download } of this.store.downloads()) {
      const st = this.inCache(download.file) ? await fs.stat(download.file).catch(() => null) : null;
      if (st?.isFile()) known.add(resolve(download.file));
      else {
        this.forget(key, download);
        touched = true;
      }
    }
    // The cache is <package>/<build>/<file>: two levels of folders, never deeper.
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const path = join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 2) await walk(path, depth + 1);
          await fs.rmdir(path).catch(() => undefined);
        } else if (e.isFile() && !known.has(resolve(path))) await fs.rm(path, { force: true }).catch(() => undefined);
      }
    };
    await walk(root, 0);
    if (touched) this.save();
  }

  // ── Test connection ───────────────────────────────────

  /**
   * Tries a registry as it is in the settings screen, saved or not, and says what it found: for
   * each package how many versions and which is the latest, or what went wrong.
   */
  async test(input: unknown): Promise<TestResult> {
    const errors: FieldError[] = [];
    const [validated] = validateRegistries([input], errors);
    const lines: TestLine[] = [];
    if (!validated) return { ok: false, lines: [{ ok: false, entry: '', message: 'Fill in the registry first.' }] };
    const form = REGISTRY_FORMS[validated.type];
    for (const e of errors) {
      const at = /\.packages\.(\d+)\./.exec(e.path);
      lines.push({ ok: false, entry: at ? `${form.entry.noun} ${Number(at[1]) + 1}` : '', message: e.message });
    }
    if (errors.length) return { ok: false, lines };

    // Not saved yet, so not made absolute yet: relative to the settings file, as it will be.
    const [cfg] = resolveRegistryPaths([validated], (p) => (isAbsolute(p) || !this.dataDir ? p : resolve(this.dataDir, p)));
    let transport: Transport;
    try {
      transport = buildTransport(cfg, this.opts.env);
    } catch (err) {
      return { ok: false, lines: [{ ok: false, entry: '', ...describe(err, null) }] };
    }
    const kind = KINDS[cfg.type];
    const ctx: RegistryContext = { registry: cfg, transport };
    if (!cfg.packages.length) {
      try {
        lines.push({ ok: true, entry: '', message: await kind.probe(ctx) });
      } catch (err) {
        lines.push({ ok: false, entry: '', ...describe(err, transport) });
      }
    }
    for (const entry of cfg.packages) {
      const label = kind.describe(entry);
      try {
        const listing = await kind.list(ctx, entry);
        if (!listing.packages.length) lines.push({ ok: false, entry: label, message: 'Reached the registry, but found nothing there.', hint: listing.hint });
        const problems: RegistryInfo['problems'] = [];
        const shown = listing.packages.slice(0, 12);
        for (const found of shown) {
          const t = await this.track({ cfg, kind, transport }, ctx, entry, found, problems);
          const n = t.versions.length;
          const left = found.versions.length - n;
          const size = t.latest?.artifact?.bytes != null ? `, ${fmtMb(t.latest.artifact.bytes)}` : '';
          lines.push({
            ok: n > 0,
            entry: found.coordinates,
            message: n
              ? kind.ordered
                ? `${n} version${n === 1 ? '' : 's'}, latest ${t.latest!.version}${size}${left ? ` (${left} more left out by the version settings)` : ''}`
                : `Found: ${t.latest!.version}${size}`
              : `None of its ${found.versions.length} versions pass the version settings.`,
          });
        }
        for (const p of problems) if (!/pass the version settings/.test(p.message)) lines.push({ ok: false, entry: p.entry, message: p.message, hint: p.hint });
        if (listing.packages.length > shown.length) lines.push({ ok: true, entry: label, message: `…and ${listing.packages.length - shown.length} more packages.` });
        if (listing.hint && listing.packages.length) lines.push({ ok: true, entry: label, message: listing.hint });
      } catch (err) {
        lines.push({ ok: false, entry: label, ...describe(err, transport) });
      }
    }
    return { ok: lines.every((l) => l.ok), lines };
  }

  /** Exposed for tests. */
  get state(): RegistryStateStore {
    return this.store;
  }
}
