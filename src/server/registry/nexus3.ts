import { REGISTRY_DEFAULTS, type RegistryPackage } from '../../shared/registry';
import { fetchText, RegistryError, type HashName } from './transport';
import { httpTime, joinUrl, type Artifact, type FoundPackage, type FoundVersion, type Listing, type RegistryContext, type RegistryKind } from './types';
import { baseVersion, compareVersions, isSnapshot } from './version';

/**
 * Nexus Repository 3, through its search API (GET /service/rest/v1/search/assets). Unlike the
 * Maven layout, a search finds every WAR in a repository without each being listed in Settings,
 * gives sizes, dates and checksums along with the listing, and also covers raw repositories,
 * which have no Maven metadata at all.
 */

interface Asset {
  path?: string;
  downloadUrl?: string;
  repository?: string;
  format?: string;
  checksum?: Record<string, string>;
  lastModified?: string;
  fileSize?: number;
  maven2?: { groupId?: string; artifactId?: string; version?: string; baseVersion?: string; classifier?: string; extension?: string };
}

/** Nexus answers 50 assets a page; this many pages is 10,000 assets. */
const MAX_PAGES = 200;

const ext = (entry: RegistryPackage) => entry.extension || REGISTRY_DEFAULTS.extension;

function searchUrl(base: string, entry: RegistryPackage, token: string | null): string {
  const q = new URLSearchParams();
  if (entry.repository) q.set('repository', entry.repository);
  if (entry.group) q.set('group', entry.group);
  if (entry.name) q.set('name', entry.name);
  for (const [k, v] of new URLSearchParams(entry.params ?? '')) q.set(k, v);
  if (token) q.set('continuationToken', token);
  return `${base.replace(/\/+$/, '')}/service/rest/v1/search/assets?${q}`;
}

/** Why a path that does exist on Nexus 3 was not found: most often it is not Nexus 3. */
function notNexus3(err: unknown): unknown {
  if (err instanceof RegistryError && err.kind === 'not-found') {
    err.hint = 'There is no Nexus 3 search API at this address. The URL should be the server itself (e.g. https://nexus.example.com, or with its context path), not a repository. For Nexus 2 or another server, use the Maven repository type.';
  }
  return err;
}

function parsePage(text: string, url: string): { items: Asset[]; continuationToken: string | null } {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RegistryError(
      `The answer from ${url.replace(/\?.*$/, '')} is not JSON${/^\s*</.test(text) ? ' but a web page, perhaps a login page' : ''}.`,
      'content',
      0,
      'Check that the URL is the Nexus 3 server and that the login is right.',
    );
  }
  if (!data || !Array.isArray(data.items)) throw new RegistryError('The answer has no list of assets: is this Nexus Repository 3?', 'content');
  return { items: data.items, continuationToken: typeof data.continuationToken === 'string' && data.continuationToken ? data.continuationToken : null };
}

/**
 * shop-1.4.0-SNAPSHOT.war in a raw repository: the name up to the first - _ or . before a version
 * (digits, or v and digits, then a separator or the end), and the rest as its version. So
 * shop_1.4.0 and shop-v1.4 are versions of shop, while app-2fa is a name.
 */
export function splitFileName(base: string): { name: string; version: string | null } {
  const m = /^(.+?)[-_.](v?\d+(?:[._-].*)?)$/i.exec(base);
  return m ? { name: m[1], version: m[2] } : { name: base, version: null };
}

interface Hit {
  group: string;
  name: string;
  version: string;
  repository: string;
  artifact: Artifact;
}

/** One asset as a version of a package, or null when it is not what the entry asks for. */
function toHit(base: string, entry: RegistryPackage, a: Asset): Hit | null {
  const path = (a.path ?? '').replace(/^\/+/, '');
  if (!path || !path.toLowerCase().endsWith(`.${ext(entry).toLowerCase()}`)) return null;
  const fileName = path.split('/').pop()!;
  const stem = fileName.slice(0, -(ext(entry).length + 1));
  const repository = a.repository || entry.repository || '';
  const classifier = entry.classifier ?? '';
  let group: string;
  let name: string;
  let version: string;
  let build: string;
  if (a.maven2?.artifactId && a.maven2.version) {
    if ((a.maven2.classifier ?? '') !== classifier) return null;
    group = a.maven2.groupId ?? '';
    name = a.maven2.artifactId;
    build = a.maven2.version;
    version = a.maven2.baseVersion || baseVersion(build);
  } else {
    // A raw repository: all there is to go on is the path.
    if (classifier && !stem.endsWith(`-${classifier}`)) return null;
    const split = splitFileName(classifier ? stem.slice(0, -(classifier.length + 1)) : stem);
    group = path.split('/').slice(0, -1).join('/');
    name = split.name;
    // A file that is overwritten in place has no version: its date stands in for one.
    version = split.version ?? (a.lastModified ? `build ${a.lastModified.slice(0, 16).replace('T', ' ')}` : 'current');
    build = `${version}@${a.checksum?.sha1 ?? a.lastModified ?? ''}`;
  }
  const checksums: Partial<Record<HashName, string>> = {};
  for (const hash of ['sha512', 'sha256', 'sha1', 'md5'] as const) {
    const value = a.checksum?.[hash];
    if (typeof value === 'string' && value) checksums[hash] = value.toLowerCase();
  }
  return {
    group,
    name,
    version,
    repository,
    artifact: {
      // Built from the registry's own URL rather than taken from downloadUrl: a Nexus whose base
      // URL setting names another host would otherwise send the download, and the login, there.
      url: joinUrl(base, 'repository', repository, path),
      fileName,
      build,
      modified: httpTime(a.lastModified),
      bytes: typeof a.fileSize === 'number' ? a.fileSize : null,
      checksums,
    },
  };
}

export const nexus3Kind: RegistryKind = {
  type: 'nexus3',
  ordered: true,

  describe: (entry) => {
    const what = [entry.group, entry.name].filter(Boolean).join(':');
    return what ? `${what} in ${entry.repository}` : `every .${ext(entry)} in ${entry.repository}`;
  },

  async list(ctx, entry): Promise<Listing> {
    const base = ctx.registry.url;
    const packages = new Map<string, FoundPackage & { byVersion: Map<string, FoundVersion> }>();
    let token: string | null = null;
    let pages = 0;
    let assets = 0;
    let hits = 0;
    let maven = false;
    let cut = false;
    do {
      const url = searchUrl(base, entry, token);
      let page;
      try {
        const { text, answer } = await fetchText(ctx.transport, url, { signal: ctx.signal, maxBytes: 16 * 1024 * 1024 });
        page = parsePage(text, answer.url);
      } catch (err) {
        throw notNexus3(err);
      }
      pages++;
      assets += page.items.length;
      for (const a of page.items) {
        if (a.maven2) maven = true;
        const hit = toHit(base, entry, a);
        if (!hit) continue;
        hits++;
        const id = `${hit.repository}/${hit.group ? `${hit.group}:` : ''}${hit.name}${entry.classifier ? `:${entry.classifier}` : ''}`;
        let pkg = packages.get(id);
        if (!pkg) {
          pkg = { id, name: hit.name, coordinates: `${hit.group ? `${hit.group}:` : ''}${hit.name} in ${hit.repository}`, versions: [], byVersion: new Map() };
          packages.set(id, pkg);
        }
        // Several builds of one SNAPSHOT: the newest stands for the version.
        const prev = pkg.byVersion.get(hit.version);
        if (!prev || newer(hit.artifact, prev.artifact!)) pkg.byVersion.set(hit.version, { version: hit.version, snapshot: isSnapshot(hit.version), artifact: hit.artifact });
      }
      token = page.continuationToken;
      if (token && pages >= MAX_PAGES) cut = true;
    } while (token && !cut);

    const hints: string[] = [];
    if (cut) hints.push(`The search was stopped after ${assets.toLocaleString('en-US')} files; there are more. Narrow it with a group or name.`);
    // Without a filter, Nexus also lists every pom, jar and checksum file.
    if (maven && pages > 2 && hits * 4 < assets && !/(^|&)maven\.extension=/.test(entry.params ?? '')) {
      hints.push(`Only ${hits} of ${assets.toLocaleString('en-US')} files found were .${ext(entry)} files. Add maven.extension=${ext(entry)} to the extra search parameters to make checks faster.`);
    }
    return {
      packages: [...packages.values()].map(({ byVersion, ...pkg }) => ({ ...pkg, versions: [...byVersion.values()] })),
      hint: hints.join(' ') || undefined,
    };
  },

  async locate(_ctx, _entry, pkg, found) {
    if (found.artifact) return found.artifact;
    throw new RegistryError(`${pkg.coordinates} ${found.version} is no longer in the search results. Check again.`, 'not-found');
  },

  async probe(ctx) {
    const url = `${ctx.registry.url.replace(/\/+$/, '')}/service/rest/v1/repositories`;
    let text: string;
    try {
      ({ text } = await fetchText(ctx.transport, url, { signal: ctx.signal, maxBytes: 4 * 1024 * 1024 }));
    } catch (err) {
      throw notNexus3(err);
    }
    let repos: { name?: string; format?: string; type?: string }[];
    try {
      repos = JSON.parse(text);
      if (!Array.isArray(repos)) throw new Error('not a list');
    } catch {
      throw new RegistryError('The answer is not a list of repositories: is this Nexus Repository 3?', 'content');
    }
    const names = repos.filter((r) => r.name).map((r) => `${r.name}${r.format ? ` (${r.format}${r.type ? `, ${r.type}` : ''})` : ''}`);
    const shown = names.slice(0, 12).join(', ') + (names.length > 12 ? ` and ${names.length - 12} more` : '');
    return names.length
      ? `Connected to Nexus 3. ${names.length} ${names.length === 1 ? 'repository' : 'repositories'} can be seen: ${shown}. Add a search to look for WARs.`
      : 'Connected to Nexus 3, but this login sees no repositories.';
  },
};

/** Whether `a` is a later build of the same version than `b`. */
function newer(a: Artifact, b: Artifact): boolean {
  if (a.modified && b.modified && a.modified !== b.modified) return a.modified > b.modified;
  return compareVersions(a.build, b.build) > 0;
}
