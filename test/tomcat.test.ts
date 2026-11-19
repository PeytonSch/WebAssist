import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import { appParams, managerCommand, managerList, nameFromPath, parseList } from '../src/server/tomcat/manager';
import { scriptCommand, ScriptRunner } from '../src/server/tomcat/scripts';
import { TomcatService } from '../src/server/tomcat/service';
import { findWars, looksComplete, WarWatcher, type WatchedWar } from '../src/server/tomcat/warwatch';
import { checkName, contextPath, deployWar, guessTarget, listApps, moveApp, stripVersion, TomcatError } from '../src/server/tomcat/webapps';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-tomcat-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal zip: just the end-of-central-directory record, which is what marks a complete file. */
function zip(extra = ''): Buffer {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  return Buffer.concat([Buffer.from(`PK\x03\x04${extra}`), eocd]);
}

function tree(files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    if (rel.endsWith('/')) mkdirSync(path, { recursive: true });
    else writeFileSync(path, content);
  }
}

describe('webapp names', () => {
  it('accepts Tomcat base names and refuses anything that could escape the folder', () => {
    for (const ok of ['ROOT', 'shop', 'api#v2', 'shop##3', 'my-app_1.2', 'Ünïcode']) expect(checkName(ok)).toBeNull();
    for (const bad of ['', '..', '../x', 'a/b', 'a\\b', '.hidden', 'x..y', 'C:', 'con', 'nul.txt', 'trailing.', 'a\u0000b', 'a:b']) {
      expect(checkName(bad), bad).not.toBeNull();
    }
  });

  it('maps names to context paths and back', () => {
    expect(contextPath('ROOT')).toBe('/');
    expect(contextPath('shop')).toBe('/shop');
    expect(contextPath('api#v2##3')).toBe('/api/v2');
    expect(appParams('shop##3')).toEqual({ path: '/shop', version: '3' });
    expect(appParams('ROOT')).toEqual({ path: '/' });
    expect(nameFromPath('/api/v2', '3')).toBe('api#v2##3');
    expect(nameFromPath('/')).toBe('ROOT');
  });
});

describe('listApps', () => {
  it('groups WARs and unpacked folders by name and ignores hidden and other files', async () => {
    tree({
      'webapps/ROOT/': '',
      'webapps/shop.war': 'x'.repeat(10),
      'webapps/shop/': '',
      'webapps/admin.WAR': 'y',
      'webapps/.shop.ab12.debughub-tmp': 'partial',
      'webapps/.git/': '',
      'webapps/notes.txt': '',
      'webapps/half.war.tmp': '',
    });
    const apps = await listApps(join(dir, 'webapps'));
    expect(apps.map((a) => [a.name, a.hasWar, a.hasDir, a.bytes])).toEqual([
      ['ROOT', false, true, null],
      ['admin', true, false, 1],
      ['shop', true, true, 10],
    ]);
    expect(apps[0].modified).toMatch(/^\d{4}-/);
  });
});

describe('moveApp', () => {
  it('moves the WAR and the unpacked folder together, and back', async () => {
    tree({ 'webapps/shop.war': 'war', 'webapps/shop/WEB-INF/web.xml': '<web-app/>', 'webapps/other.war': 'o' });
    const webapps = join(dir, 'webapps');
    const disabled = join(dir, 'disabled');
    const { moved } = await moveApp('shop', webapps, disabled);
    expect(moved).toEqual(['shop.war', 'shop']);
    expect(readdirSync(webapps)).toEqual(['other.war']);
    expect(readFileSync(join(disabled, 'shop', 'WEB-INF', 'web.xml'), 'utf8')).toBe('<web-app/>');

    await moveApp('shop', disabled, webapps);
    expect(readdirSync(webapps).sort()).toEqual(['other.war', 'shop', 'shop.war']);
    expect(readdirSync(disabled)).toEqual([]);
  });

  it('never overwrites, and refuses bad names and missing webapps', async () => {
    tree({ 'webapps/shop.war': 'new', 'disabled/shop.war': 'old' });
    const webapps = join(dir, 'webapps');
    const disabled = join(dir, 'disabled');
    await expect(moveApp('shop', webapps, disabled)).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(disabled, 'shop.war'), 'utf8')).toBe('old');
    expect(readFileSync(join(webapps, 'shop.war'), 'utf8')).toBe('new');
    await expect(moveApp('../shop', webapps, disabled)).rejects.toBeInstanceOf(TomcatError);
    await expect(moveApp('nope', webapps, disabled)).rejects.toMatchObject({ status: 404 });
  });
});

describe('deploy', () => {
  it('guesses the webapp a WAR belongs to', () => {
    expect(stripVersion('shop-1.4.0-SNAPSHOT')).toBe('shop');
    expect(stripVersion('order-service-2.0')).toBe('order-service');
    expect(stripVersion('app-2fa')).toBe('app-2fa');
    expect(stripVersion('shop-20261116.101500-3')).toBe('shop');
    expect(['shop_1.4.0', 'shop.1.4.0', 'shop-v1.4', 'shop_V2', 'shop-1.4.0-prod'].map(stripVersion)).toEqual(['shop', 'shop', 'shop', 'shop', 'shop']);
    expect(['com.acme.shop', 'log4j-web', 'app-2fa', 'shop2', '2048'].map(stripVersion)).toEqual(['com.acme.shop', 'log4j-web', 'app-2fa', 'shop2', '2048']);
    expect(guessTarget('/b/shop-1.4.0-SNAPSHOT.war', ['ROOT', 'shop'])).toBe('shop');
    expect(guessTarget('/b/shop-1.4.0.war', ['shop-1.4.0'])).toBe('shop-1.4.0');
    expect(guessTarget('/b/Shop-1.0.war', ['shop'])).toBe('shop');
    expect(guessTarget('/b/brand-new-0.1.war', [])).toBe('brand-new');
    expect(guessTarget('/b/ROOT.war', [])).toBe('ROOT');
  });

  it('copies under a name Tomcat ignores, then renames into place', async () => {
    tree({ 'build/shop-1.0.war': zip('v2'), 'webapps/shop.war': 'v1' });
    const webapps = join(dir, 'webapps');
    const seen: string[][] = [];
    // Watch the folder while deploying: no moment may show a partial shop.war.
    const timer = setInterval(() => seen.push(readdirSync(webapps)), 0);
    const out = await deployWar(join(dir, 'build', 'shop-1.0.war'), webapps, 'shop');
    clearInterval(timer);
    expect(out.replaced).toBe(true);
    expect(readFileSync(join(webapps, 'shop.war'))).toEqual(zip('v2'));
    expect(readdirSync(webapps)).toEqual(['shop.war']);
    for (const names of seen) for (const n of names) expect(n === 'shop.war' || !/\.war$/i.test(n)).toBe(true);
  });

  it('refuses to put a WAR beside a folder deployed without one', async () => {
    tree({ 'build/shop.war': zip(), 'webapps/shop/index.html': 'hi' });
    await expect(deployWar(join(dir, 'build', 'shop.war'), join(dir, 'webapps'), 'shop')).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(join(dir, 'webapps'))).toEqual(['shop']);
  });
});

describe('WarWatcher', () => {
  it('lists WARs already there without reporting them, then reports a build once it holds still', async () => {
    tree({ 'target/old.war': zip() });
    const reported: WatchedWar[] = [];
    const w = new WarWatcher([join(dir, 'target')], { pollMs: 60_000, onNew: (x) => reported.push(x) });
    await w.tick();
    await w.tick();
    expect(w.list().map((x) => x.file)).toEqual([join(dir, 'target', 'old.war')]);
    expect(reported).toEqual([]);

    // A build writes the file in pieces.
    writeFileSync(join(dir, 'target', 'shop.war'), 'PK\x03\x04 half');
    await w.tick();
    await w.tick();
    expect(reported).toEqual([]); // stable, but not a complete zip yet
    writeFileSync(join(dir, 'target', 'shop.war'), zip('done'));
    await w.tick();
    expect(reported).toEqual([]); // changed since the last look
    await w.tick();
    expect(reported.map((x) => x.file)).toEqual([join(dir, 'target', 'shop.war')]);
    await w.tick();
    expect(reported).toHaveLength(1);

    // A rebuild of an existing WAR counts too.
    writeFileSync(join(dir, 'target', 'old.war'), zip('rebuilt'));
    utimesSync(join(dir, 'target', 'old.war'), new Date(), new Date(Date.now() + 5000));
    await w.tick();
    await w.tick();
    expect(reported.map((x) => x.file.split(/[\\/]/).pop())).toEqual(['shop.war', 'old.war']);
    expect(w.get(join(dir, 'target', 'old.war'))?.fresh).toBe(true);
    w.settle(join(dir, 'target', 'old.war'));
    expect(w.get(join(dir, 'target', 'old.war'))?.fresh).toBe(false);
  });

  it('expands * in folder names and explains a missing folder', async () => {
    tree({ 'dev/a/target/a-1.0.war': zip(), 'dev/b/target/b.war': zip(), 'dev/b/target/b.jar': '' });
    const { files } = await findWars(join(dir, 'dev', '*', 'target'));
    expect(files.map((f) => f.split(/[\\/]/).pop()).sort()).toEqual(['a-1.0.war', 'b.war']);
    expect((await findWars(join(dir, 'dev', 'b', 'target', '*.war'))).files).toHaveLength(1);
    expect((await findWars(join(dir, 'nope'))).problem).toMatch(/Folder not found/);
    expect(await looksComplete(join(dir, 'dev', 'b', 'target', 'b.jar'))).toBe(false);
  });
});

describe('scriptCommand', () => {
  it('runs .bat files through cmd.exe with the whole path quoted', () => {
    const c = scriptCommand('C:/Program Files/Tomcat 9/bin/startup.bat', { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(c.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(c.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\Tomcat 9\\bin\\startup.bat""']);
    expect(c.verbatim).toBe(true);
    expect(scriptCommand('D:\\x\\stop.CMD', { platform: 'win32' }).file).toBe('cmd.exe');
    expect(scriptCommand('D:/x/start.ps1', { platform: 'win32' }).file).toBe('powershell.exe');
    expect(scriptCommand('D:/x/tomcat.exe', { platform: 'win32' })).toMatchObject({ file: 'D:\\x\\tomcat.exe', args: [] });
    expect(() => scriptCommand('C:/100%/start.bat', { platform: 'win32' })).toThrow(TomcatError);
  });

  it('runs scripts directly elsewhere, through sh when not executable', () => {
    expect(scriptCommand('/opt/tomcat/bin/startup.sh', { platform: 'linux', executable: true })).toMatchObject({ file: '/opt/tomcat/bin/startup.sh', args: [] });
    expect(scriptCommand('/opt/my scripts/up.sh', { platform: 'darwin', executable: false })).toMatchObject({ file: '/bin/sh', args: ['/opt/my scripts/up.sh'] });
  });
});

describe.skipIf(process.platform === 'win32')('ScriptRunner', () => {
  it('runs a script in its own folder, captures its output and exit code, and does not wait for it', async () => {
    tree({ 'my bin/start.sh': 'echo "starting in $(pwd)"\necho oops >&2\nexit 3\n' });
    const script = join(dir, 'my bin', 'start.sh');
    let exited!: () => void;
    const done = new Promise<void>((resolve) => (exited = resolve));
    const runner = new ScriptRunner(join(dir, 'logs'), { onExit: () => exited() });
    expect((await runner.run('start', script)).command).toContain('/bin/sh');
    await done;
    const run = (await runner.snapshot('start'))!;
    expect(run.exitCode).toBe(3);
    expect(run.running).toBe(false);
    expect(run.output).toContain(`starting in ${join(dir, 'my bin')}`);
    expect(run.output).toContain('oops');
  });

  it('reports a script that keeps running, and refuses a second start meanwhile', async () => {
    tree({ 'fg.sh': '#!/bin/sh\necho up\nexec sleep 5\n' });
    chmodSync(join(dir, 'fg.sh'), 0o755);
    const runner = new ScriptRunner(join(dir, 'logs'));
    const run = await runner.run('start', join(dir, 'fg.sh'));
    expect(run.running).toBe(true);
    expect(run.pid).toBeGreaterThan(0);
    await expect(runner.run('start', join(dir, 'fg.sh'))).rejects.toMatchObject({ status: 409 });
    process.kill(run.pid!);
    await expect(runner.run('stop', join(dir, 'missing.sh'))).rejects.toMatchObject({ status: 404 });
  });
});

describe('Tomcat Manager', () => {
  let server: Server;
  let url: string;
  const calls: string[] = [];
  beforeEach(async () => {
    calls.length = 0;
    server = createServer((req, res) => {
      calls.push(req.url!);
      if (req.headers.authorization !== `Basic ${Buffer.from('admin:s3cret').toString('base64')}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url!.startsWith('/manager/text/list')) {
        res.end('OK - Listed applications for virtual host [localhost]\n/:running:0:ROOT\n/shop:stopped:0:shop\n/ext:running:2:C:\\apps\\ext\n/manager:running:0:manager\n');
      } else if (req.url!.startsWith('/manager/text/start?path=%2Fmissing')) {
        res.end('FAIL - No context exists named [/missing]\n');
      } else res.end('OK - Started application at context path [/shop]\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as any).port}/manager/text`;
  });
  afterEach(() => server.close());

  it('lists webapps, runs commands and explains failures', async () => {
    const mgr = { url, username: 'admin', password: 's3cret' };
    const list = await managerList(mgr);
    expect(list.map((a) => [a.name, a.state, a.sessions])).toEqual([
      ['ROOT', 'running', 0],
      ['shop', 'stopped', 0],
      ['ext', 'running', 2],
      ['manager', 'running', 0],
    ]);
    expect(await managerCommand(mgr, 'start', { path: '/shop' })).toMatch(/Started/);
    expect(calls.at(-1)).toBe('/manager/text/start?path=%2Fshop');
    await expect(managerCommand(mgr, 'start', { path: '/missing' })).rejects.toThrow(/No context exists/);
    await expect(managerList({ ...mgr, password: 'wrong' })).rejects.toThrow(/manager-script/);
    const closed = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as any).port;
        probe.close(() => resolve(p));
      });
    });
    await expect(managerList({ ...mgr, url: `http://127.0.0.1:${closed}/manager/text` })).rejects.toThrow(/not running/);
    expect(parseList('/x:running::x')).toEqual([{ path: '/x', state: 'running', sessions: null, docBase: 'x', name: 'x' }]);
  });

  it('merges Manager state into the webapps folder listing', async () => {
    tree({ 'webapps/ROOT/': '', 'webapps/shop.war': zip(), 'webapps/new.war': zip(), 'disabled/old.war': zip() });
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    cfg.tomcat.webappsDir = join(dir, 'webapps');
    cfg.tomcat.disabledDir = join(dir, 'disabled');
    cfg.tomcat.manager = { url, username: 'admin', password: 's3cret' };
    const svc = new TomcatService(cfg, { emit: () => undefined, onWar: () => undefined }, { scriptLogDir: join(dir, 'logs') });
    const st = await svc.state();
    expect(st.manager).toMatchObject({ configured: true, ok: true, error: null });
    expect(st.webapps.map((a) => [a.name, a.state, a.external])).toEqual([
      ['ROOT', 'running', false],
      ['new', 'not-loaded', false],
      ['shop', 'stopped', false],
      ['ext', 'running', true],
      ['manager', 'running', true],
    ]);
    expect(st.disabled.map((a) => [a.name, a.state])).toEqual([['old', 'disabled']]);
  });
});

describe('TomcatService', () => {
  function service(over: Partial<Config['tomcat']> = {}) {
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [join(dir, 'build')] }, over);
    const events: HubEvent[] = [];
    const wars: string[] = [];
    const svc = new TomcatService(cfg, { emit: (e) => events.push(e), onWar: (w) => wars.push(`${w.name}->${w.target}`) }, { scriptLogDir: join(dir, 'logs') });
    return { svc, events, wars };
  }

  it('disables and enables without a Manager, noting each on the timeline', async () => {
    tree({ 'webapps/shop.war': zip(), 'webapps/shop/': '' });
    const { svc, events } = service();
    expect(await svc.webappAction('shop', 'disable')).toMatch(/Disabled shop/);
    expect(existsSync(join(dir, 'disabled', 'shop.war'))).toBe(true);
    expect((await svc.state()).disabled.map((a) => a.name)).toEqual(['shop']);
    await svc.webappAction('shop', 'enable');
    expect(readdirSync(join(dir, 'webapps')).sort()).toEqual(['shop', 'shop.war']);
    expect(events.map((e) => e.summary)).toEqual([expect.stringMatching(/^Disabled webapp \/shop/), expect.stringMatching(/^Enabled webapp \/shop/)]);
    await expect(svc.webappAction('shop', 'stop')).rejects.toThrow(/needs the Tomcat Manager/);
  });

  it('refuses a disabled folder inside webapps', async () => {
    tree({ 'webapps/shop.war': zip() });
    const { svc } = service({ disabledDir: join(dir, 'webapps', 'off') });
    expect((await svc.state()).problems.map((p) => p.key)).toContain('disabledDir');
    await expect(svc.webappAction('shop', 'disable')).rejects.toThrow(/inside the webapps folder/);
  });

  it('notifies about a new build and deploys it over a disabled copy', async () => {
    tree({ 'build/': '', 'disabled/shop.war': 'old', 'disabled/shop/': '', 'webapps/': '' });
    const { svc, wars } = service();
    const w = svc.warWatcher;
    await w.tick();
    writeFileSync(join(dir, 'build', 'shop-2.0.0-SNAPSHOT.war'), zip('v2'));
    await w.tick();
    await w.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(wars).toEqual(['shop-2.0.0-SNAPSHOT.war->shop']);
    const file = join(dir, 'build', 'shop-2.0.0-SNAPSHOT.war');
    expect((await svc.state()).wars[0]).toMatchObject({ file, target: 'shop', fresh: true });

    await expect(svc.deploy(join(dir, 'elsewhere.war'), 'shop')).rejects.toMatchObject({ status: 404 });
    expect(await svc.deploy(file, 'shop')).toMatch(/old disabled copy was removed/);
    expect(readdirSync(join(dir, 'webapps'))).toEqual(['shop.war']);
    expect(readdirSync(join(dir, 'disabled'))).toEqual([]);
    expect((await svc.state()).wars[0].fresh).toBe(false);
  });

  it('keeps fresh builds across a settings change', async () => {
    tree({ 'build/': '' });
    const { svc } = service();
    await svc.warWatcher.tick();
    writeFileSync(join(dir, 'build', 'a.war'), zip());
    await svc.warWatcher.tick();
    await svc.warWatcher.tick();
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    cfg.tomcat.warWatch = [join(dir, 'build')];
    svc.reconfigure(cfg);
    await svc.warWatcher.tick();
    expect(svc.warWatcher.list()[0]).toMatchObject({ fresh: true });
  });
});

describe.skipIf(process.platform === 'win32')('script output on the timeline', () => {
  it('turns the script’s output into Tomcat log events, framed by start and finish', async () => {
    tree({ 'bin/startup.sh': 'echo "Using CATALINA_BASE: /x"\necho "Tomcat started."\n' });
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    cfg.tomcat.startScript = join(dir, 'bin', 'startup.sh');
    cfg.tail.pollMs = 20;
    cfg.tail.flushMs = 20;
    const events: HubEvent[] = [];
    const svc = new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'logs') });
    await svc.runScript('start');
    for (let i = 0; i < 100 && !events.some((e) => /finished/.test(e.summary)); i++) await new Promise((r) => setTimeout(r, 20));
    await svc.stop();
    expect(events.map((e) => [e.source, e.summary])).toEqual([
      ['tomcat', 'Ran Tomcat start script startup.sh'],
      ['tomcat', 'startup.sh: Using CATALINA_BASE: /x'],
      ['tomcat', 'Tomcat start script startup.sh finished with exit code 0'],
    ]);
    expect(events[1].data.message).toBe('Using CATALINA_BASE: /x\nTomcat started.');
  });
});

describe('Tomcat API', () => {
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
    tree({ 'webapps/shop.war': zip(), 'build/': '' });
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

  it('serves the state, runs actions and refuses other origins', async () => {
    const state = await (await fetch(`${base}/api/tomcat`)).json();
    expect(state.webapps.map((a: any) => a.name)).toEqual(['shop']);
    const res = await post('/api/tomcat/webapps/shop/disable');
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/Disabled shop/);
    expect(existsSync(join(dir, 'disabled', 'shop.war'))).toBe(true);
    expect((await post(`/api/tomcat/webapps/${encodeURIComponent('../x')}/enable`)).status).toBe(400);
    expect((await post('/api/tomcat/webapps/shop/explode')).status).toBe(404);
    expect((await post('/api/tomcat/server/start')).status).toBe(400);
    const evil = await fetch(`${base}/api/tomcat/webapps/shop/enable`, { method: 'POST', headers: { origin: 'http://evil.example' } });
    expect(evil.status).toBe(403);
  });

  it('pushes new WARs over the WebSocket and deploys them', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const messages: any[] = [];
    ws.on('message', (m) => messages.push(JSON.parse(String(m))));
    await new Promise((r) => ws.once('open', r));
    const w = hub.tomcat.warWatcher;
    await w.tick();
    writeFileSync(join(dir, 'build', 'shop-1.1.war'), zip('new'));
    await w.tick();
    await w.tick();
    for (let i = 0; i < 50 && !messages.some((m) => m.type === 'war'); i++) await new Promise((r) => setTimeout(r, 10));
    const war = messages.find((m) => m.type === 'war').war;
    expect(war).toMatchObject({ name: 'shop-1.1.war', target: 'shop', fresh: true });
    ws.close();

    const res = await post('/api/tomcat/deploy', { file: war.file, name: 'shop' });
    expect((await res.json()).message).toMatch(/redeploys \/shop/);
    expect(readFileSync(join(dir, 'webapps', 'shop.war'))).toEqual(zip('new'));
    expect((await (await fetch(`${base}/api/tomcat/wars`)).json())[0].fresh).toBe(false);
  });
});
