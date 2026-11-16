import { randomBytes } from 'node:crypto';
import { promises as fs, type Stats } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The webapps folder as files: listing what is deployed, moving webapps to and from the disabled
 * folder, and copying a WAR in. Tomcat (with autoDeploy, its default) notices these changes on
 * its own within a few seconds.
 */

/** A problem the user can act on; `status` is the HTTP status the API answers with. */
export class TomcatError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface DiskApp {
  name: string;
  hasWar: boolean;
  hasDir: boolean;
  modified: string | null;
  bytes: number | null;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Why a webapp name cannot be used, or null if it can. Names come from the browser and end up in
 * paths, so they are held to what a Tomcat base name looks like: no separators, no "..", nothing
 * hidden, and nothing Windows would refuse.
 */
export function checkName(name: string): string | null {
  if (!name) return 'Enter a name';
  if (name.length > 200) return 'Name is too long';
  if (/[\\/]/.test(name)) return 'Name cannot contain / or \\';
  if (name.includes('..')) return 'Name cannot contain ..';
  if (!/^[\p{L}\p{N}_][\p{L}\p{N}._#~+@()\- ]*$/u.test(name)) {
    return 'Use letters, digits and . _ - # ~ + @ ( ) only, starting with a letter or digit';
  }
  if (/[. ]$/.test(name)) return 'Name cannot end with a dot or space';
  if (RESERVED.test(name)) return `${name} is a reserved name on Windows`;
  return null;
}

/** Tomcat's naming: ROOT is "/", # stands for / and ## starts a version ("api#v2##3" is /api/v2). */
export function contextPath(name: string): string {
  const base = name.replace(/##.*$/, '');
  return base === 'ROOT' ? '/' : `/${base.replace(/#/g, '/')}`;
}

export function versionOf(name: string): string | null {
  const i = name.indexOf('##');
  return i === -1 ? null : name.slice(i + 2) || null;
}

const isWar = (file: string) => /\.war$/i.test(file);

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * What is in a webapps-style folder: exploded folders and .war files, grouped by name. Hidden
 * entries (including this tool's own temporary files), Tomcat's work files and anything else
 * are left out.
 */
export async function listApps(dir: string): Promise<DiskApp[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const apps = new Map<string, DiskApp & { mtime: number }>();
  for (const e of entries) {
    let name: string;
    if (e.isDirectory()) name = e.name;
    else if (e.isFile() && isWar(e.name)) name = e.name.slice(0, -4);
    else continue;
    if (checkName(name)) continue;
    const st = await statOrNull(join(dir, e.name));
    if (!st) continue;
    const app = apps.get(name) ?? { name, hasWar: false, hasDir: false, modified: null, bytes: null, mtime: 0 };
    if (e.isDirectory()) app.hasDir = true;
    else {
      app.hasWar = true;
      app.bytes = st.size;
    }
    if (st.mtimeMs > app.mtime) {
      app.mtime = st.mtimeMs;
      app.modified = st.mtime.toISOString();
    }
    apps.set(name, app);
  }
  return [...apps.values()]
    .map(({ mtime: _m, ...a }) => a)
    .sort((a, b) => (a.name === 'ROOT' ? -1 : b.name === 'ROOT' ? 1 : a.name.localeCompare(b.name)));
}

/** Explains a failed move. Windows keeps files open by a running Tomcat locked. */
function moveError(err: any, what: string): TomcatError {
  const code = err?.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new TomcatError(
      `Could not move ${what}: a file in it is in use. Tomcat probably still holds it open; stop the webapp (or the Tomcat server) and try again.` +
        (err?.partial ? ` (It was ${err.message}.)` : ''),
      409,
    );
  }
  return new TomcatError(`Could not move ${what}: ${err?.message ?? err}`, 500);
}

/**
 * Moves a file or folder without ever replacing something at the target. Moving between drives
 * (EXDEV) falls back to copy then remove; if the original cannot be removed afterwards, the
 * complete copy is kept and the error says so.
 */
export async function moveEntry(from: string, to: string): Promise<void> {
  if (await exists(to)) throw new TomcatError(`${to} already exists. Nothing was moved.`, 409);
  try {
    await fs.rename(from, to);
    return;
  } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
  }
  try {
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  } catch (err) {
    await fs.rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  try {
    await fs.rm(from, { recursive: true });
  } catch (err: any) {
    throw Object.assign(new Error(`copied to ${to}, but the original could not be removed (${err?.code ?? err?.message}); delete it by hand`), { code: err?.code, partial: true });
  }
}

/**
 * Moves a webapp's WAR and its unpacked folder from one folder to another. Both must go: with
 * only the folder moved, Tomcat would unpack the WAR again; with only the WAR moved, it would
 * keep serving the folder.
 *
 * The WAR moves first. Tomcat reacts to a missing WAR by undeploying the webapp and deleting the
 * folder it unpacked, so if the folder is gone by the time it is moved, that is fine. If the
 * folder cannot be moved (locked), the WAR is put back so nothing is left half-moved.
 */
export async function moveApp(name: string, fromDir: string, toDir: string): Promise<{ moved: string[] }> {
  const problem = checkName(name);
  if (problem) throw new TomcatError(problem);
  const war = `${name}.war`;
  const items = [];
  // The WAR's extension may be in another case (APP.WAR); keep it as it is.
  const names = await fs.readdir(fromDir).catch(() => [] as string[]);
  const warName = names.find((n) => n === war) ?? names.find((n) => n.toLowerCase() === war.toLowerCase() && n.slice(0, -4) === name);
  if (warName && (await statOrNull(join(fromDir, warName)))?.isFile()) items.push(warName);
  if ((await statOrNull(join(fromDir, name)))?.isDirectory()) items.push(name);
  if (!items.length) throw new TomcatError(`${name} is not in ${fromDir}`, 404);

  await fs.mkdir(toDir, { recursive: true });
  for (const item of items) {
    if (await exists(join(toDir, item))) {
      throw new TomcatError(`${join(toDir, item)} already exists. Nothing was moved; remove or rename one of them first.`, 409);
    }
  }

  const moved: string[] = [];
  for (const item of items) {
    try {
      await moveEntry(join(fromDir, item), join(toDir, item));
      moved.push(item);
    } catch (err: any) {
      if (err instanceof TomcatError) throw err;
      // Tomcat deleted the unpacked folder after the WAR left: nothing more to move.
      if (err?.code === 'ENOENT' && item === name && moved.length) continue;
      const rollback = await Promise.all(
        moved.map((m) => moveEntry(join(toDir, m), join(fromDir, m)).then(() => null, (e) => m + ': ' + (e?.message ?? e))),
      );
      const failed = rollback.filter(Boolean);
      const e = moveError(err, name);
      if (failed.length) e.message += ` Some files were already moved and could not be moved back: ${failed.join('; ')}`;
      else if (moved.length) e.message += ' Nothing was changed.';
      throw e;
    }
  }
  return { moved };
}

/** Removes a webapp's WAR and folder from a folder, e.g. an old disabled copy replaced by a deploy. */
export async function removeApp(name: string, dir: string): Promise<boolean> {
  const problem = checkName(name);
  if (problem) throw new TomcatError(problem);
  let removed = false;
  for (const item of [`${name}.war`, name]) {
    const path = join(dir, item);
    if (!(await exists(path))) continue;
    try {
      await fs.rm(path, { recursive: true });
      removed = true;
    } catch (err) {
      throw moveError(err, path);
    }
  }
  return removed;
}

/** Tomcat only deploys files ending in .war, so a name that does not is never picked up half-written. */
export function tempWarName(name: string): string {
  return `.${name}.${randomBytes(4).toString('hex')}.debughub-tmp`;
}

export interface DeployResult {
  target: string;
  /** A WAR of the same name was replaced. */
  replaced: boolean;
}

/**
 * Copies a WAR into the webapps folder as <name>.war. The copy goes to a temporary name first
 * and is renamed when complete, so Tomcat never sees half a file. Replacing an existing WAR is
 * the point (Tomcat redeploys it); replacing a folder deployed without a WAR is not, because
 * Tomcat would go on serving the folder.
 */
export async function deployWar(src: string, webappsDir: string, name: string): Promise<DeployResult> {
  const problem = checkName(name);
  if (problem) throw new TomcatError(problem);
  const dirSt = await statOrNull(webappsDir);
  if (!dirSt?.isDirectory()) throw new TomcatError(`The webapps folder was not found: ${webappsDir}`, 404);
  const srcSt = await statOrNull(src);
  if (!srcSt?.isFile()) throw new TomcatError(`The WAR is gone: ${src}`, 404);

  const target = join(webappsDir, `${name}.war`);
  const replaced = !!(await statOrNull(target))?.isFile();
  if (!replaced && (await statOrNull(join(webappsDir, name)))?.isDirectory()) {
    throw new TomcatError(
      `${name} is deployed as a folder without a WAR, and Tomcat would keep serving the folder. Disable ${name} first, then deploy.`,
      409,
    );
  }

  const tmp = join(webappsDir, tempWarName(name));
  try {
    await fs.copyFile(src, tmp);
    // The build may still have been writing; a short copy would deploy a broken WAR.
    const [a, b] = await Promise.all([fs.stat(src), fs.stat(tmp)]);
    if (a.size !== b.size) throw new TomcatError(`${basename(src)} changed while it was copied. Try again once the build has finished.`, 409);
    // A fresh time, so Tomcat sees a change even when deploying an older build.
    const now = new Date();
    await fs.utimes(tmp, now, now);
    await fs.rename(tmp, target);
  } catch (err: any) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    if (err instanceof TomcatError) throw err;
    if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES') {
      throw new TomcatError(`Could not replace ${target}: it is in use. Tomcat probably holds it open; stop the webapp and try again.`, 409);
    }
    if (err?.code === 'ENOSPC') throw new TomcatError(`Not enough disk space to copy ${basename(src)}.`, 507);
    throw new TomcatError(`Could not deploy ${basename(src)}: ${err?.message ?? err}`, 500);
  }
  return { target, replaced };
}

/** "shop-1.4.0-SNAPSHOT" becomes "shop": Maven's default file name is <artifactId>-<version>. */
export function stripVersion(base: string): string {
  const stripped = base.replace(/-\d+(?:\.\d+)*(?:[-.][A-Za-z0-9]+)*$/, '');
  return stripped || base;
}

/**
 * The webapp name a WAR is most likely meant to replace: a deployed or disabled webapp with the
 * WAR's name, with or without its version suffix; otherwise the name without the version.
 */
export function guessTarget(warFile: string, existing: string[]): string {
  const base = basename(warFile).replace(/\.war$/i, '');
  const candidates = [base, stripVersion(base)];
  for (const c of candidates) if (existing.includes(c)) return c;
  for (const c of candidates) {
    const hit = existing.find((e) => e.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  for (const c of [candidates[1], base]) if (!checkName(c)) return c;
  // Characters Tomcat cannot use in a name become dashes; the user can still edit it.
  return candidates[1].replace(/[^\p{L}\p{N}._#~+@()-]+/gu, '-').replace(/^[^\p{L}\p{N}_]+|[. ]+$/gu, '') || 'webapp';
}
