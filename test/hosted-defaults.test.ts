import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig, validateConfig } from '../src/server/config';
import { deployFolder, detectSettings, fillDetected, hostedEditable, loadHostedConfig, type DetectMachine } from '../src/server/hosted/defaults';
import { readHostedEnv, selfName, tomcatVersion, type HostedInfo } from '../src/server/hosted/info';

/** A machine that has exactly these folders and files. */
function machine(platform: NodeJS.Platform, dirs: string[], files: string[] = []): DetectMachine {
  const norm = (p: string) => (platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
  const d = new Set(dirs.map(norm));
  const f = new Set(files.map(norm));
  return { platform, isDir: (p) => d.has(norm(p)), isFile: (p) => f.has(norm(p)) };
}

const info = (over: Partial<HostedInfo> = {}): HostedInfo => ({
  secret: 's'.repeat(64),
  contextPath: '/debug-hub',
  webappDir: '/opt/tomcat/webapps/debug-hub/',
  catalinaBase: '/opt/tomcat',
  catalinaHome: '/opt/tomcat',
  javaHome: '/usr/lib/jvm/java-17',
  serverInfo: 'Apache Tomcat/9.0.89',
  dataDir: '/opt/tomcat/debug-hub-data',
  remote: '',
  hosts: '',
  logFile: null,
  ...over,
});

const linux = machine('linux', ['/opt/tomcat/webapps', '/opt/tomcat/logs', '/opt/tomcat/bin'], ['/usr/lib/jvm/java-17/bin/java']);
const byPath = (list: { path: string; value: unknown }[]) => Object.fromEntries(list.map((d) => [d.path, d.value]));

describe('what the launcher passes', () => {
  it('is read from DEBUG_HUB_* variables', () => {
    const got = readHostedEnv({
      DEBUG_HUB_HOSTED: 'tomcat',
      DEBUG_HUB_SECRET: 'x'.repeat(64),
      DEBUG_HUB_CONTEXT_PATH: '/debug-hub',
      DEBUG_HUB_WEBAPP_DIR: 'C:\\tomcat\\webapps\\debug-hub\\',
      DEBUG_HUB_CATALINA_BASE: 'C:\\tomcat',
      DEBUG_HUB_CATALINA_HOME: '',
      DEBUG_HUB_DATA: 'C:\\tomcat\\debug-hub-data',
      DEBUG_HUB_SERVER_INFO: 'Apache Tomcat/10.1.36',
    });
    expect(got).toMatchObject({ contextPath: '/debug-hub', catalinaBase: 'C:\\tomcat', catalinaHome: 'C:\\tomcat', javaHome: null, remote: '', hosts: '' });
  });

  it('is nothing without DEBUG_HUB_HOSTED, and refuses to run hosted without a secret', () => {
    expect(readHostedEnv({})).toBeNull();
    expect(() => readHostedEnv({ DEBUG_HUB_HOSTED: 'tomcat', DEBUG_HUB_DATA: '/d' })).toThrow(/SECRET/);
  });

  it('names its own webapp from the folder, or else the context path', () => {
    expect(selfName(info(), 'linux')).toBe('debug-hub');
    expect(selfName(info({ webappDir: 'C:\\tc\\webapps\\tools#hub\\' }), 'win32')).toBe('tools#hub');
    expect(selfName(info({ webappDir: null, contextPath: '/tools/hub' }), 'linux')).toBe('tools#hub');
    expect(selfName(info({ webappDir: null, contextPath: '' }), 'linux')).toBe('ROOT');
  });

  it('reads the Tomcat version', () => {
    expect(tomcatVersion('Apache Tomcat/9.0.89')).toEqual({ version: '9.0.89', major: 9 });
    expect(tomcatVersion('Apache Tomcat/11.0.2')).toEqual({ version: '11.0.2', major: 11 });
    expect(tomcatVersion('')).toEqual({ version: null, major: null });
  });
});

describe('settings detected from the deploy path', () => {
  it('finds webapps, logs, the Tomcat folder and Java', () => {
    expect(byPath(detectSettings(info(), linux))).toEqual({
      'tomcat.webappsDir': '/opt/tomcat/webapps',
      'tomcat.disabledDir': '/opt/tomcat/webapps-disabled',
      'tomcat.logsDir': '/opt/tomcat/logs',
      'tomcat.enabled': true,
      'tomcat.home': '/opt/tomcat',
      'tomcat.javaHome': '/usr/lib/jvm/java-17',
    });
  });

  it('writes Windows paths with forward slashes, and keeps a separate CATALINA_BASE apart from the install', () => {
    const m = machine('win32', ['C:/Users/me/.IntelliJ/tomcat/abc/webapps', 'C:/Users/me/.IntelliJ/tomcat/abc/logs', 'C:/apache-tomcat-10.1.36/bin'], ['C:/Program Files/Java/jdk-21/bin/java.exe']);
    const got = byPath(detectSettings(info({
      webappDir: 'C:\\Users\\me\\.IntelliJ\\tomcat\\abc\\webapps\\debug-hub\\',
      catalinaBase: 'C:\\Users\\me\\.IntelliJ\\tomcat\\abc',
      catalinaHome: 'C:\\apache-tomcat-10.1.36',
      javaHome: 'C:\\Program Files\\Java\\jdk-21',
      serverInfo: 'Apache Tomcat/10.1.36',
    }), m));
    expect(got['tomcat.webappsDir']).toBe('C:/Users/me/.IntelliJ/tomcat/abc/webapps');
    expect(got['tomcat.logsDir']).toBe('C:/Users/me/.IntelliJ/tomcat/abc/logs');
    expect(got['tomcat.home']).toBe('C:/apache-tomcat-10.1.36');
    expect(got['tomcat.javaHome']).toBe('C:/Program Files/Java/jdk-21');
    // Tomcat 10 and later write %D in microseconds.
    expect(got['tomcat.accessDurationUnit']).toBe('us');
  });

  it('uses the folder the webapp is really in when a Host has its own appBase', () => {
    const m = machine('linux', ['/opt/tomcat/webapps', '/opt/tomcat/apps', '/opt/tomcat/logs']);
    expect(deployFolder(info({ webappDir: '/opt/tomcat/apps/debug-hub' }), m)?.dir).toBe('/opt/tomcat/apps');
  });

  it('falls back to CATALINA_BASE/webapps when the webapp lives elsewhere or runs from the WAR', () => {
    // A context file pointing at a build folder: its parent is not where Tomcat deploys from.
    expect(deployFolder(info({ webappDir: '/home/me/project/build/exploded' }), linux)?.dir).toBe('/opt/tomcat/webapps');
    expect(deployFolder(info({ webappDir: null }), linux)?.dir).toBe('/opt/tomcat/webapps');
    // ... unless a WAR of the same name sits next to it: then that folder is deployed from.
    const m = machine('linux', ['/opt/tomcat/webapps', '/srv/apps'], ['/srv/apps/debug-hub.war']);
    expect(deployFolder(info({ webappDir: '/srv/apps/debug-hub' }), m)?.dir).toBe('/srv/apps');
  });

  it('leaves out what is not there', () => {
    // Run from the WAR on a machine where none of the usual folders exist.
    const got = byPath(detectSettings(info({ javaHome: null, webappDir: null }), machine('linux', [])));
    expect(got).toEqual({});
  });
});

describe('filling detected values into the settings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-hosted-'));
    for (const d of ['webapps/debug-hub', 'logs', 'bin', 'debug-hub-data']) mkdirSync(join(dir, d), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const here = () => info({ webappDir: join(dir, 'webapps', 'debug-hub'), catalinaBase: dir, catalinaHome: dir, javaHome: null, dataDir: join(dir, 'debug-hub-data') });
  const file = () => join(dir, 'debug-hub-data', 'debug-hub.config.json');
  const slashes = (p: string) => p.replace(/\\/g, '/');

  it('only fills keys the file does not have', () => {
    const raw: Record<string, any> = { tomcat: { webappsDir: '', logsDir: '/elsewhere/logs' } };
    const filled = fillDetected(raw, detectSettings(info(), linux));
    expect(filled).toEqual(['tomcat.disabledDir', 'tomcat.enabled', 'tomcat.home', 'tomcat.javaHome']);
    // Cleared by the user stays cleared; set by the user stays as set.
    expect(raw.tomcat.webappsDir).toBe('');
    expect(raw.tomcat.logsDir).toBe('/elsewhere/logs');
    expect(raw.tomcat.home).toBe('/opt/tomcat');
  });

  it('runs with detected settings when there is no settings file yet', () => {
    const { config, filled, error } = loadHostedConfig(file(), here());
    expect(error).toBeNull();
    expect(filled).toContain('tomcat.webappsDir');
    expect(slashes(config.tomcat.webappsDir)).toBe(slashes(join(dir, 'webapps')));
    expect(slashes(config.tomcat.logsDir)).toBe(slashes(join(dir, 'logs')));
    expect(slashes(config.tomcat.disabledDir)).toBe(slashes(join(dir, 'webapps-disabled')));
    expect(config.tomcat.enabled).toBe(true);
    // Sessions and the Chrome profile are relative to the settings file: in the data folder, not the webapp.
    expect(config.sessionsDir).toBe(join(dir, 'debug-hub-data', 'sessions'));
    expect(config.chrome.profileDir).toBe(join(dir, 'debug-hub-data', 'chrome-profile'));
  });

  it('shows detected values in Settings as ordinary values, with where they come from', () => {
    const e = hostedEditable(file(), here());
    expect(slashes(e.config.tomcat.webappsDir)).toBe(slashes(join(dir, 'webapps')));
    expect(e.detected['tomcat.webappsDir']).toEqual({ value: slashes(join(dir, 'webapps')), why: expect.stringContaining('deployed') });
    expect(e.detected['tomcat.logsDir'].value).toBe(slashes(join(dir, 'logs')));
    expect(e.defaults.tomcat.webappsDir).toBe('');
    // What Settings shows passes its own validation, so the first Save works.
    expect(validateConfig(e.config).errors).toEqual([]);
  });

  it('keeps what the user saved, including a value they cleared', () => {
    const saved = structuredClone(DEFAULT_CONFIG);
    saved.tomcat.webappsDir = 'D:/other-tomcat/webapps';
    saved.tomcat.logsDir = '';
    saveConfig(file(), saved);
    const { config, filled } = loadHostedConfig(file(), here());
    expect(filled).toEqual([]);
    expect(config.tomcat.webappsDir).toMatch(/other-tomcat/);
    expect(config.tomcat.logsDir).toBe('');
    const e = hostedEditable(file(), here());
    expect(e.config.tomcat.logsDir).toBe('');
    // The detected value is still offered next to the setting.
    expect(e.detected['tomcat.logsDir'].value).toBe(slashes(join(dir, 'logs')));
  });

  it('starts on detected settings when the file cannot be read, and says so', () => {
    writeFileSync(file(), '{ not json');
    const { config, error } = loadHostedConfig(file(), here());
    expect(error).toMatch(/Could not parse/);
    expect(slashes(config.tomcat.webappsDir)).toBe(slashes(join(dir, 'webapps')));
  });
});
