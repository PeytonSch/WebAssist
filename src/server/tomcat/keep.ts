import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { KeepSource, KeptFile } from '../../shared/tomcat';
import { globToRegExp } from '../collectors/tail';
import { checkName, TomcatError } from './webapps';
import { readEntry, readZipIndex, rewriteZip, ZipError, type NewFile, type RewriteResult } from './zip';

/**
 * Keeping local files (config.yaml, config.js…) across a deploy. The user edits them inside the
 * deployed webapp; a new build would overwrite them. They are read from the copy being replaced
 * and written into the new WAR before Tomcat sees it, so the webapp starts with them. Restoring
 * them into the unpacked folder afterwards would race with Tomcat, which deletes and re-creates
 * that folder on redeploy, and with the webapp reading its config as it starts.
 */

/** Folders with nothing worth keeping and often thousands of files. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'bower_components', 'jspm_packages']);
/** Under WEB-INF: libraries (jars), and Tomcat's own work files. */
const SKIP_WEB_INF = new Set(['lib']);
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 24;
const MAX_FILES = 50;
export const MAX_KEPT_BYTES = 5 * 1024 * 1024;

export function keepMatcher(patterns: string[]): (fileName: string) => boolean {
  const res = patterns.filter(Boolean).map(globToRegExp);
  return (fileName) => res.some((re) => re.test(fileName));
}

/** Whether a folder at this path (forward slashes, relative to the webapp) is skipped. */
function skipDir(rel: string): boolean {
  const parts = rel.split('/');
  const last = parts[parts.length - 1].toLowerCase();
  if (SKIP_DIRS.has(last)) return true;
  return parts.length === 2 && parts[0].toUpperCase() === 'WEB-INF' && SKIP_WEB_INF.has(last);
}

/** A relative path that is safe to use as a zip entry name and to join onto a folder. */
function safeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

async function isDir(path: string): Promise<boolean> {
  return (await fs.lstat(path).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(path: string): Promise<boolean> {
  return (await fs.lstat(path).catch(() => null))?.isFile() ?? false;
}

/**
 * The copy of a webapp a deploy replaces: its unpacked folder in webapps (where local edits are
 * made), else its WAR there, else its disabled copy when the deploy brings a disabled webapp back.
 */
export async function findKeepSource(name: string, webappsDir: string, disabledDir: string): Promise<KeepSource | null> {
  if (checkName(name)) return null;
  const places: [KeepSource['where'], string][] = [['webapps', webappsDir]];
  if (disabledDir) places.push(['disabled', disabledDir]);
  for (const [where, dir] of places) {
    if (!dir) continue;
    if (await isDir(join(dir, name))) return { kind: 'folder', path: join(dir, name), where };
    if (await isFile(join(dir, `${name}.war`))) return { kind: 'war', path: join(dir, `${name}.war`), where };
  }
  return null;
}

/**
 * Files in the source whose name matches a pattern, by relative path. Symbolic links are not
 * followed, heavy folders are skipped and the walk is capped, so a huge webapp cannot stall it.
 */
export async function findKeptFiles(source: KeepSource, patterns: string[]): Promise<{ files: KeptFile[]; truncated: boolean }> {
  if (!patterns.length) return { files: [], truncated: false };
  const matches = keepMatcher(patterns);
  return source.kind === 'folder' ? walkFolder(source.path, matches) : listWar(source.path, matches);
}

async function walkFolder(root: string, matches: (n: string) => boolean): Promise<{ files: KeptFile[]; truncated: boolean }> {
  const files: KeptFile[] = [];
  let seen = 0;
  let truncated = false;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const entries = await fs.readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (++seen > MAX_ENTRIES || files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const child = rel ? `${rel}/${e.name}` : e.name;
      // Dirent types come from lstat, so links are neither files nor folders here.
      if (e.isDirectory()) {
        if (!skipDir(child)) await walk(child, depth + 1);
      } else if (e.isFile() && matches(e.name) && safeRel(child)) {
        const st = await fs.lstat(join(root, ...child.split('/'))).catch(() => null);
        if (st?.isFile()) files.push({ path: child, bytes: st.size });
      }
      if (truncated) return;
    }
  };
  await walk('', 0);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}

async function listWar(war: string, matches: (n: string) => boolean): Promise<{ files: KeptFile[]; truncated: boolean }> {
  const { entries } = await readZipIndex(war);
  const files: KeptFile[] = [];
  for (const e of entries) {
    if (e.name.endsWith('/') || !safeRel(e.name)) continue;
    const parts = e.name.split('/');
    if (!matches(parts[parts.length - 1])) continue;
    if (parts.slice(0, -1).some((_, i) => skipDir(parts.slice(0, i + 1).join('/')))) continue;
    if (files.length >= MAX_FILES) return { files, truncated: true };
    files.push({ path: e.name, bytes: e.size });
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated: false };
}

/**
 * Reads the chosen files from the source. Only files the search finds now can be read, so the
 * paths sent by the browser cannot reach anything else.
 */
export async function readKeptFiles(source: KeepSource, patterns: string[], paths: string[]): Promise<NewFile[]> {
  const { files } = await findKeptFiles(source, patterns);
  const found = new Map(files.map((f) => [f.path, f]));
  const out: NewFile[] = [];
  for (const path of [...new Set(paths)]) {
    const f = found.get(path);
    if (!f) throw new TomcatError(`${path} is no longer in ${source.path}. Open the deploy dialog again.`, 409);
    if (f.bytes > MAX_KEPT_BYTES) throw new TomcatError(`${path} is too large to keep (over ${MAX_KEPT_BYTES / 1024 / 1024} MB).`, 413);
    if (source.kind === 'folder') {
      const file = join(source.path, ...path.split('/'));
      const st = await fs.lstat(file);
      if (!st.isFile()) throw new TomcatError(`${path} is no longer a file.`, 409);
      out.push({ name: path, data: await fs.readFile(file), mtime: st.mtime });
    } else {
      const entry = (await readZipIndex(source.path)).entries.find((e) => e.name === path)!;
      out.push({ name: path, data: await readEntry(source.path, entry, MAX_KEPT_BYTES), mtime: new Date() });
    }
  }
  return out;
}

/** Which of these paths the WAR already has (and so would be replaced rather than added). */
export async function warHas(war: string, paths: string[]): Promise<Set<string>> {
  const names = new Set((await readZipIndex(war)).entries.map((e) => e.name));
  return new Set(paths.filter((p) => names.has(p)));
}

/**
 * Writes the new build with the kept files to `dest`. The build may still be changing (a second
 * build started), so its size and time are compared before and after.
 */
export async function writeWarWithKept(src: string, dest: string, files: NewFile[]): Promise<RewriteResult> {
  const before = await fs.stat(src);
  let result: RewriteResult;
  try {
    result = await rewriteZip(src, dest, files);
  } catch (err) {
    if (err instanceof ZipError) {
      throw new TomcatError(`Cannot keep files in this WAR: ${err.message} Deploy it without keeping files.`, 422);
    }
    throw err;
  }
  const after = await fs.stat(src);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new TomcatError('The WAR changed while it was copied. Try again once the build has finished.', 409);
  }
  return result;
}
