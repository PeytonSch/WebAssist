import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Just enough of the zip format to read files out of a WAR and to write a copy of a WAR with
 * some files replaced or added, without a zip library. Entries that do not change are copied as
 * they are, compressed bytes and all, so the copy is as good as the original; only their local
 * headers are rebuilt, from the central directory, which always has the sizes and CRC (a
 * streamed build puts them after the data instead, in a "data descriptor" this copy leaves out).
 *
 * ZIP64 (over 4 GB or 65535 entries) and encrypted entries are refused rather than half handled.
 */

export class ZipError extends Error {}

export interface ZipEntry {
  /** As stored; zip and Java use UTF-8 for names. Directories end in "/". */
  name: string;
  rawName: Buffer;
  versionMadeBy: number;
  versionNeeded: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  extra: Buffer;
  comment: Buffer;
  internalAttrs: number;
  externalAttrs: number;
  localOffset: number;
}

export interface ZipIndex {
  entries: ZipEntry[];
  comment: Buffer;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const CHUNK = 1024 * 1024;

// ── CRC-32 ──────────────────────────────────────────────
// zlib.crc32 only exists from Node 20.15/22.2; Debug Hub supports Node 18.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ── Reading ─────────────────────────────────────────────

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (!bytesRead) throw new ZipError('The file ends early; it is not a complete zip.');
    done += bytesRead;
  }
  return buf;
}

/** Finds the end-of-central-directory record: 22 bytes plus a comment of up to 64 kB, at the very end. */
function findEocd(tail: Buffer): number {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD && i + 22 + tail.readUInt16LE(i + 20) === tail.length) return i;
  }
  // Some tools leave junk after the comment; take the last signature then.
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

const ZIP64_MESSAGE = 'It is a ZIP64 archive (over 4 GB or 65535 files), which Debug Hub cannot rewrite.';

async function readIndexFrom(handle: FileHandle): Promise<ZipIndex> {
  const { size } = await handle.stat();
  if (size < 22) throw new ZipError('The file is too small to be a zip.');
  const tailLen = Math.min(size, 22 + MAX_U16);
  const tailStart = size - tailLen;
  const tail = await readAt(handle, tailStart, tailLen);
  const at = findEocd(tail);
  if (at === -1) throw new ZipError('No zip directory found; the file is not a complete zip.');
  if (at >= 20 && tail.readUInt32LE(at - 20) === SIG_ZIP64_LOCATOR) throw new ZipError(ZIP64_MESSAGE);
  const disk = tail.readUInt16LE(at + 4);
  const cdDisk = tail.readUInt16LE(at + 6);
  const countHere = tail.readUInt16LE(at + 8);
  const count = tail.readUInt16LE(at + 10);
  const cdSize = tail.readUInt32LE(at + 12);
  const cdOffset = tail.readUInt32LE(at + 16);
  const comment = Buffer.from(tail.subarray(at + 22, at + 22 + tail.readUInt16LE(at + 20)));
  if (count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new ZipError(ZIP64_MESSAGE);
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new ZipError('It is a split (multi-part) zip.');
  if (cdOffset + cdSize > tailStart + at) throw new ZipError('The zip directory points past the end of the file.');

  const cd = await readAt(handle, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('The zip directory is damaged.');
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > cd.length) throw new ZipError('The zip directory is damaged.');
    const rawName = Buffer.from(cd.subarray(p + 46, p + 46 + nameLen));
    const entry: ZipEntry = {
      name: rawName.toString('utf8'),
      rawName,
      versionMadeBy: cd.readUInt16LE(p + 4),
      versionNeeded: cd.readUInt16LE(p + 6),
      flags: cd.readUInt16LE(p + 8),
      method: cd.readUInt16LE(p + 10),
      time: cd.readUInt16LE(p + 12),
      date: cd.readUInt16LE(p + 14),
      crc: cd.readUInt32LE(p + 16),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      extra: Buffer.from(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)),
      comment: Buffer.from(cd.subarray(p + 46 + nameLen + extraLen, end)),
      internalAttrs: cd.readUInt16LE(p + 36),
      externalAttrs: cd.readUInt32LE(p + 38),
      localOffset: cd.readUInt32LE(p + 42),
    };
    if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) throw new ZipError(`${entry.name} in it is encrypted.`);
    if (entry.compressedSize === MAX_U32 || entry.size === MAX_U32 || entry.localOffset === MAX_U32 || hasZip64Extra(entry.extra)) {
      throw new ZipError(ZIP64_MESSAGE);
    }
    entries.push(entry);
    p = end;
  }
  return { entries, comment };
}

/** Extra field 0x0001 holds 64-bit sizes and offsets. */
function hasZip64Extra(extra: Buffer): boolean {
  for (let p = 0; p + 4 <= extra.length; p += 4 + extra.readUInt16LE(p + 2)) {
    if (extra.readUInt16LE(p) === 0x0001) return true;
  }
  return false;
}

/** The entries of a zip, from its central directory. Throws ZipError for what cannot be handled. */
export async function readZipIndex(file: string): Promise<ZipIndex> {
  const handle = await fs.open(file, 'r');
  try {
    return await readIndexFrom(handle);
  } finally {
    await handle.close();
  }
}

/** Where an entry's data starts, and its local extra field (which may differ from the central one). */
async function localInfo(handle: FileHandle, entry: ZipEntry): Promise<{ dataStart: number; extra: Buffer }> {
  const head = await readAt(handle, entry.localOffset, 30);
  if (head.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError(`The zip is damaged at ${entry.name}.`);
  const nameLen = head.readUInt16LE(26);
  const extraLen = head.readUInt16LE(28);
  const extra = extraLen ? await readAt(handle, entry.localOffset + 30 + nameLen, extraLen) : Buffer.alloc(0);
  return { dataStart: entry.localOffset + 30 + nameLen + extraLen, extra };
}

/** One entry's content, uncompressed. Refuses entries bigger than maxBytes. */
export async function readEntry(file: string, entry: ZipEntry, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  if (entry.size > maxBytes || entry.compressedSize > maxBytes) throw new ZipError(`${entry.name} is too large to read (${entry.size} bytes).`);
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`${entry.name} uses a compression method Debug Hub cannot read (${entry.method}).`);
  const handle = await fs.open(file, 'r');
  try {
    const { dataStart } = await localInfo(handle, entry);
    const raw = entry.compressedSize ? await readAt(handle, dataStart, entry.compressedSize) : Buffer.alloc(0);
    const data = entry.method === 0 ? raw : inflateRawSync(raw);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError(`${entry.name} in the zip is damaged (its checksum does not match).`);
    return data;
  } finally {
    await handle.close();
  }
}

// ── Writing ─────────────────────────────────────────────

export interface NewFile {
  /** Entry name with forward slashes, e.g. "WEB-INF/classes/config.yaml". */
  name: string;
  data: Buffer;
  /** Shown as the entry's time; defaults to now. */
  mtime?: Date;
}

export interface RewriteResult {
  replaced: string[];
  added: string[];
}

/** Zip times are local DOS time, in 2-second steps, from 1980. */
export function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

function localHeader(e: ZipEntry, extra: Buffer): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(e.versionNeeded, 4);
  b.writeUInt16LE(e.flags, 6);
  b.writeUInt16LE(e.method, 8);
  b.writeUInt16LE(e.time, 10);
  b.writeUInt16LE(e.date, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.compressedSize, 18);
  b.writeUInt32LE(e.size, 22);
  b.writeUInt16LE(e.rawName.length, 26);
  b.writeUInt16LE(extra.length, 28);
  return Buffer.concat([b, e.rawName, extra]);
}

function centralHeader(e: ZipEntry): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE(e.versionMadeBy, 4);
  b.writeUInt16LE(e.versionNeeded, 6);
  b.writeUInt16LE(e.flags, 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(e.time, 12);
  b.writeUInt16LE(e.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.compressedSize, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(e.rawName.length, 28);
  b.writeUInt16LE(e.extra.length, 30);
  b.writeUInt16LE(e.comment.length, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(e.internalAttrs, 36);
  b.writeUInt32LE(e.externalAttrs >>> 0, 38);
  b.writeUInt32LE(e.localOffset, 42);
  return Buffer.concat([b, e.rawName, e.extra, e.comment]);
}

/** A new entry for content: deflated, unless that does not make it smaller. */
function freshEntry(name: string, data: Buffer, mtime: Date, like?: ZipEntry): { entry: ZipEntry; body: Buffer } {
  const deflated = data.length ? deflateRawSync(data) : data;
  const store = deflated.length >= data.length;
  const body = store ? data : deflated;
  const rawName = like?.rawName ?? Buffer.from(name, 'utf8');
  const { time, date } = dosTime(mtime);
  const nonAscii = /[^\x20-\x7e]/.test(name);
  return {
    body,
    entry: {
      name,
      rawName,
      // Made by: zip 2.0 on the original's host (its permission bits stay meaningful), else MS-DOS.
      versionMadeBy: like ? (like.versionMadeBy & 0xff00) | 20 : 20,
      versionNeeded: 20,
      flags: nonAscii || (like && like.flags & FLAG_UTF8) ? FLAG_UTF8 : 0,
      method: store ? 0 : 8,
      time,
      date,
      crc: crc32(data),
      compressedSize: body.length,
      size: data.length,
      extra: Buffer.alloc(0),
      comment: like?.comment ?? Buffer.alloc(0),
      internalAttrs: 0,
      externalAttrs: like?.externalAttrs ?? 0,
      localOffset: 0,
    },
  };
}

/** Folder entries ("a/", "a/b/") for a path, so tools that list folders see the new file's. */
function parentDirs(name: string): string[] {
  const parts = name.split('/').slice(0, -1);
  return parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/`);
}

class Writer {
  offset = 0;
  constructor(private handle: FileHandle) {}
  async write(buf: Buffer): Promise<void> {
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await this.handle.write(buf, done, buf.length - done);
      done += bytesWritten;
    }
    this.offset += buf.length;
  }
  /** Copies bytes from another file, a chunk at a time, so a large WAR is never all in memory. */
  async copy(from: FileHandle, position: number, length: number): Promise<void> {
    for (let done = 0; done < length; ) {
      const n = Math.min(CHUNK, length - done);
      await this.write(await readAt(from, position + done, n));
      done += n;
    }
  }
}

/**
 * Writes a copy of the zip `src` to `dest` (which must not exist) with `files` in it: an entry of
 * the same name is replaced where it is, others are added at the end, with their folders. All
 * other entries keep their data byte for byte.
 */
export async function rewriteZip(src: string, dest: string, files: NewFile[]): Promise<RewriteResult> {
  const input = await fs.open(src, 'r');
  let output: FileHandle | null = null;
  try {
    const index = await readIndexFrom(input);
    const byName = new Map(files.map((f) => [f.name, f]));
    const existing = new Set(index.entries.map((e) => e.name));
    output = await fs.open(dest, 'wx');
    const out = new Writer(output);
    const central: ZipEntry[] = [];
    const replaced: string[] = [];

    const put = async (entry: ZipEntry, extra: Buffer, body: () => Promise<void>) => {
      if (out.offset > MAX_U32 || central.length >= MAX_U16) throw new ZipError(ZIP64_MESSAGE);
      entry.localOffset = out.offset;
      await out.write(localHeader(entry, extra));
      await body();
      central.push(entry);
    };

    for (const e of index.entries) {
      const file = byName.get(e.name);
      if (file) {
        const { entry, body } = freshEntry(e.name, file.data, file.mtime ?? new Date(), e);
        await put(entry, Buffer.alloc(0), () => out.write(body));
        if (!replaced.includes(e.name)) replaced.push(e.name);
        continue;
      }
      const { dataStart, extra } = await localInfo(input, e);
      // The central directory has the real sizes and CRC, so no data descriptor is needed.
      const entry: ZipEntry = { ...e, flags: e.flags & ~FLAG_DESCRIPTOR };
      await put(entry, extra, () => out.copy(input, dataStart, e.compressedSize));
    }

    const added: string[] = [];
    for (const f of files) {
      if (existing.has(f.name)) continue;
      for (const dir of parentDirs(f.name)) {
        if (existing.has(dir)) continue;
        existing.add(dir);
        const { entry } = freshEntry(dir, Buffer.alloc(0), f.mtime ?? new Date());
        entry.externalAttrs = 0x10; // MS-DOS directory attribute
        await put(entry, Buffer.alloc(0), async () => undefined);
      }
      existing.add(f.name);
      const { entry, body } = freshEntry(f.name, f.data, f.mtime ?? new Date());
      await put(entry, Buffer.alloc(0), () => out.write(body));
      added.push(f.name);
    }

    const cdOffset = out.offset;
    for (const e of central) await out.write(centralHeader(e));
    const cdSize = out.offset - cdOffset;
    if (out.offset > MAX_U32) throw new ZipError(ZIP64_MESSAGE);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(index.comment.length, 20);
    await out.write(Buffer.concat([eocd, index.comment]));
    return { replaced, added };
  } catch (err) {
    if (output) {
      await output.close().catch(() => undefined);
      output = null;
      await fs.rm(dest, { force: true }).catch(() => undefined);
    }
    throw err;
  } finally {
    await input.close();
    await output?.close();
  }
}
