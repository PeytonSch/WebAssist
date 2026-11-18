import { spawn } from 'node:child_process';
import { closeSync, promises as fs, openSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRun } from '../../shared/tomcat';
import type { StartCommand } from '../config';
import { backgroundSpawn, readTail, type ScriptCommand } from './scripts';
import { TomcatError } from './webapps';

/**
 * Runs the start commands: the rest of the dev setup (a database, a front-end dev server, a
 * watcher) brought up with Tomcat. Like the Tomcat scripts, each one runs detached with its
 * output going to a file, so it outlives Debug Hub and closing the hub never breaks its output.
 */

/**
 * A command line run by the system shell. On Windows that is cmd.exe: with /s and the whole line
 * in one more pair of quotes, cmd.exe drops just those outer quotes and runs the rest exactly as
 * typed, quoted paths and all. The line must reach cmd.exe as written (verbatim): Node's own
 * quoting would escape the user's quotes with backslashes, which cmd.exe does not understand.
 */
export function shellCommand(command: string, opts: { platform?: NodeJS.Platform; comspec?: string } = {}): ScriptCommand {
  const platform = opts.platform ?? process.platform;
  const line = command.trim();
  if (!line) throw new TomcatError('The command is empty.');
  if (/[\r\n]/.test(line)) throw new TomcatError('A command must be one line. Put several commands in a script, or join them with &&.');
  if (platform === 'win32') {
    const file = opts.comspec || 'cmd.exe';
    const args = ['/d', '/s', '/c', `"${line}"`];
    return { file, args, verbatim: true, display: `${file} ${args.join(' ')}` };
  }
  return { file: '/bin/sh', args: ['-c', line], verbatim: false, display: line };
}

/**
 * Ends a command and everything it started. A shell runs the command as its child (npm runs
 * node, which may run more), so killing just the shell would leave the real work running.
 * Windows: taskkill /T follows the parent links down the tree. Elsewhere the command was started
 * detached, as the leader of its own process group, so signalling the group reaches all of it.
 */
export function killTree(pid: number, opts: { platform?: NodeJS.Platform; signal?: NodeJS.Signals } = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    return new Promise((resolve, reject) => {
      const p = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      p.once('error', reject);
      // 128: no such process, which is what stopping wanted.
      p.once('exit', (code) => (code === 0 || code === 128 ? resolve() : reject(new Error(`taskkill exited with code ${code}`))));
    });
  }
  try {
    process.kill(-pid, opts.signal ?? 'SIGTERM');
  } catch (err: any) {
    if (err?.code !== 'ESRCH') return Promise.reject(err);
  }
  return Promise.resolve();
}

/** How a run ended, for the start sequence. */
export interface CommandEnd {
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  stopped: boolean;
}

interface Running {
  run: CommandRun;
  logFile: string;
  ended: Promise<CommandEnd>;
}

export interface CommandHooks {
  onStart?: (run: CommandRun, logFile: string) => void;
  onExit?: (run: CommandRun) => void;
}

const MAX_OUTPUT = 8 * 1024;
/** How long a stopped command has to exit after SIGTERM before it is killed outright. */
const KILL_GRACE_MS = 3000;

export const commandLabel = (c: { name: string; command: string }) => c.name.trim() || c.command.trim();
/** Two entries are the same command if they run the same line in the same folder; the name is only a label. */
const keyOf = (c: { command: string; cwd: string }) => `${c.cwd}\n${c.command.trim()}`;

export class CommandRunner {
  private runs = new Map<number, Running>();
  private nextId = 1;

  constructor(
    private logDir = join(tmpdir(), 'debug-hub', 'start-commands'),
    private hooks: CommandHooks = {},
    private platform: NodeJS.Platform = process.platform,
  ) {}

  /** The run of this command that is still going, if any. */
  runningFor(c: StartCommand): Running | null {
    for (const r of this.runs.values()) if (r.run.running && keyOf(r.run) === keyOf(c)) return r;
    return null;
  }

  /** The latest run of this command. */
  latestFor(c: StartCommand): CommandRun | null {
    let latest: CommandRun | null = null;
    for (const r of this.runs.values()) if (keyOf(r.run) === keyOf(c) && (!latest || r.run.id > latest.id)) latest = r.run;
    return latest;
  }

  /** Runs still going that none of these commands account for. */
  others(commands: StartCommand[]): CommandRun[] {
    const keys = new Set(commands.map(keyOf));
    return [...this.runs.values()].filter((r) => r.run.running && !keys.has(keyOf(r.run))).map((r) => r.run);
  }

  /** A run and the file its output goes to. */
  get(id: number): { run: CommandRun; logFile: string } | null {
    const r = this.runs.get(id);
    return r ? { run: r.run, logFile: r.logFile } : null;
  }

  ended(id: number): Promise<CommandEnd> {
    const r = this.runs.get(id);
    if (!r) throw new TomcatError('No such command run.', 404);
    return r.ended;
  }

  /** Starts a command. Refuses one that is already running, which would usually mean a second dev server. */
  async start(c: StartCommand): Promise<CommandRun> {
    const label = commandLabel(c);
    const already = this.runningFor(c);
    if (already) {
      throw new TomcatError(`${label} is already running (process ${already.run.pid}). Stop it first to run it again.`, 409);
    }
    const shell = shellCommand(c.command, { platform: this.platform, comspec: process.env.ComSpec });
    let st;
    try {
      st = statSync(c.cwd);
    } catch {
      throw new TomcatError(`The folder for ${label} was not found: ${c.cwd}`, 404);
    }
    if (!st.isDirectory()) throw new TomcatError(`The folder for ${label} is not a folder: ${c.cwd}`);

    await fs.mkdir(this.logDir, { recursive: true });
    this.cleanOldLogs();
    const id = this.nextId++;
    const logFile = join(this.logDir, `command-${Date.now()}-${id}.log`);
    const fd = openSync(logFile, 'a');
    const run: CommandRun = {
      id,
      name: label,
      command: c.command.trim(),
      cwd: c.cwd,
      shell: shell.display,
      startedAt: new Date().toISOString(),
      endedAt: null,
      pid: null,
      running: true,
      exitCode: null,
      signal: null,
      error: null,
      stopped: false,
      output: '',
      outputTruncated: false,
    };
    let settle!: (e: CommandEnd) => void;
    const ended = new Promise<CommandEnd>((resolve) => (settle = resolve));
    this.runs.set(id, { run, logFile, ended });
    this.hooks.onStart?.(run, logFile);
    const finish = (patch: Partial<CommandRun>) => {
      if (!run.running) return;
      Object.assign(run, patch, { running: false, endedAt: new Date().toISOString() });
      settle({ exitCode: run.exitCode, signal: run.signal, error: run.error, stopped: run.stopped });
      this.hooks.onExit?.(run);
    };
    try {
      const child = spawn(shell.file, shell.args, {
        cwd: c.cwd,
        stdio: ['ignore', fd, fd],
        // Outlives Debug Hub without a console window of its own: the output is on the timeline
        // and the Tomcat page's console. Elsewhere it leads its own process group, so Stop can end all of it.
        ...backgroundSpawn(this.platform),
        windowsVerbatimArguments: shell.verbatim,
      });
      run.pid = child.pid ?? null;
      child.once('error', (err) => finish({ error: err.message }));
      child.once('exit', (code, signal) => finish({ exitCode: code, signal }));
      child.unref();
    } catch (err) {
      finish({ error: (err as Error).message });
    } finally {
      closeSync(fd);
    }
    return run;
  }

  /** Stops a run and everything it started. */
  async stop(id: number): Promise<CommandRun> {
    const r = this.runs.get(id);
    if (!r) throw new TomcatError('No such command run. Refresh the page.', 404);
    if (!r.run.running || !r.run.pid) return r.run;
    r.run.stopped = true;
    await killTree(r.run.pid, { platform: this.platform });
    if (this.platform !== 'win32') {
      // A command that ignores SIGTERM (or a child that does) is killed outright after a moment.
      const pid = r.run.pid;
      const timer = setTimeout(() => void killTree(pid, { signal: 'SIGKILL' }).catch(() => undefined), KILL_GRACE_MS);
      void r.ended.then(() => clearTimeout(timer));
    }
    return r.run;
  }

  /** A run with the end of its output. */
  async snapshot(run: CommandRun): Promise<CommandRun> {
    const r = this.runs.get(run.id);
    if (!r) return run;
    const { text, truncated } = await readTail(r.logFile, MAX_OUTPUT);
    return { ...r.run, output: text, outputTruncated: truncated };
  }

  /** Output files of runs that have ended, except the latest of each command. */
  private cleanOldLogs(): void {
    const latest = new Map<string, number>();
    for (const r of this.runs.values()) latest.set(keyOf(r.run), Math.max(latest.get(keyOf(r.run)) ?? 0, r.run.id));
    for (const [id, r] of this.runs) {
      if (!r.run.running && latest.get(keyOf(r.run)) !== id) {
        this.runs.delete(id);
        void fs.rm(r.logFile, { force: true }).catch(() => undefined);
      }
    }
  }
}
