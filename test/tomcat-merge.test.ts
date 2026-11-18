import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import { compareVersions } from '../src/server/tomcat/merge';
import { TomcatService } from '../src/server/tomcat/service';
import { readEntry, readZipIndex, rewriteZip } from '../src/server/tomcat/zip';
import { MERGE_MAX_BYTES, type KeepComparePreview, type MergeFile } from '../src/shared/keepmerge';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-tomcat-merge-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tree(files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    if (rel.endsWith('/')) mkdirSync(path, { recursive: true });
    else writeFileSync(path, content);
  }
}

/** A real WAR with these files, written by rewriteZip from an empty zip. */
async function war(path: string, files: Record<string, string | Buffer>): Promise<void> {
  const empty = join(dir, `.empty-${Math.random()}.zip`);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  writeFileSync(empty, eocd);
  mkdirSync(join(path, '..'), { recursive: true });
  await rewriteZip(empty, path, Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));
  rmSync(empty);
}

async function warBytes(path: string): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  for (const e of (await readZipIndex(path)).entries) if (!e.name.endsWith('/')) out[e.name] = await readEntry(path, e);
  return out;
}

const MINE = 'server:\r\n  port: 9090\r\ndb:\r\n  url: jdbc:postgresql://localhost/shop\r\nlegacy: true\r\n';
const BUILD = 'server:\n  port: 8080\n  timeout: 30\ndb:\n  url: jdbc:postgresql://db/shop\nmail:\n  host: smtp\n  port: 25\n';

describe('compareVersions', () => {
  const cmp = (path: string, a: string | Buffer, b: string | Buffer | null) => compareVersions(path, Buffer.from(a), b === null ? null : Buffer.from(b));

  it('tells identical, only deployed and different apart', () => {
    expect(cmp('config.yaml', 'a: 1\n', 'a: 1\n')).toMatchObject({ status: 'identical', kind: 'yaml', keepable: true });
    expect(cmp('config.yaml', 'a: 1\n', null)).toMatchObject({ status: 'only-deployed', mergeable: false });
    expect(cmp('config.yaml', 'a: 1\r\n', 'a: 1\n')).toMatchObject({ status: 'differs', formatOnly: true, mergeable: true, lines: { added: 0, removed: 0 } });
  });

  it('says which settings the build adds, drops and sets differently', () => {
    const c = cmp('WEB-INF/classes/config.yaml', MINE, BUILD);
    expect(c).toMatchObject({ status: 'differs', mergeable: true, reason: null, formatOnly: false, lines: { added: 6, removed: 3 } });
    expect(c.keys).toMatchObject({ addedCount: 3, removedCount: 1, changedCount: 2 });
    expect(c.keys!.added.map((k) => [k.path, k.count])).toEqual([['server.timeout', 1], ['mail', 2]]);
    expect(c.keys!.removed.map((k) => k.path)).toEqual(['legacy']);
    expect(c.keys!.changed.map((k) => `${k.path}: ${k.from} -> ${k.to}`)).toEqual(['server.port: 9090 -> 8080', 'db.url: jdbc:postgresql://localhost/shop -> jdbc:postgresql://db/shop']);
  });

  it('falls back to line counts for other files, and gives a reason for what cannot be merged', () => {
    expect(cmp('notes.txt', 'one\ntwo\n', 'one\nthree\nfour\n')).toMatchObject({ kind: 'text', keys: null, lines: { added: 2, removed: 1 }, mergeable: true });
    expect(cmp('config.yaml', Buffer.from([0x50, 0x4b, 0, 1, 2]), 'a: 1\n')).toMatchObject({ mergeable: false, reason: expect.stringMatching(/deployed copy cannot be merged.*not a text file/) });
    expect(cmp('config.yaml', 'a: 1\n', Buffer.from([0xff, 0xfe, 0x61, 0]))).toMatchObject({ mergeable: false, reason: expect.stringMatching(/new build.*UTF-16/) });
    expect(cmp('config.yaml', `a: ${'x'.repeat(MERGE_MAX_BYTES)}\n`, 'a: 1\n')).toMatchObject({ status: 'differs', mergeable: false, lines: null, reason: expect.stringMatching(/Too large to compare and merge/) });
  });
});

describe('TomcatService: comparing and merging kept files', () => {
  function service() {
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [join(dir, 'build')] });
    const events: HubEvent[] = [];
    const svc = new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'logs') });
    return { svc, events };
  }

  async function newBuild(svc: TomcatService, files: Record<string, string | Buffer>, name = 'shop-2.0.war'): Promise<string> {
    await svc.warWatcher.tick();
    const file = join(dir, 'build', name);
    await war(file, files);
    await svc.warWatcher.tick();
    return file;
  }

  const deployedTree = () =>
    tree({
      'build/': '',
      'webapps/shop.war': 'old',
      'webapps/shop/WEB-INF/classes/config.yaml': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MINE)]),
      'webapps/shop/js/config.js': "window.CONFIG = { api: '/local' };\n",
      'webapps/shop/WEB-INF/classes/log4j2.xml': '<Configuration/>\n',
      'webapps/shop/index.html': 'old',
    });
  const buildFiles = { 'WEB-INF/classes/config.yaml': BUILD, 'WEB-INF/classes/log4j2.xml': '<Configuration/>\n', 'index.html': 'new' };

  it('compares every kept file with the new WAR', async () => {
    deployedTree();
    const { svc } = service();
    const file = await newBuild(svc, buildFiles);
    const p = await svc.keepCompare('shop', file);
    expect(p.files.map((f) => f.path)).toEqual(['js/config.js', 'WEB-INF/classes/config.yaml', 'WEB-INF/classes/log4j2.xml']);
    expect(p.compare['js/config.js']).toMatchObject({ status: 'only-deployed', kind: 'js' });
    expect(p.compare['WEB-INF/classes/log4j2.xml']).toMatchObject({ status: 'identical', kind: 'xml' });
    expect(p.compare['WEB-INF/classes/config.yaml']).toMatchObject({ status: 'differs', mergeable: true, keys: { addedCount: 3, removedCount: 1, changedCount: 2 } });
    // Without a WAR, or for a webapp that is not there, there is nothing to compare.
    expect((await svc.keepCompare('shop')).compare).toEqual({});
    expect(await svc.keepCompare('nothing', file)).toMatchObject({ source: null, files: [], compare: {} });
    // The plain preview is as before.
    expect((await svc.keepPreview('shop', file)).files[0]).toEqual({ path: 'js/config.js', bytes: 35, inWar: false });
  });

  it('gives both versions as text, with how the deployed copy is stored', async () => {
    deployedTree();
    const { svc } = service();
    const file = await newBuild(svc, buildFiles);
    const m = await svc.mergeFile('shop', file, 'WEB-INF/classes/config.yaml');
    expect(m.kind).toBe('yaml');
    expect(m.deployed.text).toBe(MINE.replace(/\r\n/g, '\n'));
    expect(m.deployed.format).toEqual({ encoding: 'utf-8', bom: true, eol: '\r\n', mixedEol: false, finalNewline: true });
    expect(m.build.text).toBe(BUILD);
    expect(m.build.format.eol).toBe('\n');
    expect(m.deployed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m.deployed.hash).not.toBe(m.build.hash);

    // Only files the search for kept files finds; never a path from the request as it is.
    await expect(svc.mergeFile('shop', file, 'index.html')).rejects.toMatchObject({ status: 409 });
    await expect(svc.mergeFile('shop', file, '../shop.war')).rejects.toMatchObject({ status: 409 });
    await expect(svc.mergeFile('shop', file, 'js/config.js')).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/has no js\/config\.js to merge with/) });
    await expect(svc.mergeFile('shop', join(dir, 'webapps', 'shop.war'), 'WEB-INF/classes/config.yaml')).rejects.toMatchObject({ status: 404 });
    await expect(svc.mergeFile('../x', file, 'WEB-INF/classes/config.yaml')).rejects.toMatchObject({ status: 400 });
    await expect(svc.mergeFile('gone', file, 'WEB-INF/classes/config.yaml')).rejects.toMatchObject({ status: 409 });
  });

  it('deploys a merge: written into the WAR as the deployed copy is stored, next to kept files', async () => {
    deployedTree();
    const { svc, events } = service();
    const file = await newBuild(svc, buildFiles);
    const m = await svc.mergeFile('shop', file, 'WEB-INF/classes/config.yaml');
    const text = 'server:\n  port: 9090\n  timeout: 30\ndb:\n  url: jdbc:postgresql://localhost/shop\nmail:\n  host: smtp\n  port: 25\n';
    const message = await svc.deploy(file, 'shop', 'remove', ['js/config.js', 'WEB-INF/classes/config.yaml'], [
      { path: 'WEB-INF/classes/config.yaml', text, deployedHash: m.deployed.hash, buildHash: m.build.hash },
    ]);
    expect(message).toMatch(/Kept js\/config\.js \(added\) from the deployed copy\. Wrote your merge of WEB-INF\/classes\/config\.yaml\./);
    const deployed = await warBytes(join(dir, 'webapps', 'shop.war'));
    // The merge keeps the byte order mark and CRLF line endings of the file it replaces.
    expect(deployed['WEB-INF/classes/config.yaml']).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\n/g, '\r\n'))]));
    expect(deployed['js/config.js'].toString()).toBe("window.CONFIG = { api: '/local' };\n");
    expect(deployed['WEB-INF/classes/log4j2.xml'].toString()).toBe('<Configuration/>\n');
    expect(deployed['index.html'].toString()).toBe('new');
    // The build itself is untouched.
    expect((await warBytes(file))['WEB-INF/classes/config.yaml'].toString()).toBe(BUILD);
    expect(events.at(-1)?.data).toMatchObject({ kept: ['js/config.js'], merged: ['WEB-INF/classes/config.yaml'] });
    expect(events.at(-1)?.summary).toMatch(/Wrote your merge of WEB-INF\/classes\/config\.yaml\./);
  });

  it('refuses a merge made from versions that changed since, without touching webapps', async () => {
    deployedTree();
    const { svc } = service();
    const file = await newBuild(svc, buildFiles);
    const m = await svc.mergeFile('shop', file, 'WEB-INF/classes/config.yaml');
    const merged = { path: 'WEB-INF/classes/config.yaml', text: 'a: 1\n', deployedHash: m.deployed.hash, buildHash: m.build.hash };
    const before = readFileSync(join(dir, 'webapps', 'shop.war'), 'utf8');

    // The deployed file was edited after the merge view read it.
    writeFileSync(join(dir, 'webapps/shop/WEB-INF/classes/config.yaml'), 'edited: meanwhile\n');
    await expect(svc.deploy(file, 'shop', 'remove', [], [merged])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/changed in the deployed copy after it was merged/) });
    writeFileSync(join(dir, 'webapps/shop/WEB-INF/classes/config.yaml'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MINE)]));

    // The WAR was built again with another config.
    await war(join(dir, 'build', 'other.war'), { ...buildFiles, 'WEB-INF/classes/config.yaml': `${BUILD}extra: 1\n` });
    await svc.warWatcher.tick();
    await expect(svc.deploy(join(dir, 'build', 'other.war'), 'shop', 'remove', [], [merged])).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/other\.war changed after it was merged/) });

    // Not a kept file, the same file twice, a file that is gone.
    await expect(svc.deploy(file, 'shop', 'remove', [], [{ path: 'index.html', text: 'x' }])).rejects.toMatchObject({ status: 409 });
    await expect(svc.deploy(file, 'shop', 'remove', [], [merged, merged])).rejects.toMatchObject({ status: 400 });
    await expect(svc.deploy(file, 'shop', 'remove', [], [{ path: 'WEB-INF/classes/config.yaml', text: 'x'.repeat(2 * MERGE_MAX_BYTES + 1) }])).rejects.toMatchObject({ status: 413 });
    expect(readFileSync(join(dir, 'webapps', 'shop.war'), 'utf8')).toBe(before);

    // Without hashes (a script that knows what it is doing) the merge is written.
    await svc.deploy(file, 'shop', 'remove', [], [{ path: 'WEB-INF/classes/config.yaml', text: 'a: 1' }]);
    expect((await warBytes(join(dir, 'webapps', 'shop.war')))['WEB-INF/classes/config.yaml']).toEqual(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a: 1')]));
  });

  it('keeps an ISO-8859-1 file in its encoding, and refuses characters it cannot hold', async () => {
    tree({ 'build/': '', 'webapps/shop.war': 'old', 'webapps/shop/config.js': Buffer.from([0x2f, 0x2f, 0x20, 0xfc, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x31, 0x0a]) }); // "// ü\nx = 1\n"
    const { svc } = service();
    const file = await newBuild(svc, { 'config.js': 'x = 2\n' });
    const m = await svc.mergeFile('shop', file, 'config.js');
    expect(m.deployed).toMatchObject({ text: '// ü\nx = 1\n', format: { encoding: 'latin1' } });
    await expect(svc.deploy(file, 'shop', 'remove', [], [{ path: 'config.js', text: '// ü €\nx = 2\n' }])).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/ISO-8859-1/) });
    await svc.deploy(file, 'shop', 'remove', [], [{ path: 'config.js', text: '// üß\nx = 2\n' }]);
    expect((await warBytes(join(dir, 'webapps', 'shop.war')))['config.js']).toEqual(Buffer.from([0x2f, 0x2f, 0x20, 0xfc, 0xdf, 0x0a, 0x78, 0x20, 0x3d, 0x20, 0x32, 0x0a]));
  });
});

describe('Tomcat API: compare, merge file and deploy with merged content', () => {
  let hub: Hub;
  let server: Server;
  let base: string;
  beforeEach(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as any).port;
        probe.close(() => resolve(p));
      });
    });
    tree({ 'webapps/shop.war': 'w', 'webapps/shop/config.yaml': 'port: 9090\nname: mine\n', 'build/': '' });
    const config: Config = structuredClone(DEFAULT_CONFIG);
    config.port = port;
    config.chrome.enabled = false;
    config.sessionsDir = join(dir, 'sessions');
    config.tomcat.webappsDir = join(dir, 'webapps');
    config.tomcat.disabledDir = join(dir, 'disabled');
    config.tomcat.warWatch = [join(dir, 'build')];
    hub = new Hub(config);
    hub.start();
    server = await startServer(hub, dir, { configFile: join(dir, 'debug-hub.config.json') });
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    server.close();
    await hub.stop();
  });
  const post = (path: string, body: unknown = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('serves the comparison and both texts, and deploys a merge far bigger than other request bodies', async () => {
    await hub.tomcat.warWatcher.tick();
    const file = join(dir, 'build', 'shop.war');
    await war(file, { 'config.yaml': 'port: 8080\nname: build\ntimeout: 30\n', 'index.html': 'new' });
    await hub.tomcat.warWatcher.tick();
    const q = `name=shop&file=${encodeURIComponent(file)}`;

    const cmp: KeepComparePreview = await (await fetch(`${base}/api/tomcat/keep/compare?${q}`)).json();
    expect(cmp.files).toEqual([{ path: 'config.yaml', bytes: 22, inWar: true }]);
    expect(cmp.compare['config.yaml']).toMatchObject({ status: 'differs', keys: { addedCount: 1, added: [{ path: 'timeout', value: '30', count: 1, line: 2 }], changedCount: 2 } });

    const both: MergeFile = await (await fetch(`${base}/api/tomcat/keep/file?${q}&path=config.yaml`)).json();
    expect(both).toMatchObject({ path: 'config.yaml', kind: 'yaml', deployed: { text: 'port: 9090\nname: mine\n', bytes: 22 }, build: { text: 'port: 8080\nname: build\ntimeout: 30\n' } });
    expect((await fetch(`${base}/api/tomcat/keep/file?${q}&path=index.html`)).status).toBe(409);
    expect((await fetch(`${base}/api/tomcat/keep/file?${q}`)).status).toBe(409);

    expect((await post('/api/tomcat/deploy', { file, name: 'shop', merged: 'config.yaml' })).status).toBe(400);
    expect((await post('/api/tomcat/deploy', { file, name: 'shop', merged: [{ path: 'config.yaml' }] })).status).toBe(400);
    expect((await post('/api/tomcat/deploy', { file, name: 'shop', merged: [{ path: 'config.yaml', text: 'x', deployedHash: 'stale' }] })).status).toBe(409);

    // 200 kB of comments: three times the limit of other request bodies.
    const text = `port: 9090\nname: mine\ntimeout: 30\n${'# padding to make the request large\n'.repeat(5600)}`;
    const res = await post('/api/tomcat/deploy', { file, name: 'shop', keep: ['config.yaml'], merged: [{ path: 'config.yaml', text, deployedHash: both.deployed.hash, buildHash: both.build.hash }] });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/Wrote your merge of config\.yaml\./);
    const deployed = await warBytes(join(dir, 'webapps', 'shop.war'));
    expect(deployed['config.yaml'].toString()).toBe(text);
    expect(deployed['index.html'].toString()).toBe('new');

    // A deploy that only keeps files works as before.
    await hub.tomcat.warWatcher.tick();
    const kept = await post('/api/tomcat/deploy', { file, name: 'shop', keep: ['config.yaml'] });
    expect((await kept.json()).message).toMatch(/Kept config\.yaml \(replaced\) from the deployed copy\./);
    expect((await warBytes(join(dir, 'webapps', 'shop.war')))['config.yaml'].toString()).toBe('port: 9090\nname: mine\n');
  });
});
