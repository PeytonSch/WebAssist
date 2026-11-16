import { spawn } from 'node:child_process';
import { closeSync, constants, promises as fs, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ScriptKind, ScriptRun } from '../../shared/tomcat';
import { TomcatError } from './webapps';

/**
 * Runs the user's own Tomcat start and stop scripts.
 *
 * The usual startup script launches Tomcat and exits at once, but a custom one may keep Tomcat in
 * the foreground ("catalina run"). So the hub never waits for the script, and starts it detached
 * with its output going to a file rather than a pipe: closing Debug Hub must not take a
 * foreground Tomcat down with it, which a broken pipe or a shared process group would.
 */

export interface ScriptCommand {
  file: string;
  args: string[];
  /** Pass the arguments to Windows as written; cmd.exe has its own quoting rules. */
  verbatim: boolean;
  /** The command line, for showing to the user. */
  display: string;
}

/**
 * How to run a script on a platform. On Windows, .bat and .cmd files can only be run through
 * cmd.exe (Node refuses to spawn them directly). "/s /c" with the whole command in one more
 * pair of quotes is the form that keeps a quoted path with spaces intact.
 */
export function scriptCommand(
  script: string,
  opts: { platform?: NodeJS.Platform; executable?: boolean; comspec?: string } = {},
): ScriptCommand {
  const platform = opts.platform ?? process.platform;
  const ext = extname(script).toLowerCase();
  if (platform === 'win32') {
    // Settings may hold forward slashes; cmd.exe reads "C:/x/startup.bat" as a switch in places.
    const path = script.replace(/\//g, '\\');
    if (/["%\r\n]/.test(path)) throw new TomcatError(`The script path cannot contain " or %: ${script}`);
    if (ext === '.bat' || ext === '.cmd') {
      const file = opts.comspec || 'cmd.exe';
      const args = ['/d', '/s', '/c', `""${path}""`];
      return { file, args, verbatim: true, display: `${file} ${args.join(' ')}` };
    }
    if (ext === '.ps1') {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path];
      return { file: 'powershell.exe', args, verbatim: false, display: `powershell.exe ${args.slice(0, -1).join(' ')} "${path}"` };
    }
    return { file: path, args: [], verbatim: false, display: `"${path}"` };
  }
  // A shell script without the executable bit still runs through sh; one with it uses its own #! line.
  if (ext === '.sh' && opts.executable === false) return { file: '/bin/sh', args: [script], verbatim: false, display: `/bin/sh '${script}'` };
  return { file: script, args: [], verbatim: false, display: `'${script}'` };
}

const MAX_OUTPUT = 32 * 1024;

interface Running {
  run: ScriptRun;
  logFile: string;
}

export interface ScriptHooks {
  /** A run started; its output is in logFile. */
  onStart?: (run: ScriptRun, logFile: string) => void;
  onExit?: (run: ScriptRun) => void;
}

export class ScriptRunner {
  private runs = new Map<ScriptKind, Running>();

  constructor(private logDir = join(tmpdir(), 'debug-hub', 'tomcat-scripts'), private hooks: ScriptHooks = {}) {}

  async run(kind: ScriptKind, script: string): Promise<ScriptRun> {
    const label = kind === 'start' ? 'start script' : 'stop script';
    if (!script) throw new TomcatError(`No Tomcat ${label} is set. Add one in Settings › Tomcat.`);
    const prev = this.runs.get(kind);
    if (prev?.run.running) {
      throw new TomcatError(
        `The ${label} from ${new Date(prev.run.startedAt).toLocaleTimeString()} is still running (process ${prev.run.pid}). If it keeps Tomcat in the foreground, use Stop instead.`,
        409,
      );
    }
    let st;
    try {
      st = await fs.stat(script);
    } catch {
      throw new TomcatError(`The ${label} was not found: ${script}`, 404);
    }
    if (!st.isFile()) throw new TomcatError(`The ${label} is not a file: ${script}`);
    let executable = true;
    if (process.platform !== 'win32') executable = await fs.access(script, constants.X_OK).then(() => true, () => false);
    const cmd = scriptCommand(script, { executable, comspec: process.env.ComSpec });

    await fs.mkdir(this.logDir, { recursive: true });
    await this.cleanOldLogs(kind);
    const logFile = join(this.logDir, `tomcat-${kind}-${Date.now()}.log`);
    const fd = openSync(logFile, 'a');
    const run: ScriptRun = {
      kind,
      script,
      command: cmd.display,
      startedAt: new Date().toISOString(),
      endedAt: null,
      pid: null,
      running: true,
      exitCode: null,
      signal: null,
      error: null,
      output: '',
      outputTruncated: false,
    };
    this.runs.set(kind, { run, logFile });
    this.hooks.onStart?.(run, logFile);
    const finish = (patch: Partial<ScriptRun>) => {
      if (!run.running) return;
      Object.assign(run, patch, { running: false, endedAt: new Date().toISOString() });
      this.hooks.onExit?.(run);
    };
    const failed = (err: any) =>
      finish({ error: err?.code === 'EACCES' ? `Not allowed to run ${basename(script)}. Is it executable?` : String(err?.message ?? err) });
    try {
      const child = spawn(cmd.file, cmd.args, {
        cwd: dirname(script),
        stdio: ['ignore', fd, fd],
        detached: true,
        windowsHide: true,
        windowsVerbatimArguments: cmd.verbatim,
      });
      run.pid = child.pid ?? null;
      child.once('error', failed);
      child.once('exit', (code, signal) => finish({ exitCode: code, signal }));
      // Debug Hub may exit while the script (or a foreground Tomcat) keeps running.
      child.unref();
    } catch (err) {
      failed(err);
    } finally {
      // The child has its own copy of the file handle.
      closeSync(fd);
    }
    return this.snapshot(kind) as Promise<ScriptRun>;
  }

  /** The latest run of a kind with the end of its output. */
  async snapshot(kind: ScriptKind): Promise<ScriptRun | null> {
    const r = this.runs.get(kind);
    if (!r) return null;
    const { text, truncated } = await readTail(r.logFile, MAX_OUTPUT);
    return { ...r.run, output: text, outputTruncated: truncated };
  }

  private async cleanOldLogs(kind: ScriptKind): Promise<void> {
    const names = await fs.readdir(this.logDir).catch(() => [] as string[]);
    for (const n of names) {
      // On Windows, a foreground Tomcat from an earlier Debug Hub may still hold its file open; it stays.
      if (n.startsWith(`tomcat-${kind}-`)) await fs.rm(join(this.logDir, n), { force: true }).catch(() => undefined);
    }
  }
}

/**
 * Follows one script's output file line by line. Unlike the log Tailer, reads are queued rather
 * than skipped while one is running, so `drain` returns only once everything written so far has
 * been passed on: the "script finished" note must come after the script's last line.
 */
export class OutputFollower {
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private file: string, private pollMs: number, private onLine: (line: string) => void) {}

  start(): void {
    this.timer ??= setInterval(() => void this.drain(), this.pollMs);
  }

  drain(): Promise<void> {
    this.queue = this.queue.then(() => this.read()).catch(() => undefined);
    return this.queue;
  }

  /** Reads what is left, including a last line without a newline, and stops. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drain();
    const rest = this.partial + this.decoder.end();
    this.partial = '';
    if (rest) this.onLine(rest.replace(/\r$/, ''));
  }

  private async read(): Promise<void> {
    let handle;
    try {
      handle = await fs.open(this.file, 'r');
    } catch {
      return;
    }
    try {
      const { size } = await handle.stat();
      const buf = Buffer.alloc(64 * 1024);
      while (this.offset < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - this.offset), this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        const lines = (this.partial + this.decoder.write(buf.subarray(0, bytesRead))).split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) this.onLine(line.replace(/\r$/, ''));
      }
    } finally {
      await handle.close();
    }
  }
}

async function readTail(file: string, max: number): Promise<{ text: string; truncated: boolean }> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return { text: '', truncated: false };
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    // Starting mid-file can split a character or a line; drop the partial first line.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
