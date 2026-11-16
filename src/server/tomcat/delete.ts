import { promises as fs, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DeleteItem } from '../../shared/tomcat';
import { checkName, TomcatError } from './webapps';

/**
 * Deleting a webapp for good: its WAR and its unpacked folder, from webapps or from the disabled
 * folder. Nothing outside that folder is touched: names are checked, every path must sit
 * directly in the folder, and symbolic links (and Windows junctions) are removed as links, never
 * followed, wherever they are in the webapp.
 */

/** Stops counting a huge folder for the confirmation; the count is then shown as "at least". */
const MAX_COUNT = 200_000;
/** Windows refuses to delete a file another program has open. */
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

const isLocked = (err: any) => LOCKED.has(err?.code);

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Files and bytes under a folder, without following links. */
async function measure(path: string): Promise<{ bytes: number; files: number; partial: boolean }> {
  let bytes = 0;
  let files = 0;
  let seen = 0;
  const stack = [path];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > MAX_COUNT) return { bytes, files, partial: true };
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        files += 1;
        if (e.isFile()) bytes += (await lstatOrNull(p).catch(() => null))?.size ?? 0;
      }
    }
  }
  return { bytes, files, partial: false };
}

/** The WAR's file name as it is on disk; its extension may be in another case (APP.WAR). */
function warName(names: string[], name: string): string | undefined {
  const war = `${name}.war`;
  return names.find((n) => n === war) ?? names.find((n) => n.toLowerCase() === war.toLowerCase() && n.slice(0, -4) === name);
}

/**
 * What deleting a webapp from `dir` would remove: its WAR and its unpacked folder, with sizes.
 * Only entries whose names on disk are exactly the webapp's are included.
 */
export async function planDelete(name: string, dir: string): Promise<DeleteItem[]> {
  const problem = checkName(name);
  if (problem) throw new TomcatError(`Not a webapp name: ${problem}`);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    throw new TomcatError(`The folder was not found: ${dir}`, 404);
  }
  const base = resolve(dir);
  const items: DeleteItem[] = [];
  for (const entry of [warName(names, name), names.includes(name) ? name : undefined]) {
    if (!entry) continue;
    const path = join(dir, entry);
    // checkName already rules out separators and "..", so this cannot fail; it is the last guard.
    if (dirname(resolve(path)) !== base) throw new TomcatError(`Refusing to delete ${path}: it is not directly in ${dir}.`);
    const st = await lstatOrNull(path);
    if (!st) continue;
    if (st.isSymbolicLink()) items.push({ name: entry, path, kind: 'link', bytes: 0, files: 0, partial: false });
    else if (st.isDirectory() && entry === name) items.push({ name: entry, path, kind: 'folder', ...(await measure(path)) });
    else if (st.isFile() && entry !== name) items.push({ name: entry, path, kind: 'war', bytes: st.size, files: 1, partial: false });
  }
  // The WAR first: see deleteApp.
  return items.sort((a, b) => (a.kind === 'folder' ? 1 : 0) - (b.kind === 'folder' ? 1 : 0));
}

/** Runs fs work again while Windows reports the file in use, until the deadline. */
async function retry(work: () => Promise<void>, deadline: number): Promise<void> {
  for (let wait = 50; ; wait = Math.min(wait * 2, 1000)) {
    try {
      return await work();
    } catch (err: any) {
      if (err?.code === 'ENOENT') return; // Tomcat removed it meanwhile.
      if (!isLocked(err) || Date.now() + wait > deadline) throw err;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Removes a file or a link. A link to a folder on Windows (or a junction) is removed with rmdir. */
async function removeOne(path: string, st: Stats): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err: any) {
    if (st.isSymbolicLink() && (err?.code === 'EPERM' || err?.code === 'EISDIR')) return fs.rmdir(path);
    // Read-only files cannot be deleted on Windows until they are writable.
    if (err?.code === 'EPERM' && process.platform === 'win32' && st.isFile()) {
      await fs.chmod(path, 0o666);
      return fs.unlink(path);
    }
    throw err;
  }
}

/** Deletes a folder's contents and then the folder, never following links. Failures carry the path. */
async function removeTree(path: string, deadline: number): Promise<void> {
  const st = await lstatOrNull(path);
  if (!st) return;
  try {
    if (!st.isDirectory()) return await retry(() => removeOne(path, st), deadline);
    const names = await fs.readdir(path).catch((err) => (err?.code === 'ENOENT' ? [] : Promise.reject(err)));
    for (const n of names) await removeTree(join(path, n), deadline);
    await retry(() => fs.rmdir(path), deadline);
  } catch (err: any) {
    if (err && !err.failedPath) err.failedPath = path;
    throw err;
  }
}

function describe(item: DeleteItem, what: { bytes: number; files: number; partial: boolean } = item): string {
  if (item.kind === 'war') return `${item.path} (${fmtBytes(what.bytes)})`;
  if (item.kind === 'link') return `${item.path} (a link)`;
  return `${item.path} (${what.partial ? 'at least ' : ''}${what.files} file${what.files === 1 ? '' : 's'}, ${fmtBytes(what.bytes)})`;
}

export interface DeleteOptions {
  /** The entry names the user confirmed; the delete is refused if what is there now differs. */
  expected?: string[];
  /** How long to keep retrying a file Windows reports in use. */
  waitMs?: number;
  /**
   * The folder is Tomcat's webapps folder. Once the WAR is gone, a running Tomcat undeploys the
   * webapp within its check interval (10 s by default), which lets go of its files, so a locked
   * folder is retried for longer.
   */
  tomcatWatches?: boolean;
}

/** Tomcat's default autoDeploy check interval, plus time to undeploy. */
const TOMCAT_UNDEPLOY_MS = 12_000;

/**
 * Deletes a webapp's WAR, then its folder. In that order because Tomcat unpacks a WAR whose
 * folder is missing: deleting the folder first would bring it straight back. With the WAR gone,
 * a running Tomcat undeploys the webapp and may delete the folder itself, which is fine.
 *
 * A failure part way says exactly what was deleted and what is still there.
 */
export async function deleteApp(name: string, dir: string, opts: DeleteOptions = {}): Promise<{ deleted: DeleteItem[] }> {
  const items = await planDelete(name, dir);
  if (!items.length) throw new TomcatError(`${name} is not in ${dir}`, 404);
  if (opts.expected) {
    const now = items.map((i) => i.name).sort().join('\n');
    if (now !== [...opts.expected].sort().join('\n')) {
      throw new TomcatError(`${name} changed since you chose to delete it: it is now ${items.map((i) => i.name).join(' and ')}. Nothing was deleted; check and try again.`, 409);
    }
  }
  const deleted: DeleteItem[] = [];
  for (const item of items) {
    const undeploys = opts.tomcatWatches && deleted.some((d) => d.kind === 'war');
    const deadline = Date.now() + (undeploys ? TOMCAT_UNDEPLOY_MS : (opts.waitMs ?? 2000));
    try {
      await removeTree(item.path, deadline);
      deleted.push(item);
    } catch (err: any) {
      const rest = items.slice(deleted.length);
      const left = await Promise.all(
        rest.map(async (i) => {
          const st = await lstatOrNull(i.path).catch(() => null);
          if (!st) return null;
          return describe(i, i.kind === 'folder' ? await measure(i.path) : i);
        }),
      );
      const stillThere = left.filter(Boolean);
      const where = err?.failedPath && err.failedPath !== item.path ? ` (${err.failedPath})` : '';
      const why = isLocked(err)
        ? `a file in it is in use${where}. Tomcat probably still has it open; stop the webapp (or Tomcat) first, then delete again.`
        : `${err?.message ?? err}`;
      const done = deleted.length ? `Deleted ${deleted.map((d) => d.path).join(' and ')}.` : 'Nothing was deleted.';
      const rem = stillThere.length ? ` Still there: ${stillThere.join('; ')}.` : '';
      throw Object.assign(new TomcatError(`Could not delete ${item.path}: ${why} ${done}${rem}`, isLocked(err) ? 409 : 500), {
        deleted: deleted.map((d) => d.path),
      });
    }
  }
  return { deleted };
}
