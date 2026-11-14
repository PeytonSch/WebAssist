import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Payload updater. No Electron imports, so it can be unit-tested with plain Node.
 *
 * The installed shell never changes. What updates is the "payload": the hub server, its UI and
 * the desktop window code, published as one file on each GitHub Release. Payloads live in the
 * user-data folder, one directory per version:
 *
 *   <root>/state.json            { current, previous, bad[] }
 *   <root>/<version>/app.cjs     entry point
 *   <root>/<version>/ui/...
 *
 * A new version is unpacked beside the old one and made current by rewriting state.json, so an
 * interrupted update leaves the previous version untouched and runnable.
 */

export interface Manifest {
  version: string;
  /** Lowest shell API level this payload runs on. */
  minShell: number;
  /** Payload file name, relative to the manifest; `url` overrides it when present. */
  file: string;
  url?: string;
  sha256: string;
  size: number;
}

export interface PayloadInfo {
  version: string;
  dir: string;
  source: 'bundled' | 'downloaded';
}

export type UpdateResult =
  | { result: 'none' }
  | { result: 'updated'; version: string }
  | { result: 'offline'; error: string }
  | { result: 'failed'; version?: string; error: string }
  | { result: 'shell-outdated'; version: string };

export interface Progress {
  phase: 'checking' | 'downloading' | 'installing';
  version?: string;
  /** 0 to 100 while downloading. */
  percent?: number;
}

export interface UpdaterOptions {
  /** Directory that holds downloaded payloads. */
  root: string;
  /** Payload shipped inside the installer; the fallback when nothing has been downloaded. */
  bundledDir: string | null;
  /** URL of latest.json, or null to disable updating. */
  manifestUrl: string | null;
  shellApi: number;
  fetch: typeof fetch;
  onProgress?: (p: Progress) => void;
  log?: (msg: string) => void;
}

interface State {
  current: string | null;
  previous: string | null;
  bad: string[];
}

const MAX_PAYLOAD_BYTES = 200 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** "v1.2.3" / "1.2.3" -> [1, 2, 3]; anything after a "-" is ignored. */
const parseVersion = (v: string) =>
  String(v || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);

export function isNewer(remote: string, local: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** Packs a directory tree into the single-file payload format: gzip(JSON { files: { path: base64 } }). */
export function packPayload(dir: string): Buffer {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${name.name}` : name.name;
      if (name.isDirectory()) walk(child);
      else if (name.isFile()) files[child] = readFileSync(join(dir, child)).toString('base64');
    }
  };
  walk('');
  return gzipSync(JSON.stringify({ files }), { level: 9 });
}

export function unpackPayload(data: Buffer, dest: string): void {
  const parsed = JSON.parse(gunzipSync(data, { maxOutputLength: MAX_PAYLOAD_BYTES * 2 }).toString('utf8'));
  const files = parsed?.files;
  if (!files || typeof files !== 'object') throw new Error('Payload has no file list');
  for (const [rel, b64] of Object.entries(files)) {
    const clean = normalize(rel);
    // A payload may only write inside its own version directory.
    if (isAbsolute(clean) || clean === '..' || clean.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(clean)) {
      throw new Error(`Payload contains an unsafe path: ${rel}`);
    }
    const out = join(dest, clean);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(String(b64), 'base64'));
  }
}

export class Updater {
  private log: (msg: string) => void;

  constructor(private o: UpdaterOptions) {
    this.log = o.log ?? (() => undefined);
    mkdirSync(o.root, { recursive: true });
  }

  private get stateFile(): string {
    return join(this.o.root, 'state.json');
  }

  private readState(): State {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      return { current: s.current ?? null, previous: s.previous ?? null, bad: Array.isArray(s.bad) ? s.bad : [] };
    } catch {
      return { current: null, previous: null, bad: [] };
    }
  }

  private writeState(s: State): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.stateFile);
  }

  private downloaded(version: string | null, bad: string[]): PayloadInfo | null {
    if (!version || !VERSION.test(version) || bad.includes(version)) return null;
    const dir = join(this.o.root, version);
    return existsSync(join(dir, 'app.cjs')) ? { version, dir, source: 'downloaded' } : null;
  }

  private bundled(): PayloadInfo | null {
    const dir = this.o.bundledDir;
    if (!dir || !existsSync(join(dir, 'app.cjs'))) return null;
    try {
      const version = JSON.parse(readFileSync(join(dir, 'payload.json'), 'utf8')).version;
      return { version: String(version), dir, source: 'bundled' };
    } catch {
      return null;
    }
  }

  /** Every payload that could be started, best first. */
  candidates(): PayloadInfo[] {
    const s = this.readState();
    const list = [this.downloaded(s.current, s.bad), this.downloaded(s.previous, s.bad), this.bundled()].filter(
      (p): p is PayloadInfo => p !== null,
    );
    // A reinstalled shell can bundle something newer than the last download.
    return list
      .filter((p, i) => list.findIndex((q) => q.dir === p.dir) === i)
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0));
  }

  current(): PayloadInfo | null {
    return this.candidates()[0] ?? null;
  }

  /** Records that a payload failed to start, so it is never chosen or downloaded again. */
  markBad(version: string): void {
    const s = this.readState();
    if (!s.bad.includes(version)) s.bad.push(version);
    if (s.current === version) {
      s.current = s.previous;
      s.previous = null;
    }
    this.writeState(s);
  }

  /** Checks the release feed and installs a newer payload if there is one. Never throws. */
  async update(checkTimeoutMs = 6000, downloadTimeoutMs = 120_000): Promise<UpdateResult> {
    const { manifestUrl } = this.o;
    if (!manifestUrl) return { result: 'none' };
    const installed = this.current();
    this.o.onProgress?.({ phase: 'checking' });

    let manifest: Manifest;
    try {
      const res = await this.o.fetch(manifestUrl, { signal: AbortSignal.timeout(checkTimeoutMs), cache: 'no-store' });
      if (res.status === 404) return { result: 'none' }; // no releases yet
      if (!res.ok) throw new Error(`Update check failed (${res.status})`);
      manifest = (await res.json()) as Manifest;
    } catch (err) {
      return { result: 'offline', error: (err as Error).message };
    }

    try {
      const { version } = manifest;
      if (!VERSION.test(String(version)) || !/^[0-9a-f]{64}$/.test(String(manifest.sha256)) || !(manifest.size > 0)) {
        throw new Error('The update manifest is malformed');
      }
      if (installed && !isNewer(version, installed.version)) return { result: 'none' };
      if (this.readState().bad.includes(version)) {
        this.log(`Skipping ${version}: it failed to start before`);
        return { result: 'none' };
      }
      if (manifest.minShell > this.o.shellApi) return { result: 'shell-outdated', version };
      if (manifest.size > MAX_PAYLOAD_BYTES) throw new Error('The update is implausibly large');

      const url = new URL(manifest.url ?? manifest.file, manifestUrl);
      if (url.origin !== new URL(manifestUrl).origin) throw new Error('The update points at a different site');

      this.o.onProgress?.({ phase: 'downloading', version, percent: 0 });
      const data = await this.download(url.toString(), manifest, downloadTimeoutMs);
      const digest = createHash('sha256').update(data).digest('hex');
      if (digest !== manifest.sha256) throw new Error('The download did not match its checksum');

      this.o.onProgress?.({ phase: 'installing', version });
      const finalDir = join(this.o.root, version);
      const tmpDir = `${finalDir}.tmp-${process.pid}`;
      rmSync(tmpDir, { recursive: true, force: true });
      try {
        unpackPayload(data, tmpDir);
        if (!existsSync(join(tmpDir, 'app.cjs'))) throw new Error('The update is missing its entry point');
        rmSync(finalDir, { recursive: true, force: true });
        renameSync(tmpDir, finalDir);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }

      const s = this.readState();
      const keep = installed?.source === 'downloaded' ? installed.version : s.current;
      this.writeState({ ...s, current: version, previous: keep && keep !== version ? keep : null });
      this.prune();
      return { result: 'updated', version };
    } catch (err) {
      return { result: 'failed', version: manifest.version, error: (err as Error).message };
    }
  }

  private async download(url: string, manifest: Manifest, timeoutMs: number): Promise<Buffer> {
    const res = await this.o.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const chunks: Buffer[] = [];
    let received = 0;
    let lastPercent = -1;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > manifest.size) {
        await reader.cancel();
        throw new Error('The download is larger than the manifest says');
      }
      chunks.push(Buffer.from(value));
      const percent = Math.floor((received / manifest.size) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        this.o.onProgress?.({ phase: 'downloading', version: manifest.version, percent });
      }
    }
    if (received !== manifest.size) throw new Error('The download was cut short');
    return Buffer.concat(chunks);
  }

  /** Removes payload directories that are neither current nor the rollback target. */
  private prune(): void {
    const s = this.readState();
    for (const name of readdirSync(this.o.root, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name === s.current || name.name === s.previous) continue;
      rmSync(join(this.o.root, name.name), { recursive: true, force: true });
    }
  }
}
