import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, promises, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import { deleteApp, planDelete } from '../src/server/tomcat/delete';
import { findKeepSource, findKeptFiles, readKeptFiles } from '../src/server/tomcat/keep';
import { reveal, revealCommand } from '../src/server/tomcat/reveal';
import { TomcatService } from '../src/server/tomcat/service';
import { readEntry, readZipIndex, rewriteZip } from '../src/server/tomcat/zip';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-tomcat-files-'));
});
afterEach(() => {
  vi.restoreAllMocks();
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
async function war(path: string, files: Record<string, string>): Promise<void> {
  const empty = join(dir, `.empty-${Math.random()}.zip`);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  writeFileSync(empty, eocd);
  mkdirSync(join(path, '..'), { recursive: true });
  await rewriteZip(empty, path, Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));
  rmSync(empty);
}

async function warFiles(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of (await readZipIndex(path)).entries) if (!e.name.endsWith('/')) out[e.name] = (await readEntry(path, e)).toString();
  return out;
}

const canLink = process.platform !== 'win32';

describe('planDelete and deleteApp', () => {
  it('lists the WAR and the folder with sizes, and deletes the WAR first', async () => {
    tree({ 'webapps/shop.war': 'x'.repeat(100), 'webapps/shop/index.html': 'hello', 'webapps/shop/WEB-INF/web.xml': '<web-app/>', 'webapps/shopping/': '', 'webapps/other.war': 'y' });
    const items = await planDelete('shop', join(dir, 'webapps'));
    expect(items.map((i) => [i.name, i.kind, i.bytes, i.files])).toEqual([
      ['shop.war', 'war', 100, 1],
      ['shop', 'folder', 15, 2],
    ]);
    const order: string[] = [];
    const unlink = promises.unlink;
    vi.spyOn(promises, 'unlink').mockImplementation(async (p) => {
      order.push(String(p).slice(dir.length + 1));
      return unlink(p);
    });
    const { deleted } = await deleteApp('shop', join(dir, 'webapps'));
    expect(deleted.map((d) => d.name)).toEqual(['shop.war', 'shop']);
    expect(order[0]).toBe(join('webapps', 'shop.war'));
    expect(readdirSync(join(dir, 'webapps')).sort()).toEqual(['other.war', 'shopping']);
  });

  it('refuses bad names, missing webapps and a changed folder', async () => {
    tree({ 'webapps/shop/': '', 'outside/': '' });
    await expect(planDelete('../outside', join(dir, 'webapps'))).rejects.toMatchObject({ status: 400 });
    await expect(planDelete('..', join(dir, 'webapps'))).rejects.toMatchObject({ status: 400 });
    await expect(deleteApp('nothing', join(dir, 'webapps'))).rejects.toMatchObject({ status: 404 });
    // The user confirmed only the folder; a WAR has appeared since.
    writeFileSync(join(dir, 'webapps', 'shop.war'), 'new');
    await expect(deleteApp('shop', join(dir, 'webapps'), { expected: ['shop'] })).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(join(dir, 'webapps')).sort()).toEqual(['shop', 'shop.war']);
  });

  it.skipIf(!canLink)('removes links as links and never deletes what they point to', async () => {
    tree({ 'outside/keep.txt': 'precious', 'outside/sub/also.txt': 'precious', 'webapps/shop/a.txt': 'a' });
    symlinkSync(join(dir, 'outside'), join(dir, 'webapps', 'shop', 'linked-dir'));
    symlinkSync(join(dir, 'outside', 'keep.txt'), join(dir, 'webapps', 'shop', 'linked-file'));
    symlinkSync(join(dir, 'outside'), join(dir, 'webapps', 'api'));
    const items = await planDelete('shop', join(dir, 'webapps'));
    // Links are counted as entries, not followed.
    expect(items[0]).toMatchObject({ kind: 'folder', files: 3 });
    await deleteApp('shop', join(dir, 'webapps'));
    expect((await planDelete('api', join(dir, 'webapps')))[0]).toMatchObject({ kind: 'link', name: 'api' });
    await deleteApp('api', join(dir, 'webapps'));
    expect(readdirSync(join(dir, 'webapps'))).toEqual([]);
    expect(readFileSync(join(dir, 'outside', 'keep.txt'), 'utf8')).toBe('precious');
    expect(readFileSync(join(dir, 'outside', 'sub', 'also.txt'), 'utf8')).toBe('precious');
  });

  it('says exactly what was deleted and what is left when a file is in use', async () => {
    tree({ 'webapps/shop.war': 'war', 'webapps/shop/WEB-INF/lib/locked.jar': 'jar', 'webapps/shop/WEB-INF/lib/other.jar': 'jar2', 'webapps/shop/index.html': 'x' });
    const unlink = promises.unlink;
    vi.spyOn(promises, 'unlink').mockImplementation(async (p) => {
      if (String(p).endsWith('locked.jar')) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return unlink(p);
    });
    const err = await deleteApp('shop', join(dir, 'webapps'), { waitMs: 100 }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.message).toContain(`Could not delete ${join(dir, 'webapps', 'shop')}: a file in it is in use (${join(dir, 'webapps', 'shop', 'WEB-INF', 'lib', 'locked.jar')})`);
    expect(err.message).toContain('Tomcat probably still has it open');
    expect(err.message).toContain(`Deleted ${join(dir, 'webapps', 'shop.war')}.`);
    // It stops at the first file in use rather than leave a running webapp half deleted.
    expect(err.message).toMatch(/Still there: .*shop \(3 files, 8 B\)\./);
    expect(err.deleted).toEqual([join(dir, 'webapps', 'shop.war')]);
  });
});

describe('kept files', () => {
  const patterns = ['config.yaml', 'config.js'];

  it('finds the copy a deploy replaces: the unpacked folder, else the WAR, else the disabled copy', async () => {
    tree({ 'webapps/a/': '', 'webapps/a.war': '', 'webapps/b.war': '', 'disabled/c/': '', 'disabled/c.war': '' });
    const w = join(dir, 'webapps');
    const d = join(dir, 'disabled');
    expect(await findKeepSource('a', w, d)).toEqual({ kind: 'folder', path: join(w, 'a'), where: 'webapps' });
    expect(await findKeepSource('b', w, d)).toEqual({ kind: 'war', path: join(w, 'b.war'), where: 'webapps' });
    expect(await findKeepSource('c', w, d)).toEqual({ kind: 'folder', path: join(d, 'c'), where: 'disabled' });
    expect(await findKeepSource('c', w, '')).toBeNull();
    expect(await findKeepSource('../x', w, d)).toBeNull();
  });

  it('searches the whole webapp by file name, skipping libraries, node_modules and links', async () => {
    tree({
      'shop/config.yaml': 'a',
      'shop/js/app/config.js': 'b',
      'shop/WEB-INF/classes/config.yaml': 'c',
      'shop/WEB-INF/lib/config.js': 'no',
      'shop/node_modules/x/config.js': 'no',
      'shop/other.yaml': 'no',
    });
    if (canLink) symlinkSync(join(dir, 'shop', 'config.yaml'), join(dir, 'shop', 'js', 'config.yaml'));
    const { files } = await findKeptFiles({ kind: 'folder', path: join(dir, 'shop'), where: 'webapps' }, patterns);
    expect(files.map((f) => f.path)).toEqual(['config.yaml', 'js/app/config.js', 'WEB-INF/classes/config.yaml']);
    expect((await findKeptFiles({ kind: 'folder', path: join(dir, 'shop'), where: 'webapps' }, ['*.yaml'])).files.map((f) => f.path)).toEqual([
      'config.yaml',
      'other.yaml',
      'WEB-INF/classes/config.yaml',
    ]);
  });

  it('reads them from a deployed WAR too, and only paths the search finds', async () => {
    await war(join(dir, 'shop.war'), { 'config.yaml': 'from war', 'WEB-INF/lib/config.js': 'no', 'index.html': '' });
    const source = { kind: 'war' as const, path: join(dir, 'shop.war'), where: 'webapps' as const };
    expect((await findKeptFiles(source, patterns)).files).toEqual([{ path: 'config.yaml', bytes: 8 }]);
    const [f] = await readKeptFiles(source, patterns, ['config.yaml']);
    expect(f.data.toString()).toBe('from war');
    await expect(readKeptFiles(source, patterns, ['index.html'])).rejects.toMatchObject({ status: 409 });
    await expect(readKeptFiles({ ...source, kind: 'folder', path: dir }, patterns, ['../../etc/passwd'])).rejects.toMatchObject({ status: 409 });
  });
});

describe('kept files with the default names', () => {
  it('finds log4j2.xml in WEB-INF/classes and keeps each same-named file at its own path', async () => {
    tree({
      'build/': '',
      'webapps/shop.war': 'old',
      'webapps/shop/WEB-INF/classes/log4j2.xml': '<Configuration status="debug"/>',
      'webapps/shop/WEB-INF/classes/config.yaml': 'classes: mine',
      'webapps/shop/WEB-INF/lib/log4j2.xml': 'not this one',
      'webapps/shop/js/config.js': 'one',
      'webapps/shop/admin/js/config.js': 'two',
    });
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [join(dir, 'build')] });
    const svc = new TomcatService(cfg, { emit: () => undefined, onWar: () => undefined }, { scriptLogDir: join(dir, 'logs') });
    await svc.warWatcher.tick();
    const file = join(dir, 'build', 'shop.war');
    await war(file, { 'WEB-INF/classes/log4j2.xml': '<Configuration status="warn"/>', 'js/config.js': 'build', 'index.html': 'new' });
    await svc.warWatcher.tick();

    const preview = await svc.keepPreview('shop', file);
    expect(preview.patterns).toEqual(['config.yaml', 'config.js', 'log4j2.xml']);
    expect(preview.files.map((f) => [f.path, f.inWar])).toEqual([
      ['admin/js/config.js', false],
      ['js/config.js', true],
      ['WEB-INF/classes/config.yaml', false],
      ['WEB-INF/classes/log4j2.xml', true],
    ]);
    await svc.deploy(file, 'shop', 'remove', preview.files.map((f) => f.path));
    expect(await warFiles(join(dir, 'webapps', 'shop.war'))).toEqual({
      'WEB-INF/classes/log4j2.xml': '<Configuration status="debug"/>',
      'js/config.js': 'one',
      'index.html': 'new',
      'admin/js/config.js': 'two',
      'WEB-INF/classes/config.yaml': 'classes: mine',
    });
  });
});

describe('TomcatService delete and keep', () => {
  function service(over: Partial<Config['tomcat']> = {}) {
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [join(dir, 'build')] }, over);
    const events: HubEvent[] = [];
    const svc = new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'logs') });
    return { svc, events };
  }

  it('deletes from webapps or the disabled folder and notes it on the timeline', async () => {
    tree({ 'webapps/shop.war': 'w', 'webapps/shop/a.txt': 'a', 'disabled/old/x.txt': 'x' });
    const { svc, events } = service();
    expect((await svc.deletePlan('shop', 'webapps')).map((i) => i.name)).toEqual(['shop.war', 'shop']);
    expect(await svc.deleteWebapp('shop', 'webapps', ['shop.war', 'shop'])).toMatch(/^Deleted shop\.war and shop from .*webapps\. Tomcat undeploys it/);
    expect(await svc.deleteWebapp('old', 'disabled', ['old'])).toMatch(/^Deleted old from .*disabled\.$/);
    expect(readdirSync(join(dir, 'webapps'))).toEqual([]);
    expect(events.map((e) => e.summary)).toEqual(['Deleted webapp /shop from webapps: shop.war and shop', 'Deleted webapp /old from disabled: old']);
    await expect(service({ disabledDir: '' }).svc.deleteWebapp('old', 'disabled')).rejects.toThrow(/folder for disabled webapps/);
  });

  it('refuses to delete the Manager it uses', async () => {
    tree({ 'webapps/manager/': '' });
    const { svc } = service({ manager: { url: 'http://127.0.0.1:1/manager/text', username: '', password: '' } });
    await expect(svc.deleteWebapp('manager', 'webapps')).rejects.toThrow(/Tomcat Manager/);
    expect(existsSync(join(dir, 'webapps', 'manager'))).toBe(true);
  });

  async function newBuild(svc: TomcatService, files: Record<string, string>): Promise<string> {
    await svc.warWatcher.tick();
    const file = join(dir, 'build', 'shop-2.0.war');
    await war(file, files);
    await svc.warWatcher.tick();
    return file;
  }

  it('previews and keeps local config from the unpacked folder: replaced and added before Tomcat sees the WAR', async () => {
    tree({ 'build/': '', 'webapps/shop.war': 'old', 'webapps/shop/config.yaml': 'env: mine\n', 'webapps/shop/js/config.js': 'local = 1', 'webapps/shop/index.html': 'old' });
    const { svc, events } = service();
    const file = await newBuild(svc, { 'config.yaml': 'env: build\n', 'index.html': 'new', 'WEB-INF/web.xml': '<web-app/>' });

    const preview = await svc.keepPreview('shop', file);
    expect(preview).toMatchObject({ patterns: ['config.yaml', 'config.js', 'log4j2.xml'], source: { kind: 'folder', where: 'webapps' }, problem: null });
    expect(preview.files).toEqual([
      { path: 'config.yaml', bytes: 10, inWar: true },
      { path: 'js/config.js', bytes: 9, inWar: false },
    ]);
    expect((await svc.keepPreview('nothing-here', file)).source).toBeNull();

    const message = await svc.deploy(file, 'shop', 'remove', ['config.yaml', 'js/config.js']);
    expect(message).toMatch(/Kept config\.yaml \(replaced\) and js\/config\.js \(added\) from the deployed copy\./);
    expect(await warFiles(join(dir, 'webapps', 'shop.war'))).toEqual({
      'config.yaml': 'env: mine\n',
      'index.html': 'new',
      'WEB-INF/web.xml': '<web-app/>',
      'js/config.js': 'local = 1',
    });
    // No temporary file is left for Tomcat to trip over, and the build itself is untouched.
    expect(readdirSync(join(dir, 'webapps')).filter((n) => n.startsWith('.'))).toEqual([]);
    expect(await warFiles(file)).toMatchObject({ 'config.yaml': 'env: build\n' });
    expect(events.at(-1)?.summary).toMatch(/Deployed shop-2\.0\.war as shop\.war .* Kept config\.yaml \(replaced\)/);
    expect(events.at(-1)?.data.kept).toEqual(['config.yaml', 'js/config.js']);
  });

  it('keeps files from a disabled copy it brings back, and deploys plainly without the choice', async () => {
    tree({ 'build/': '', 'webapps/': '', 'disabled/shop/WEB-INF/classes/config.yaml': 'disabled one' });
    const { svc } = service();
    const file = await newBuild(svc, { 'index.html': 'new' });
    expect((await svc.keepPreview('shop', file)).source).toMatchObject({ where: 'disabled' });
    await svc.deploy(file, 'shop', 'remove', ['WEB-INF/classes/config.yaml']);
    expect(await warFiles(join(dir, 'webapps', 'shop.war'))).toEqual({ 'index.html': 'new', 'WEB-INF/classes/config.yaml': 'disabled one' });
    expect(existsSync(join(dir, 'disabled', 'shop'))).toBe(false);

    await svc.deploy(file, 'shop');
    expect(readFileSync(join(dir, 'webapps', 'shop.war'))).toEqual(readFileSync(file));
  });

  it('refuses a kept file that has gone, and a WAR it cannot rewrite, without touching webapps', async () => {
    tree({ 'build/': '', 'webapps/shop.war': 'old', 'webapps/shop/config.yaml': 'mine' });
    const { svc } = service();
    const file = await newBuild(svc, { 'index.html': 'new' });
    await expect(svc.deploy(file, 'shop', 'remove', ['config.js'])).rejects.toMatchObject({ status: 409 });

    // A ZIP64 marker in the build: it cannot be rewritten.
    const buf = readFileSync(file);
    buf.writeUInt16LE(0xffff, buf.length - 12);
    writeFileSync(file, buf);
    await svc.warWatcher.tick();
    await svc.warWatcher.tick();
    expect((await svc.keepPreview('shop', file)).problem).toMatch(/ZIP64/);
    await expect(svc.deploy(file, 'shop', 'remove', ['config.yaml'])).rejects.toThrow(/Deploy it without keeping files/);
    expect(readdirSync(join(dir, 'webapps')).sort()).toEqual(['shop', 'shop.war']);
    expect(readFileSync(join(dir, 'webapps', 'shop.war'), 'utf8')).toBe('old');
  });
});

describe('Tomcat API: delete and keep', () => {
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
    tree({ 'webapps/shop.war': 'w', 'webapps/shop/config.yaml': 'mine', 'build/': '' });
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

  it('previews kept files, plans and deletes', async () => {
    const keep = await (await fetch(`${base}/api/tomcat/keep?name=shop`)).json();
    expect(keep.files).toEqual([{ path: 'config.yaml', bytes: 4, inWar: null }]);

    const plan = await (await fetch(`${base}/api/tomcat/delete?name=shop&from=webapps`)).json();
    expect(plan.items.map((i: any) => i.name)).toEqual(['shop.war', 'shop']);
    expect((await fetch(`${base}/api/tomcat/delete?name=shop&from=elsewhere`)).status).toBe(400);
    expect((await post('/api/tomcat/delete', { name: 'shop', from: 'webapps' })).status).toBe(400);
    expect((await post('/api/tomcat/delete', { name: '../x', from: 'webapps', items: [] })).status).toBe(400);
    const res = await post('/api/tomcat/delete', { name: 'shop', from: 'webapps', items: ['shop.war', 'shop'] });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/^Deleted shop\.war and shop/);
    expect(readdirSync(join(dir, 'webapps'))).toEqual([]);
    const evil = await fetch(`${base}/api/tomcat/delete`, { method: 'POST', headers: { origin: 'http://evil.example' }, body: '{}' });
    expect(evil.status).toBe(403);
  });
});

// Keeps the helper honest: a WAR made by the JDK's jar tool (data descriptors, 0xCAFE marker) survives a rewrite.
describe.skipIf(!(() => {
  try {
    execFileSync('jar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})())('a WAR from the jar tool', () => {
  it('rewrites to a WAR jar can still list and extract', async () => {
    tree({ 'src/index.html': 'hi', 'src/WEB-INF/web.xml': '<web-app/>', 'src/config.yaml': 'build' });
    execFileSync('jar', ['cf', join(dir, 'shop.war'), '-C', join(dir, 'src'), '.']);
    await rewriteZip(join(dir, 'shop.war'), join(dir, 'out.war'), [{ name: 'config.yaml', data: Buffer.from('mine') }]);
    const listing = execFileSync('jar', ['tf', join(dir, 'out.war')]).toString();
    expect(listing).toMatch(/META-INF\/MANIFEST\.MF/);
    mkdirSync(join(dir, 'x'));
    execFileSync('jar', ['xf', join(dir, 'out.war')], { cwd: join(dir, 'x') });
    expect(readFileSync(join(dir, 'x', 'config.yaml'), 'utf8')).toBe('mine');
    expect(readFileSync(join(dir, 'x', 'WEB-INF', 'web.xml'), 'utf8')).toBe('<web-app/>');
  });
});

describe('Show in the file manager', () => {
  it('builds the command for each platform', () => {
    expect(revealCommand('C:/dev/my shop/target/shop.war', true, 'win32')).toEqual({ file: 'explorer.exe', args: ['/select,"C:\\dev\\my shop\\target\\shop.war"'], verbatim: true });
    expect(revealCommand('C:\\tomcat\\webapps', false, 'win32')).toEqual({ file: 'explorer.exe', args: ['"C:\\tomcat\\webapps"'], verbatim: true });
    expect(revealCommand('/Users/me/shop/target/shop.war', true, 'darwin')).toEqual({ file: 'open', args: ['-R', '/Users/me/shop/target/shop.war'], verbatim: false });
    expect(revealCommand('/opt/tomcat/webapps', false, 'darwin')).toEqual({ file: 'open', args: ['/opt/tomcat/webapps'], verbatim: false });
    expect(revealCommand('/home/me/shop/target/shop.war', true, 'linux')).toEqual({ file: 'xdg-open', args: ['/home/me/shop/target'], verbatim: false });
  });

  it('starts it detached, ignores its exit code and reports a missing program', async () => {
    const calls: unknown[] = [];
    const fake = (fail: boolean) => (file: string, args: string[], opts: object) => {
      calls.push([file, args, opts]);
      const handlers: Record<string, (e?: Error) => void> = {};
      setTimeout(() => (fail ? handlers.error?.(new Error('spawn xdg-open ENOENT')) : handlers.spawn?.()), 1);
      return { once: (ev: string, fn: (e?: Error) => void) => (handlers[ev] = fn), unref: () => void calls.push('unref') };
    };
    await reveal('C:/x/a.war', true, { platform: 'win32', spawn: fake(false) });
    expect(calls).toEqual([['explorer.exe', ['/select,"C:\\x\\a.war"'], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }], 'unref']);
    await expect(reveal('/x/a.war', true, { platform: 'linux', spawn: fake(true) })).rejects.toThrow(/Could not start xdg-open: spawn xdg-open ENOENT/);
  });

  it('only shows WARs the watcher knows and webapps in the configured folders', async () => {
    tree({ 'build/a.war': 'x', 'webapps/shop.war': 'w', 'webapps/shop/': '', 'webapps/api.war': 'w' });
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [join(dir, 'build')] });
    const shown: [string, boolean][] = [];
    const svc = new TomcatService(cfg, { emit: () => undefined, onWar: () => undefined }, { scriptLogDir: join(dir, 'logs'), reveal: async (p, s) => void shown.push([p, s]) });
    await svc.warWatcher.tick();
    await svc.reveal({ file: join(dir, 'build', 'a.war') });
    await svc.reveal({ name: 'shop', from: 'webapps' });
    await svc.reveal({ name: 'api', from: 'webapps' });
    await svc.reveal({ from: 'webapps' });
    expect(shown).toEqual([
      [join(dir, 'build', 'a.war'), true],
      [join(dir, 'webapps', 'shop'), true],
      [join(dir, 'webapps', 'api.war'), true],
      [join(dir, 'webapps'), false],
    ]);
    await expect(svc.reveal({ file: '/etc/passwd' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.reveal({ name: '../build', from: 'webapps' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.reveal({ name: 'nothing', from: 'webapps' })).rejects.toMatchObject({ status: 404 });
  });
});
