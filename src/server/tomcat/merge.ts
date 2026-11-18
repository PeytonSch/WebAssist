import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { compareKeys, countKeys, fileKind, readKeys } from '../../shared/configkeys';
import { diffLines, lineCounts } from '../../shared/diff';
import { MAX_LISTED_KEYS, MERGE_MAX_BYTES, MERGE_MAX_LINES, type KeepCompare, type MergedInput, type MergeFile, type MergeSide } from '../../shared/keepmerge';
import type { KeepSource, KeptFile } from '../../shared/tomcat';
import { decodeText, encodeText, splitLines, type DecodedText } from '../../shared/textformat';
import { MAX_KEPT_BYTES, readKeptFiles } from './keep';
import { TomcatError } from './webapps';
import { readEntry, readZipIndex, ZipError, type NewFile, type ZipIndex } from './zip';

/**
 * Comparing and merging kept files. A kept file used to win as a whole; a new build may bring
 * settings the deployed copy does not have, so each kept file is compared with the build's file
 * of the same path, and the deploy can write a merge of the two into the WAR instead of either.
 *
 * Paths are checked the way readKeptFiles checks them: only files the search for kept files
 * finds now can be read or replaced, never a path taken from the request as it is.
 */

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const hashOf = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** The build's file at this path, or null when the WAR has none. */
async function readBuild(war: string, path: string, index?: ZipIndex): Promise<Buffer | null> {
  const entry = (index ?? (await readZipIndex(war))).entries.find((e) => e.name === path);
  return entry ? readEntry(war, entry, MAX_KEPT_BYTES) : null;
}

/** One of the files the search found, from the copy being replaced. */
async function readFound(source: KeepSource, path: string, index?: ZipIndex): Promise<Buffer> {
  if (source.kind === 'folder') {
    const file = join(source.path, ...path.split('/'));
    if (!(await fs.lstat(file)).isFile()) throw new TomcatError(`${path} is no longer a file.`, 409);
    return fs.readFile(file);
  }
  const entry = (index ?? (await readZipIndex(source.path))).entries.find((e) => e.name === path);
  if (!entry) throw new TomcatError(`${path} is no longer in ${source.path}.`, 409);
  return readEntry(source.path, entry, MAX_KEPT_BYTES);
}

const base = (kind: KeepCompare['kind']): KeepCompare => ({ status: 'differs', kind, keepable: true, mergeable: false, reason: null, formatOnly: false, lines: null, keys: null });

/** How the deployed copy of a file compares with the build's (null: the build has none). */
export function compareVersions(path: string, deployed: Uint8Array, build: Uint8Array | null): KeepCompare {
  const out = base(fileKind(path));
  if (!build) return { ...out, status: 'only-deployed', reason: 'The new build has no file here.' };
  if (deployed.length === build.length && Buffer.compare(deployed, build) === 0) return { ...out, status: 'identical' };
  if (deployed.length > MERGE_MAX_BYTES || build.length > MERGE_MAX_BYTES) {
    return { ...out, reason: `Too large to compare and merge (${mb(Math.max(deployed.length, build.length))}; the limit is ${mb(MERGE_MAX_BYTES)}).` };
  }
  const d = decodeText(deployed);
  const b = decodeText(build);
  if ('problem' in d) return { ...out, reason: `The deployed copy cannot be merged: ${d.problem}` };
  if ('problem' in b) return { ...out, reason: `The new build's file cannot be merged: ${b.problem}` };
  const dl = splitLines(d.text);
  const bl = splitLines(b.text);
  if (dl.length > MERGE_MAX_LINES || bl.length > MERGE_MAX_LINES) {
    return { ...out, reason: `Too long to merge (${Math.max(dl.length, bl.length).toLocaleString('en-US')} lines).` };
  }
  out.mergeable = true;
  out.lines = lineCounts(diffLines(dl, bl, { coarse: true }));
  out.formatOnly = d.text === b.text;
  const mine = readKeys(d.text, out.kind);
  const theirs = readKeys(b.text, out.kind);
  if (mine && theirs) {
    const delta = compareKeys(mine, theirs, out.kind);
    const cut = (v: string) => (v.length > 200 ? `${v.slice(0, 200)}…` : v);
    out.keys = {
      added: delta.added.slice(0, MAX_LISTED_KEYS).map((c) => (c.value === undefined ? c : { ...c, value: cut(c.value) })),
      addedCount: countKeys(delta.added),
      removed: delta.removed.slice(0, MAX_LISTED_KEYS).map((c) => (c.value === undefined ? c : { ...c, value: cut(c.value) })),
      removedCount: countKeys(delta.removed),
      changed: delta.changed.slice(0, MAX_LISTED_KEYS).map((c) => ({ ...c, from: cut(c.from), to: cut(c.to) })),
      changedCount: delta.changed.length,
    };
  }
  return out;
}

/** Compares each kept-file candidate with the new WAR's file of the same path. */
export async function compareKept(source: KeepSource, war: string, files: KeptFile[]): Promise<Record<string, KeepCompare>> {
  const out: Record<string, KeepCompare> = {};
  const warIndex = await readZipIndex(war);
  const sourceIndex = source.kind === 'war' ? await readZipIndex(source.path) : undefined;
  for (const f of files) {
    const kind = fileKind(f.path);
    const entry = warIndex.entries.find((e) => e.name === f.path);
    if (f.bytes > MAX_KEPT_BYTES) {
      out[f.path] = { ...base(kind), status: entry ? 'differs' : 'only-deployed', keepable: false, reason: `Too large to keep (${mb(f.bytes)}; the limit is ${mb(MAX_KEPT_BYTES)}).` };
      continue;
    }
    if (entry && entry.size > MAX_KEPT_BYTES) {
      out[f.path] = { ...base(kind), reason: `The new build's file is too large to compare (${mb(entry.size)}).` };
      continue;
    }
    try {
      out[f.path] = compareVersions(f.path, await readFound(source, f.path, sourceIndex), entry ? await readEntry(war, entry, MAX_KEPT_BYTES) : null);
    } catch (err) {
      if (!(err instanceof ZipError) && !(err instanceof TomcatError) && !(err as NodeJS.ErrnoException)?.code) throw err;
      out[f.path] = { ...base(kind), status: entry ? 'differs' : 'only-deployed', reason: `Could not be compared: ${(err as Error).message}` };
    }
  }
  return out;
}

function side(data: Uint8Array, text: DecodedText): MergeSide {
  return { text: text.text, format: text.format, hash: hashOf(data), bytes: data.length };
}

/** Both versions of one kept file as text, for the merge view. */
export async function readMergeFile(source: KeepSource, patterns: string[], war: string, path: string): Promise<MergeFile> {
  const [kept] = await readKeptFiles(source, patterns, [path]);
  const build = await readBuild(war, path);
  if (!build) throw new TomcatError(`${basename(war)} has no ${path} to merge with. Keeping the deployed copy adds it.`, 409);
  if (kept.data.length > MERGE_MAX_BYTES || build.length > MERGE_MAX_BYTES) {
    throw new TomcatError(`${path} is too large to merge (${mb(Math.max(kept.data.length, build.length))}; the limit is ${mb(MERGE_MAX_BYTES)}). Keep the deployed copy or use the new build's.`, 413);
  }
  const d = decodeText(kept.data);
  const b = decodeText(build);
  if ('problem' in d) throw new TomcatError(`The deployed ${path} cannot be merged: ${d.problem}`, 422);
  if ('problem' in b) throw new TomcatError(`The new build's ${path} cannot be merged: ${b.problem}`, 422);
  return { path, kind: fileKind(path), deployed: side(kept.data, d), build: side(build, b) };
}

/**
 * The merged files as they go into the WAR: each merged text stored the way the deployed copy
 * is (line endings, byte order mark, encoding). Refuses a merge whose deployed copy or build
 * file changed since the merge view read them, since it was made from other content.
 */
export async function mergedFiles(source: KeepSource, patterns: string[], war: string, merged: MergedInput[]): Promise<NewFile[]> {
  const out: NewFile[] = [];
  const seen = new Set<string>();
  for (const m of merged) {
    if (seen.has(m.path)) throw new TomcatError(`${m.path} is merged twice in this deploy.`);
    seen.add(m.path);
    if (m.text.length > 2 * MERGE_MAX_BYTES) throw new TomcatError(`The merged ${m.path} is too large (over ${mb(2 * MERGE_MAX_BYTES)}).`, 413);
    const [kept] = await readKeptFiles(source, patterns, [m.path]);
    if (m.deployedHash !== undefined && hashOf(kept.data) !== m.deployedHash) {
      throw new TomcatError(`${m.path} changed in the deployed copy after it was merged. Open the merge again.`, 409);
    }
    if (m.buildHash !== undefined) {
      const build = await readBuild(war, m.path);
      if (!build || hashOf(build) !== m.buildHash) {
        throw new TomcatError(`${m.path} in ${basename(war)} changed after it was merged (the WAR was built again). Open the merge again.`, 409);
      }
    }
    const d = decodeText(kept.data);
    if ('problem' in d) throw new TomcatError(`The deployed ${m.path} cannot be merged: ${d.problem}`, 422);
    const data = encodeText(m.text, d.format);
    if ('problem' in data) throw new TomcatError(`${m.path}: ${data.problem}`, 422);
    out.push({ name: m.path, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), mtime: new Date() });
  }
  return out;
}
