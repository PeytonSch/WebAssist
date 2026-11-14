import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNewer, packPayload, Updater, type Manifest, type Progress } from '../src/shell/updater';

let work: string;
let server: Server;
let base: string;
/** What the fake release feed serves, by path. */
let feed: Record<string, Buffer | string>;

function makePayloadDir(version: string, marker = version): string {
  const dir = join(work, `src-${version}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'app.cjs'), `exports.run = async () => ${JSON.stringify(marker)};`);
  writeFileSync(join(dir, 'ui', 'index.html'), `<title>${marker}</title>`);
  writeFileSync(join(dir, 'payload.json'), JSON.stringify({ version, minShell: 1 }));
  return dir;
}

function publish(version: string, over: Partial<Manifest> = {}, data = packPayload(makePayloadDir(version))): void {
  const file = `payload-${version}.json.gz`;
  feed[`/${file}`] = data;
  feed['/latest.json'] = JSON.stringify({
    version, minShell: 1, file, size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'), ...over,
  });
}

function updater(opts: { bundled?: string | null; progress?: Progress[]; url?: string | null } = {}): Updater {
  return new Updater({
    root: join(work, 'installed'),
    bundledDir: opts.bundled ?? null,
    manifestUrl: opts.url === undefined ? `${base}/latest.json` : opts.url,
    shellApi: 1,
    fetch,
    onProgress: (p) => opts.progress?.push(p),
  });
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), 'dh-upd-'));
  feed = {};
  server = createServer((req, res) => {
    const body = feed[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(work, { recursive: true, force: true });
});

describe('isNewer', () => {
  it('compares numerically and ignores a leading v', () => {
    expect(isNewer('v0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0', '1.0.1')).toBe(false);
  });
});

describe('Updater', () => {
  it('starts from the bundled payload and does nothing when the feed has no release', async () => {
    const u = updater({ bundled: makePayloadDir('0.1.0') });
    expect(await u.update()).toEqual({ result: 'none' });
    expect(u.current()).toMatchObject({ version: '0.1.0', source: 'bundled' });
  });

  it('downloads, verifies and installs a newer version, reporting progress', async () => {
    publish('0.2.0');
    const progress: Progress[] = [];
    const u = updater({ bundled: makePayloadDir('0.1.0'), progress });
    expect(await u.update()).toEqual({ result: 'updated', version: '0.2.0' });
    const cur = u.current()!;
    expect(cur).toMatchObject({ version: '0.2.0', source: 'downloaded' });
    expect(readFileSync(join(cur.dir, 'ui', 'index.html'), 'utf8')).toBe('<title>0.2.0</title>');
    expect(progress.map((p) => p.phase)).toEqual(expect.arrayContaining(['checking', 'downloading', 'installing']));
    expect(progress.filter((p) => p.phase === 'downloading').at(-1)!.percent).toBe(100);
    // Running it again finds nothing to do.
    expect(await updater({ bundled: makePayloadDir('0.1.0') }).update()).toEqual({ result: 'none' });
  });

  it('keeps one previous version for rollback and prunes older ones', async () => {
    const u = updater({ bundled: makePayloadDir('0.1.0') });
    for (const v of ['0.2.0', '0.3.0', '0.4.0']) {
      publish(v);
      await u.update();
    }
    const dirs = readdirSync(join(work, 'installed')).filter((n) => n !== 'state.json').sort();
    expect(dirs).toEqual(['0.3.0', '0.4.0']);
    expect(u.candidates().map((c) => c.version)).toEqual(['0.4.0', '0.3.0', '0.1.0']);
  });

  it('rejects a download that does not match its checksum and leaves the old version in place', async () => {
    publish('0.2.0', { sha256: 'a'.repeat(64) });
    const u = updater({ bundled: makePayloadDir('0.1.0') });
    const r = await u.update();
    expect(r).toMatchObject({ result: 'failed', version: '0.2.0' });
    expect((r as any).error).toMatch(/checksum/);
    expect(u.current()!.version).toBe('0.1.0');
    expect(existsSync(join(work, 'installed', '0.2.0'))).toBe(false);
  });

  it('rejects a truncated or oversized download', async () => {
    publish('0.2.0');
    const real = JSON.parse(String(feed['/latest.json']));
    feed['/latest.json'] = JSON.stringify({ ...real, size: real.size + 10 });
    expect(await updater().update()).toMatchObject({ result: 'failed', error: expect.stringMatching(/cut short/) });
    feed['/latest.json'] = JSON.stringify({ ...real, size: real.size - 10 });
    expect(await updater().update()).toMatchObject({ result: 'failed', error: expect.stringMatching(/larger/) });
  });

  it('refuses payloads that write outside their own directory', async () => {
    const evil = gzipSync(JSON.stringify({ files: { 'app.cjs': '', '../../escaped.txt': Buffer.from('x').toString('base64') } }));
    publish('0.2.0', {}, evil);
    const r = await updater().update();
    expect(r).toMatchObject({ result: 'failed', error: expect.stringMatching(/unsafe path/) });
    expect(existsSync(join(work, 'escaped.txt'))).toBe(false);
    expect(readdirSync(join(work, 'installed')).filter((n) => n.includes('0.2.0'))).toEqual([]);
  });

  it('refuses a manifest that points the download at another site', async () => {
    publish('0.2.0', { url: 'http://example.invalid/payload.json.gz' });
    expect(await updater().update()).toMatchObject({ result: 'failed', error: expect.stringMatching(/different site/) });
  });

  it('reports when the update needs a newer shell, without installing it', async () => {
    publish('0.2.0', { minShell: 2 });
    const u = updater({ bundled: makePayloadDir('0.1.0') });
    expect(await u.update()).toEqual({ result: 'shell-outdated', version: '0.2.0' });
    expect(u.current()!.version).toBe('0.1.0');
  });

  it('carries on with what is installed when offline', async () => {
    const u = updater({ bundled: makePayloadDir('0.1.0'), url: 'http://127.0.0.1:9/latest.json' });
    expect(await u.update(500)).toMatchObject({ result: 'offline' });
    expect(u.current()!.version).toBe('0.1.0');
  });

  it('never re-downloads a version that was marked bad, and falls back to the previous one', async () => {
    const u = updater({ bundled: makePayloadDir('0.1.0') });
    publish('0.2.0');
    await u.update();
    publish('0.3.0');
    await u.update();
    u.markBad('0.3.0');
    expect(u.current()!.version).toBe('0.2.0');
    expect(await u.update()).toEqual({ result: 'none' });
    expect(u.current()!.version).toBe('0.2.0');
    publish('0.3.1');
    expect(await u.update()).toEqual({ result: 'updated', version: '0.3.1' });
  });

  it('prefers a bundled payload that is newer than the last download', async () => {
    publish('0.2.0');
    await updater().update();
    feed = {};
    expect(updater({ bundled: makePayloadDir('0.5.0') }).current()).toMatchObject({ version: '0.5.0', source: 'bundled' });
  });

  it('is disabled without a feed URL', async () => {
    expect(await updater({ url: null, bundled: makePayloadDir('0.1.0') }).update()).toEqual({ result: 'none' });
  });
});

describe('doctor flag parsing', async () => {
  const { flag } = await import('../src/server/doctor');
  it('reads Windows command lines, including a quoted whole argument and paths with spaces', () => {
    const chrome = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=51234 --user-data-dir=C:\\Users\\me\\AppData\\Local\\JetBrains\\IntelliJIdea2026.2\\chrome-user-data-51234 http://localhost:5173';
    expect(flag(chrome, '--remote-debugging-port')).toBe('51234');
    expect(flag(chrome, '--user-data-dir')).toBe('C:\\Users\\me\\AppData\\Local\\JetBrains\\IntelliJIdea2026.2\\chrome-user-data-51234');
    const java = 'C:\\jdk\\bin\\java.exe -Dfoo=1 "-Dcatalina.base=C:\\Users\\Jane Doe\\AppData\\Local\\JetBrains\\IntelliJIdea2026.2\\tomcat\\ab12" -Dcatalina.home=C:\\tomcat org.apache.catalina.startup.Bootstrap start';
    expect(flag(java, '-Dcatalina.base')).toBe('C:\\Users\\Jane Doe\\AppData\\Local\\JetBrains\\IntelliJIdea2026.2\\tomcat\\ab12');
    expect(flag(java, '-Dcatalina.home')).toBe('C:\\tomcat');
    expect(flag('chrome --user-data-dir="/tmp/a b" --x', '--user-data-dir')).toBe('/tmp/a b');
    expect(flag(java, '--missing')).toBeNull();
  });
});
