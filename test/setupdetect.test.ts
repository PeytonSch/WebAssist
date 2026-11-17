import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSetup, expand } from '../src/server/setup-detect';

let home: string;
const touch = (...parts: string[]) => {
  const file = join(home, ...parts);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '');
  return file;
};
const norm = (p: string) => p.replace(/\\/g, '/');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dh-detect-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const detect = (env: NodeJS.ProcessEnv = {}) => detectSetup({ env, platform: 'linux', home, projectRoots: [join(home, 'work')] });

describe('detectSetup', () => {
  it('finds a Tomcat in the home folder, with its logs, webapps and version', () => {
    touch('apache-tomcat-10.1.19', 'bin', 'catalina.sh');
    touch('apache-tomcat-10.1.19', 'conf', 'server.xml');
    mkdirSync(join(home, 'apache-tomcat-10.1.19', 'logs'));
    mkdirSync(join(home, 'apache-tomcat-10.1.19', 'webapps'));
    const t = detect().tomcat.find((x) => x.base.includes('apache-tomcat-10'))!;
    expect(t).toMatchObject({ version: '10.1.19', major: 10, from: 'installed' });
    expect(t.logs).toBe(norm(join(home, 'apache-tomcat-10.1.19', 'logs')));
    expect(t.webapps).toBe(norm(join(home, 'apache-tomcat-10.1.19', 'webapps')));
    expect(t.home).toBe(t.base);
  });

  it('finds IntelliJ IDEA run folders, with the install from CATALINA_HOME', () => {
    touch('tc', 'lib', 'catalina.jar');
    writeFileSync(join(home, 'tc', 'RELEASE-NOTES'), '                     Apache Tomcat Version 9.0.85\n');
    const run = join(home, '.cache', 'JetBrains', 'IntelliJIdea2025.2', 'tomcat', 'abc123');
    touch('.cache', 'JetBrains', 'IntelliJIdea2025.2', 'tomcat', 'abc123', 'conf', 'server.xml');
    mkdirSync(join(run, 'logs'));
    const found = detect({ CATALINA_HOME: join(home, 'tc') }).tomcat;
    const ij = found.find((x) => x.from.startsWith('IntelliJ'))!;
    expect(ij.from).toBe('IntelliJ IDEA run folder (IntelliJIdea2025.2)');
    expect(ij.logs).toBe(norm(join(run, 'logs')));
    expect(found.find((x) => x.from === 'CATALINA_HOME')).toMatchObject({ version: '9.0.85', major: 9 });
  });

  it('finds JDKs with their version, and WAR build folders in projects and modules', () => {
    touch('.jdks', 'temurin-17', 'bin', 'java');
    writeFileSync(join(home, '.jdks', 'temurin-17', 'release'), 'JAVA_VERSION="17.0.10"\n');
    touch('work', 'shop', 'target', 'shop.war');
    touch('work', 'big', 'big-web', 'target', 'big-web.war');
    touch('work', 'lib', 'target', 'lib.jar');
    const d = detect();
    expect(d.javaHomes.find((j) => j.dir.endsWith('temurin-17'))).toMatchObject({ version: '17.0.10', from: 'downloaded by IntelliJ' });
    expect(d.warFolders.map((w) => norm(w.dir).replace(norm(home), '~')).sort()).toEqual(['~/work/big/big-web/target', '~/work/shop/target']);
  });

  it('finds Postgres logs from PGDATA and names the daily files', () => {
    const log = touch('pg', 'log', 'postgresql-2026-11-17.log');
    utimesSync(log, new Date(), new Date());
    const found = detect({ PGDATA: join(home, 'pg') }).postgresLogs;
    expect(found[0].pattern).toBe(`${norm(join(home, 'pg', 'log'))}/postgresql-*.log`);
  });
});

describe('expand', () => {
  it('matches * in any folder name, ignoring case', () => {
    touch('a', 'Tomcat9', 'x');
    touch('a', 'tomcat10', 'x');
    touch('a', 'other', 'x');
    expect(expand(`${norm(home)}/a/tomcat*/x`).map((p) => p.split('/').slice(-2)[0]).sort()).toEqual(['Tomcat9', 'tomcat10']);
  });
});
