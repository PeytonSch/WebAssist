import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/server/config';
import { TomcatService } from '../src/server/tomcat/service';
import type { DeployRestart } from '../src/shared/tomcat';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-deploy-restart-'));
  mkdirSync(join(dir, 'webapps'));
  mkdirSync(join(dir, 'build'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A Tomcat as far as the Manager shows it: which webapps are listed, and how commands go. */
interface FakeTomcat {
  down?: boolean;
  apps: Record<string, 'running' | 'stopped'>;
  /** Answers FAIL to these commands. */
  fail?: string[];
  calls: string[];
}

function service(tomcat: FakeTomcat, over: Partial<Config['tomcat']> = {}) {
  const cfg: Config = structuredClone(DEFAULT_CONFIG);
  Object.assign(
    cfg.tomcat,
    { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [join(dir, 'build')], manager: { url: 'http://localhost:8080/manager/text', username: 'u', password: 'p' } },
    over,
  );
  const fetchImpl = (async (input: string | URL) => {
    if (tomcat.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const url = new URL(String(input));
    const cmd = url.pathname.split('/').pop()!;
    const path = url.searchParams.get('path') ?? '';
    if (cmd === 'list') {
      const lines = Object.entries(tomcat.apps).map(([n, st]) => `/${n}:${st}:0:${n}`);
      return new Response(`OK - Listed applications for virtual host [localhost]\n${lines.join('\n')}\n`);
    }
    tomcat.calls.push(`${cmd} ${path}`);
    if (tomcat.fail?.includes(cmd)) return new Response(`FAIL - Application at context path [${path}] could not be ${cmd}ed\n`);
    if (cmd === 'start') tomcat.apps[path.slice(1)] = 'running';
    return new Response(`OK - ${cmd} application at context path [${path}]\n`);
  }) as typeof fetch;
  const events: HubEvent[] = [];
  const svc = new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'logs'), fetch: fetchImpl, deployRestartPollMs: 10, deployRestartWaitMs: 400 });
  return { svc, events };
}

async function build(svc: TomcatService): Promise<string> {
  await svc.warWatcher.tick();
  const file = join(dir, 'build', 'shop-2.0.war');
  writeFileSync(file, 'new build');
  await svc.warWatcher.tick();
  return file;
}

/** An unpacked folder Tomcat made before this deploy. */
function oldFolder(name: string): void {
  mkdirSync(join(dir, 'webapps', name), { recursive: true });
  writeFileSync(join(dir, 'webapps', name, 'index.html'), 'old');
  const past = new Date(Date.now() - 3600_000);
  utimesSync(join(dir, 'webapps', name), past, past);
}

/** What Tomcat does when it notices the new WAR: unpacks it afresh. */
function unpack(name: string): void {
  rmSync(join(dir, 'webapps', name), { recursive: true, force: true });
  mkdirSync(join(dir, 'webapps', name));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ended(svc: TomcatService, name: string): Promise<DeployRestart> {
  for (let i = 0; i < 200; i++) {
    const r = (await svc.state()).deployRestarts.find((d) => d.name === name);
    if (r?.endedAt) return r;
    await sleep(10);
  }
  throw new Error('the restart did not end');
}

describe('restart after deploy', () => {
  it('waits until Tomcat has deployed the new WAR, then reloads it', async () => {
    oldFolder('shop');
    writeFileSync(join(dir, 'webapps', 'shop.war'), 'old');
    const tomcat: FakeTomcat = { apps: { shop: 'running' }, calls: [] };
    const { svc, events } = service(tomcat);
    const file = await build(svc);

    const message = await svc.deploy(file, 'shop');
    expect(message).toMatch(/Debug Hub restarts it once Tomcat has deployed it\.$/);
    expect((await svc.state()).deployRestarts).toMatchObject([{ name: 'shop', phase: 'waiting', endedAt: null }]);
    // The folder is still the old build's: not yet.
    await sleep(80);
    expect(tomcat.calls).toEqual([]);

    unpack('shop');
    const r = await ended(svc, 'shop');
    expect(r).toMatchObject({ phase: 'done', message: 'Reloaded /shop after the deploy.' });
    expect(tomcat.calls).toEqual(['reload /shop']);
    expect(events.at(-1)).toMatchObject({ level: 'info', summary: 'Reloaded /shop after the deploy.', data: { webapp: 'shop', action: 'restart-after-deploy' } });
  });

  it('starts a webapp that did not start, which cannot be reloaded', async () => {
    const tomcat: FakeTomcat = { apps: {}, fail: ['reload'], calls: [] };
    const { svc } = service(tomcat);
    const file = await build(svc);
    await svc.deploy(file, 'shop');
    // A new webapp: listed once Tomcat has deployed it, stopped because it failed to start.
    tomcat.apps.shop = 'stopped';
    unpack('shop');
    expect(await ended(svc, 'shop')).toMatchObject({ phase: 'done', message: 'Started /shop after the deploy.' });
    expect(tomcat.calls).toEqual(['reload /shop', 'start /shop']);
  });

  it('says so when neither works', async () => {
    const tomcat: FakeTomcat = { apps: { shop: 'stopped' }, fail: ['reload', 'start'], calls: [] };
    const { svc, events } = service(tomcat);
    const file = await build(svc);
    await svc.deploy(file, 'shop');
    unpack('shop');
    const r = await ended(svc, 'shop');
    expect(r.phase).toBe('failed');
    expect(r.message).toMatch(/^Could not restart \/shop after the deploy: Tomcat: Application at context path \[\/shop\] could not be started/);
    expect(events.at(-1)?.level).toBe('warn');
  });

  it('leaves it alone when Tomcat is not running: it deploys the WAR when it starts', async () => {
    const tomcat: FakeTomcat = { down: true, apps: {}, calls: [] };
    const { svc } = service(tomcat);
    const file = await build(svc);
    await svc.deploy(file, 'shop');
    expect(await ended(svc, 'shop')).toMatchObject({ phase: 'skipped', message: expect.stringMatching(/Tomcat is not running.*Tomcat deploys the new WAR when it starts\./) });
  });

  it('reloads anyway once the wait is over, if Tomcat never visibly redeployed it', async () => {
    oldFolder('shop');
    writeFileSync(join(dir, 'webapps', 'shop.war'), 'old');
    const tomcat: FakeTomcat = { apps: { shop: 'running' }, calls: [] };
    const { svc, events } = service(tomcat);
    await svc.deploy(await build(svc), 'shop');
    const r = await ended(svc, 'shop');
    expect(r).toMatchObject({ phase: 'done', message: expect.stringMatching(/^Reloaded \/shop after the deploy, though Tomcat had not visibly redeployed/) });
    expect(events.at(-1)?.level).toBe('warn');
  });

  it('fails when Tomcat never deploys it', async () => {
    const tomcat: FakeTomcat = { apps: {}, calls: [] };
    const { svc } = service(tomcat);
    await svc.deploy(await build(svc), 'shop');
    expect(await ended(svc, 'shop')).toMatchObject({ phase: 'failed', message: expect.stringMatching(/Tomcat had not deployed it after 0 s\. Is autoDeploy on/) });
    expect(tomcat.calls).toEqual([]);
  });

  it('is skipped when turned off, for one deploy or in the settings, and without the Manager', async () => {
    const tomcat: FakeTomcat = { apps: { shop: 'running' }, calls: [] };
    const off = service(tomcat);
    const file = await build(off.svc);
    expect(await off.svc.deploy(file, 'shop', 'remove', [], [], { restart: false })).not.toMatch(/restarts it/);
    expect((await off.svc.state()).deployRestarts).toEqual([]);

    const setting = service(tomcat, { restartAfterDeploy: false });
    expect(await setting.svc.deploy(await build(setting.svc), 'shop')).not.toMatch(/restarts it/);
    // Asked for this once, though the setting is off.
    expect(await setting.svc.deploy(await build(setting.svc), 'shop', 'remove', [], [], { restart: true })).toMatch(/restarts it/);

    const noManager = service(tomcat, { manager: { url: '', username: '', password: '' } });
    expect(await noManager.svc.deploy(await build(noManager.svc), 'shop')).not.toMatch(/restarts it/);
    expect((await noManager.svc.state()).deployRestarts).toEqual([]);
    await sleep(50);
  });

  it('a second deploy replaces the restart still waiting for the first', async () => {
    const tomcat: FakeTomcat = { apps: { shop: 'running' }, calls: [] };
    oldFolder('shop');
    writeFileSync(join(dir, 'webapps', 'shop.war'), 'old');
    const { svc } = service(tomcat);
    const file = await build(svc);
    await svc.deploy(file, 'shop');
    await sleep(30);
    await svc.deploy(file, 'shop');
    expect((await svc.state()).deployRestarts).toHaveLength(1);
    unpack('shop');
    await ended(svc, 'shop');
    await sleep(50);
    expect(tomcat.calls).toEqual(['reload /shop']);
  });
});
