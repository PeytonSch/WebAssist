import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyLogFile, folderSource, scanLogsFolder } from '../src/server/collectors/logsdir';
import { contextToName, listWebapps, logBaseName, nameToContext, webappFromMessage, Webapps } from '../src/server/webapps';

describe('webapp names', () => {
  it('maps context paths to webapp names and back', () => {
    expect(contextToName('/shop')).toBe('shop');
    expect(contextToName('')).toBe('ROOT');
    expect(contextToName('/')).toBe('ROOT');
    expect(contextToName('/shop/admin')).toBe('shop#admin');
    expect(nameToContext('ROOT')).toBe('/');
    expect(nameToContext('shop#admin')).toBe('/shop/admin');
    expect(nameToContext('shop##2')).toBe('/shop');
  });
  it('strips dates, rotation numbers and extensions from log file names', () => {
    expect(logBaseName('/logs/shop.2026-11-16.log')).toBe('shop');
    expect(logBaseName('/logs/shop.log')).toBe('shop');
    expect(logBaseName('/logs/shop.log.2026-11-16')).toBe('shop');
    expect(logBaseName('/logs/shop-20261116.1.log')).toBe('shop');
    expect(logBaseName('/logs/shop.0.log')).toBe('shop');
    expect(logBaseName('/logs/catalina.out')).toBe('catalina');
    expect(logBaseName('/logs/localhost_access_log.2026-11-16.txt')).toBe('localhost_access_log');
  });
});

describe('labelling Tomcat events with their webapp', () => {
  it('takes per-webapp log files by name and leaves Tomcat’s shared logs unlabelled', () => {
    const w = new Webapps();
    expect(w.fromFile('/logs/shop.2026-11-16.log')).toBe('shop');
    for (const f of ['catalina.2026-11-16.log', 'catalina.out', 'localhost.2026-11-16.log', 'manager.2026-11-16.log',
      'host-manager.2026-11-16.log', 'commons-daemon.2026-11-16.log', 'tomcat9-stdout.2026-11-16.log', 'tomcat9-stderr.2026-11-16.log']) {
      expect(w.fromFile(`/logs/${f}`)).toBeNull();
    }
  });
  it('matches a known webapp name with a suffix in the file name', () => {
    const w = new Webapps();
    w.learn('shop');
    w.learn('shop-admin');
    expect(w.fromFile('/logs/shop-debug.log')).toBe('shop');
    expect(w.fromFile('/logs/shop-admin.2026-11-16.log')).toBe('shop-admin');
    expect(w.fromFile('/logs/shopping.log')).toBe('shopping');
  });
  it('reads Tomcat’s context markers in messages', () => {
    expect(webappFromMessage('16-Nov-2026 10:00:00.123 SEVERE [exec-1] o.a.c.c.StandardWrapperValve.invoke Servlet.service() for servlet [dispatcher] in context with path [/shop] threw exception')).toBe('shop');
    expect(webappFromMessage('… in context with path [] threw exception')).toBe('ROOT');
    expect(webappFromMessage('SEVERE [main] o.a.c.core.StandardContext.startInternal Context [/shop] startup failed due to previous errors')).toBe('shop');
    expect(webappFromMessage('INFO [main] o.a.c.startup.HostConfig.deployDirectory Deploying web application directory [/opt/tomcat/webapps/billing]')).toBe('billing');
    expect(webappFromMessage('INFO [main] o.a.c.startup.HostConfig.deployWAR Deploying web application archive [C:\\tomcat\\webapps\\billing.war]')).toBe('billing');
    expect(webappFromMessage('WARNING [main] o.a.c.loader.WebappClassLoaderBase.clearReferencesThreads The web application [shop] appears to have started a thread')).toBe('shop');
    expect(webappFromMessage('INFO [main] o.a.c.core.ContainerBase.[Catalina].[localhost].[/shop].log Initializing Spring')).toBe('shop');
    expect(webappFromMessage('INFO [main] Reloading Context with name [/shop/admin] has started')).toBe('shop#admin');
    expect(webappFromMessage('INFO [main] nothing about webapps [/api/orders] here')).toBeNull();
  });
  it('labels log entries by file first, then by message, then by a known name in brackets', () => {
    const w = new Webapps();
    expect(w.forLog('/logs/shop.log', 'INFO in context with path [/billing]')).toBe('shop');
    expect(w.forLog('/logs/catalina.out', 'SEVERE … in context with path [/billing] threw exception')).toBe('billing');
    expect(w.forLog('/logs/catalina.out', '10:00:00.123 [exec-1] [/api] DEBUG c.x.Y - unknown bracket')).toBeNull();
    expect(w.forLog('/logs/catalina.out', '10:00:00.123 [exec-1] [billing] DEBUG c.x.Y - known bracket')).toBe('billing');
    expect(w.forLog('/logs/catalina.out', '10:00:00.123 [exec-1] DEBUG c.x.Y - nothing')).toBeNull();
  });
  it('resolves access-log paths only against known webapps', () => {
    const w = new Webapps();
    expect(w.forPath('/shop/api/orders')).toBeNull();
    w.learn('shop');
    w.learn('shop#admin');
    expect(w.forPath('/shop/api/orders?x=1')).toBe('shop');
    expect(w.forPath('/shop/admin/users')).toBe('shop#admin');
    expect(w.forPath('/other/thing')).toBeNull();
    w.learn('ROOT');
    expect(w.forPath('/other/thing')).toBe('ROOT');
    expect(w.forPath('/')).toBe('ROOT');
  });
});

describe('webapps folders and the logs folder', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-webapps-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists webapp directories and WARs, and refreshes', async () => {
    const webapps = join(dir, 'webapps');
    const disabled = join(dir, 'disabled');
    mkdirSync(join(webapps, 'ROOT'), { recursive: true });
    mkdirSync(join(webapps, 'shop'));
    mkdirSync(disabled);
    writeFileSync(join(webapps, 'shop.war'), '');
    writeFileSync(join(webapps, 'billing.war'), '');
    writeFileSync(join(webapps, 'notes.txt'), '');
    mkdirSync(join(disabled, 'legacy'));
    expect((await listWebapps(webapps)).sort()).toEqual(['ROOT', 'billing', 'shop']);
    expect(await listWebapps(join(dir, 'missing'))).toEqual([]);

    const w = new Webapps([webapps, disabled]);
    await w.refresh();
    expect(w.names()).toEqual(['ROOT', 'billing', 'legacy', 'shop']);
    expect(w.forPath('/billing/x')).toBe('billing');
    mkdirSync(join(webapps, 'reports'));
    await w.refresh();
    expect(w.forPath('/reports/x')).toBe('reports');
  });

  it('sorts a logs folder into application and access logs, skipping archives and listed files', async () => {
    const logs = join(dir, 'logs');
    mkdirSync(logs);
    for (const f of ['catalina.2026-11-16.log', 'catalina.out', 'shop.2026-11-16.log', 'localhost_access_log.2026-11-16.txt',
      'catalina.2026-10-01.log.gz', 'shop.2026-09-01.log.zip', 'catalina.2026-11-16.log.lck', '.hidden.log', 'billing.log']) {
      writeFileSync(join(logs, f), 'x\n');
    }
    mkdirSync(join(logs, 'archive'));
    expect(classifyLogFile(join(logs, 'localhost_access_log.2026-11-16.txt'))).toBe('access');
    expect(classifyLogFile(join(logs, 'catalina.out'))).toBe('app');
    expect(classifyLogFile(join(logs, 'x.log.gz'))).toBeNull();

    const scan = await scanLogsFolder(logs, [join(logs, 'billing*')], []);
    expect(scan.problem).toBeNull();
    expect(scan.app.map((f) => f.path.split(/[\\/]/).pop()).sort()).toEqual(['catalina.2026-11-16.log', 'catalina.out', 'shop.2026-11-16.log']);
    expect(scan.access.map((f) => f.path.split(/[\\/]/).pop())).toEqual(['localhost_access_log.2026-11-16.txt']);
    expect(scan.skipped).toBe(5);
    expect((await scanLogsFolder(join(dir, 'nope'), [], [])).problem).toMatch(/Folder not found/);

    // A file listed by hand as an access log is not also followed as an application log.
    const app = folderSource(logs, 'app', [], [join(logs, 'shop.*.log')]);
    expect(app.accept!(join(logs, 'shop.2026-11-16.log'))).toBe(false);
    expect(app.accept!(join(logs, 'catalina.out'))).toBe(true);
    expect(app.accept!(join(logs, 'localhost_access_log.2026-11-16.txt'))).toBe(false);
  });
});
