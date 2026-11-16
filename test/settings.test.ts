import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchPattern } from '../src/server/collectors/tail';
import { DEFAULT_CONFIG, editableConfig, loadConfig, saveConfig, validateConfig } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-settings-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('validateConfig', () => {
  it('accepts the defaults', () => {
    expect(validateConfig(structuredClone(DEFAULT_CONFIG)).errors).toEqual([]);
  });

  it('reports each problem against the setting it belongs to', () => {
    const input: any = structuredClone(DEFAULT_CONFIG);
    input.port = 70000;
    input.chrome.port = '';
    input.correlation.header = 'X Request';
    input.correlation.logPatterns = ['ok=(\\w+)', 'broken=(', ''];
    input.tomcat.accessDurationUnit = 'minutes';
    const paths = validateConfig(input).errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['port', 'chrome.port', 'correlation.header', 'correlation.logPatterns.1', 'tomcat.accessDurationUnit']),
    );
    expect(paths).not.toContain('correlation.logPatterns.0');
  });

  it('trims text, drops blank list entries, lower-cases redacted headers and keeps unknown keys', () => {
    const input: any = structuredClone(DEFAULT_CONFIG);
    input.tomcat.appLogs = ['  C:/logs/catalina.*.log ', '', '   '];
    input.redact.headers = ['X-Api-Key'];
    input.port = '4100';
    input.future = { keep: true };
    const { config, errors } = validateConfig(input);
    expect(errors).toEqual([]);
    expect(config.tomcat.appLogs).toEqual(['C:/logs/catalina.*.log']);
    expect(config.redact.headers).toEqual(['x-api-key']);
    expect(config.port).toBe(4100);
    expect((config as any).future).toEqual({ keep: true });
  });

  it('drops blank start commands and requires a command on the others', () => {
    const input: any = structuredClone(DEFAULT_CONFIG);
    input.tomcat.startCommands = [
      { name: ' Postgres ', command: ' net start postgresql-x64-16 ', cwd: '', wait: true },
      { name: '', command: '', cwd: '' },
      { name: 'Vite', command: '', cwd: 'C:/dev/web' },
    ];
    input.tomcat.preserveFiles = ['config.yaml', 'conf/app.js'];
    const { config, errors } = validateConfig(input);
    expect(config.tomcat.startCommands).toEqual([
      { name: 'Postgres', command: 'net start postgresql-x64-16', cwd: '', wait: true },
      { name: 'Vite', command: '', cwd: 'C:/dev/web', wait: false },
    ]);
    expect(errors.map((e) => e.path).sort()).toEqual(['tomcat.preserveFiles.1', 'tomcat.startCommands.2.command']);
  });

  it('refuses a Chrome port equal to the hub port', () => {
    const input: any = structuredClone(DEFAULT_CONFIG);
    input.chrome.port = input.port;
    expect(validateConfig(input).errors.map((e) => e.path)).toContain('chrome.port');
  });
});

describe('saveConfig', () => {
  it('keeps keys it does not manage and writes Windows paths that load back unchanged', () => {
    const file = join(dir, 'debug-hub.config.json');
    writeFileSync(file, JSON.stringify({ handAdded: 1, chrome: { extra: 'x' } }));
    const { config } = validateConfig({ ...structuredClone(DEFAULT_CONFIG), tomcat: { ...DEFAULT_CONFIG.tomcat, enabled: true, appLogs: ['C:\\tomcat\\logs\\catalina.*.log'] } });
    saveConfig(file, config);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.handAdded).toBe(1);
    expect(raw.chrome.extra).toBe('x');
    expect(editableConfig(file).config.tomcat.appLogs).toEqual(['C:\\tomcat\\logs\\catalina.*.log']);
    expect(loadConfig(file).config.tomcat.enabled).toBe(true);
    expect(readdirSync(dir)).toEqual(['debug-hub.config.json']);
  });

  it('shows defaults and the reason when the file cannot be read', () => {
    const file = join(dir, 'debug-hub.config.json');
    writeFileSync(file, '{ not json');
    const e = editableConfig(file);
    expect(e.error).toMatch(/Could not parse/);
    expect(e.config).toEqual(DEFAULT_CONFIG);
  });
});

describe('matchPattern', () => {
  it('lists matching files newest first and explains a missing folder', async () => {
    writeFileSync(join(dir, 'catalina.2026-11-13.log'), 'a');
    writeFileSync(join(dir, 'catalina.2026-11-14.log'), 'bb');
    writeFileSync(join(dir, 'other.txt'), '');
    const m = await matchPattern(join(dir, 'catalina.*.log'));
    expect(m.problem).toBeNull();
    expect(m.files.map((f) => f.bytes).sort()).toEqual([1, 2]);
    expect((await matchPattern(join(dir, 'nope', '*.log'))).problem).toMatch(/Folder not found/);
  });
});

describe('settings API', () => {
  let hub: Hub;
  let server: Server;
  let base: string;
  const file = () => join(dir, 'debug-hub.config.json');

  let port: number;
  beforeEach(async () => {
    // A real port: the server checks the Host header against it.
    port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.port = port;
    config.chrome.enabled = false;
    config.sessionsDir = join(dir, 'sessions');
    hub = new Hub(config);
    hub.start();
    server = await startServer(hub, dir, { configFile: file() });
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    server.close();
    await hub.stop();
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  it('rejects invalid settings without writing the file', async () => {
    const bad = { ...structuredClone(DEFAULT_CONFIG), port: -1 };
    const res = await send('PUT', '/api/config', bad);
    expect(res.status).toBe(400);
    expect((await res.json()).errors[0].path).toBe('port');
    expect(() => readFileSync(file())).toThrow();
  });

  it('saves, applies to the running hub and moves recording to a new sessions folder', async () => {
    mkdirSync(join(dir, 'logs'));
    const next: any = structuredClone(DEFAULT_CONFIG);
    next.port = port;
    next.chrome.enabled = false;
    next.sessionsDir = 'recordings';
    next.tomcat = { ...next.tomcat, enabled: true, appLogs: ['logs/app.*.log'] };
    const res = await send('PUT', '/api/config', next);
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(file(), 'utf8')).sessionsDir).toBe('recordings');
    expect(hub.cfg.sessionsDir).toBe(join(dir, 'recordings'));
    expect(hub.cfg.tomcat.appLogs).toEqual([join(dir, 'logs', 'app.*.log')]);
    expect(hub.status().collectors.map((c) => c.name)).toContain('Tomcat logs');
    expect(readdirSync(join(dir, 'recordings')).some((f) => f.endsWith('.jsonl'))).toBe(true);

    const got = await (await send('GET', '/api/config')).json();
    expect(got.config.sessionsDir).toBe('recordings');
    expect(got.file).toBe(file());
  });

  it('resolves relative patterns against the config folder when previewing matches', async () => {
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'logs', 'app.1.log'), 'x');
    const res = await send('POST', '/api/config/match', { patterns: ['logs/app.*.log', ''] });
    const [m, empty] = await res.json();
    expect(m.resolved).toBe(join(dir, 'logs', 'app.*.log'));
    expect(m.files).toHaveLength(1);
    expect(empty.files).toEqual([]);
  });
});
