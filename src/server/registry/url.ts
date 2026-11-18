import type { RegistryPackage } from '../../shared/registry';
import { fetchAnswer, RegistryError, type Answer } from './transport';
import { httpTime, type Artifact, type RegistryContext, type RegistryKind } from './types';

/**
 * One fixed URL to a WAR, e.g. a CI server's "last successful build" artifact. There are no
 * versions to list: a new build shows as a change in the file's ETag, Last-Modified or size,
 * read with a HEAD request, or where HEAD is refused (signed download links, some CI servers)
 * with a GET for the first byte only.
 */

/** Statuses that say "not this way" rather than "not here": try GET before giving up. */
const HEAD_REFUSED = [400, 403, 404, 405, 501];

/** The package's address: its own when absolute, else under the registry's URL. */
export function entryUrl(registryUrl: string, entry: RegistryPackage): string {
  const url = (entry.url ?? '').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (!registryUrl) throw new RegistryError(`${url || 'The URL'} is not a complete address, and the registry has no URL for it to be relative to.`, 'config');
  return new URL(url.replace(/^\/+/, ''), `${registryUrl.replace(/\/+$/, '')}/`).toString();
}

/** The file's headers without downloading it. */
async function head(ctx: RegistryContext, url: string): Promise<{ answer: Answer; bytes: number | null }> {
  const viaHead = await fetchAnswer(ctx.transport, url, { method: 'HEAD', signal: ctx.signal, allow: HEAD_REFUSED });
  if (viaHead.status >= 200 && viaHead.status < 300) {
    const n = Number(viaHead.headers['content-length']);
    return { answer: viaHead, bytes: viaHead.headers['content-length'] !== undefined && Number.isFinite(n) ? n : null };
  }
  // The body is not read: a server that ignores Range would send the whole WAR.
  const viaGet = await fetchAnswer(ctx.transport, url, { signal: ctx.signal, headers: [['Range', 'bytes=0-0']], headersOnly: true });
  const total = /\/(\d+)\s*$/.exec(viaGet.headers['content-range'] ?? '')?.[1];
  const n = Number(total ?? (viaGet.status === 200 ? viaGet.headers['content-length'] : NaN));
  return { answer: viaGet, bytes: Number.isFinite(n) ? n : null };
}

/** shop.war from Content-Disposition, else from the address it ended up at, else from the entry's name. */
function fileNameOf(answer: Answer, entry: RegistryPackage): string {
  const cd = answer.headers['content-disposition'] ?? '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd)?.[1];
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/.exec(cd);
  let name = '';
  try {
    name = star ? decodeURIComponent(star) : (plain?.[1] ?? plain?.[2] ?? '');
    if (!name) name = decodeURIComponent(new URL(answer.url).pathname.split('/').pop() ?? '');
  } catch {
    /* an odd name: fall back to the entry's */
  }
  return /\.war$/i.test(name) ? name : `${entry.name || 'download'}.war`;
}

const stamp = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function current(ctx: RegistryContext, entry: RegistryPackage): Promise<{ artifact: Artifact; version: string; changes: boolean }> {
  const url = entryUrl(ctx.registry.url, entry);
  const { answer, bytes } = await head(ctx, url);
  if (/^text\/html/i.test(answer.headers['content-type'] ?? '')) {
    throw new RegistryError(`${answer.url} answers with a web page, not a WAR.`, 'content', answer.status, 'It may be a login page: check the login, or open the address in a browser to see what it shows.');
  }
  const etag = (answer.headers.etag ?? '').replace(/^W\//, '').replace(/"/g, '');
  const modified = httpTime(answer.headers['last-modified']);
  const changes = !!(etag || modified || bytes !== null);
  const version = modified ? `build ${stamp(modified)}` : etag ? `build ${etag.slice(0, 12)}` : 'current';
  return {
    version,
    changes,
    artifact: { url, fileName: fileNameOf(answer, entry), build: [etag, modified ?? '', bytes ?? ''].join('|'), modified, bytes, checksums: {} },
  };
}

export const urlKind: RegistryKind = {
  type: 'url',
  ordered: false,

  describe: (entry) => entry.name || entry.url || 'URL',

  async list(ctx, entry) {
    const { artifact, version, changes } = await current(ctx, entry);
    const name = entry.name || artifact.fileName.replace(/\.war$/i, '');
    return {
      packages: [{ id: `url:${entry.name || entry.url}`, name, coordinates: artifact.url.replace(/^https?:\/\//, '').replace(/\?.*$/, ''), versions: [{ version, snapshot: false, artifact }] }],
      hint: changes ? undefined : 'The server gives no ETag, Last-Modified or size for this file, so a new build cannot be told from the old one. Download & deploy still fetches the current file.',
    };
  },

  // Asked again rather than taken from the listing: the file may have been rebuilt since.
  locate: async (ctx, entry) => (await current(ctx, entry)).artifact,

  async probe() {
    return 'Add a URL to check.';
  },
};
