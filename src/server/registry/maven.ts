import { REGISTRY_DEFAULTS, type RegistryPackage } from '../../shared/registry';
import { fetchAnswer, fetchText, RegistryError, type HashName } from './transport';
import { joinUrl, mavenTime, type Artifact, type FoundPackage, type Listing, type RegistryContext, type RegistryKind } from './types';
import { isSnapshot, sortNewestFirst, versionMatcher } from './version';

/**
 * A repository in Maven's layout, read the way Maven reads it: maven-metadata.xml next to the
 * artifact lists its versions, and the one inside a -SNAPSHOT folder names the latest timestamped
 * build. That is all any Maven repository has to serve, so this works with Nexus 2 and 3,
 * Artifactory, GitLab and GitHub package registries and a plain folder behind a web server.
 */

const unescape = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

/** The text of every <tag>…</tag>, in order. Enough for Maven metadata, which has no attributes or nesting of the same tag. */
export function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

const xmlText = (xml: string, tag: string): string | null => {
  const inner = xmlAll(xml, tag)[0];
  return inner === undefined ? null : unescape(inner.trim());
};

const withoutComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

export interface ArtifactMetadata {
  versions: string[];
  latest: string | null;
  release: string | null;
  lastUpdated: string | null;
}

/** maven-metadata.xml of an artifact: the versions it has. */
export function parseArtifactMetadata(text: string): ArtifactMetadata {
  const xml = withoutComments(text);
  if (!/<metadata[\s>]/.test(xml)) throw new RegistryError('That is not a maven-metadata.xml: it has no <metadata>.', 'content');
  const versions = xmlAll(xmlAll(xml, 'versions')[0] ?? '', 'version').map((v) => unescape(v.trim())).filter(Boolean);
  const latest = xmlText(xml, 'latest');
  const release = xmlText(xml, 'release');
  // Some repositories only keep <latest> and <release> up to date.
  for (const v of [release, latest]) if (v && !versions.includes(v)) versions.push(v);
  return { versions: [...new Set(versions)], latest, release, lastUpdated: mavenTime(xmlText(xml, 'lastUpdated')) };
}

export interface SnapshotBuild {
  /** The version in the file name: 1.4.0-20260114.101502-3, or 1.4.0-SNAPSHOT where builds are not kept apart. */
  value: string;
  updated: string | null;
}

/**
 * maven-metadata.xml inside a -SNAPSHOT folder: the latest build of that version for a given
 * extension and classifier. Repositories that keep one file per snapshot ("non-unique") have no
 * build to name; the file is then called by the -SNAPSHOT version itself.
 */
export function parseSnapshotMetadata(text: string, version: string, extension: string, classifier: string): SnapshotBuild {
  const xml = withoutComments(text);
  const lastUpdated = mavenTime(xmlText(xml, 'lastUpdated'));
  for (const sv of xmlAll(xml, 'snapshotVersion')) {
    if ((xmlText(sv, 'extension') ?? '') !== extension || (xmlText(sv, 'classifier') ?? '') !== classifier) continue;
    const value = xmlText(sv, 'value');
    if (value) return { value, updated: mavenTime(xmlText(sv, 'updated')) ?? lastUpdated };
  }
  const snapshot = xmlAll(xml, 'snapshot')[0] ?? '';
  const timestamp = xmlText(snapshot, 'timestamp');
  const buildNumber = xmlText(snapshot, 'buildNumber');
  if (timestamp && buildNumber && xmlText(snapshot, 'localCopy') !== 'true') {
    return { value: `${version.replace(/-SNAPSHOT$/i, '')}-${timestamp}-${buildNumber}`, updated: mavenTime(timestamp) ?? lastUpdated };
  }
  return { value: version, updated: lastUpdated };
}

/** The first hex digest of the right length in a checksum file: "abc…", "abc…  shop.war" or "SHA1(shop.war)= abc…". */
export function parseChecksum(text: string, hash: HashName): string | null {
  const length = { md5: 32, sha1: 40, sha256: 64, sha512: 128 }[hash];
  return new RegExp(`(?:^|[^0-9a-fA-F])([0-9a-fA-F]{${length}})(?![0-9a-fA-F])`).exec(text.slice(0, 4096))?.[1].toLowerCase() ?? null;
}

const ext = (entry: RegistryPackage) => entry.extension || REGISTRY_DEFAULTS.extension;
const groupPath = (entry: RegistryPackage) => (entry.groupId ?? '').split('.');

function artifactDir(ctx: RegistryContext, entry: RegistryPackage, artifactId: string): string {
  return joinUrl(ctx.registry.url, ...groupPath(entry), artifactId);
}

/** Sidecar files, strongest first. A repository has at least one of the last two. */
const SIDECARS: HashName[] = ['sha256', 'sha1', 'md5'];

// ── Finding the artifacts in a group ────────────────────

/** An Artifact ID that is empty, or has * or ?, or is a /regular expression/: the group is searched. */
export const isArtifactPattern = (artifactId: string | undefined): boolean => {
  const a = (artifactId ?? '').trim();
  return !a || /[*?]/.test(a) || /^\/.+\/[a-z]*$/.test(a);
};

/** More than this many folders in a group are not looked into: the listing says so. */
export const MAX_GROUP_CHILDREN = 300;
/** Requests at a time while looking through a group. */
const CONCURRENCY = 6;
const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The folders a directory listing links to, by name. Works with the listings of Nexus 2,
 * Nexus 3's browse pages, Artifactory, Apache and nginx: each links to its sub-folders with a
 * trailing slash, relative or absolute. Links that lead anywhere but one level down are not folders
 * of this one (the parent, sort links, the server's own pages).
 */
export function listingFolders(html: string, dirUrl: string): string[] {
  const base = new URL(dirUrl.endsWith('/') ? dirUrl : `${dirUrl}/`);
  const out = new Set<string>();
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = unescape(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || href.startsWith('?') || href.startsWith('#')) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin || url.search) continue;
    // Some servers write the path encoded, some not: compare decoded.
    let path: string;
    let dir: string;
    try {
      path = decodeURIComponent(url.pathname);
      dir = decodeURIComponent(base.pathname);
    } catch {
      continue;
    }
    if (!path.startsWith(dir) || !path.endsWith('/')) continue;
    const name = path.slice(dir.length, -1);
    if (NAME.test(name) && name !== '.' && name !== '..') out.add(name);
  }
  return [...out];
}

/** Where Nexus 3 shows a repository folder as a web page, when the registry URL is a Nexus 3 repository. */
export function nexus3BrowseUrl(repositoryUrl: string, path: string[]): string | null {
  const m = /^(.*)\/repository\/([^/]+)\/*$/.exec(repositoryUrl);
  return m ? `${joinUrl(m[1], 'service', 'rest', 'repository', 'browse', m[2], ...path)}/` : null;
}

const noListing = (entry: RegistryPackage) =>
  new RegistryError(
    `The repository does not list what is in ${entry.groupId}, so its artifacts cannot be found without naming them.`,
    'not-found',
    0,
    'Enter the Artifact ID of each package instead. On Nexus 3, the Nexus 3 search registry type finds every WAR of a group too.',
  );

/** The names of the folders in a group's folder: its artifacts, and any groups below it. */
async function groupFolders(ctx: RegistryContext, entry: RegistryPackage): Promise<string[]> {
  const tries = [`${joinUrl(ctx.registry.url, ...groupPath(entry))}/`];
  const browse = nexus3BrowseUrl(ctx.registry.url, groupPath(entry));
  if (browse) tries.push(browse);
  let found = false;
  for (const url of tries) {
    const { text, answer } = await fetchText(ctx.transport, url, { signal: ctx.signal, maxBytes: 8 * 1024 * 1024, allow: [400, 403, 404, 405] });
    if (answer.status !== 200) continue;
    found = true;
    const folders = listingFolders(text, url);
    if (folders.length) return folders;
  }
  if (found) return [];
  throw noListing(entry);
}

/** Runs `fn` over `items`, a few at a time, in order. */
async function inTurn<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return out;
}

/**
 * Whether an artifact publishes the file the entry asks for (a .war, by default), going by its
 * newest version. Remembered per version, so a check of a large group asks once per new version.
 */
const publishes = new Map<string, boolean>();
const MAX_REMEMBERED = 5000;

async function hasFile(ctx: RegistryContext, entry: RegistryPackage, pkg: FoundPackage): Promise<boolean> {
  const newest = sortNewestFirst(pkg.versions, (v) => v.version)[0];
  if (!newest) return false;
  const memo = `${ctx.registry.url}|${pkg.id}|${newest.version}`;
  const known = publishes.get(memo);
  if (known !== undefined) return known;
  let artifact: Artifact;
  try {
    artifact = await mavenKind.locate(ctx, entry, pkg, newest);
  } catch (err) {
    // A -SNAPSHOT folder whose metadata has no build of this extension.
    if (err instanceof RegistryError && err.kind === 'not-found') return false;
    throw err;
  }
  const answer = await fetchAnswer(ctx.transport, artifact.url, { signal: ctx.signal, headersOnly: true, allow: [403, 404, 405, 410] });
  // A server that refuses to say is given the benefit of the doubt, and asked again next time.
  if (answer.status === 403 || answer.status === 405) return true;
  const has = answer.status !== 404 && answer.status !== 410;
  if (publishes.size >= MAX_REMEMBERED) publishes.clear();
  publishes.set(memo, has);
  return has;
}

/** Forgets what hasFile found, for tests. */
export function forgetPublished(): void {
  publishes.clear();
}

function foundPackage(entry: RegistryPackage, artifactId: string, versions: string[]): FoundPackage {
  const classifier = entry.classifier ? `:${entry.classifier}` : '';
  return {
    id: `${entry.groupId}:${artifactId}${classifier}${ext(entry) === 'war' ? '' : `@${ext(entry)}`}`,
    name: artifactId,
    coordinates: `${entry.groupId}:${artifactId}${classifier}`,
    versions: versions.map((version) => ({ version, snapshot: isSnapshot(version), artifact: null })),
  };
}

/** Every artifact of a group that has the file the entry asks for. */
async function discover(ctx: RegistryContext, entry: RegistryPackage): Promise<Listing> {
  const matches = versionMatcher(entry.artifactId ?? '');
  const all = (await groupFolders(ctx, entry)).filter(matches).sort();
  const folders = all.slice(0, MAX_GROUP_CHILDREN);
  const looked = await inTurn(folders, async (name): Promise<FoundPackage | null> => {
    const { text, answer } = await fetchText(ctx.transport, `${artifactDir(ctx, entry, name)}/maven-metadata.xml`, {
      signal: ctx.signal,
      maxBytes: 4 * 1024 * 1024,
      allow: [403, 404, 410],
    });
    // No metadata: a group below this one, or a folder something else put there.
    if (answer.status !== 200) return null;
    let meta: ArtifactMetadata;
    try {
      meta = parseArtifactMetadata(text);
    } catch {
      return null;
    }
    if (!meta.versions.length) return null;
    const pkg = foundPackage(entry, name, meta.versions);
    return (await hasFile(ctx, entry, pkg)) ? pkg : null;
  });
  const packages = looked.filter((p): p is FoundPackage => !!p);
  const what = `.${ext(entry)}${entry.classifier ? ` (classifier ${entry.classifier})` : ''}`;
  let hint: string | undefined;
  if (all.length > folders.length) hint = `${entry.groupId} has ${all.length} folders; only the first ${folders.length} were looked into. Narrow the Artifact ID, e.g. shop-*.`;
  else if (!packages.length && folders.length) hint = `${folders.length} folder${folders.length === 1 ? '' : 's'} in ${entry.groupId}${entry.artifactId ? ` matching ${entry.artifactId}` : ''}, but no artifact with a ${what} in its newest version.`;
  else if (!folders.length) hint = `Nothing in ${entry.groupId}${entry.artifactId ? ` matches ${entry.artifactId}` : ''}.`;
  return { packages, hint };
}

export const mavenKind: RegistryKind = {
  type: 'maven',
  ordered: true,

  describe: (entry) => `${entry.groupId}:${entry.artifactId || '*'}${entry.classifier ? `:${entry.classifier}` : ''}`,

  async list(ctx, entry) {
    if (isArtifactPattern(entry.artifactId)) return discover(ctx, entry);
    const artifactId = entry.artifactId ?? '';
    const url = `${artifactDir(ctx, entry, artifactId)}/maven-metadata.xml`;
    let text: string;
    try {
      ({ text } = await fetchText(ctx.transport, url, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024 }));
    } catch (err) {
      if (err instanceof RegistryError && err.kind === 'not-found') {
        err.hint = `No maven-metadata.xml there. Check the group ID and artifact ID, and that the registry’s URL is the repository’s root (the folder that has ${groupPath(entry)[0] || 'com'}/ in it).`;
      }
      throw err;
    }
    return { packages: [foundPackage(entry, artifactId, parseArtifactMetadata(text).versions)] };
  },

  async locate(ctx, entry, pkg, found): Promise<Artifact> {
    // The package's name is its artifact ID, also where the entry names a whole group.
    const dir = `${artifactDir(ctx, entry, pkg.name)}/${encodeURIComponent(found.version)}`;
    const suffix = `${entry.classifier ? `-${entry.classifier}` : ''}.${ext(entry)}`;
    let build: SnapshotBuild = { value: found.version, updated: null };
    if (/-SNAPSHOT$/i.test(found.version)) {
      // Without the folder's metadata (some static repositories), the file is named by the version.
      const { text, answer } = await fetchText(ctx.transport, `${dir}/maven-metadata.xml`, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024, allow: [404] });
      if (answer.status !== 404) build = parseSnapshotMetadata(text, found.version, ext(entry), entry.classifier ?? '');
    }
    const fileName = `${pkg.name}-${build.value}${suffix}`;
    return {
      url: `${dir}/${encodeURIComponent(fileName)}`,
      fileName,
      // Where builds are not kept apart, the time of the last upload tells them apart.
      build: build.value === found.version && build.updated ? `${build.value}@${build.updated}` : build.value,
      modified: build.updated,
      bytes: null,
      checksums: {},
    };
  },

  async checksums(ctx, artifact) {
    for (const hash of SIDECARS) {
      let text: string;
      try {
        const got = await fetchText(ctx.transport, `${artifact.url}.${hash}`, { signal: ctx.signal, maxBytes: 64 * 1024, allow: [404, 410] });
        if (got.answer.status !== 200) continue;
        text = got.text;
      } catch (err) {
        // A repository that guards or lacks one kind of checksum file may still have another.
        if (err instanceof RegistryError && (err.kind === 'forbidden' || err.kind === 'content')) continue;
        throw err;
      }
      const digest = parseChecksum(text, hash);
      if (digest) return { [hash]: digest };
    }
    return {};
  },

  async probe(ctx) {
    // Many repositories do not list their root (403 or 404); a login that is wrong still shows as 401.
    const answer = await fetchAnswer(ctx.transport, ctx.registry.url, { signal: ctx.signal, headersOnly: true, allow: [403, 404] });
    const host = new URL(answer.url).host;
    return answer.status === 200
      ? `Reached ${host}. Add a package to look for.`
      : `Reached ${host}, which does not list the repository’s root (HTTP ${answer.status}). Add a package to see whether its metadata is found.`;
  },
};
