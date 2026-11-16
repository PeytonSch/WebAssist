import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromeCandidates, chromeSetup, findChrome, launchChrome, resolveExecutable, resolveProfileDir, type Machine } from '../src/server/chrome-launch';
import { ChromeCollector } from '../src/server/collectors/chrome';
import { describeProbe, hostsToTry, probeChrome, probeHost, type ProbeResult } from '../src/server/collectors/chrome-probe';
import { DEFAULT_CONFIG } from '../src/server/config';
import { chromeArgs, chromeCommandLines } from '../src/shared/chrome-command';

const machine = (platform: NodeJS.Platform, env: Record<string, string>, files: string[] = [], home = '/home/me'): Machine => ({
  platform,
  env,
  home,
  isFile: (p) => files.includes(p),
});

describe('finding Chrome', () => {
  it('looks in Program Files, Program Files (x86) and the per-user folder on Windows', () => {
    // Windows hands environment names to Node in whatever case they were defined.
    const m = machine('win32', { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
    expect(chromeCandidates(m)).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('finds a per-user install on Windows when there is no machine-wide one', () => {
    const local = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const m = machine('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, [local]);
    expect(findChrome('', m)).toMatchObject({ path: local, source: 'found', problem: null });
  });

  it('looks in /Applications and ~/Applications on macOS', () => {
    const user = '/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const m = machine('darwin', {}, [user], '/Users/me');
    expect(chromeCandidates(m)).toEqual(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', user]);
    expect(findChrome('', m).path).toBe(user);
  });

  it('searches PATH for the usual Chrome and Chromium names on Linux', () => {
    const m = machine('linux', { PATH: '/usr/local/bin:/usr/bin' }, ['/usr/bin/chromium']);
    expect(chromeCandidates(m)).toContain('/usr/bin/google-chrome-stable');
    expect(chromeCandidates(m)).toContain('/usr/local/bin/chromium-browser');
    expect(findChrome('', m).path).toBe('/usr/bin/chromium');
  });

  it('uses the configured program, even pasted with quotes, and accepts a macOS .app bundle', () => {
    const win = 'D:\\Apps\\Chrome\\chrome.exe';
    expect(findChrome(`"${win}"`, machine('win32', {}, [win]))).toMatchObject({ path: win, source: 'settings' });
    const inner = '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta';
    expect(findChrome('/Applications/Google Chrome Beta.app', machine('darwin', {}, [inner])).path).toBe(inner);
  });

  it('says so when the configured program does not exist, instead of silently using another', () => {
    const r = findChrome('/opt/nope/chrome', machine('linux', { PATH: '/usr/bin' }, ['/usr/bin/google-chrome']));
    expect(r.path).toBeNull();
    expect(r.problem).toMatch(/no program at \/opt\/nope\/chrome/i);
  });

  it('reports where it looked when Chrome is not installed', () => {
    const r = findChrome('', machine('linux', { PATH: '/usr/bin' }));
    expect(r).toMatchObject({ path: null, source: 'none' });
    expect(r.tried).toContain('/usr/bin/google-chrome');
  });

  it('resolves the profile folder and program against the settings folder', () => {
    expect(resolveProfileDir('chrome-profile', '/cfg')).toBe('/cfg/chrome-profile');
    expect(resolveProfileDir('', '/cfg')).toBe('/cfg/chrome-profile');
    expect(resolveProfileDir('/abs/profile', '/cfg')).toBe('/abs/profile');
    expect(resolveExecutable('', '/cfg')).toBe('');
    expect(resolveExecutable('bin/chrome', '/cfg')).toBe('/cfg/bin/chrome');
    // A Windows path stays as it is even when the tests run elsewhere.
    expect(resolveExecutable('C:\\Chrome\\chrome.exe', '/cfg')).toBe('C:\\Chrome\\chrome.exe');
  });

  it('gives the settings screen absolute paths', () => {
    const setup = chromeSetup('', 'chrome-profile', '/cfg', machine('linux', { PATH: '/usr/bin' }, ['/usr/bin/google-chrome']));
    expect(setup).toEqual({ platform: 'linux', executable: '/usr/bin/google-chrome', source: 'found', problem: null, profileDir: '/cfg/chrome-profile' });
  });
});

describe('the Chrome command line', () => {
  const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const profile = 'C:\\Users\\me\\AppData\\Roaming\\Debug Hub\\chrome-profile';

  it('always passes its own profile folder with the debugging port', () => {
    expect(chromeArgs(57017, profile)).toEqual([
      '--remote-debugging-port=57017',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]);
  });

  it('gives Windows a Command Prompt and a PowerShell variant, with no environment variables', () => {
    const [cmd, ps] = chromeCommandLines('win32', exe, chromeArgs(57017, profile));
    expect(cmd.label).toBe('Command Prompt');
    expect(cmd.text).toBe(`"${exe}" --remote-debugging-port=57017 --user-data-dir="${profile}" --no-first-run --no-default-browser-check`);
    expect(ps.label).toBe('PowerShell');
    // A bare quoted path is only a string in PowerShell; & runs it.
    expect(ps.text).toBe(`& '${exe}' --remote-debugging-port=57017 '--user-data-dir=${profile}' --no-first-run --no-default-browser-check`);
    for (const l of [cmd, ps]) expect(l.text).not.toMatch(/%\w+%|\$env:/);
  });

  it('escapes quotes in PowerShell and POSIX shells', () => {
    const [, ps] = chromeCommandLines('win32', exe, chromeArgs(9222, "C:\\Users\\O'Brien\\profile"));
    expect(ps.text).toContain(`'--user-data-dir=C:\\Users\\O''Brien\\profile'`);
    const [sh] = chromeCommandLines('darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromeArgs(9222, "/Users/o'brien/Debug Hub/p"));
    expect(sh.label).toBe('Terminal');
    expect(sh.text).toBe(
      `'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --remote-debugging-port=9222 --user-data-dir='/Users/o'\\''brien/Debug Hub/p' --no-first-run --no-default-browser-check`,
    );
  });
});

// ── Probing the debugging port ──────────────────────────

const servers: (Server | HttpServer)[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  // close() waits for open connections, and the silent server never ends its own.
  sockets.forEach((s) => s.destroy());
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

function listen<T extends Server | HttpServer>(server: T): Promise<number> {
  servers.push(server);
  server.on('connection', (s: Socket) => sockets.add(s));
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
}

/** A free port with nothing on it. */
async function freePort(): Promise<number> {
  const s = createServer();
  const port = await new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
  await new Promise((r) => s.close(r));
  return port;
}

const fakeChrome = () =>
  createHttpServer((req, res) => {
    const port = (req.socket.address() as AddressInfo).port;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ Browser: 'Chrome/157.0.8103.79', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/abc` }));
  });

describe('probing the debugging port', () => {
  it('tells nothing listening from another program and from no answer', async () => {
    expect((await probeHost('127.0.0.1', await freePort())).kind).toBe('refused');

    const web = await listen(createHttpServer((_q, s) => s.writeHead(404).end('no')));
    expect(await probeHost('127.0.0.1', web)).toEqual({ kind: 'other', host: '127.0.0.1', detail: 'HTTP 404' });

    const raw = await listen(createServer((sock) => sock.end('hello\r\n\r\n')));
    expect((await probeHost('127.0.0.1', raw)).kind).toBe('other');

    const silent = await listen(createServer(() => undefined));
    expect((await probeHost('127.0.0.1', silent, 300)).kind).toBe('timeout');

    const chrome = await listen(fakeChrome());
    expect(await probeHost('127.0.0.1', chrome)).toMatchObject({ kind: 'chrome', browser: 'Chrome/157.0.8103.79' });
  });

  it('dials 127.0.0.1 as well when the host is localhost', async () => {
    expect(hostsToTry('localhost')).toEqual(['127.0.0.1', 'localhost']);
    expect(hostsToTry('127.0.0.1')).toEqual(['127.0.0.1']);
    // Chrome listens on IPv4 only; whatever "localhost" resolves to, it is found.
    const chrome = await listen(fakeChrome());
    expect(await probeChrome('localhost', chrome)).toMatchObject({ kind: 'chrome', host: '127.0.0.1' });
  });

  it('explains a closed port with the profile and running-Chrome causes', () => {
    const text = describeProbe({ kind: 'refused', host: '127.0.0.1' }, 57017);
    const [first, ...rest] = text.split('\n');
    expect(first).toBe('Waiting for Chrome: nothing is listening on 127.0.0.1:57017');
    expect(rest.join(' ')).toMatch(/--user-data-dir/);
    expect(rest.join(' ')).toMatch(/136/);
    expect(rest.join(' ')).toMatch(/already running/);
    expect(describeProbe({ kind: 'other', host: '::1', detail: 'HTTP 404' }, 9222)).toMatch(/^Waiting for Chrome: something other than Chrome is on \[::1\]:9222/);
  });

  it('puts the reason in the Chrome collector status', async () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.chrome.port = await freePort();
    let collector: ChromeCollector;
    const seen = new Promise<string>((resolve) => {
      collector = new ChromeCollector(cfg, () => undefined, () => resolve(collector.status.detail));
    });
    collector!.start();
    try {
      expect(await seen).toMatch(/nothing is listening on 127\.0\.0\.1:/);
      expect(collector!.status.state).toBe('waiting');
    } finally {
      collector!.stop();
    }
  });
});

// ── Launching ───────────────────────────────────────────

interface Spawned {
  cmd: string;
  args: string[];
  opts: Record<string, any>;
  emit: (event: 'exit' | 'error', ...args: any[]) => void;
}

/** A spawn stand-in that records the call and lets the test end the "process". */
function fakeSpawn() {
  const calls: Spawned[] = [];
  const spawn = (cmd: string, args: string[], opts: Record<string, any>) => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    calls.push({ cmd, args, opts, emit: (e, ...a) => handlers[e]?.(...a) });
    return { once: (e: 'exit' | 'error', cb: (...a: any[]) => void) => (handlers[e] = cb), unref: () => undefined };
  };
  return { calls, spawn };
}

const linux = machine('linux', { PATH: '/usr/bin' }, ['/usr/bin/google-chrome']);
const chromeUp: ProbeResult = { kind: 'chrome', host: '127.0.0.1', browser: 'Chrome/157', webSocketDebuggerUrl: 'ws://x' };
const closed: ProbeResult = { kind: 'refused', host: '127.0.0.1' };
const base = { host: '127.0.0.1', port: 57017, executable: '', profileDir: '/data/chrome-profile', machine: linux, mkdir: () => undefined, pollMs: 5 };

describe('launchChrome', () => {
  it('starts nothing when Chrome already answers on the port', async () => {
    const { calls, spawn } = fakeSpawn();
    const r = await launchChrome({ ...base, spawn, probe: async () => chromeUp });
    expect(r).toMatchObject({ ok: true, outcome: 'already-running' });
    expect(calls).toHaveLength(0);
  });

  it('refuses when another program holds the port', async () => {
    const { calls, spawn } = fakeSpawn();
    const r = await launchChrome({ ...base, spawn, probe: async () => ({ kind: 'other', host: '127.0.0.1', detail: 'HTTP 404' }) });
    expect(r).toMatchObject({ ok: false, outcome: 'port-taken' });
    expect(calls).toHaveLength(0);
  });

  it('spawns Chrome directly, detached, with the port and an absolute profile folder', async () => {
    const { calls, spawn } = fakeSpawn();
    const answers = [closed, closed, closed, chromeUp];
    const made: string[] = [];
    const r = await launchChrome({ ...base, spawn, mkdir: (d) => made.push(d), probe: async () => answers.shift() ?? chromeUp });
    expect(r).toMatchObject({ ok: true, outcome: 'started', executable: '/usr/bin/google-chrome', profileDir: '/data/chrome-profile' });
    expect(made).toEqual(['/data/chrome-profile']);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('/usr/bin/google-chrome');
    expect(calls[0].args).toEqual(chromeArgs(57017, '/data/chrome-profile'));
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(calls[0].opts.shell).toBeFalsy();
  });

  it('recognises Chrome handing the request to one already open on the profile', async () => {
    const { calls, spawn } = fakeSpawn();
    let n = 0;
    const r = await launchChrome({
      ...base,
      spawn,
      probe: async () => {
        // The new process quits with success right after starting, port still closed.
        if (++n === 2) calls[0].emit('exit', 0, null);
        return closed;
      },
    });
    expect(r).toMatchObject({ ok: false, outcome: 'exited' });
    expect(r.message).toMatch(/already open on this profile/);
    expect(r.hint).toContain('/data/chrome-profile');
  });

  it('reports a crash, a failed spawn and a port that never opens', async () => {
    let s = fakeSpawn();
    let n = 0;
    const crashed = await launchChrome({ ...base, spawn: s.spawn, probe: async () => (++n === 2 && s.calls[0].emit('exit', 1, null), closed) });
    expect(crashed).toMatchObject({ ok: false, outcome: 'exited' });
    expect(crashed.message).toMatch(/exit code 1/);

    s = fakeSpawn();
    n = 0;
    const err = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
    const failed = await launchChrome({ ...base, spawn: s.spawn, probe: async () => (++n === 2 && s.calls[0].emit('error', err), closed) });
    expect(failed).toMatchObject({ ok: false, outcome: 'failed' });
    expect(failed.message).toMatch(/EACCES/);

    s = fakeSpawn();
    const slow = await launchChrome({ ...base, spawn: s.spawn, waitMs: 40, probe: async () => closed });
    expect(slow).toMatchObject({ ok: false, outcome: 'no-port' });
    expect(slow.hint).toMatch(/keeps trying/);
  });

  it('says where it looked when Chrome is not installed', async () => {
    const { calls, spawn } = fakeSpawn();
    const r = await launchChrome({ ...base, spawn, machine: machine('linux', { PATH: '/usr/bin' }), probe: async () => closed });
    expect(r).toMatchObject({ ok: false, outcome: 'not-found' });
    expect(r.hint).toContain('/usr/bin/google-chrome');
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(process.platform === 'win32')('launchChrome with a real process', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dh-launch-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the program and waits for its debugging port', async () => {
    // A stand-in Chrome: serves /json/version on the port it was given and records its profile.
    const exe = join(dir, 'fake-chrome');
    writeFileSync(
      exe,
      `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
const arg = (n) => process.argv.find((a) => a.startsWith('--' + n + '='))?.split('=').slice(1).join('=');
const port = Number(arg('remote-debugging-port'));
fs.writeFileSync(require('node:path').join(arg('user-data-dir'), 'started'), String(process.pid));
http.createServer((q, s) => s.end(JSON.stringify({ Browser: 'FakeChrome/1', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/x' }))).listen(port, '127.0.0.1');
setTimeout(() => process.exit(0), 5000);
`,
    );
    chmodSync(exe, 0o755);
    const profileDir = join(dir, 'profile with space');
    const port = await freePort();
    const r = await launchChrome({ host: '127.0.0.1', port, executable: exe, profileDir, waitMs: 5000 });
    try {
      expect(r).toMatchObject({ ok: true, outcome: 'started', browser: 'FakeChrome/1' });
      expect(existsSync(join(profileDir, 'started'))).toBe(true);
    } finally {
      try {
        process.kill(Number(readFileSync(join(profileDir, 'started'), 'utf8')));
      } catch {
        /* already gone */
      }
    }
  });
});
