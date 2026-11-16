import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { crc32, readEntry, readZipIndex, rewriteZip, ZipError } from '../src/server/tomcat/zip';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-zip-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const has = (cmd: string, arg = '--version') => {
  try {
    execFileSync(cmd, [arg], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const python = ['python3', 'python'].find((c) => has(c));

interface Fixture {
  name: string;
  data: string | Buffer;
  deflate?: boolean;
  /** Sizes and CRC after the data, as a streaming writer (jar, Maven) does. */
  descriptor?: boolean;
  extra?: Buffer;
  flags?: number;
}

/** Builds a zip the way build tools do, including the variants rewriteZip must cope with. */
function makeZip(entries: Fixture[], comment = ''): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const body = e.deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const name = Buffer.from(e.name);
    const extra = e.extra ?? Buffer.alloc(0);
    const flags = (e.descriptor ? 0x08 : 0) | (e.flags ?? 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt16LE(0x6000, 10);
    local.writeUInt16LE(0x5a21, 12);
    if (!e.descriptor) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const desc = Buffer.alloc(e.descriptor ? 16 : 0);
    if (e.descriptor) {
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(body.length, 8);
      desc.writeUInt32LE(data.length, 12);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x0314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(e.deflate ? 8 : 0, 10);
    c.writeUInt16LE(0x6000, 12);
    c.writeUInt16LE(0x5a21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(e.name.endsWith('/') ? 0x41ed0010 : 0x81a40000, 38);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, name, extra]));
    const chunk = Buffer.concat([local, name, extra, body, desc]);
    parts.push(chunk);
    offset += chunk.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...parts, cd, eocd, Buffer.from(comment)]);
}

/** An entry's stored (compressed) bytes, found through its local header. */
function rawData(zip: Buffer, localOffset: number, compressedSize: number): Buffer {
  const start = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  return zip.subarray(start, start + compressedSize);
}

const WAR: Fixture[] = [
  { name: 'META-INF/', data: '', extra: Buffer.from([0xfe, 0xca, 0, 0]) },
  { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\r\n\r\n', deflate: true, descriptor: true },
  { name: 'index.html', data: '<h1>shop</h1>'.repeat(50), deflate: true, descriptor: true },
  { name: 'config.yaml', data: 'env: build\n', deflate: true, descriptor: true },
  { name: 'WEB-INF/', data: '' },
  { name: 'WEB-INF/lib/big.jar', data: Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 256)) },
  { name: 'WEB-INF/classes/ünï.txt', data: 'unicode', flags: 0x800 },
];

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
    // Incremental use gives the same answer as one call.
    expect(crc32(Buffer.from('6789'), crc32(Buffer.from('12345')))).toBe(0xcbf43926);
  });
});

describe('readZipIndex and readEntry', () => {
  it('lists entries from the central directory and reads stored and deflated ones', async () => {
    const file = join(dir, 'a.war');
    writeFileSync(file, makeZip(WAR, 'built by test'));
    const { entries, comment } = await readZipIndex(file);
    expect(entries.map((e) => e.name)).toEqual(WAR.map((e) => e.name));
    expect(comment.toString()).toBe('built by test');
    const byName = new Map(entries.map((e) => [e.name, e]));
    expect((await readEntry(file, byName.get('config.yaml')!)).toString()).toBe('env: build\n');
    expect((await readEntry(file, byName.get('WEB-INF/lib/big.jar')!)).length).toBe(5000);
    await expect(readEntry(file, byName.get('index.html')!, 100)).rejects.toThrow(/too large/);
  });

  it.skipIf(!python)('reads a zip written by Python, streamed with data descriptors', async () => {
    const script = [
      'import sys, zipfile',
      "z = zipfile.ZipFile(sys.stdout.buffer, 'w', zipfile.ZIP_DEFLATED)",
      "z.writestr('a/config.js', 'module.exports = 1\\n')",
      "z.writestr(zipfile.ZipInfo('b.txt'), 'stored')",
      'z.close()',
    ].join('\n');
    const file = join(dir, 'py.zip');
    writeFileSync(file, execFileSync(python!, ['-I', '-c', script]));
    const { entries } = await readZipIndex(file);
    expect(entries.map((e) => [e.name, !!(e.flags & 8)])).toEqual([['a/config.js', true], ['b.txt', true]]);
    expect((await readEntry(file, entries[0])).toString()).toBe('module.exports = 1\n');
  });

  it('refuses ZIP64, encrypted, truncated and non-zip files', async () => {
    const zip64 = makeZip([{ name: 'a', data: 'x' }]);
    zip64.writeUInt16LE(0xffff, zip64.length - 12);
    writeFileSync(join(dir, 'z64.zip'), zip64);
    await expect(readZipIndex(join(dir, 'z64.zip'))).rejects.toThrow(/ZIP64/);

    writeFileSync(join(dir, 'enc.zip'), makeZip([{ name: 'secret', data: 'x', flags: 1 }]));
    await expect(readZipIndex(join(dir, 'enc.zip'))).rejects.toThrow(/encrypted/);

    const whole = makeZip(WAR);
    writeFileSync(join(dir, 'half.zip'), whole.subarray(0, whole.length / 2));
    await expect(readZipIndex(join(dir, 'half.zip'))).rejects.toBeInstanceOf(ZipError);
    writeFileSync(join(dir, 'text.zip'), 'not a zip at all, just some text');
    await expect(readZipIndex(join(dir, 'text.zip'))).rejects.toBeInstanceOf(ZipError);
  });
});

describe('rewriteZip', () => {
  async function rewrite(files: { name: string; data: string }[]) {
    const src = join(dir, 'shop.war');
    const dest = join(dir, 'out.war');
    writeFileSync(src, makeZip(WAR, 'comment'));
    const result = await rewriteZip(src, dest, files.map((f) => ({ name: f.name, data: Buffer.from(f.data), mtime: new Date(2026, 10, 16, 10, 30, 0) })));
    return { src, dest, result };
  }

  it('replaces and adds files and copies every other entry byte for byte', async () => {
    const { src, dest, result } = await rewrite([
      { name: 'config.yaml', data: 'env: local\n' },
      { name: 'js/app/config.js', data: 'window.CONFIG = { api: "http://localhost" };\n'.repeat(20) },
    ]);
    expect(result).toEqual({ replaced: ['config.yaml'], added: ['js/app/config.js'] });

    const before = readFileSync(src);
    const after = readFileSync(dest);
    const a = await readZipIndex(src);
    const b = await readZipIndex(dest);
    expect(b.entries.map((e) => e.name)).toEqual([...WAR.map((e) => e.name), 'js/', 'js/app/', 'js/app/config.js']);
    expect(b.comment.toString()).toBe('comment');
    for (const e of a.entries) {
      if (e.name === 'config.yaml') continue;
      const n = b.entries.find((x) => x.name === e.name)!;
      expect(rawData(after, n.localOffset, n.compressedSize), e.name).toEqual(rawData(before, e.localOffset, e.compressedSize));
      expect([n.crc, n.size, n.method, n.time, n.date, n.externalAttrs, n.extra]).toEqual([e.crc, e.size, e.method, e.time, e.date, e.externalAttrs, e.extra]);
      // Sizes are in the local header now, so the data-descriptor flag is cleared.
      expect(n.flags & 8).toBe(0);
      expect(after.readUInt32LE(n.localOffset + 18)).toBe(n.compressedSize);
    }
    const get = async (name: string) => (await readEntry(dest, b.entries.find((e) => e.name === name)!)).toString();
    expect(await get('config.yaml')).toBe('env: local\n');
    expect(await get('js/app/config.js')).toMatch(/^window\.CONFIG/);
    expect(await get('WEB-INF/classes/ünï.txt')).toBe('unicode');
    // The first entry keeps its local extra field (jar's 0xCAFE marker).
    expect(after.subarray(30 + 9, 30 + 9 + 4)).toEqual(Buffer.from([0xfe, 0xca, 0, 0]));
  });

  it.skipIf(!python)('writes a zip Python reads and tests clean', async () => {
    const { dest } = await rewrite([
      { name: 'config.yaml', data: 'env: local\n' },
      { name: 'WEB-INF/classes/config.js', data: 'module.exports = {}\n' },
    ]);
    const script = [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      "print(z.read('config.yaml').decode(), end='')",
      "print(z.read('WEB-INF/classes/config.js').decode(), end='')",
      "print(len(z.read('WEB-INF/lib/big.jar')))",
    ].join('\n');
    expect(execFileSync(python!, ['-I', '-c', script, dest]).toString()).toBe('env: local\nmodule.exports = {}\n5000\n');
  });

  it.skipIf(!has('unzip', '-v'))('writes a zip unzip tests clean', async () => {
    const { dest } = await rewrite([{ name: 'config.yaml', data: 'env: local\n' }]);
    expect(execFileSync('unzip', ['-t', dest]).toString()).toMatch(/No errors detected/);
  });

  it('never overwrites, and leaves nothing behind on failure', async () => {
    const src = join(dir, 'shop.war');
    writeFileSync(src, makeZip(WAR));
    writeFileSync(join(dir, 'taken.war'), 'mine');
    await expect(rewriteZip(src, join(dir, 'taken.war'), [])).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(join(dir, 'taken.war'), 'utf8')).toBe('mine');

    const broken = makeZip(WAR);
    // Point the second entry at garbage: its local header cannot be found.
    const cdOffset = broken.readUInt32LE(broken.length - 6);
    let p = cdOffset;
    p += 46 + broken.readUInt16LE(p + 28) + broken.readUInt16LE(p + 30) + broken.readUInt16LE(p + 32);
    broken.writeUInt32LE(3, p + 42);
    writeFileSync(join(dir, 'broken.war'), broken);
    await expect(rewriteZip(join(dir, 'broken.war'), join(dir, 'out.war'), [])).rejects.toThrow(/damaged/);
    expect(existsSync(join(dir, 'out.war'))).toBe(false);
  });
});
