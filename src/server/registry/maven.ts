import { REGISTRY_DEFAULTS, type RegistryPackage } from '../../shared/registry';
import { fetchAnswer, fetchText, RegistryError, type HashName } from './transport';
import { joinUrl, mavenTime, type Artifact, type FoundPackage, type FoundVersion, type RegistryContext, type RegistryKind } from './types';
import { isSnapshot } from './version';

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

function artifactDir(ctx: RegistryContext, entry: RegistryPackage): string {
  return joinUrl(ctx.registry.url, ...groupPath(entry), entry.artifactId ?? '');
}

/** Sidecar files, strongest first. A repository has at least one of the last two. */
const SIDECARS: HashName[] = ['sha256', 'sha1', 'md5'];

export const mavenKind: RegistryKind = {
  type: 'maven',
  ordered: true,

  describe: (entry) => `${entry.groupId}:${entry.artifactId}${entry.classifier ? `:${entry.classifier}` : ''}`,

  async list(ctx, entry) {
    const url = `${artifactDir(ctx, entry)}/maven-metadata.xml`;
    let text: string;
    try {
      ({ text } = await fetchText(ctx.transport, url, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024 }));
    } catch (err) {
      if (err instanceof RegistryError && err.kind === 'not-found') {
        err.hint = `No maven-metadata.xml there. Check the group ID and artifact ID, and that the registry’s URL is the repository’s root (the folder that has ${groupPath(entry)[0] || 'com'}/ in it).`;
      }
      throw err;
    }
    const meta = parseArtifactMetadata(text);
    const versions: FoundVersion[] = meta.versions.map((version) => ({ version, snapshot: isSnapshot(version), artifact: null }));
    const pkg: FoundPackage = {
      id: `${entry.groupId}:${entry.artifactId}${entry.classifier ? `:${entry.classifier}` : ''}${ext(entry) === 'war' ? '' : `@${ext(entry)}`}`,
      name: entry.artifactId ?? '',
      coordinates: mavenKind.describe(entry),
      versions,
    };
    return { packages: [pkg] };
  },

  async locate(ctx, entry, _pkg, found): Promise<Artifact> {
    const dir = `${artifactDir(ctx, entry)}/${encodeURIComponent(found.version)}`;
    const suffix = `${entry.classifier ? `-${entry.classifier}` : ''}.${ext(entry)}`;
    let build: SnapshotBuild = { value: found.version, updated: null };
    if (/-SNAPSHOT$/i.test(found.version)) {
      // Without the folder's metadata (some static repositories), the file is named by the version.
      const { text, answer } = await fetchText(ctx.transport, `${dir}/maven-metadata.xml`, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024, allow: [404] });
      if (answer.status !== 404) build = parseSnapshotMetadata(text, found.version, ext(entry), entry.classifier ?? '');
    }
    const fileName = `${entry.artifactId}-${build.value}${suffix}`;
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
