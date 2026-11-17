import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig, type Config } from '../src/server/config';
import { startServer } from '../src/server/http';
import { Hub } from '../src/server/hub';
import type { EditorMachine, Step } from '../src/server/source/editor';
import type { RunResult, Runner } from '../src/server/source/launch';
import { SourceService } from '../src/server/source/service';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-open-'));
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  put('shop/pom.xml', '');
  put('shop/target/shop.war', 'x');
  put('shop/src/main/java/com/example/orders/OrderService.java', 'package com.example.orders;\n\n\npublic class OrderService {\n}\n');
  put('admin/pom.xml', '');
  put('admin/target/admin.war', 'x');
  put('admin/src/main/java/com/example/orders/OrderService.java', 'package com.example.orders;\nclass OrderService {}\n');
  put('admin/src/main/java/com/example/admin/Only.java', 'package com.example.admin;\nclass Only {}\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Records every program started; answers helpers with `answer`. */
class FakeRunner implements Runner {
  runs: Step[] = [];
  launches: Step[] = [];
  constructor(private answer: (s: Step) => RunResult = () => ({ code: 0, stdout: '', stderr: '' }), private launchAnswer: RunResult = { code: null, stdout: '', stderr: '' }) {}
  async run(step: Step) {
    this.runs.push(step);
    return this.answer(step);
  }
  async launch(step: Step) {
    this.launches.push(step);
    return this.launchAnswer;
  }
}

function machine(o: { files?: string[]; dirs?: Record<string, string[]>; env?: Record<string, string> } = {}): EditorMachine {
  const files = new Set(o.files ?? []);
  return {
    platform: 'linux',
    env: o.env ?? { PATH: '/usr/bin' },
    home: '/home/me',
    tmpdir: '/tmp',
    user: 'me',
    isFile: (p) => files.has(p),
    listDir: (p) => o.dirs?.[p] ?? [],
    readText: () => null,
    mtimeMs: () => 0,
  };
}

function config(editor: Partial<Config['editor']>): Config {
  const c = structuredClone(DEFAULT_CONFIG);
  c.tomcat.warWatch = [join(dir, '*', 'target')];
  c.editor = { ...c.editor, ...editor };
  return c;
}

async function service(editor: Partial<Config['editor']>, runner: Runner, m = machine({ files: ['/usr/bin/code', '/usr/bin/nvim', '/usr/bin/emacsclient', '/usr/bin/wezterm', '/usr/bin/myed'] })) {
  const s = new SourceService(config(editor), { runner, machine: m });
  await s.index.build();
  return s;
}

const shopFile = () => join(dir, 'shop/src/main/java/com/example/orders/OrderService.java');

describe('SourceService.open', () => {
  it('asks for an editor first', async () => {
    const s = await service({ kind: '' }, new FakeRunner());
    await expect(s.open({ className: 'com.example.orders.OrderService' })).rejects.toMatchObject({ status: 400, extra: { settings: true } });
  });

  it('refuses classes that are not in the sources, and never opens a path from the request', async () => {
    const runner = new FakeRunner();
    const s = await service({ kind: 'vscode' }, runner);
    await expect(s.open({ className: 'org.apache.catalina.core.StandardWrapperValve' })).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/not in the indexed sources/) });
    await expect(s.open({ className: 'com.example.admin.Only', pick: '/etc/passwd' })).rejects.toMatchObject({ status: 400 });
    // A file name with a path in it is ignored, not followed.
    await s.open({ className: 'com.example.admin.Only', file: '../../../../etc/passwd' });
    expect(runner.launches.map((l) => l.args[1])).toEqual([`${join(dir, 'admin/src/main/java/com/example/admin/Only.java')}:2:1`]);
  });

  it('lists the candidates when several projects define the class, and opens the one picked', async () => {
    const runner = new FakeRunner();
    const s = await service({ kind: 'vscode' }, runner);
    const err = await s.open({ className: 'com.example.orders.OrderService$1', file: 'OrderService.java', line: 87 }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.extra.candidates.map((c: { project: string }) => c.project).sort()).toEqual(['admin', 'shop']);
    expect(runner.launches).toEqual([]);
    const r = await s.open({ className: 'com.example.orders.OrderService$1', file: 'OrderService.java', line: 87, pick: shopFile() });
    expect(r).toMatchObject({ file: shopFile(), line: 87, project: 'shop', editor: 'VS Code', message: 'Opened OrderService.java:87 in VS Code' });
    expect(runner.launches[0]).toMatchObject({ file: '/usr/bin/code', args: ['--goto', `${shopFile()}:87:1`] });
    // The webapp decides without asking.
    const w = await s.open({ className: 'com.example.orders.OrderService', webapp: 'admin', line: 3 });
    expect(w.project).toBe('admin');
  });

  it('opens a class without a line at its declaration', async () => {
    const runner = new FakeRunner();
    const s = await service({ kind: 'idea' }, runner, machine({ env: { PATH: '/opt/bin' }, files: ['/opt/bin/idea'] }));
    const r = await s.open({ className: 'com.example.orders.OrderService', webapp: 'shop' });
    expect(r.line).toBe(4);
    // A JUL logger names Class.method.
    expect((await s.open({ className: 'com.example.orders.OrderService.load', webapp: 'shop' })).line).toBe(4);
    expect(runner.launches[0]).toMatchObject({ file: '/opt/bin/idea', args: ['--line', '4', shopFile()] });
  });

  it('reports a launcher that fails at once', async () => {
    const s = await service({ kind: 'vscode' }, new FakeRunner(undefined, { code: 3, stdout: '', stderr: '' }));
    await expect(s.open({ className: 'com.example.admin.Only' })).rejects.toMatchObject({ status: 502, message: 'VS Code exited with code 3.' });
    const s2 = await service({ kind: 'vscode' }, new FakeRunner(undefined, { code: null, stdout: '', stderr: '', error: 'spawn EACCES' }));
    await expect(s2.open({ className: 'com.example.admin.Only' })).rejects.toMatchObject({ message: 'VS Code could not be started: spawn EACCES' });
  });

  it('explains how to start the Emacs server when emacsclient cannot reach one', async () => {
    const runner = new FakeRunner(() => ({ code: 1, stdout: '', stderr: 'emacsclient: can\'t find socket; have you started the server?' }));
    const s = await service({ kind: 'emacs' }, runner);
    const err = await s.open({ className: 'com.example.admin.Only', line: 2 }).catch((e) => e);
    expect(err.message).toBe('emacsclient could not reach a running Emacs.');
    expect(err.extra.hint).toMatch(/M-x server-start/);
    expect(err.extra.output).toMatch(/started the server/);
    expect(runner.runs[0].args).toEqual(['-n', '+2:1', join(dir, 'admin/src/main/java/com/example/admin/Only.java')]);
  });

  it('Neovim: sends the file to the running nvim working in the project', async () => {
    const shopRoot = join(dir, 'shop');
    const runner = new FakeRunner((s) => {
      if (s.args[2] === '--remote-expr') return { code: 0, stdout: s.args[1] === '/tmp/nvim.me/b/nvim.2.0' ? `${shopRoot}/src\n` : '/elsewhere\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const m = machine({ files: ['/usr/bin/nvim'], dirs: { '/tmp/nvim.me': ['a', 'b'], '/tmp/nvim.me/a': ['nvim.1.0'], '/tmp/nvim.me/b': ['nvim.2.0'] } });
    const s = await service({ kind: 'nvim' }, runner, m);
    const r = await s.open({ className: 'com.example.orders.OrderService', webapp: 'shop', line: 87 });
    expect(r.message).toBe(`Opened OrderService.java:87 in Neovim (the running nvim in ${shopRoot}/src)`);
    const send = runner.runs.find((x) => x.args.includes('--remote-send'))!;
    expect(send.args.slice(0, 3)).toEqual(['--server', '/tmp/nvim.me/b/nvim.2.0', '--remote-send']);
    expect(send.args[3]).toContain(`fnameescape('${shopFile()}') | call cursor(87, 1)`);
    expect(runner.launches).toEqual([]);
  });

  it('Neovim: opens a new terminal window when no nvim is running, or reuse is off', async () => {
    const runner = new FakeRunner();
    const s = await service({ kind: 'nvim', terminal: 'wezterm start --cwd {dir} -- {cmd}' }, runner);
    const r = await s.open({ className: 'com.example.admin.Only', line: 2 });
    expect(r.how).toBe('a new WezTerm window');
    expect(runner.launches[0]).toMatchObject({ file: '/usr/bin/wezterm', args: ['start', '--cwd', join(dir, 'admin'), '--', '/usr/bin/nvim', '+2', join(dir, 'admin/src/main/java/com/example/admin/Only.java')] });

    const off = new FakeRunner();
    const m = machine({ files: ['/usr/bin/nvim', '/usr/bin/wezterm'], dirs: { '/tmp/nvim.me': ['a'], '/tmp/nvim.me/a': ['nvim.1.0'] } });
    const s2 = await service({ kind: 'nvim', nvimReuse: false }, off, m);
    await s2.open({ className: 'com.example.admin.Only' });
    expect(off.runs).toEqual([]);
    expect(off.launches).toHaveLength(1);
  });

  it('custom: runs the template without a shell', async () => {
    const runner = new FakeRunner();
    const s = await service({ kind: 'custom', custom: 'myed --line {line} {file}' }, runner);
    const r = await s.open({ className: 'com.example.admin.Only', line: 9 });
    expect(r.message).toBe('Opened Only.java:9');
    expect(runner.launches[0]).toMatchObject({ file: '/usr/bin/myed', args: ['--line', '9', join(dir, 'admin/src/main/java/com/example/admin/Only.java')] });
  });
});

describe('editor settings', () => {
  it('validates the editor section', () => {
    const input: any = structuredClone(DEFAULT_CONFIG);
    input.editor = { kind: 'notepad', program: ' "C:\\x\\ed.exe" ', nvimReuse: 'yes', terminal: 'wezterm start {nope}', custom: '', sourceDirs: [' C:/dev/lib ', ''] };
    const { config, errors } = validateConfig(input);
    expect(errors.map((e) => e.path).sort()).toEqual(['editor.kind', 'editor.nvimReuse', 'editor.terminal']);
    expect(config.editor.program).toBe('C:\\x\\ed.exe');
    expect(config.editor.sourceDirs).toEqual(['C:/dev/lib']);
    const custom: any = structuredClone(DEFAULT_CONFIG);
    custom.editor.kind = 'custom';
    expect(validateConfig(custom).errors.map((e) => e.path)).toEqual(['editor.custom']);
    custom.editor.custom = 'ed --line {line}';
    expect(validateConfig(custom).errors[0].message).toBe('Must contain {file}');
    expect(validateConfig(structuredClone(DEFAULT_CONFIG)).config.editor).toEqual(DEFAULT_CONFIG.editor);
  });
});

describe('source API', () => {
  let hub: Hub;
  let server: Server;
  let base: string;
  let runner: FakeRunner;

  beforeEach(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    const cfg = config({ kind: 'custom', custom: 'myed {file}:{line}' });
    cfg.port = port;
    cfg.chrome.enabled = false;
    cfg.sessionsDir = join(dir, 'sessions');
    hub = new Hub(cfg);
    runner = new FakeRunner();
    hub.source = new SourceService(cfg, { runner, machine: machine({ files: ['/usr/bin/myed'] }) });
    hub.start();
    await hub.source.index.ready();
    server = await startServer(hub, dir, { configFile: join(dir, 'debug-hub.config.json') });
    base = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    server.close();
    await hub.stop();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('says which classes are linkable', async () => {
    const r = await (await post('/api/source/resolve', { names: ['com.example.admin.Only', 'java.lang.Thread', 'com.example.orders.OrderService', 7], webapp: 'shop' })).json();
    expect(r.known).toEqual({ 'com.example.admin.Only': 1, 'com.example.orders.OrderService': 1 });
    expect(typeof r.generation).toBe('number');
  });

  it('opens a known class, refuses an unknown one, and asks when several files match', async () => {
    const ok = await post('/api/source/open', { className: 'com.example.admin.Only', file: 'Only.java', line: 2 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).message).toBe('Opened Only.java:2');
    expect(runner.launches[0].args).toEqual([`${join(dir, 'admin/src/main/java/com/example/admin/Only.java')}:2`]);

    const unknown = await post('/api/source/open', { className: 'java.lang.Thread', file: '/etc/passwd' });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).settings).toBe(true);

    const several = await post('/api/source/open', { className: 'com.example.orders.OrderService' });
    expect(several.status).toBe(409);
    expect((await several.json()).candidates).toHaveLength(2);

    const bad = await post('/api/source/open', { className: 'com.example.orders.OrderService', pick: '/etc/passwd' });
    expect(bad.status).toBe(400);
    expect(runner.launches).toHaveLength(1);
  });

  it('refuses requests from other sites, since open starts programs', async () => {
    const r = await post('/api/source/open', { className: 'com.example.admin.Only' }, { origin: 'http://evil.example' });
    expect(r.status).toBe(403);
    expect(runner.launches).toEqual([]);
  });

  it('reports the projects found and the editor', async () => {
    const st = await (await fetch(`${base}/api/source/status`)).json();
    expect(st.index.projects.map((p: { name: string }) => p.name).sort()).toEqual(['admin', 'shop']);
    expect(st.editor).toMatchObject({ kind: 'custom' });
    const ed = await (await fetch(`${base}/api/source/editor?kind=nvim&program=`)).json();
    expect(ed.name).toBe('Neovim');
  });
});
