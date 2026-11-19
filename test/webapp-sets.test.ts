import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/server/config';
import { TomcatService } from '../src/server/tomcat/service';
import { planSet, SETS_FILE, validateSet, WebappSetStore } from '../src/server/tomcat/sets';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-sets-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    if (!rel.endsWith('/')) writeFileSync(path, content);
  }
}
const ls = (sub: string) => (existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).sort() : []);

describe('webapp set plans', () => {
  it('disables what is not in the set, enables what is, and lists what is nowhere', () => {
    const plan = planSet({ webapps: ['ROOT', 'shop', 'admin', 'reports'] }, ['ROOT', 'shop', 'billing', 'docs', 'manager'], ['admin', 'old'], (n) => n === 'manager');
    expect(plan).toEqual({ disable: ['billing', 'docs'], enable: ['admin'], missing: ['reports'], kept: ['manager'] });
    expect(planSet({ webapps: ['a'] }, ['a'], [], () => false)).toEqual({ disable: [], enable: [], missing: [], kept: [] });
    // Deployed and disabled under the same name: it counts as deployed.
    expect(planSet({ webapps: ['a'] }, ['a'], ['a'], () => false).enable).toEqual([]);
  });

  it('checks names, and tidies the list', () => {
    expect(validateSet({ name: '  Checkout bug ', webapps: ['shop', ' ROOT', 'shop', 'admin##2'] })).toEqual({ set: { name: 'Checkout bug', webapps: ['admin##2', 'ROOT', 'shop'] }, errors: [] });
    const bad = validateSet({ name: '', webapps: ['../x', 7] });
    expect(bad.errors.map((e) => e.path)).toEqual(['name', 'webapps.0', 'webapps.1']);
  });
});

describe('webapp set store', () => {
  it('saves, renames, refuses a second set of the same name, and deletes', () => {
    const store = new WebappSetStore(join(dir, SETS_FILE));
    expect(store.list()).toEqual([]);
    store.save({ name: 'Billing', webapps: ['billing', 'ROOT'] });
    store.save({ name: 'checkout', webapps: ['shop'] });
    expect(store.list().map((s) => [s.name, s.webapps])).toEqual([
      ['Billing', ['billing', 'ROOT']],
      ['checkout', ['shop']],
    ]);
    expect(() => store.save({ name: 'BILLING', webapps: [] })).toThrow(/already a set called Billing/);
    expect(() => store.save({ name: 'billing', webapps: [] }, 'checkout')).toThrow(/already a set called Billing/);
    // Saving a set under its own name, in another case, renames it.
    store.save({ name: 'BILLING', webapps: ['billing'] }, 'Billing');
    store.save({ name: 'Billing', webapps: ['billing', 'ROOT'] }, 'BILLING');
    // Changing a set keeps one of it, under its new name.
    store.save({ name: 'Checkout bug', webapps: ['shop', 'admin'] }, 'checkout');
    expect(store.list().map((s) => s.name)).toEqual(['Billing', 'Checkout bug']);
    expect(store.get('checkout bug').webapps).toEqual(['admin', 'shop']);
    store.delete('billing');
    expect(store.list().map((s) => s.name)).toEqual(['Checkout bug']);
    expect(() => store.delete('nope')).toThrow(/no set called nope/);
    expect(JSON.parse(readFileSync(join(dir, SETS_FILE), 'utf8'))).toMatchObject({ version: 1, sets: [{ name: 'Checkout bug' }] });
  });

  it('keeps an unreadable file aside rather than overwriting it, and skips bad entries', () => {
    const file = join(dir, SETS_FILE);
    writeFileSync(file, JSON.stringify({ version: 1, sets: [{ name: 'A', webapps: ['ok', '../bad'] }, { name: '' }, { name: 'a' }] }));
    const store = new WebappSetStore(file);
    expect(store.list()).toEqual([{ name: 'A', webapps: ['ok'], updated: new Date(0).toISOString() }]);
    writeFileSync(file, '{ not json');
    expect(store.list()).toEqual([]);
    expect(store.problem).toMatch(/Could not read/);
    store.save({ name: 'New', webapps: [] });
    expect(readdirSync(dir).filter((f) => f.includes('.broken-'))).toHaveLength(1);
    expect(store.list().map((s) => s.name)).toEqual(['New']);
  });
});

describe('applying a webapp set', () => {
  function service(manager?: { running: string[] }) {
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'webapps'), disabledDir: join(dir, 'disabled'), warWatch: [] });
    const calls: string[] = [];
    let fetchImpl: typeof fetch | undefined;
    if (manager) {
      cfg.tomcat.manager = { ...cfg.tomcat.manager, url: 'http://localhost:8080/manager/text', username: 'u', password: 'p' };
      fetchImpl = (async (input: string | URL) => {
        const url = new URL(String(input));
        const cmd = url.pathname.split('/').pop()!;
        calls.push(`${cmd} ${url.searchParams.get('path') ?? ''}`.trim());
        if (cmd === 'list') {
          const lines = ['/manager:running:0:manager', ...manager.running.map((n) => `/${n}:running:0:${n}`)];
          return new Response(`OK - Listed applications for virtual host [localhost]\n${lines.join('\n')}\n`);
        }
        if (cmd === 'stop') manager.running = manager.running.filter((n) => `/${n}` !== url.searchParams.get('path'));
        return new Response(`OK - ${cmd} application at context path [${url.searchParams.get('path')}]\n`);
      }) as typeof fetch;
    }
    const events: HubEvent[] = [];
    const svc = new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'logs'), fetch: fetchImpl });
    svc.useDataDir(dir);
    return { svc, events, calls };
  }

  it('moves what is not in the set out, brings what is back, and says what it did', async () => {
    tree({ 'webapps/ROOT.war': 'r', 'webapps/shop.war': 's', 'webapps/billing.war': 'b', 'webapps/billing/x.txt': 'x', 'disabled/admin.war': 'a', 'disabled/old.war': 'o' });
    const { svc, events } = service();
    svc.saveSet({ name: 'Admin task', webapps: ['ROOT', 'admin', 'reports'] });
    const before = (await svc.state()).sets.list[0];
    expect(before).toMatchObject({ current: false, plan: { disable: ['billing', 'shop'], enable: ['admin'], missing: ['reports'], kept: [] } });

    const r = await svc.applySet('admin task');
    expect(r).toMatchObject({ disabled: ['billing', 'shop'], enabled: ['admin'], missing: ['reports'], failed: [] });
    expect(r.message).toBe('Applied Admin task: disabled billing, shop; enabled admin. Not found, deploy to add: reports.');
    expect(ls('webapps')).toEqual(['ROOT.war', 'admin.war']);
    expect(ls('disabled')).toEqual(['billing', 'billing.war', 'old.war', 'shop.war']);
    expect((await svc.state()).sets).toMatchObject({ list: [{ current: true }], applying: null });
    expect(events.some((e) => e.summary.startsWith('Applied Admin task'))).toBe(true);

    // Applied again: nothing to move.
    expect((await svc.applySet('Admin task')).message).toBe('Admin task is already what is deployed. Not found, deploy to add: reports.');
    await expect(svc.applySet('nope')).rejects.toThrow(/no set called nope/);
  });

  it('stops running webapps before moving them, and never disables the Manager', async () => {
    tree({ 'webapps/shop.war': 's', 'webapps/billing.war': 'b', 'webapps/manager/index.html': 'm', 'disabled/admin.war': 'a' });
    const { svc, calls } = service({ running: ['shop', 'billing'] });
    svc.saveSet({ name: 'Admin', webapps: ['admin'] });
    expect((await svc.state()).sets.list[0].plan).toMatchObject({ disable: ['billing', 'shop'], kept: ['manager'] });
    const r = await svc.applySet('Admin');
    expect(r.failed).toEqual([]);
    expect(calls.filter((c) => c.startsWith('stop'))).toEqual(['stop /billing', 'stop /shop']);
    expect(ls('webapps')).toEqual(['admin.war', 'manager']);
  });

  it('goes on past a webapp that cannot be moved, and says which', async () => {
    tree({ 'webapps/shop.war': 's', 'webapps/billing.war': 'b', 'disabled/shop.war': 'older copy', 'disabled/admin.war': 'a' });
    const { svc } = service();
    svc.saveSet({ name: 'Admin', webapps: ['admin'] });
    const r = await svc.applySet('Admin');
    // A disabled copy of shop is already there: that move is refused, the rest is done.
    expect(r.failed.map((f) => f.name)).toEqual(['shop']);
    expect(r.disabled).toEqual(['billing']);
    expect(r.enabled).toEqual(['admin']);
    expect(r.message).toMatch(/Could not move: shop\./);
  });

  it('needs both folders, and a settings folder to keep sets in', async () => {
    const { svc } = service();
    svc.saveSet({ name: 'A', webapps: [] });
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    const bare = new TomcatService(cfg, { emit: () => undefined, onWar: () => undefined }, { scriptLogDir: join(dir, 'logs') });
    expect(() => bare.saveSet({ name: 'A', webapps: [] })).toThrow(/settings folder/);
    expect((await bare.state()).sets.error).toMatch(/settings folder/);
    bare.useDataDir(dir);
    await expect(bare.applySet('A')).rejects.toThrow(/webapps folder/);
  });
});
