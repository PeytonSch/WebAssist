import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, posix, resolve, win32 } from 'node:path';
import { chromeArgs } from '../shared/chrome-command';
import { describeProbe, hostPort, probeChrome, type ProbeResult } from './collectors/chrome-probe';
import type { Config } from './config';

/**
 * Starts Chrome with its debugging port for the Start Chrome button. Chrome is spawned
 * directly, not through a shell, so there is no quoting or %VARIABLE% expansion to get wrong:
 * the profile folder reaches Chrome exactly as given.
 */

/** The parts of the machine that finding Chrome depends on, so tests can stand in for them. */
export interface Machine {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  isFile: (path: string) => boolean;
}

export function thisMachine(): Machine {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Environment variable names are case-insensitive on Windows, and a plain object is not. */
function envVar(m: Machine, name: string): string | undefined {
  if (m.platform !== 'win32') return m.env[name];
  const key = Object.keys(m.env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? m.env[key] : undefined;
}

const pathFor = (m: Machine) => (m.platform === 'win32' ? win32 : posix);

/** Where Chrome is installed by default, most likely first. */
export function chromeCandidates(m: Machine): string[] {
  const path = pathFor(m);
  if (m.platform === 'win32') {
    // Machine-wide installs, then the per-user install Chrome falls back to without admin rights.
    return ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']
      .map((v) => envVar(m, v))
      .filter((root): root is string => !!root)
      .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (m.platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    return [path.join('/Applications', app), path.join(m.home, 'Applications', app)];
  }
  const dirs = (envVar(m, 'PATH') ?? '').split(':').filter(Boolean);
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  return names.flatMap((name) => dirs.map((dir) => path.join(dir, name)));
}

export interface ChromeLocation {
  /** The program to run, or null when none was found. */
  path: string | null;
  /** 'settings' when chrome.executable is set, else 'found' or 'none'. */
  source: 'settings' | 'found' | 'none';
  /** Every path looked at, for the error message. */
  tried: string[];
  problem: string | null;
}

/**
 * Finds the program to run. A configured path wins; it may be pasted with quotes around it, and
 * on macOS it may name the .app bundle instead of the program inside it.
 */
export function findChrome(configured: string, m: Machine): ChromeLocation {
  let wanted = configured.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  if (wanted) {
    if (m.platform === 'darwin' && /\.app\/?$/.test(wanted)) {
      const app = wanted.replace(/\/$/, '');
      wanted = posix.join(app, 'Contents', 'MacOS', posix.basename(app, '.app'));
    }
    if (m.isFile(wanted)) return { path: wanted, source: 'settings', tried: [wanted], problem: null };
    return {
      path: null,
      source: 'settings',
      tried: [wanted],
      problem: `There is no program at ${wanted}. Fix Chrome program in Settings, or clear it to find Chrome automatically.`,
    };
  }
  const tried = chromeCandidates(m);
  const found = tried.find((p) => m.isFile(p));
  if (found) return { path: found, source: 'found', tried, problem: null };
  return { path: null, source: 'none', tried, problem: 'Chrome was not found where it is usually installed. Set Chrome program in Settings.' };
}

/** chrome.profileDir as an absolute folder. Relative paths are relative to the settings file. */
export function resolveProfileDir(profileDir: string, configDir: string): string {
  return resolve(configDir, profileDir.trim() || 'chrome-profile');
}

/** chrome.executable as an absolute path, or '' to find Chrome automatically. */
export function resolveExecutable(executable: string, configDir: string): string {
  const e = executable.trim().replace(/^"(.*)"$/, '$1');
  return e && !isAbsolute(e) && !win32.isAbsolute(e) ? resolve(configDir, e) : e;
}

// ── Launching ───────────────────────────────────────────

export interface LaunchResult {
  ok: boolean;
  outcome: 'started' | 'already-running' | 'not-found' | 'failed' | 'exited' | 'no-port' | 'port-taken';
  message: string;
  /** What to do about it, when it did not work. */
  hint?: string;
  executable?: string;
  profileDir?: string;
  browser?: string;
}

/** The slice of a spawned process the launcher listens to. */
interface Child {
  once(event: 'exit' | 'error', cb: (...args: any[]) => void): unknown;
  unref(): void;
}

export interface LaunchOptions {
  host: string;
  port: number;
  /** chrome.executable, absolute or empty. */
  executable: string;
  /** Absolute; created if missing. */
  profileDir: string;
  /** How long to wait for the debugging port to open. */
  waitMs?: number;
  pollMs?: number;
  machine?: Machine;
  spawn?: (cmd: string, args: string[], opts: Record<string, unknown>) => Child;
  probe?: (host: string, port: number) => Promise<ProbeResult>;
  mkdir?: (dir: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function launchChrome(o: LaunchOptions): Promise<LaunchResult> {
  const probe = o.probe ?? ((host: string, port: number) => probeChrome(host, port, 1000));
  const at = hostPort(o.host, o.port);

  // Never start a second Chrome on a port that already works, or that something else holds.
  const before = await probe(o.host, o.port);
  if (before.kind === 'chrome') {
    return { ok: true, outcome: 'already-running', browser: before.browser, message: `${before.browser} is already running with its debugging port at ${at}. Nothing was started.` };
  }
  if (before.kind === 'other' || before.kind === 'timeout') {
    return { ok: false, outcome: 'port-taken', message: describeProbe(before, o.port).split('\n')[0].replace(/^Waiting for Chrome: /, ''), hint: 'Choose another debugging port in Settings, or close the program that uses this one.' };
  }

  const machine = o.machine ?? thisMachine();
  const where = findChrome(o.executable, machine);
  if (!where.path) {
    return { ok: false, outcome: 'not-found', message: where.problem!, hint: where.source === 'none' ? `Looked in: ${where.tried.join(', ') || 'nowhere (no PATH)'}` : undefined };
  }
  const exe = where.path;
  const facts = { executable: exe, profileDir: o.profileDir };

  try {
    (o.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true })))(o.profileDir);
  } catch (err) {
    return { ok: false, outcome: 'failed', ...facts, message: `Cannot create the profile folder ${o.profileDir}: ${(err as Error).message}`, hint: 'Choose another profile folder in Settings.' };
  }

  let exited: { code: number | null; signal: string | null } | null = null;
  let failed: Error | null = null;
  const spawn = o.spawn ?? ((cmd: string, args: string[], opts: Record<string, unknown>): Child => nodeSpawn(cmd, args, opts as SpawnOptions));
  try {
    const child = spawn(exe, chromeArgs(o.port, o.profileDir), {
      // Chrome outlives Debug Hub: detached keeps it out of the hub's process group (and, on
      // Windows, out of the job object that would close it when the hub quits).
      detached: true,
      stdio: 'ignore',
      // Not hidden: windowsHide asks Windows to start the first window hidden, and Chrome is a
      // GUI program with no console window to hide anyway.
      windowsHide: false,
    });
    child.once('error', (err: Error) => (failed = err));
    child.once('exit', (code: number | null, signal: string | null) => (exited = { code, signal }));
    child.unref();
  } catch (err) {
    failed = err as Error;
  }

  const deadline = Date.now() + (o.waitMs ?? 10_000);
  for (;;) {
    if (failed) {
      return { ok: false, outcome: 'failed', ...facts, message: `Could not start ${exe}: ${(failed as Error).message}`, hint: 'Check Chrome program in Settings.' };
    }
    const now = await probe(o.host, o.port);
    if (now.kind === 'chrome') {
      return { ok: true, outcome: 'started', ...facts, browser: now.browser, message: `Started ${now.browser} with its debugging port at ${at}.` };
    }
    if (exited) return exitedResult(exited, facts, o);
    if (Date.now() >= deadline) break;
    await sleep(o.pollMs ?? 250);
  }
  return {
    ok: false,
    outcome: 'no-port',
    ...facts,
    message: `Chrome was started, but its debugging port at ${at} did not open within ${Math.round((o.waitMs ?? 10_000) / 1000)} s.`,
    hint: `Debug Hub keeps trying and connects if it opens. If it does not, close every Chrome window that uses ${o.profileDir} and try again.`,
  };
}

function exitedResult(e: { code: number | null; signal: string | null }, facts: { executable: string; profileDir: string }, o: LaunchOptions): LaunchResult {
  // A Chrome already running on the same profile takes the request over and the new process
  // quits at once, with success, and the debugging flag is dropped along the way.
  if (e.code === 0) {
    return {
      ok: false,
      outcome: 'exited',
      ...facts,
      message: 'A Chrome already open on this profile took the request over, so the debugging port did not open.',
      hint: `Close every Chrome window that uses ${o.profileDir} (or end Chrome in the task manager), then try again.`,
    };
  }
  return {
    ok: false,
    outcome: 'exited',
    ...facts,
    message: `Chrome quit before opening its debugging port (${e.signal ? `signal ${e.signal}` : `exit code ${e.code}`}).`,
    hint: 'Try running the command shown under Settings > Browser in a terminal to see what Chrome reports.',
  };
}

let inFlight: Promise<LaunchResult> | null = null;

/**
 * Starts Chrome with the running settings. A second click while Chrome is starting gets the
 * same answer instead of a second Chrome.
 */
export function startChrome(cfg: Config, configDir: string): Promise<LaunchResult> {
  inFlight ??= (async () => {
    try {
      const r = await launchChrome({
        host: cfg.chrome.host,
        port: cfg.chrome.port,
        executable: resolveExecutable(cfg.chrome.executable, configDir),
        profileDir: resolveProfileDir(cfg.chrome.profileDir, configDir),
      });
      if (r.ok && !cfg.chrome.enabled) r.message += ' Recording from Chrome is turned off in Settings, so nothing is captured.';
      return r;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** What the settings screen shows: which Chrome would start, and with which profile folder. */
export function chromeSetup(executable: string, profileDir: string, configDir: string, m: Machine = thisMachine()) {
  const where = findChrome(resolveExecutable(executable, configDir), m);
  return {
    platform: m.platform,
    executable: where.path,
    source: where.source,
    problem: where.problem,
    profileDir: resolveProfileDir(profileDir, configDir),
  };
}
export type ChromeSetup = ReturnType<typeof chromeSetup>;
