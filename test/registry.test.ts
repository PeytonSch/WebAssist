import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig, type Config, type FieldError } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import { validateRegistries } from '../src/server/registry/config';
import { forgetPublished, isArtifactPattern, listingFolders, mavenKind, nexus3BrowseUrl, parseArtifactMetadata, parseChecksum, parseSnapshotMetadata } from '../src/server/registry/maven';
import { nexus3Kind, splitFileName } from '../src/server/registry/nexus3';
import { RegistryProblem, RegistryService, safeFileName } from '../src/server/registry/service';
import { RegistryStateStore, STATE_FILE } from '../src/server/registry/state';
import { basicAuth, buildTransport, displayUrl, downloadTo, failure, fetchAnswer, fetchText, RegistryError, resolveEnv, sameHost, scrub, type Transport } from '../src/server/registry/transport';
import type { RegistryContext } from '../src/server/registry/types';
import { urlKind } from '../src/server/registry/url';
import { baseVersion, compareVersions, isSnapshot, sortNewestFirst, versionMatcher } from '../src/server/registry/version';
import type { RegistryConfig, RegistryMessage } from '../src/shared/registry';
import type { HubEvent } from '../src/shared/types';

// ── A fake registry ─────────────────────────────────────

interface Hit {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

interface Fake {
  url: string;
  port: number;
  hits: Hit[];
}

let dir: string;
const servers: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-registry-'));
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  rmSync(dir, { recursive: true, force: true });
});

type Handler = (req: IncomingMessage, res: ServerResponse, path: string) => void;

async function serve(handler: Handler, tls?: { cert: string; key: string }): Promise<Fake> {
  const hits: Hit[] = [];
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    hits.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
    handler(req, res, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  };
  const server = tls ? createTlsServer(tls, listener) : createServer(listener);
  servers.push(server as Server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`, port, hits };
}

/** Serves files by path, like a static Maven repository. With `login`, only to that Authorization header. */
function files(store: Map<string, string | Buffer>, login?: string): Handler {
  return (req, res, path) => {
    if (login && req.headers.authorization !== login) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Fake Nexus"' });
      return void res.end();
    }
    const body = store.get(path);
    if (body === undefined) {
      res.writeHead(404);
      return void res.end('not here');
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(200, { 'content-length': String(buf.length) });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
}

/** A minimal zip: just the end-of-central-directory record, which is what marks a complete WAR. */
function war(extra = ''): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([Buffer.from(`PK\x03\x04${extra}`), eocd]);
}

const digest = (hash: string, b: Buffer) => createHash(hash).update(b).digest('hex');

const artifactMeta = (versions: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>com.example</groupId>
  <artifactId>shop</artifactId>
  <versioning>
    <latest>${versions[versions.length - 1]}</latest>
    <versions>
${versions.map((v) => `      <version>${v}</version>`).join('\n')}
    </versions>
    <lastUpdated>20261114101502</lastUpdated>
  </versioning>
</metadata>`;

const snapshotMeta = (version: string, stamp: string, build: number) => {
  const value = `${version.replace('-SNAPSHOT', '')}-${stamp}-${build}`;
  return `<metadata modelVersion="1.1.0">
  <groupId>com.example</groupId><artifactId>shop</artifactId><version>${version}</version>
  <versioning>
    <snapshot><timestamp>${stamp}</timestamp><buildNumber>${build}</buildNumber></snapshot>
    <lastUpdated>${stamp.replace('.', '')}</lastUpdated>
    <snapshotVersions>
      <snapshotVersion><extension>pom</extension><value>${value}</value><updated>${stamp.replace('.', '')}</updated></snapshotVersion>
      <snapshotVersion><classifier>sources</classifier><extension>jar</extension><value>${value}</value><updated>${stamp.replace('.', '')}</updated></snapshotVersion>
      <snapshotVersion><extension>war</extension><value>${value}</value><updated>${stamp.replace('.', '')}</updated></snapshotVersion>
    </snapshotVersions>
  </versioning>
</metadata>`;
};

const REPO = '/repository/maven-public';
const SHOP = `${REPO}/com/example/shop`;

/** A Maven repository with shop 2.3.0 and 2.4.0, each with its WAR and a .sha1 next to it. */
function mavenStore(versions = ['2.3.0', '2.4.0']): Map<string, string | Buffer> {
  const store = new Map<string, string | Buffer>();
  store.set(`${SHOP}/maven-metadata.xml`, artifactMeta(versions));
  for (const v of versions) publish(store, v);
  return store;
}

function publish(store: Map<string, string | Buffer>, version: string, body = war(version)): void {
  const all = parseArtifactMetadata(String(store.get(`${SHOP}/maven-metadata.xml`))).versions;
  if (!all.includes(version)) store.set(`${SHOP}/maven-metadata.xml`, artifactMeta([...all, version]));
  store.set(`${SHOP}/${version}/shop-${version}.war`, body);
  store.set(`${SHOP}/${version}/shop-${version}.war.sha1`, digest('sha1', body));
}

function registry(over: Partial<RegistryConfig> & { url: string }): RegistryConfig {
  return {
    name: 'Nexus',
    type: 'maven',
    auth: { type: 'none' },
    headers: [],
    insecureTls: false,
    caFile: '',
    timeoutMs: 5000,
    checkMinutes: 0,
    packages: [{ groupId: 'com.example', artifactId: 'shop', classifier: '', extension: 'war', versions: 'all', versionPattern: '', deployAs: '' }],
    ...over,
  };
}

const transportFor = (reg: RegistryConfig, env: Record<string, string> = {}): Transport => buildTransport(reg, env);
const ctxFor = (reg: RegistryConfig): RegistryContext => ({ registry: reg, transport: transportFor(reg) });

function makeService(registries: RegistryConfig[], opts: { names?: string[]; keepDownloads?: number; env?: Record<string, string> } = {}) {
  const events: HubEvent[] = [];
  const messages: RegistryMessage[] = [];
  const cfg = { ...structuredClone(DEFAULT_CONFIG), registries } as Config;
  const names = opts.names ?? [];
  const svc = new RegistryService(
    cfg,
    {
      emit: (ev) => events.push(ev),
      notify: (m) => messages.push(m),
      webappNames: async () => ({ deployed: names, all: names }),
      adoptWar: async (file) => ({ file, name: basename(file), bytes: statSync(file).size, modified: statSync(file).mtime.toISOString(), sig: 'sig', target: 'guessed', fresh: false }),
    },
    { keepDownloads: opts.keepDownloads, env: opts.env ?? {} },
  );
  svc.useDataDir(dir);
  return { svc, events, messages, cfg };
}

const KEY = 'Nexus::com.example:shop';
const notices = (messages: RegistryMessage[]) => messages.flatMap((m) => (m.change === 'new' ? [`${m.notice.name} ${m.notice.version}`] : []));
const cacheFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) e.isDirectory() ? walk(join(d, e.name)) : out.push(e.name);
  };
  walk(join(dir, 'registry-cache'));
  return out.sort();
};

// ── Versions ────────────────────────────────────────────

describe('Maven version order', () => {
  it('orders versions as Maven does, not as text', () => {
    const ordered = ['1.0-alpha-1', '1.0-beta-1', '1.0-M2', '1.0-RC1', '1.0-SNAPSHOT', '1.0', '1.0-sp', '1.0.1', '1.9', '1.10', '1.10.1', '2.0-rc-1', '2.0', '10.0'];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i], ordered[i + 1]), `${ordered[i]} < ${ordered[i + 1]}`).toBe(-1);
      expect(compareVersions(ordered[i + 1], ordered[i]), `${ordered[i + 1]} > ${ordered[i]}`).toBe(1);
    }
    expect(sortNewestFirst([...ordered].sort(), (v) => v)).toEqual([...ordered].reverse());
  });

  it('treats trailing zeros, case and release qualifiers as nothing', () => {
    for (const [a, b] of [['1', '1.0'], ['1.0', '1.0.0'], ['1.0', '1.0-ga'], ['1.0', '1.0.Final'], ['1.0-RC1', '1.0-rc-1'], ['1.0-cr1', '1.0-RC1'], ['1.0-a1', '1.0-alpha-1'], ['1.0-SNAPSHOT', '1.0-snapshot']]) {
      expect(compareVersions(a, b), `${a} = ${b}`).toBe(0);
    }
  });

  it('follows Maven on separators and unknown qualifiers', () => {
    expect(compareVersions('1.foo', '1-foo')).toBe(-1);
    expect(compareVersions('1-foo', '1-1')).toBe(-1);
    expect(compareVersions('1-1', '1.1')).toBe(-1);
    expect(compareVersions('1-foo2', '1-foo10')).toBe(-1);
    // A qualifier Maven does not know sorts after a release.
    expect(compareVersions('1.0', '1.0-hotfix')).toBe(-1);
    expect(compareVersions('1.4.0-20260114.101502-3', '1.4.0-20260115.090000-1')).toBe(-1);
  });

  it('knows snapshots and their timestamped builds', () => {
    expect(isSnapshot('1.4.0-SNAPSHOT')).toBe(true);
    expect(isSnapshot('1.4.0-20260114.101502-3')).toBe(true);
    expect(isSnapshot('1.4.0')).toBe(false);
    expect(isSnapshot('1.4.0-RC1')).toBe(false);
    expect(baseVersion('1.4.0-20260114.101502-3')).toBe('1.4.0-SNAPSHOT');
    expect(baseVersion('1.4.0')).toBe('1.4.0');
  });

  it('matches version patterns with wildcards or a regular expression', () => {
    expect(['2.4.1', '2.10.0', '3.0.0', '12.4'].filter(versionMatcher('2.*'))).toEqual(['2.4.1', '2.10.0']);
    expect(['2.4.1', '2.4.1-RC1', '2.5.0-SNAPSHOT'].filter(versionMatcher('/^\\d+\\.\\d+\\.\\d+$/'))).toEqual(['2.4.1']);
    expect(['1.0-rc1', '1.0-RC2', '1.0'].filter(versionMatcher('*-RC?'))).toEqual(['1.0-rc1', '1.0-RC2']);
    expect(versionMatcher('')('anything')).toBe(true);
    expect(() => versionMatcher('/(/')).toThrow();
  });
});

// ── Maven metadata ──────────────────────────────────────

describe('Maven metadata', () => {
  it('reads the versions of an artifact', () => {
    const meta = parseArtifactMetadata(artifactMeta(['2.3.0', '2.4.0', '2.5.0-SNAPSHOT']));
    expect(meta.versions).toEqual(['2.3.0', '2.4.0', '2.5.0-SNAPSHOT']);
    expect(meta.latest).toBe('2.5.0-SNAPSHOT');
    expect(meta.lastUpdated).toBe('2026-11-14T10:15:02.000Z');
  });

  it('adds <release> and <latest> when the list lacks them, ignores comments, and refuses other documents', () => {
    const meta = parseArtifactMetadata('<metadata><versioning><release>1.2</release><!-- <version>9.9</version> --><versions><version>1.1</version></versions></versioning></metadata>');
    expect(meta.versions).toEqual(['1.1', '1.2']);
    expect(() => parseArtifactMetadata('<html><body>Sign in</body></html>')).toThrow(/not a maven-metadata/);
  });

  it('resolves a snapshot to its latest timestamped build for the extension and classifier', () => {
    const xml = snapshotMeta('2.5.0-SNAPSHOT', '20261114.101502', 3);
    expect(parseSnapshotMetadata(xml, '2.5.0-SNAPSHOT', 'war', '')).toEqual({ value: '2.5.0-20261114.101502-3', updated: '2026-11-14T10:15:02.000Z' });
    // The sources jar is a different file; a classifier nobody published falls back to the build number.
    expect(parseSnapshotMetadata(xml, '2.5.0-SNAPSHOT', 'jar', 'sources').value).toBe('2.5.0-20261114.101502-3');
    const older = '<metadata><versioning><snapshot><timestamp>20260101.000000</timestamp><buildNumber>7</buildNumber></snapshot></versioning></metadata>';
    expect(parseSnapshotMetadata(older, '1.0-SNAPSHOT', 'war', '').value).toBe('1.0-20260101.000000-7');
  });

  it('names the file by the version where a repository keeps one file per snapshot', () => {
    const xml = '<metadata><versioning><snapshot><localCopy>true</localCopy></snapshot><lastUpdated>20261114101502</lastUpdated></versioning></metadata>';
    expect(parseSnapshotMetadata(xml, '1.0-SNAPSHOT', 'war', '')).toEqual({ value: '1.0-SNAPSHOT', updated: '2026-11-14T10:15:02.000Z' });
  });

  it('finds the digest in the checksum file formats in use', () => {
    const sha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    expect(parseChecksum(`${sha1}\n`, 'sha1')).toBe(sha1);
    expect(parseChecksum(`${sha1.toUpperCase()}  shop-1.0.war`, 'sha1')).toBe(sha1);
    expect(parseChecksum(`SHA1(shop-1.0.war)= ${sha1}`, 'sha1')).toBe(sha1);
    expect(parseChecksum('<html>404</html>', 'sha1')).toBeNull();
    // A SHA-256 is not mistaken for a SHA-1 that happens to be inside it.
    expect(parseChecksum('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha1')).toBeNull();
  });
});

describe('Maven repository', () => {
  it('lists versions from maven-metadata.xml and builds the path Maven would', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const { packages } = await mavenKind.list(ctxFor(reg), reg.packages[0]);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ id: 'com.example:shop', name: 'shop', coordinates: 'com.example:shop' });
    expect(packages[0].versions.map((v) => v.version)).toEqual(['2.3.0', '2.4.0']);
    expect(fake.hits[0].path).toBe(`${SHOP}/maven-metadata.xml`);

    const artifact = await mavenKind.locate(ctxFor(reg), reg.packages[0], packages[0], packages[0].versions[1]);
    expect(artifact).toMatchObject({ url: `${fake.url}${SHOP}/2.4.0/shop-2.4.0.war`, fileName: 'shop-2.4.0.war', build: '2.4.0' });
  });

  it('resolves a SNAPSHOT to its timestamped file, with a classifier', async () => {
    const store = mavenStore(['2.4.0', '2.5.0-SNAPSHOT']);
    store.set(`${SHOP}/2.5.0-SNAPSHOT/maven-metadata.xml`, snapshotMeta('2.5.0-SNAPSHOT', '20261114.101502', 3));
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const entry = { ...reg.packages[0], classifier: 'prod' };
    const { packages } = await mavenKind.list(ctxFor(reg), entry);
    expect(packages[0].id).toBe('com.example:shop:prod');
    const snap = packages[0].versions.find((v) => v.snapshot)!;
    // No snapshotVersion for the prod classifier: the build number from <snapshot> is used.
    const artifact = await mavenKind.locate(ctxFor(reg), entry, packages[0], snap);
    expect(artifact.url).toBe(`${fake.url}${SHOP}/2.5.0-SNAPSHOT/shop-2.5.0-20261114.101502-3-prod.war`);
    expect(artifact.build).toBe('2.5.0-20261114.101502-3');
    expect(artifact.modified).toBe('2026-11-14T10:15:02.000Z');
  });

  it('falls back to the plain file name when a snapshot folder has no metadata', async () => {
    const fake = await serve(files(mavenStore(['1.0-SNAPSHOT'])));
    const reg = registry({ url: fake.url + REPO });
    const { packages } = await mavenKind.list(ctxFor(reg), reg.packages[0]);
    const artifact = await mavenKind.locate(ctxFor(reg), reg.packages[0], packages[0], packages[0].versions[0]);
    expect(artifact.fileName).toBe('shop-1.0-SNAPSHOT.war');
  });

  it('takes the strongest checksum file there is', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const url = `${fake.url}${SHOP}/2.4.0/shop-2.4.0.war`;
    const artifact = { url, fileName: 'shop-2.4.0.war', build: '2.4.0', modified: null, bytes: null, checksums: {} };
    expect(await mavenKind.checksums!(ctxFor(reg), artifact)).toEqual({ sha1: digest('sha1', war('2.4.0')) });
    expect(fake.hits.map((h) => h.path.split('.').pop())).toEqual(['sha256', 'sha1']);
    store.set(`${SHOP}/2.4.0/shop-2.4.0.war.sha256`, `${digest('sha256', war('2.4.0'))}  shop-2.4.0.war\n`);
    expect(await mavenKind.checksums!(ctxFor(reg), artifact)).toEqual({ sha256: digest('sha256', war('2.4.0')) });
    store.delete(`${SHOP}/2.4.0/shop-2.4.0.war.sha256`);
    store.delete(`${SHOP}/2.4.0/shop-2.4.0.war.sha1`);
    expect(await mavenKind.checksums!(ctxFor(reg), artifact)).toEqual({});
  });

  it('says what to check when the metadata is not there', async () => {
    const fake = await serve(files(new Map()));
    const reg = registry({ url: fake.url + REPO });
    const err: RegistryError = await mavenKind.list(ctxFor(reg), reg.packages[0]).catch((e) => e);
    expect(err.kind).toBe('not-found');
    expect(err.message).toContain(`Not found (404): ${fake.url}${SHOP}/maven-metadata.xml`);
    expect(err.hint).toMatch(/group ID and artifact ID.*repository’s root/);
  });
});

// ── Finding the artifacts of a group ───────────────────

const GROUP = `${REPO}/com/example`;
const folderPage = (names: string[]) =>
  `<html><body><h1>Index of /com/example</h1><a href="../">Parent Directory</a> <a href="?C=N;O=D">Name</a>\n${names.map((n) => `<a href="${n}/">${n}/</a>`).join('\n')}\n<a href="maven-metadata.xml">maven-metadata.xml</a></body></html>`;

/** A group with two WARs (shop, admin), a JAR library, a group below it and a stray folder. */
function groupStore(): Map<string, string | Buffer> {
  const store = mavenStore();
  const add = (artifact: string, version: string, file: string) => {
    const meta = parseArtifactMetadata(String(store.get(`${GROUP}/${artifact}/maven-metadata.xml`) ?? artifactMeta([]).replace('<latest></latest>', ''))).versions;
    store.set(`${GROUP}/${artifact}/maven-metadata.xml`, artifactMeta([...meta, version]).replace(/<artifactId>shop</, `<artifactId>${artifact}<`));
    store.set(`${GROUP}/${artifact}/${version}/${file}`, war(version));
  };
  add('admin', '1.0.0', 'admin-1.0.0.war');
  add('admin', '1.1.0-SNAPSHOT', 'admin-1.1.0-20261114.101502-3.war');
  store.set(`${GROUP}/admin/1.1.0-SNAPSHOT/maven-metadata.xml`, snapshotMeta('1.1.0-SNAPSHOT', '20261114.101502', 3));
  add('core-lib', '3.2.1', 'core-lib-3.2.1.jar');
  store.set(`${GROUP}/`, folderPage(['admin', 'core-lib', 'shop', 'tools', 'notes']));
  store.set(`${GROUP}/tools/`, folderPage(['cli']));
  return store;
}

describe('Maven repository: every WAR of a group', () => {
  beforeEach(() => forgetPublished());

  it('reads the folders a directory listing links to, whatever the server', () => {
    const at = 'https://nexus.example.com/nexus/content/repositories/releases/com/example/';
    // Nexus 2: absolute links. Apache and Artifactory: relative ones. Parent and sort links are not folders.
    const nexus2 = `<a href="${at}shop/">shop/</a><a href="${at}admin/">admin/</a><a href="${at.replace(/example\/$/, '')}">Parent</a>`;
    expect(listingFolders(nexus2, at)).toEqual(['shop', 'admin']);
    expect(listingFolders(folderPage(['a', 'b-c']), at.slice(0, -1))).toEqual(['a', 'b-c']);
    expect(listingFolders(`<a href='x/'>x</a><A HREF=y/>y</A><a href="z/deeper/">z</a><a href="https://elsewhere.example/q/">q</a><a href="file.war">f</a>`, at)).toEqual(['x', 'y']);
    expect(listingFolders('<a href="/nexus/content/repositories/releases/com/example/s%20p/">bad</a>', at)).toEqual([]);
  });

  it('knows when an artifact ID asks for a search', () => {
    expect(['', ' ', '*', 'shop-*', 'sh?p', '/^shop/'].map(isArtifactPattern)).toEqual([true, true, true, true, true, true]);
    expect(['shop', 'shop.web', 'a/b'].map(isArtifactPattern)).toEqual([false, false, false]);
    expect(nexus3BrowseUrl('https://n.example/repository/maven-public', ['com', 'example'])).toBe('https://n.example/service/rest/repository/browse/maven-public/com/example/');
    expect(nexus3BrowseUrl('https://n.example/nexus/content/repositories/x', ['com'])).toBeNull();
  });

  it('finds the artifacts with a WAR, leaving out libraries, groups below and stray folders', async () => {
    const fake = await serve(files(groupStore()));
    const reg = registry({ url: fake.url + REPO });
    const entry = { ...reg.packages[0], artifactId: '' };
    expect(mavenKind.describe(entry)).toBe('com.example:*');
    const listing = await mavenKind.list(ctxFor(reg), entry);
    expect(listing.packages.map((p) => [p.id, p.name, p.coordinates])).toEqual([
      ['com.example:admin', 'admin', 'com.example:admin'],
      ['com.example:shop', 'shop', 'com.example:shop'],
    ]);
    expect(listing.hint).toBeUndefined();
    // The snapshot is found by its timestamped file, which the package then downloads from.
    const admin = listing.packages[0];
    const artifact = await mavenKind.locate(ctxFor(reg), entry, admin, admin.versions.find((v) => v.snapshot)!);
    expect(artifact.url).toBe(`${fake.url}${GROUP}/admin/1.1.0-SNAPSHOT/admin-1.1.0-20261114.101502-3.war`);

    // What a check found out about each artifact is not asked again until it has a new version.
    const before = fake.hits.length;
    await mavenKind.list(ctxFor(reg), entry);
    const again = fake.hits.slice(before).map((h) => h.path);
    expect(again.filter((p) => /\.(war|jar)$/.test(p))).toEqual([]);
  });

  it('narrows the search with * and ?, and the same package key as naming it', async () => {
    const fake = await serve(files(groupStore()));
    const reg = registry({ url: fake.url + REPO });
    const { packages } = await mavenKind.list(ctxFor(reg), { ...reg.packages[0], artifactId: 'sh*' });
    expect(packages.map((p) => p.id)).toEqual(['com.example:shop']);
    const none = await mavenKind.list(ctxFor(reg), { ...reg.packages[0], artifactId: 'core-*' });
    expect(none.packages).toEqual([]);
    expect(none.hint).toMatch(/1 folder in com\.example matching core-\*, but no artifact with a \.war/);
    const jars = await mavenKind.list(ctxFor(reg), { ...reg.packages[0], artifactId: 'core-*', extension: 'jar' });
    expect(jars.packages.map((p) => p.id)).toEqual(['com.example:core-lib@jar']);
  });

  it('uses Nexus 3’s browse pages where the repository path does not list folders', async () => {
    const store = groupStore();
    store.delete(`${GROUP}/`);
    store.set('/service/rest/repository/browse/maven-public/com/example/', folderPage(['shop']));
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const { packages } = await mavenKind.list(ctxFor(reg), { ...reg.packages[0], artifactId: '' });
    expect(packages.map((p) => p.name)).toEqual(['shop']);
  });

  it('says what to do where the repository lists nothing', async () => {
    const store = groupStore();
    store.delete(`${GROUP}/`);
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const err: RegistryError = await mavenKind.list(ctxFor(reg), { ...reg.packages[0], artifactId: '' }).catch((e) => e);
    expect(err.message).toMatch(/does not list what is in com\.example/);
    expect(err.hint).toMatch(/Artifact ID of each package/);
  });

  it('checks every WAR of a group, one package each, and lets a named entry keep its own', async () => {
    const fake = await serve(files(groupStore()));
    const { svc } = makeService([
      registry({
        url: fake.url + REPO,
        packages: [
          { groupId: 'com.example', artifactId: 'shop', classifier: '', extension: 'war', versions: 'all', versionPattern: '', deployAs: 'ROOT' },
          { groupId: 'com.example', artifactId: '', classifier: '', extension: 'war', versions: 'all', versionPattern: '', deployAs: '' },
        ],
      }),
    ]);
    await svc.checkNow();
    const pkgs = (await svc.snapshot()).registries[0].packages;
    expect(pkgs.map((p) => [p.key, p.target, p.targetFrom])).toEqual([
      ['Nexus::com.example:admin', 'admin', 'guess'],
      ['Nexus::com.example:shop', 'ROOT', 'settings'],
    ]);
  });
});

// ── Nexus 3 ─────────────────────────────────────────────

interface FakeAsset {
  path: string;
  repository: string;
  downloadUrl?: string;
  lastModified?: string;
  fileSize?: number;
  checksum?: Record<string, string>;
  maven2?: Record<string, string>;
}

const mavenAsset = (version: string, ext: string, extra: Partial<FakeAsset> = {}, build = version): FakeAsset => ({
  path: `com/example/shop/${version}/shop-${build}.${ext}`,
  repository: 'maven-releases',
  downloadUrl: `http://other-host.example/repository/maven-releases/com/example/shop/${version}/shop-${build}.${ext}`,
  lastModified: '2026-11-14T10:15:02.000+00:00',
  fileSize: 1234,
  checksum: { sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) },
  maven2: { groupId: 'com.example', artifactId: 'shop', version: build, extension: ext, ...(build !== version ? { baseVersion: version } : {}) },
  ...extra,
});

/** Nexus 3's search: `pageSize` assets at a time, with a continuationToken while there are more. */
function nexusSearch(assets: FakeAsset[], pageSize = 2): Handler {
  return (req, res, path) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (path === '/service/rest/v1/repositories') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify([{ name: 'maven-releases', format: 'maven2', type: 'hosted' }, { name: 'raw-builds', format: 'raw', type: 'hosted' }]));
    }
    if (path !== '/service/rest/v1/search/assets') {
      res.writeHead(404);
      return void res.end();
    }
    const found = assets.filter(
      (a) =>
        (!q.get('repository') || a.repository === q.get('repository')) &&
        (!q.get('name') || a.maven2?.artifactId === q.get('name')) &&
        (!q.get('maven.extension') || a.maven2?.extension === q.get('maven.extension')),
    );
    const start = Number(q.get('continuationToken') ?? 0);
    const next = start + pageSize < found.length ? String(start + pageSize) : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: found.slice(start, start + pageSize), continuationToken: next }));
  };
}

describe('Nexus 3 search', () => {
  const entry = { repository: 'maven-releases', group: '', name: '', params: '', classifier: '', extension: 'war', versions: 'all' as const, versionPattern: '', deployAs: '' };

  it('follows continuation tokens through every page and keeps only the WARs', async () => {
    const assets = ['1.0', '1.1', '1.2'].flatMap((v) => [mavenAsset(v, 'pom'), mavenAsset(v, 'war'), mavenAsset(v, 'war.sha1')]);
    const fake = await serve(nexusSearch(assets));
    const reg = registry({ type: 'nexus3', url: fake.url, packages: [entry] });
    const { packages } = await nexus3Kind.list(ctxFor(reg), entry);
    expect(fake.hits.map((h) => new URL(h.path, fake.url).searchParams.get('continuationToken'))).toEqual([null, '2', '4', '6', '8']);
    expect(fake.hits.every((h) => new URL(h.path, fake.url).searchParams.get('repository') === 'maven-releases')).toBe(true);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ id: 'maven-releases/com.example:shop', name: 'shop', coordinates: 'com.example:shop in maven-releases' });
    expect(packages[0].versions.map((v) => v.version).sort()).toEqual(['1.0', '1.1', '1.2']);
    const artifact = packages[0].versions[0].artifact!;
    expect(artifact).toMatchObject({ fileName: 'shop-1.0.war', bytes: 1234, modified: '2026-11-14T10:15:02.000Z', checksums: { sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) } });
    // From the registry's own address, not the downloadUrl Nexus reports (which may name another host).
    expect(artifact.url).toBe(`${fake.url}/repository/maven-releases/com/example/shop/1.0/shop-1.0.war`);
  });

  it('sends the name, group and extra parameters, and suggests a filter when most of what comes back is not a WAR', async () => {
    const assets = ['1.0', '1.1', '1.2', '1.3'].flatMap((v) => [mavenAsset(v, 'pom'), mavenAsset(v, 'jar'), mavenAsset(v, 'pom.sha1'), mavenAsset(v, 'jar.sha1'), mavenAsset(v, 'war')]);
    const fake = await serve(nexusSearch(assets, 5));
    const reg = registry({ type: 'nexus3', url: fake.url });
    const slow = await nexus3Kind.list(ctxFor(reg), { ...entry, name: 'shop' });
    expect(new URL(fake.hits[0].path, fake.url).searchParams.get('name')).toBe('shop');
    expect(slow.hint).toMatch(/Only 4 of 20 files.*maven\.extension=war/);
    fake.hits.length = 0;
    const fast = await nexus3Kind.list(ctxFor(reg), { ...entry, params: 'maven.extension=war&sort=version' });
    expect(fake.hits).toHaveLength(1);
    expect(new URL(fake.hits[0].path, fake.url).searchParams.get('sort')).toBe('version');
    expect(fast.hint).toBeUndefined();
    expect(fast.packages[0].versions).toHaveLength(4);
  });

  it('groups a snapshot’s builds under their version and takes the newest', async () => {
    const assets = [
      mavenAsset('2.0-SNAPSHOT', 'war', { lastModified: '2026-11-13T08:00:00.000+00:00' }, '2.0-20261113.080000-1'),
      mavenAsset('2.0-SNAPSHOT', 'war', { lastModified: '2026-11-14T08:00:00.000+00:00' }, '2.0-20261114.080000-2'),
      mavenAsset('2.0-SNAPSHOT', 'war', { maven2: { groupId: 'com.example', artifactId: 'shop', version: '2.0-20261114.080000-2', extension: 'war', classifier: 'docs', baseVersion: '2.0-SNAPSHOT' } }),
    ];
    const fake = await serve(nexusSearch(assets, 50));
    const reg = registry({ type: 'nexus3', url: fake.url });
    const { packages } = await nexus3Kind.list(ctxFor(reg), entry);
    expect(packages[0].versions).toHaveLength(1);
    expect(packages[0].versions[0]).toMatchObject({ version: '2.0-SNAPSHOT', snapshot: true, artifact: { build: '2.0-20261114.080000-2' } });
  });

  it('reads raw repositories from the file names alone', async () => {
    const raw = (path: string): FakeAsset => ({ path, repository: 'raw-builds', lastModified: '2026-11-14T10:15:02.000+00:00', fileSize: 10, checksum: { sha1: 'c'.repeat(40) } });
    const fake = await serve(nexusSearch([raw('builds/shop/shop-1.4.0.war'), raw('builds/shop/shop-1.5.0-SNAPSHOT.war'), raw('builds/admin/admin.war'), raw('builds/readme.txt')], 50));
    const reg = registry({ type: 'nexus3', url: fake.url });
    const { packages } = await nexus3Kind.list(ctxFor(reg), { ...entry, repository: 'raw-builds' });
    expect(packages.map((p) => [p.coordinates, p.versions.map((v) => v.version)])).toEqual([
      ['builds/shop:shop in raw-builds', ['1.4.0', '1.5.0-SNAPSHOT']],
      ['builds/admin:admin in raw-builds', ['build 2026-11-14 10:15']],
    ]);
    expect(splitFileName('my-app-2.0.1-RC1')).toEqual({ name: 'my-app', version: '2.0.1-RC1' });
    expect(splitFileName('ROOT')).toEqual({ name: 'ROOT', version: null });
    expect(splitFileName('shop_1.4.0')).toEqual({ name: 'shop', version: '1.4.0' });
    expect(splitFileName('shop-v2.1')).toEqual({ name: 'shop', version: 'v2.1' });
    expect(splitFileName('app-2fa')).toEqual({ name: 'app-2fa', version: null });
    expect(splitFileName('app-2fa-1.0')).toEqual({ name: 'app-2fa', version: '1.0' });
  });

  it('says so when the address is not a Nexus 3, and lists the repositories when it is', async () => {
    const notNexus = await serve(files(new Map()));
    const reg = registry({ type: 'nexus3', url: notNexus.url });
    const err: RegistryError = await nexus3Kind.list(ctxFor(reg), entry).catch((e) => e);
    expect(err.kind).toBe('not-found');
    expect(err.hint).toMatch(/no Nexus 3 search API.*Maven repository type/);

    const html = await serve((_req, res) => res.end('<html>Sign in</html>'));
    const page: RegistryError = await nexus3Kind.list(ctxFor(registry({ type: 'nexus3', url: html.url })), entry).catch((e) => e);
    expect(page.message).toMatch(/not JSON but a web page/);

    const fake = await serve(nexusSearch([]));
    expect(await nexus3Kind.probe(ctxFor(registry({ type: 'nexus3', url: fake.url })))).toMatch(/2 repositories can be seen: maven-releases \(maven2, hosted\), raw-builds \(raw, hosted\)/);
  });
});

// ── Direct URL ──────────────────────────────────────────

describe('direct URL', () => {
  const entry = { name: 'shop', url: '', deployAs: '' };

  it('reads the build from ETag, Last-Modified and size with a HEAD', async () => {
    let etag = '"v1"';
    const fake = await serve((req, res) => {
      res.writeHead(200, { etag, 'last-modified': 'Sat, 14 Nov 2026 10:15:02 GMT', 'content-length': '4096', 'content-type': 'application/java-archive' });
      res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(4096));
    });
    const reg = registry({ type: 'url', url: fake.url, packages: [] });
    const e = { ...entry, url: 'job/shop/lastSuccessfulBuild/artifact/target/shop.war' };
    const first = (await urlKind.list(ctxFor(reg), e)).packages[0];
    expect(fake.hits.map((h) => h.method)).toEqual(['HEAD']);
    expect(fake.hits[0].path).toBe('/job/shop/lastSuccessfulBuild/artifact/target/shop.war');
    expect(first).toMatchObject({ name: 'shop', id: 'url:shop' });
    expect(first.versions[0].artifact).toMatchObject({ fileName: 'shop.war', bytes: 4096, modified: '2026-11-14T10:15:02.000Z' });
    etag = '"v2"';
    const second = (await urlKind.list(ctxFor(reg), e)).packages[0];
    expect(second.versions[0].artifact!.build).not.toBe(first.versions[0].artifact!.build);
  });

  it('asks for the first byte with GET where HEAD is refused, without reading the file', async () => {
    const fake = await serve((req, res) => {
      if (req.method === 'HEAD') {
        res.writeHead(405);
        return void res.end();
      }
      res.writeHead(206, { 'content-range': 'bytes 0-0/987654', 'content-length': '1', etag: 'W/"abc"', 'content-disposition': 'attachment; filename="shop-1.4.0.war"' });
      res.end('P');
    });
    const reg = registry({ type: 'url', url: '', packages: [] });
    const found = (await urlKind.list(ctxFor(reg), { ...entry, url: `${fake.url}/download?id=7` })).packages[0];
    expect(fake.hits.map((h) => [h.method, h.headers.range])).toEqual([['HEAD', undefined], ['GET', 'bytes=0-0']]);
    expect(found.versions[0].artifact).toMatchObject({ bytes: 987654, fileName: 'shop-1.4.0.war', build: 'abc||987654' });
    expect(found.versions[0].version).toBe('build abc');
  });

  it('refuses a web page, and says when a server gives nothing to tell builds apart', async () => {
    const page = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html>Sign in</html>');
    });
    const err: RegistryError = await urlKind.list(ctxFor(registry({ type: 'url', url: '' })), { ...entry, url: `${page.url}/shop.war` }).catch((e) => e);
    expect(err.kind).toBe('content');
    expect(err.hint).toMatch(/login page/);

    const bare = await serve((_req, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.end();
    });
    const listing = await urlKind.list(ctxFor(registry({ type: 'url', url: '' })), { ...entry, url: `${bare.url}/shop.war` });
    expect(listing.hint).toMatch(/cannot be told from the old one/);
    expect(listing.packages[0].versions[0].version).toBe('current');
  });
});

// ── Login, headers and secrets ──────────────────────────

describe('login and headers', () => {
  it('builds Authorization for a user name and password or a token', () => {
    const basic = transportFor(registry({ url: 'https://nexus.example.com/repository/x', auth: { type: 'basic', username: 'ci', password: 's3cret pass' } }));
    expect(basic.headers).toEqual([['Authorization', `Basic ${Buffer.from('ci:s3cret pass').toString('base64')}`]]);
    expect(basicAuth('ci', 'pä55')).toBe(`Basic ${Buffer.from('ci:pä55', 'utf8').toString('base64')}`);
    expect(basic.hasLogin).toBe(true);
    const bearer = transportFor(registry({ url: 'https://x.example', auth: { type: 'bearer', token: 'glpat-abc123' } }));
    expect(bearer.headers).toEqual([['Authorization', 'Bearer glpat-abc123']]);
    expect(transportFor(registry({ url: 'https://x.example' }))).toMatchObject({ headers: [], hasLogin: false });
  });

  it('adds custom headers, which win over the login for the same header', () => {
    const t = transportFor(
      registry({ url: 'https://x.example', auth: { type: 'bearer', token: 'abcdef' }, headers: [{ name: 'X-JFrog-Art-Api', value: 'key-123456' }, { name: 'authorization', value: 'Custom zzzzzz' }] }),
    );
    expect(t.headers).toEqual([['authorization', 'Custom zzzzzz'], ['X-JFrog-Art-Api', 'key-123456']]);
    expect(() => transportFor(registry({ url: 'https://x.example', headers: [{ name: 'X-Bad', value: 'a\r\nInjected: 1' }] }))).toThrow(/line break/);
  });

  it('fills ${env:NAME} from the environment and refuses a variable that is not set', () => {
    const reg = registry({
      url: 'https://x.example',
      auth: { type: 'basic', username: '${env:NEXUS_USER}', password: '${env:NEXUS_PASSWORD}' },
      headers: [{ name: 'X-Token', value: 'Token ${env:API_TOKEN}' }],
    });
    const t = buildTransport(reg, { NEXUS_USER: 'ci', NEXUS_PASSWORD: 'hunter22', API_TOKEN: 'tok-9876' });
    expect(t.headers).toEqual([['Authorization', basicAuth('ci', 'hunter22')], ['X-Token', 'Token tok-9876']]);
    expect(resolveEnv('a ${env:ONE} b ${env:TWO}', 'x', { ONE: '1', TWO: '2' })).toBe('a 1 b 2');

    const err: RegistryError = (() => {
      try {
        buildTransport(reg, { NEXUS_USER: 'ci' });
      } catch (e) {
        return e as RegistryError;
      }
      throw new Error('did not throw');
    })();
    expect(err.kind).toBe('config');
    expect(err.message).toBe('The environment variable NEXUS_PASSWORD, used for registry Nexus’s password, is not set where Debug Hub runs.');
  });

  it('keeps secrets out of anything shown', () => {
    const t = buildTransport(
      registry({ url: 'https://deploy:urlpass99@x.example/repo', auth: { type: 'basic', username: 'ci', password: '${env:PW}' }, headers: [{ name: 'X-Key', value: 'key-123456' }] }),
      { PW: 'hunter22' },
    );
    const leaky = `GET https://deploy:urlpass99@x.example/repo?token=key-123456 failed for hunter22 / ${Buffer.from('ci:hunter22').toString('base64')}`;
    const clean = scrub(leaky, t.secrets);
    for (const secret of ['hunter22', 'key-123456', 'urlpass99', Buffer.from('ci:hunter22').toString('base64')]) expect(clean).not.toContain(secret);
    expect(clean).toContain('https://x.example/repo?token=***');
    expect(displayUrl('https://deploy:urlpass99@x.example/repo')).toBe('https://x.example/repo');
  });

  it('sends the login to the registry and says which way a 401 or 403 went wrong', async () => {
    const store = mavenStore();
    const fake = await serve(files(store, basicAuth('ci', 'hunter22')));
    const url = `${fake.url}${SHOP}/maven-metadata.xml`;
    const good = transportFor(registry({ url: fake.url, auth: { type: 'basic', username: 'ci', password: 'hunter22' } }));
    expect((await fetchText(good, url)).text).toContain('<version>2.4.0</version>');
    expect(fake.hits[0].headers['user-agent']).toBe('debug-hub');

    const wrong: RegistryError = await fetchText(transportFor(registry({ url: fake.url, auth: { type: 'basic', username: 'ci', password: 'wrong-pass' } })), url).catch((e) => e);
    expect(wrong).toMatchObject({ kind: 'auth', status: 401 });
    expect(wrong.message).toMatch(/did not accept the login \(401 Unauthorized\)/);
    expect(wrong.hint).toMatch(/Check the user name and password.*asks for Basic authentication/);
    expect(wrong.message + wrong.hint).not.toContain('wrong-pass');

    const none: RegistryError = await fetchText(transportFor(registry({ url: fake.url })), url).catch((e) => e);
    expect(none.message).toMatch(/wants a login \(401 Unauthorized\)/);
    expect(none.hint).toMatch(/Set a login for registry Nexus/);

    const forbidden = await serve((_req, res) => {
      res.writeHead(403);
      res.end();
    });
    const denied: RegistryError = await fetchText(good, `${forbidden.url}/x`).catch((e) => e);
    expect(denied).toMatchObject({ kind: 'forbidden', status: 403 });
    expect(denied.hint).toMatch(/may not read here/);
  });
});

describe('redirects', () => {
  it('follows a redirect to another host without the login or the custom headers', async () => {
    const body = war('blob');
    const blob = await serve((_req, res) => res.end(body));
    const fake = await serve((_req, res, path) => {
      if (path === '/repository/x/shop.war') res.writeHead(302, { location: `${blob.url}/bucket/shop.war?X-Amz-Signature=abc` });
      else if (path === '/old/shop.war') res.writeHead(301, { location: '/repository/x/moved.war' });
      else return void res.end('same host');
      res.end();
    });
    const t = transportFor(registry({ url: fake.url, auth: { type: 'bearer', token: 'tok-123456' }, headers: [{ name: 'X-Api-Key', value: 'key-123456' }] }));

    const answer = await fetchAnswer(t, `${fake.url}/repository/x/shop.war`);
    expect(answer.body).toEqual(body);
    expect(answer.url).toBe(`${blob.url}/bucket/shop.war?X-Amz-Signature=abc`);
    expect(fake.hits[0].headers).toMatchObject({ authorization: 'Bearer tok-123456', 'x-api-key': 'key-123456' });
    expect(blob.hits).toHaveLength(1);
    expect(blob.hits[0].headers.authorization).toBeUndefined();
    expect(blob.hits[0].headers['x-api-key']).toBeUndefined();

    // On the same host the login stays.
    await fetchAnswer(t, `${fake.url}/old/shop.war`);
    expect(fake.hits[fake.hits.length - 1]).toMatchObject({ path: '/repository/x/moved.war', headers: { authorization: 'Bearer tok-123456' } });
  });

  it('does not carry a login written into the URL to another host either', async () => {
    const blob = await serve((_req, res) => res.end('ok'));
    const fake = await serve((_req, res) => {
      res.writeHead(307, { location: `${blob.url}/file` });
      res.end();
    });
    const t = transportFor(registry({ url: fake.url.replace('://', '://ci:urlpass99@') }));
    await fetchAnswer(t, `${fake.url.replace('://', '://ci:urlpass99@')}/file`);
    expect(fake.hits[0].headers.authorization).toBe(basicAuth('ci', 'urlpass99'));
    expect(blob.hits[0].headers.authorization).toBeUndefined();
  });

  it('treats another port or a downgrade to http as another host', () => {
    const u = (s: string) => new URL(s);
    expect(sameHost(u('https://nexus.example.com/a'), u('https://NEXUS.example.com:443/b'))).toBe(true);
    expect(sameHost(u('http://nexus.example.com/a'), u('https://nexus.example.com/b'))).toBe(true);
    expect(sameHost(u('https://nexus.example.com/a'), u('http://nexus.example.com/b'))).toBe(false);
    expect(sameHost(u('https://nexus.example.com/a'), u('https://nexus.example.com:8443/b'))).toBe(false);
    expect(sameHost(u('https://nexus.example.com/a'), u('https://blobs.example.com/b'))).toBe(false);
    expect(sameHost(u('http://nexus.example.com:8081/a'), u('https://nexus.example.com/b'))).toBe(false);
  });

  it('explains a login refused after a redirect, and stops a redirect loop', async () => {
    const other = await serve((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    const fake = await serve((_req, res, path) => {
      res.writeHead(302, { location: path === '/loop' ? '/loop' : `${other.url}/x` });
      res.end();
    });
    const t = transportFor(registry({ url: fake.url, auth: { type: 'bearer', token: 'tok-123456' } }));
    const err: RegistryError = await fetchAnswer(t, `${fake.url}/go`).catch((e) => e);
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(new RegExp(`redirected to 127\\.0\\.0\\.1:${other.port}, and the login is not sent to another host`));
    const loop: RegistryError = await fetchAnswer(t, `${fake.url}/loop`).catch((e) => e);
    expect(loop.message).toMatch(/Too many redirects/);
  });
});

describe('connection problems', () => {
  const t = transportFor(registry({ url: 'https://nexus.example.com', timeoutMs: 200 }));
  const explain = (code: string, message = code) => failure(t, Object.assign(new Error(message), { code }), new URL('https://nexus.example.com:8443/x'));

  it('tells DNS, refused, unreachable, TLS and timeout apart', () => {
    expect(explain('ENOTFOUND')).toMatchObject({ kind: 'dns', message: 'Host not found: nexus.example.com.' });
    expect(explain('EAI_AGAIN').kind).toBe('dns');
    expect(explain('ECONNREFUSED')).toMatchObject({ kind: 'refused', message: 'Connection refused: nothing is listening on nexus.example.com:8443.' });
    expect(explain('EHOSTUNREACH').kind).toBe('network');
    expect(explain('ECONNRESET').kind).toBe('network');
    expect(explain('TIMEOUT')).toMatchObject({ kind: 'timeout' });
    expect(explain('ABORTED')).toMatchObject({ kind: 'canceled', message: 'Canceled' });
    for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
      expect(explain(code), code).toMatchObject({ kind: 'tls' });
      expect(explain(code).hint).toMatch(/certificate file \(PEM\).*Allow untrusted certificates/);
    }
    expect(explain('ERR_TLS_CERT_ALTNAME_INVALID').message).toMatch(/for another host name/);
    expect(explain('CERT_HAS_EXPIRED').message).toMatch(/has expired/);
    expect(explain('EPROTO', 'wrong version number').message).toMatch(/is it really https/);
    expect(explain('EWHATEVER', 'socket hang up')).toMatchObject({ kind: 'network', message: 'Could not reach nexus.example.com:8443: socket hang up' });
  });

  it('reports a refused connection and a server that never answers', async () => {
    const closed = await serve(() => undefined);
    const port = closed.port;
    await new Promise((r) => servers.pop()!.close(r));
    const refused: RegistryError = await fetchAnswer(t, `http://127.0.0.1:${port}/x`).catch((e) => e);
    expect(refused).toMatchObject({ kind: 'refused', message: `Connection refused: nothing is listening on 127.0.0.1:${port}.` });

    const silent = await serve(() => undefined);
    const started = Date.now();
    const slow: RegistryError = await fetchAnswer(t, `${silent.url}/x`).catch((e) => e);
    expect(slow.kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);

    // The timeout also covers an answer that starts and then stalls.
    const stalls = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write('some');
    });
    const stalled: RegistryError = await fetchAnswer(t, `${stalls.url}/x`).catch((e) => e);
    expect(stalled).toMatchObject({ kind: 'timeout', message: `No answer from 127.0.0.1:${stalls.port} within 0.2 s.` });
  });

  it('reports 404, 429 and 500 for what they are', async () => {
    const fake = await serve((_req, res, path) => {
      res.writeHead(Number(path.slice(1)));
      res.end();
    });
    const get = (status: number): Promise<RegistryError> => fetchAnswer(t, `${fake.url}/${status}`).catch((e) => e);
    expect(await get(404)).toMatchObject({ kind: 'not-found', status: 404, message: `Not found (404): ${fake.url}/404` });
    expect((await get(429)).hint).toMatch(/Check less often/);
    expect(await get(500)).toMatchObject({ kind: 'http', status: 500 });
    expect((await get(407)).message).toMatch(/proxy/);
  });
});

// A self-signed certificate for localhost and 127.0.0.1, made for these tests only (valid until 2126).
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBnDCCAUGgAwIBAgIUK9aQdw2meDRCHht9vDBVojs+6cQwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExODA1MjMzOVoYDzIxMjYxMDI1
MDUyMzM5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATNMQPZbR8H44PQOKMUnj6VfOi/8OeWijfrqFyHFuqI8zegezLFvr6L
2JwLe+bb/ICNxsjbiKKJ5UXlfObT1aAYo28wbTAdBgNVHQ4EFgQU8z78nw1WCkbT
V0kD87IhaeplAXUwHwYDVR0jBBgwFoAU8z78nw1WCkbTV0kD87IhaeplAXUwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSQAwRgIhAMNsu2nFP4z7U9mc/gmG6Ul7rcCZFAYkVHcc+e9qEspdAiEA
ycwa56BwAar0rucEAxKkF6leJimJcgafNGSWB3iMrto=
-----END CERTIFICATE-----
`;
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtkYebZDOhcOOlYoc
pJg+BhkTGJaKHSI+RmaH52vLcrShRANCAATNMQPZbR8H44PQOKMUnj6VfOi/8OeW
ijfrqFyHFuqI8zegezLFvr6L2JwLe+bb/ICNxsjbiKKJ5UXlfObT1aAY
-----END PRIVATE KEY-----
`;

describe('certificates', () => {
  it('refuses an untrusted certificate, and accepts it with the CA file or when told to', async () => {
    const fake = await serve((_req, res) => res.end('secure'), { cert: TEST_CERT, key: TEST_KEY });
    const err: RegistryError = await fetchText(transportFor(registry({ url: fake.url })), `${fake.url}/x`).catch((e) => e);
    expect(err.kind).toBe('tls');
    expect(err.message).toMatch(/certificate is not trusted \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)\)/);

    expect((await fetchText(transportFor(registry({ url: fake.url, insecureTls: true })), `${fake.url}/x`)).text).toBe('secure');

    writeFileSync(join(dir, 'ca.pem'), TEST_CERT);
    expect((await fetchText(transportFor(registry({ url: fake.url, caFile: join(dir, 'ca.pem') })), `${fake.url}/x`)).text).toBe('secure');
  });

  it('says so when the certificate file is missing or not PEM', () => {
    expect(() => transportFor(registry({ url: 'https://x.example', caFile: join(dir, 'nope.pem') }))).toThrow(/cannot be read.*ENOENT/);
    writeFileSync(join(dir, 'ca.der'), Buffer.from([0x30, 0x82, 1, 2]));
    expect(() => transportFor(registry({ url: 'https://x.example', caFile: join(dir, 'ca.der') }))).toThrow(/not a PEM file/);
  });
});

describe('downloads', () => {
  it('streams to a file, hashes it and reports progress', async () => {
    const body = Buffer.concat([Buffer.alloc(300_000, 7), war()]);
    const fake = await serve(files(new Map([['/shop.war', body]])));
    const seen: [number, number | null][] = [];
    const dest = join(dir, 'out.part');
    const got = await downloadTo(transportFor(registry({ url: fake.url })), `${fake.url}/shop.war`, dest, { hashes: ['sha1', 'sha256'], onProgress: (r, t) => seen.push([r, t]) });
    expect(readFileSync(dest)).toEqual(body);
    expect(got.bytes).toBe(body.length);
    expect(got.digests).toEqual({ sha1: digest('sha1', body), sha256: digest('sha256', body) });
    expect(seen[0]).toEqual([0, body.length]);
    expect(seen[seen.length - 1]).toEqual([body.length, body.length]);
  });

  it('fails on a body cut short rather than keeping a short file', async () => {
    const fake = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': '1000' });
      res.write(Buffer.alloc(100));
      setTimeout(() => res.destroy(), 20);
    });
    const err: RegistryError = await downloadTo(transportFor(registry({ url: fake.url })), `${fake.url}/shop.war`, join(dir, 'out.part')).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryError);
    expect(err.kind).toBe('network');
  });
});

// ── Settings ────────────────────────────────────────────

describe('registry settings', () => {
  const check = (input: unknown) => {
    const errors: FieldError[] = [];
    return { registries: validateRegistries(input, errors), errors: errors.map((e) => `${e.path}: ${e.message}`) };
  };

  it('accepts the defaults and a complete registry of each kind', () => {
    expect(validateConfig(structuredClone(DEFAULT_CONFIG))).toMatchObject({ errors: [], config: { registries: [] } });
    const { registries, errors } = check([
      { name: ' Nexus ', type: 'maven', url: 'https://nexus.example.com/repository/maven-public/', auth: { type: 'basic', username: ' ci ', password: ' keep spaces ' }, packages: [{ groupId: 'com.example', artifactId: 'shop' }, { groupId: '', artifactId: '' }] },
      { name: 'Search', type: 'nexus3', url: 'https://nexus.example.com', auth: { type: 'bearer', token: '${env:NEXUS_TOKEN}' }, checkMinutes: 0, packages: [{ repository: 'maven-releases', params: 'maven.extension=war' }] },
      { name: 'CI', type: 'url', url: '', headers: [{ name: 'PRIVATE-TOKEN', value: 'x' }, { name: '', value: '' }], packages: [{ name: 'shop', url: 'https://ci.example.com/shop.war', deployAs: 'ROOT' }] },
      { name: '', url: '', packages: [] },
    ]);
    expect(errors).toEqual([]);
    expect(registries).toHaveLength(3);
    expect(registries[0]).toEqual({
      name: 'Nexus',
      type: 'maven',
      url: 'https://nexus.example.com/repository/maven-public',
      auth: { type: 'basic', username: 'ci', password: ' keep spaces ' },
      headers: [],
      insecureTls: false,
      caFile: '',
      timeoutMs: 30_000,
      checkMinutes: 15,
      packages: [{ groupId: 'com.example', artifactId: 'shop', classifier: '', extension: 'war', versions: 'all', versionPattern: '', deployAs: '' }],
    });
    expect(registries[1]).toMatchObject({ auth: { type: 'bearer', token: '${env:NEXUS_TOKEN}' }, checkMinutes: 0 });
    expect(registries[1].packages[0]).toEqual({ repository: 'maven-releases', group: '', name: '', classifier: '', extension: 'war', versions: 'all', versionPattern: '', params: 'maven.extension=war', deployAs: '' });
    expect(registries[2]).toMatchObject({ headers: [{ name: 'PRIVATE-TOKEN', value: 'x' }], packages: [{ name: 'shop', url: 'https://ci.example.com/shop.war', deployAs: 'ROOT' }] });
  });

  it('reports each problem against the input it belongs to', () => {
    const { errors } = check([
      { name: 'A', type: 'maven', url: 'nexus.example.com', auth: { type: 'basic', username: '' }, timeoutMs: 5, checkMinutes: -1, packages: [{ groupId: 'com example', artifactId: 'sh op', versionPattern: '/(/', deployAs: '../x', versions: 'newest' }] },
      { name: 'a', type: 'ftp', url: 'https://x.example', auth: { type: 'bearer' }, headers: [{ name: 'Bad Name', value: 'v' }], packages: [] },
      { name: 'U', type: 'url', url: '', packages: [{ name: 'shop', url: 'builds/shop.war' }, { name: '', url: 'ftp://x/shop.war' }] },
    ]);
    const paths = errors.map((e) => e.split(':')[0]);
    expect(paths).toEqual(
      expect.arrayContaining([
        'registries.0.url',
        'registries.0.auth.username',
        'registries.0.timeoutMs',
        'registries.0.checkMinutes',
        'registries.0.packages.0.groupId',
        'registries.0.packages.0.artifactId',
        'registries.0.packages.0.versionPattern',
        'registries.0.packages.0.deployAs',
        'registries.0.packages.0.versions',
        'registries.1.type',
        'registries.1.name',
        'registries.1.auth.token',
        'registries.1.headers.0.name',
        'registries.2.packages.0.url',
        'registries.2.packages.1.name',
        'registries.2.packages.1.url',
      ]),
    );
    expect(errors).toContain('registries.1.name: Another registry is already called a');
  });

  it('is part of the settings the hub saves', () => {
    const input: any = structuredClone(DEFAULT_CONFIG);
    input.registries = [{ name: 'Nexus', type: 'maven', url: 'https://nexus.example.com/repository/x', packages: [{ groupId: 'g', artifactId: 'a' }] }, { name: 'Broken', type: 'maven', url: '' }];
    const { config, errors } = validateConfig(input);
    expect(errors).toEqual([{ path: 'registries.1.url', message: 'URL is required' }]);
    expect(config.registries[0].packages[0].extension).toBe('war');
  });
});

// ── Checking, the state file and downloads ──────────────

describe('checking for new versions', () => {
  it('takes what is there at the first look as known, then announces a new version once', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const { svc, messages, events } = makeService([registry({ url: fake.url + REPO })], { names: ['shop'] });
    await svc.checkNow();
    let pkg = (await svc.snapshot()).registries[0].packages[0];
    expect(pkg).toMatchObject({ key: KEY, name: 'shop', coordinates: 'com.example:shop', latest: '2.4.0', fresh: false, target: 'shop', versionCount: 2, deployed: null });
    expect(pkg.versions.map((v) => v.version)).toEqual(['2.4.0', '2.3.0']);
    expect(notices(messages)).toEqual([]);

    publish(store, '2.10.0');
    await svc.checkNow();
    pkg = (await svc.snapshot()).registries[0].packages[0];
    expect(pkg).toMatchObject({ latest: '2.10.0', fresh: true });
    expect(pkg.versions.map((v) => v.version)).toEqual(['2.10.0', '2.4.0', '2.3.0']);
    expect(notices(messages)).toEqual(['shop 2.10.0']);
    expect(messages.find((m) => m.change === 'new')).toMatchObject({ notice: { key: KEY, registry: 'Nexus', target: 'shop', coordinates: 'com.example:shop' } });
    expect(events.map((e) => e.summary)).toContain('New package version: shop 2.10.0 (com.example:shop, Nexus)');

    // Still new, but not announced again.
    await svc.checkNow();
    expect(notices(messages)).toEqual(['shop 2.10.0']);
    expect((await svc.snapshot()).registries[0].packages[0].fresh).toBe(true);
  });

  it('remembers across a restart what was seen, announced and dismissed', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const first = makeService([reg]);
    await first.svc.checkNow();
    first.svc.stop();
    expect(JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')).packages[KEY].seen).toEqual({ version: '2.4.0', build: '2.4.0' });
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // Published while Debug Hub was not running: announced at the next start.
    publish(store, '2.5.0');
    const second = makeService([reg]);
    await second.svc.checkNow();
    expect(notices(second.messages)).toEqual(['shop 2.5.0']);
    second.svc.stop();

    const third = makeService([reg]);
    await third.svc.checkNow();
    expect(notices(third.messages)).toEqual([]);
    expect((await third.svc.snapshot()).registries[0].packages[0].fresh).toBe(true);
    third.svc.dismiss(KEY);
    expect((await third.svc.snapshot()).registries[0].packages[0].fresh).toBe(false);
    third.svc.stop();

    const fourth = makeService([reg]);
    await fourth.svc.checkNow();
    expect((await fourth.svc.snapshot()).registries[0].packages[0]).toMatchObject({ latest: '2.5.0', fresh: false });
  });

  it('announces a rebuilt SNAPSHOT, which keeps its version', async () => {
    const store = mavenStore(['2.5.0-SNAPSHOT']);
    store.set(`${SHOP}/2.5.0-SNAPSHOT/maven-metadata.xml`, snapshotMeta('2.5.0-SNAPSHOT', '20261114.101502', 1));
    const fake = await serve(files(store));
    const { svc, messages } = makeService([registry({ url: fake.url + REPO })]);
    await svc.checkNow();
    await svc.checkNow();
    expect(notices(messages)).toEqual([]);
    store.set(`${SHOP}/2.5.0-SNAPSHOT/maven-metadata.xml`, snapshotMeta('2.5.0-SNAPSHOT', '20261115.090000', 2));
    await svc.checkNow();
    expect(notices(messages)).toEqual(['shop 2.5.0-SNAPSHOT']);
    expect(svc.state.get(KEY)!.announced).toEqual({ version: '2.5.0-SNAPSHOT', build: '2.5.0-20261115.090000-2' });
  });

  it('filters releases, snapshots and version patterns before deciding what is latest', async () => {
    const store = mavenStore(['2.3.0', '2.4.0', '3.0.0-RC1', '3.0.0-SNAPSHOT']);
    const fake = await serve(files(store));
    const entry = registry({ url: '' }).packages[0];
    const { svc } = makeService([
      registry({ name: 'Releases', url: fake.url + REPO, packages: [{ ...entry, versions: 'releases' }] }),
      registry({ name: 'Snapshots', url: fake.url + REPO, packages: [{ ...entry, versions: 'snapshots' }] }),
      registry({ name: 'Twos', url: fake.url + REPO, packages: [{ ...entry, versionPattern: '2.*' }] }),
      registry({ name: 'None', url: fake.url + REPO, packages: [{ ...entry, versionPattern: '9.*' }] }),
    ]);
    await svc.checkNow();
    const { registries } = await svc.snapshot();
    expect(registries.map((r) => [r.name, r.packages[0].latest, r.packages[0].versionCount])).toEqual([
      ['Releases', '3.0.0-RC1', 3],
      ['Snapshots', '3.0.0-SNAPSHOT', 1],
      ['Twos', '2.4.0', 2],
      ['None', null, 0],
    ]);
    expect(registries[3].problems[0]).toMatchObject({ message: 'None of its 4 versions pass the version settings.', filtered: true });
  });

  it('starts over when the version settings change, so narrowing them does not silence later versions', async () => {
    const store = mavenStore(['2.4.0', '3.0.0-SNAPSHOT']);
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const { svc, messages, cfg } = makeService([reg]);
    await svc.checkNow();
    expect(svc.state.get(KEY)!.seen).toMatchObject({ version: '3.0.0-SNAPSHOT' });
    // Releases only: 2.4.0 is the latest now, which is not news.
    svc.reconfigure({ ...cfg, registries: [{ ...reg, packages: [{ ...reg.packages[0], versions: 'releases' }] }] });
    await svc.checkNow();
    expect(svc.state.get(KEY)!.seen).toMatchObject({ version: '2.4.0' });
    expect(notices(messages)).toEqual([]);
    // A release below the snapshot seen earlier is announced all the same.
    publish(store, '2.5.0');
    await svc.checkNow();
    expect(notices(messages)).toEqual(['shop 2.5.0']);
    // A version that disappears and comes back is not news twice.
    svc.dismiss(KEY);
    store.set(`${SHOP}/maven-metadata.xml`, artifactMeta(['2.4.0', '3.0.0-SNAPSHOT']));
    await svc.checkNow();
    store.set(`${SHOP}/maven-metadata.xml`, artifactMeta(['2.4.0', '2.5.0', '3.0.0-SNAPSHOT']));
    await svc.checkNow();
    expect(notices(messages)).toEqual(['shop 2.5.0']);
    expect((await svc.snapshot()).registries[0].packages[0].fresh).toBe(false);
  });

  it('lists a registry’s problem without stopping the others, and never shows a secret', async () => {
    const store = mavenStore();
    const fake = await serve(files(store, basicAuth('ci', 'hunter22')));
    const good = registry({ name: 'Good', url: fake.url + REPO, auth: { type: 'basic', username: 'ci', password: '${env:PW}' } });
    const bad = registry({ name: 'Bad', url: fake.url + REPO, auth: { type: 'basic', username: 'ci', password: 'wrong-pass' } });
    const unset = registry({ name: 'Unset', url: fake.url + REPO, auth: { type: 'bearer', token: '${env:MISSING_TOKEN}' } });
    const { svc, events } = makeService([good, bad, unset, { ...good, name: 'good' }], { env: { PW: 'hunter22' } });
    await svc.checkNow();
    const state = await svc.snapshot();
    expect(state.registries.map((r) => [r.name, r.packages.length, !!r.error, r.problems.length])).toEqual([
      ['Good', 1, false, 0],
      ['Bad', 0, false, 1],
      ['Unset', 0, true, 0],
      ['good', 0, true, 0],
    ]);
    expect(state.registries[1].problems[0]).toMatchObject({ entry: 'com.example:shop' });
    expect(state.registries[1].problems[0].message).toMatch(/did not accept the login/);
    expect(state.registries[2].error).toMatch(/environment variable MISSING_TOKEN/);
    expect(state.registries[3].error).toBe('Another registry is already called good.');
    const everything = JSON.stringify(state) + JSON.stringify(events) + readFileSync(join(dir, STATE_FILE), 'utf8');
    for (const secret of ['hunter22', 'wrong-pass', Buffer.from('ci:hunter22').toString('base64')]) expect(everything).not.toContain(secret);
    // The timeline is told about the problem once, not on every check.
    await svc.checkNow();
    expect(events.filter((e) => /Package registry Bad/.test(e.summary))).toHaveLength(1);
  });

  it('keeps registries whose settings did not change when others are saved', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const { svc, cfg } = makeService([reg]);
    await svc.checkNow();
    const before = fake.hits.length;
    svc.reconfigure({ ...cfg, registries: [reg, registry({ name: 'Other', url: fake.url + REPO, packages: [] })] });
    expect((await svc.snapshot()).registries.map((r) => [r.name, r.packages.length])).toEqual([['Nexus', 1], ['Other', 0]]);
    expect(fake.hits.length).toBe(before);
    svc.reconfigure({ ...cfg, registries: [] });
    expect((await svc.snapshot()).registries).toEqual([]);
  });

  it('checks a Nexus 3 search and a direct URL the same way', async () => {
    const assets = [mavenAsset('1.0', 'war'), mavenAsset('1.1', 'war')];
    const nexus = await serve(nexusSearch(assets, 50));
    let etag = '"v1"';
    const ci = await serve((req, res) => {
      res.writeHead(200, { etag, 'content-length': '26' });
      res.end(req.method === 'HEAD' ? undefined : war());
    });
    const { svc, messages } = makeService([
      registry({ name: 'Search', type: 'nexus3', url: nexus.url, packages: [{ repository: 'maven-releases', deployAs: '' }] }),
      registry({ name: 'CI', type: 'url', url: '', packages: [{ name: 'admin', url: `${ci.url}/admin.war`, deployAs: 'ROOT' }] }),
    ]);
    await svc.checkNow();
    assets.push(mavenAsset('1.2', 'war'));
    etag = '"v2"';
    await svc.checkNow();
    expect(notices(messages).sort()).toEqual(['admin build v2', 'shop 1.2']);
    const state = await svc.snapshot();
    expect(state.registries[0].packages[0]).toMatchObject({ key: 'Search::maven-releases/com.example:shop', latest: '1.2', fresh: true });
    expect(state.registries[0].packages[0].versions[0]).toMatchObject({ bytes: 1234, modified: '2026-11-14T10:15:02.000Z' });
    expect(state.registries[1].packages[0]).toMatchObject({ name: 'admin', target: 'ROOT', fresh: true });
  });
});

describe('the state file', () => {
  it('is written whole, survives being unreadable, and drops what is malformed', () => {
    const file = join(dir, STATE_FILE);
    const store = new RegistryStateStore(file);
    store.touch('a').seen = { version: '1.0', build: '1.0' };
    store.touch('a').deployed = { version: '1.0', build: '1.0', as: 'shop', at: '2026-11-14T10:00:00.000Z' };
    store.touch('a').downloads.push({ version: '1.0', build: '1.0', file: join(dir, 'x.war'), bytes: 3, checksum: 'sha1:abc', modified: null, downloadedAt: '2026-11-14T10:00:00.000Z' });
    store.save();
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const again = new RegistryStateStore(file);
    expect(again.get('a')).toMatchObject({ seen: { version: '1.0', build: '1.0' }, deployed: { as: 'shop' }, downloads: [{ bytes: 3, checksum: 'sha1:abc' }] });

    writeFileSync(file, JSON.stringify({ version: 1, packages: { ok: { seen: { version: '2', build: '2' }, downloads: [{ file: 5 }, 'x'] }, bad: 'nope', worse: { seen: { version: 1 } } } }));
    const lenient = new RegistryStateStore(file);
    expect(lenient.keys().sort()).toEqual(['ok', 'worse']);
    expect(lenient.get('ok')).toMatchObject({ seen: { version: '2', build: '2' }, downloads: [] });
    expect(lenient.get('worse')!.seen).toBeNull();

    writeFileSync(file, '{ not json');
    const broken = new RegistryStateStore(file);
    expect(broken.problem).toMatch(/Could not read/);
    expect(broken.keys()).toEqual([]);
    broken.touch('b');
    broken.save();
    expect(JSON.parse(readFileSync(file, 'utf8')).packages.b).toBeDefined();
  });

  it('forgets packages not seen for months', () => {
    const store = new RegistryStateStore(join(dir, STATE_FILE));
    const now = Date.parse('2026-11-14T00:00:00Z');
    store.touch('old', now - 200 * 24 * 60 * 60_000).downloads.push({ version: '1', build: '1', file: 'f', bytes: 1, checksum: null, modified: null, downloadedAt: '' });
    store.touch('recent', now - 10 * 24 * 60 * 60_000);
    expect(store.forgetStale(now).map((d) => d.file)).toEqual(['f']);
    expect(store.keys()).toEqual(['recent']);
  });
});

describe('download and checksum', () => {
  it('downloads into the cache, verifies the checksum and hands the file over', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const { svc, messages, events } = makeService([registry({ url: fake.url + REPO })], { names: ['Shop'] });
    await svc.checkNow();
    const { war: got, note } = await svc.download(KEY);
    expect(note).toMatch(/SHA-1 verified/);
    expect(basename(got.file)).toBe('shop-2.4.0.war');
    expect(got.file.startsWith(join(dir, 'registry-cache'))).toBe(true);
    // The target is the package's, matched to a webapp that exists, not the file name's guess.
    expect(got.target).toBe('Shop');
    expect(readFileSync(got.file)).toEqual(war('2.4.0'));
    expect(cacheFiles()).toEqual(['shop-2.4.0.war']);
    expect(svc.state.get(KEY)!.downloads[0]).toMatchObject({ version: '2.4.0', bytes: war('2.4.0').length, checksum: `sha1:${digest('sha1', war('2.4.0'))}` });
    expect(messages.some((m) => m.change === 'download' && m.download?.phase === 'verifying')).toBe(true);
    expect(messages.filter((m) => m.change === 'download').pop()).toMatchObject({ key: KEY, download: null });
    expect(events.map((e) => e.summary).pop()).toMatch(/^Downloaded shop-2\.4\.0\.war from Nexus \(.*SHA-1 verified\)$/);
    expect((await svc.snapshot()).registries[0].packages[0].versions.map((v) => [v.version, v.cached])).toEqual([['2.4.0', true], ['2.3.0', false]]);

    // The same build again needs no download.
    const hits = fake.hits.length;
    expect((await svc.download(KEY, '2.4.0')).note).toBe('Already downloaded.');
    expect(fake.hits.length).toBe(hits);
  });

  it('refuses a download that does not match the registry’s checksum, and keeps nothing', async () => {
    const store = mavenStore();
    store.set(`${SHOP}/2.4.0/shop-2.4.0.war.sha1`, 'f'.repeat(40));
    const fake = await serve(files(store));
    const { svc } = makeService([registry({ url: fake.url + REPO })]);
    await svc.checkNow();
    const err: RegistryProblem = await svc.download(KEY).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryProblem);
    expect(err.message).toMatch(/shop-2\.4\.0\.war does not match the registry’s SHA-1 checksum \(the registry says ffffffffffff…/);
    expect(err.status).toBe(502);
    expect(cacheFiles()).toEqual([]);
    expect(svc.state.get(KEY)!.downloads).toEqual([]);
  });

  it('says when there is no checksum to verify against, and refuses what is not a WAR', async () => {
    const store = mavenStore();
    store.delete(`${SHOP}/2.4.0/shop-2.4.0.war.sha1`);
    const page = Buffer.from('<html><body>Please sign in</body></html>');
    publish(store, '2.3.0', page);
    const fake = await serve(files(store));
    const { svc } = makeService([registry({ url: fake.url + REPO })]);
    await svc.checkNow();
    expect((await svc.download(KEY)).note).toMatch(/publishes no checksum for it, so it was not verified/);
    const err: RegistryProblem = await svc.download(KEY, '2.3.0').catch((e) => e);
    expect(err.message).toMatch(/is not a WAR \(a zip archive\)/);
    expect(cacheFiles()).toEqual(['shop-2.4.0.war']);
  });

  it('uses the checksum a Nexus 3 search gives, strongest first', async () => {
    const body = war('nexus');
    const assets = [mavenAsset('1.0', 'war', { checksum: { md5: digest('md5', body), sha1: digest('sha1', body), sha256: digest('sha256', body) } })];
    const search = nexusSearch(assets, 50);
    const fake = await serve((req, res, path) => (path.startsWith('/repository/') ? files(new Map([['/repository/maven-releases/com/example/shop/1.0/shop-1.0.war', body]]))(req, res, path) : search(req, res, path)));
    const { svc } = makeService([registry({ name: 'Search', type: 'nexus3', url: fake.url, packages: [{ repository: 'maven-releases', deployAs: 'store' }] })]);
    await svc.checkNow();
    const { war: got, note } = await svc.download('Search::maven-releases/com.example:shop');
    expect(note).toMatch(/SHA-256 verified/);
    expect(got.target).toBe('store');
    assets[0].checksum = { sha256: 'e'.repeat(64) };
    assets[0].lastModified = '2026-11-15T00:00:00.000+00:00';
    await svc.checkNow();
    // The search reports one build per release, so the cached file still stands for it.
    expect((await svc.download('Search::maven-releases/com.example:shop')).note).toBe('Already downloaded.');
  });

  it('can be canceled, leaving no partial file', async () => {
    const store = mavenStore();
    let release: () => void = () => undefined;
    const fake = await serve((req, res, path) => {
      if (!path.endsWith('shop-2.4.0.war')) return files(store)(req, res, path);
      res.writeHead(200, { 'content-length': '5000000' });
      res.write(Buffer.alloc(100_000));
      release = () => res.destroy();
    });
    const { svc, messages } = makeService([registry({ url: fake.url + REPO })]);
    await svc.checkNow();
    const pending = svc.download(KEY).catch((e) => e);
    for (let i = 0; i < 200 && !messages.some((m) => m.change === 'download' && (m.download?.received ?? 0) > 0); i++) await new Promise((r) => setTimeout(r, 10));
    expect((await svc.snapshot()).registries[0].packages[0].download).toMatchObject({ phase: 'downloading', total: 5_000_000 });
    await expect(svc.download(KEY)).rejects.toThrow(/already being downloaded/);
    svc.cancel(KEY);
    const err: RegistryProblem = await pending;
    release();
    expect(err.message).toBe('The download was canceled.');
    expect(cacheFiles()).toEqual([]);
    expect((await svc.snapshot()).registries[0].packages[0].download).toBeNull();
  });

  it('keeps the newest downloads and the deployed one, and deletes the rest', async () => {
    const store = mavenStore(['1.0', '1.1', '1.2', '1.3']);
    const fake = await serve(files(store));
    const { svc } = makeService([registry({ url: fake.url + REPO })], { keepDownloads: 2, names: ['shop'] });
    await svc.checkNow();
    const first = await svc.download(KEY, '1.0');
    svc.deployed(first.war.file, 'shop');
    for (const v of ['1.1', '1.2', '1.3']) {
      await svc.download(KEY, v);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(cacheFiles()).toEqual(['shop-1.0.war', 'shop-1.2.war', 'shop-1.3.war']);
    expect(readdirSync(join(dir, 'registry-cache')).length).toBe(1);
    expect(readdirSync(join(dir, 'registry-cache', readdirSync(join(dir, 'registry-cache'))[0])).sort()).toEqual(['1.0', '1.2', '1.3']);
  });

  it('clears out what a crash left in the cache, and forgets downloads whose file is gone', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const reg = registry({ url: fake.url + REPO });
    const first = makeService([reg]);
    await first.svc.checkNow();
    const { war: got } = await first.svc.download(KEY);
    first.svc.stop();
    const folder = join(got.file, '..');
    writeFileSync(join(folder, '.shop-2.4.0.war.ab12cd34.part'), 'half');
    mkdirSync(join(dir, 'registry-cache', 'stray', '1.0'), { recursive: true });
    writeFileSync(join(dir, 'registry-cache', 'stray', '1.0', 'old.war'), 'x');
    const second = makeService([reg]);
    await new Promise((r) => setTimeout(r, 100));
    expect(cacheFiles()).toEqual(['shop-2.4.0.war']);
    expect(existsSync(join(dir, 'registry-cache', 'stray'))).toBe(false);
    second.svc.stop();

    rmSync(got.file);
    const third = makeService([reg]);
    await new Promise((r) => setTimeout(r, 100));
    expect(third.svc.state.get(KEY)!.downloads).toEqual([]);
  });

  it('records what was deployed, settles the notice, and lets a local WAR take the name over', async () => {
    const store = mavenStore();
    const fake = await serve(files(store));
    const { svc } = makeService([registry({ url: fake.url + REPO })], { names: ['shop'] });
    await svc.checkNow();
    publish(store, '2.5.0');
    await svc.checkNow();
    const { war: got } = await svc.download(KEY);
    svc.deployed(got.file, 'shop');
    expect((await svc.snapshot()).registries[0].packages[0]).toMatchObject({ fresh: false, deployed: { version: '2.5.0', as: 'shop' } });
    // Rolling back to an older version is a deploy like any other.
    const older = await svc.download(KEY, '2.3.0');
    svc.deployed(older.war.file, 'shop');
    expect((await svc.snapshot()).registries[0].packages[0].deployed).toMatchObject({ version: '2.3.0' });
    svc.deployed('C:/dev/shop/target/shop.war', 'shop');
    expect((await svc.snapshot()).registries[0].packages[0].deployed).toBeNull();
  });

  it('deploys each package as the name set for it, or as it was last deployed', async () => {
    const fake = await serve(files(mavenStore()));
    const { svc } = makeService([registry({ url: fake.url + REPO })], { names: ['shop'] });
    await svc.checkNow();
    const pkg = async () => (await svc.snapshot()).registries[0].packages[0];
    expect(await pkg()).toMatchObject({ target: 'shop', targetFrom: 'guess' });

    await svc.setTarget(KEY, 'ROOT');
    expect(await pkg()).toMatchObject({ target: 'ROOT', targetFrom: 'package' });
    expect((await svc.download(KEY)).war.target).toBe('ROOT');
    // Remembered across a restart, in the state file.
    const again = makeService([registry({ url: fake.url + REPO })], { names: ['shop'] }).svc;
    await again.checkNow();
    expect((await again.snapshot()).registries[0].packages[0].target).toBe('ROOT');

    // The default is not remembered: a Deploy as in Settings later still counts.
    await svc.setTarget(KEY, ' shop ');
    expect(await pkg()).toMatchObject({ target: 'shop', targetFrom: 'guess' });
    expect(svc.state.get(KEY)?.deployAs).toBeUndefined();
    await expect(svc.setTarget(KEY, '../x')).rejects.toThrow(RegistryProblem);

    // Deployed under another name in the deploy dialog: that name from then on.
    const { war: got } = await svc.download(KEY);
    svc.deployed(got.file, 'shop-test');
    expect(await pkg()).toMatchObject({ target: 'shop-test', targetFrom: 'package' });
    svc.deployed(got.file, 'shop');
    expect(await pkg()).toMatchObject({ target: 'shop', targetFrom: 'guess' });
    await svc.setTarget(KEY, 'other');
    await svc.setTarget(KEY, '');
    expect(await pkg()).toMatchObject({ target: 'shop', targetFrom: 'guess' });
  });

  it('deploys a new package as its name without the version, unless set otherwise', async () => {
    const raw = (path: string): FakeAsset => ({ path, repository: 'raw-builds', lastModified: '2026-11-14T10:15:02.000+00:00', fileSize: 10, checksum: { sha1: 'c'.repeat(40) } });
    const fake = await serve(nexusSearch([raw('builds/billing_2.0.1.war'), raw('builds/billing_2.1.0.war'), raw('builds/reports-v3.war')], 50));
    const search = { repository: 'raw-builds', group: '', name: '', params: '', classifier: '', extension: 'war', versions: 'all' as const, versionPattern: '', deployAs: '' };
    const { svc } = makeService([registry({ name: 'Raw', type: 'nexus3', url: fake.url, packages: [search] })]);
    await svc.checkNow();
    const pkgs = async () => (await svc.snapshot()).registries[0].packages.map((p) => [p.name, p.versionCount, p.target, p.targetFrom]);
    // One package per name, its versions together, deployed under the bare name.
    expect(await pkgs()).toEqual([
      ['billing', 2, 'billing', 'guess'],
      ['reports', 1, 'reports', 'guess'],
    ]);
    await svc.setTarget((await svc.snapshot()).registries[0].packages[0].key, 'ROOT');
    expect((await pkgs())[0]).toEqual(['billing', 2, 'ROOT', 'package']);
  });

  it('makes registry file names safe to write', () => {
    expect(safeFileName('shop-2.4.0.war')).toBe('shop-2.4.0.war');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\windows\\system32\\evil.war')).toBe('evil.war');
    expect(safeFileName('.hidden.war')).toBe('hidden.war');
    expect(safeFileName('a:b*c?.war')).toBe('a_b_c_.war');
    expect(safeFileName('nul.war')).toBe('download.war');
    expect(safeFileName('')).toBe('download.war');
  });
});

describe('Test connection', () => {
  it('reports what each package entry finds', async () => {
    const store = mavenStore(['2.3.0', '2.4.0', '2.4.1', '3.0.0-SNAPSHOT']);
    const fake = await serve(files(store));
    const { svc } = makeService([]);
    const entry = registry({ url: '' }).packages[0];
    const result = await svc.test({ name: 'New', type: 'maven', url: fake.url + REPO, packages: [{ ...entry, versions: 'releases' }, { ...entry, artifactId: 'missing' }] });
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toEqual({ ok: true, entry: 'com.example:shop', message: '3 versions, latest 2.4.1 (1 more left out by the version settings)' });
    expect(result.lines[1]).toMatchObject({ ok: false, entry: 'com.example:missing' });
    expect(result.lines[1].message).toMatch(/Not found \(404\)/);
    expect(result.lines[1].hint).toMatch(/group ID and artifact ID/);
    // Nothing about a test is remembered.
    expect(existsSync(join(dir, STATE_FILE))).toBe(false);
  });

  it('names a wrong login, a missing variable and unfinished settings without showing a secret', async () => {
    const fake = await serve(files(mavenStore(), basicAuth('ci', 'hunter22')));
    const { svc } = makeService([], { env: { PW: 'hunter22' } });
    const base = { name: 'New', type: 'maven', url: fake.url + REPO, packages: [registry({ url: '' }).packages[0]] };
    const ok = await svc.test({ ...base, auth: { type: 'basic', username: 'ci', password: '${env:PW}' } });
    expect(ok).toEqual({ ok: true, lines: [{ ok: true, entry: 'com.example:shop', message: '2 versions, latest 2.4.0' }] });

    const wrong = await svc.test({ ...base, auth: { type: 'basic', username: 'ci', password: 'wrong-pass' } });
    expect(wrong.ok).toBe(false);
    expect(wrong.lines[0].message).toMatch(/did not accept the login/);
    expect(JSON.stringify(wrong)).not.toContain('wrong-pass');

    const unset = await svc.test({ ...base, auth: { type: 'bearer', token: '${env:NOPE}' } });
    expect(unset.lines[0].message).toMatch(/environment variable NOPE/);

    const unfinished = await svc.test({ ...base, url: '', packages: [{ groupId: '', artifactId: 'shop' }] });
    expect(unfinished.lines.map((l) => [l.entry, l.message])).toEqual([['Package 1', 'Group ID is required'], ['', 'URL is required']]);
    expect((await svc.test({})).lines[0].message).toBe('Fill in the registry first.');
  });

  it('lists a Nexus 3’s repositories when no search is set up yet', async () => {
    const fake = await serve(nexusSearch([]));
    const { svc } = makeService([]);
    const result = await svc.test({ name: 'Search', type: 'nexus3', url: fake.url, packages: [] });
    expect(result).toMatchObject({ ok: true, lines: [{ entry: '' }] });
    expect(result.lines[0].message).toMatch(/Connected to Nexus 3\. 2 repositories/);
  });
});

// ── Through the hub ─────────────────────────────────────

describe('registry API', () => {
  let hub: Hub;
  let server: Server;
  let base: string;
  let store: Map<string, string | Buffer>;

  beforeEach(async () => {
    const { createServer: probeServer } = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const probe = probeServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    store = mavenStore();
    const fake = await serve(files(store, basicAuth('ci', 'hunter22')));
    mkdirSync(join(dir, 'webapps'));
    writeFileSync(join(dir, 'webapps', 'shop.war'), war('old'));
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.port = port;
    config.chrome.enabled = false;
    config.sessionsDir = join(dir, 'sessions');
    config.tomcat.webappsDir = join(dir, 'webapps');
    config.registries = [registry({ url: fake.url + REPO, auth: { type: 'basic', username: 'ci', password: 'hunter22' } })];
    hub = new Hub(config);
    hub.start();
    server = await startServer(hub, dir, { configFile: join(dir, 'debug-hub.config.json') });
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    server.close();
    await hub.stop();
  });
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('checks, announces over the WebSocket, downloads and deploys through the Tomcat page’s deploy', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));

    let state = await (await post('/api/registry/check')).json();
    expect(state.registries[0]).toMatchObject({ name: 'Nexus', type: 'maven', error: null, problems: [] });
    expect(state.registries[0].packages[0]).toMatchObject({ latest: '2.4.0', fresh: false, target: 'shop' });
    expect(JSON.stringify(state)).not.toContain('hunter22');

    publish(store, '2.5.0');
    state = await (await post('/api/registry/check', { registry: 'Nexus' })).json();
    expect(state.registries[0].packages[0]).toMatchObject({ latest: '2.5.0', fresh: true });
    for (let i = 0; i < 50 && !messages.some((m) => m.type === 'registry' && m.change === 'new'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(messages.find((m) => m.change === 'new').notice).toMatchObject({ name: 'shop', version: '2.5.0', target: 'shop' });
    ws.close();

    const res = await post('/api/registry/download', { key: KEY });
    expect(res.status).toBe(200);
    const { war: got, note } = await res.json();
    expect(note).toMatch(/SHA-1 verified/);
    expect(got).toMatchObject({ name: 'shop-2.5.0.war', target: 'shop' });

    // From here on it is an ordinary deploy on the Tomcat page.
    const deployed = await post('/api/tomcat/deploy', { file: got.file, name: 'shop' });
    expect((await deployed.json()).message).toMatch(/Deployed shop-2\.5\.0\.war as shop\.war/);
    expect(readFileSync(join(dir, 'webapps', 'shop.war'))).toEqual(war('2.5.0'));
    state = await (await fetch(`${base}/api/registry`)).json();
    expect(state.registries[0].packages[0]).toMatchObject({ fresh: false, deployed: { version: '2.5.0', as: 'shop' } });
    expect(state.registries[0].packages[0].versions[0]).toMatchObject({ version: '2.5.0', cached: true });
    // Files outside the cache and the watch folders are still refused.
    expect((await post('/api/tomcat/deploy', { file: join(dir, 'webapps', 'shop.war'), name: 'x' })).status).toBe(404);
  });

  it('answers problems with a status and a message, and refuses other origins', async () => {
    await post('/api/registry/check');
    expect((await post('/api/registry/download', { key: 'nope' })).status).toBe(404);
    const gone = await post('/api/registry/download', { key: KEY, version: '9.9.9' });
    expect(gone.status).toBe(404);
    expect((await gone.json()).error).toMatch(/has no version 9\.9\.9 any more/);
    expect((await post('/api/registry/check', { registry: 'Other' })).status).toBe(404);
    expect((await post('/api/registry/dismiss', { key: KEY })).status).toBe(200);
    expect((await fetch(`${base}/api/registry/nothing`)).status).toBe(405);
    expect((await post('/api/registry/nothing')).status).toBe(404);
    const test = await (await post('/api/registry/test', { registry: { name: 'T', type: 'maven', url: 'http://127.0.0.1:1/repo', packages: [{ groupId: 'g', artifactId: 'a' }] } })).json();
    expect(test.lines[0]).toMatchObject({ ok: false, entry: 'g:a' });
    expect(test.lines[0].message).toMatch(/Connection refused/);
    const evil = await fetch(`${base}/api/registry`, { headers: { origin: 'http://evil.example' } });
    expect(evil.status).toBe(403);
  });

  it('applies registries saved in Settings without a restart', async () => {
    const config = (await (await fetch(`${base}/api/config`)).json()).config;
    expect(config.registries).toEqual([]);
    const bad = await fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, port: hub.cfg.port, sessionsDir: join(dir, 'sessions'), registries: [{ name: 'X', type: 'maven', url: '' }] }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).errors).toEqual([{ path: 'registries.0.url', message: 'URL is required' }]);
    const ok = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...config, port: hub.cfg.port, sessionsDir: join(dir, 'sessions'), registries: [{ name: 'Saved', type: 'url', url: '', packages: [] }] }),
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, 'debug-hub.config.json'), 'utf8')).registries[0]).toMatchObject({ name: 'Saved', type: 'url', checkMinutes: 15 });
    const state = await (await fetch(`${base}/api/registry`)).json();
    expect(state.registries.map((r: any) => r.name)).toEqual(['Saved']);
  });
});
