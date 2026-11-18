import { spawn } from 'node:child_process';
import { closeSync, constants, promises as fs, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ScriptKind, ScriptRun } from '../../shared/tomcat';
import { TomcatError } from './webapps';

/**
 * Runs the Tomcat start and stop scripts: the user's own, or Tomcat's (catalina run, which keeps
 * Tomcat in the foreground so its console shows on the Tomcat page).
 *
 * The hub never waits for a script, and starts it in the background with its output going to a
 * file rather than a pipe: closing Debug Hub must not take a foreground Tomcat down with it, which
 * a broken pipe or a shared process group would. See backgroundSpawn for how.
 */

/**
 * How a script, Tomcat or a start command is started: in the background, without a window of
 * its own, outliving Debug Hub.
 *
 * Elsewhere than Windows: detached, so it leads its own process group (a signal to Debug Hub's
 * group does not reach it, and Stop can signal all of it).
 *
 * Windows: not detached. Node's detached there means DETACHED_PROCESS, a process without any
 * console, and then every console program it starts (java.exe for Tomcat, node.exe for a dev
 * server) gets a new, visible console window: the extra terminal windows. Started attached and
 * with windowsHide, the shell gets a hidden console of its own (or shares Debug Hub's, when that
 * was started from a terminal), and what it runs inherits it, so nothing shows. It still outlives
 * Debug Hub: Node puts the shell in a job that ends it when Debug Hub exits, but that job lets
 * the shell's children break away (JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK), so Tomcat itself keeps
 * running and writing to its output file.
 */
export function backgroundSpawn(platform: NodeJS.Platform = process.platform): { detached: boolean; windowsHide: boolean } {
  return { detached: platform !== 'win32', windowsHide: true };
}

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
  opts: { platform?: NodeJS.Platform; executable?: boolean; comspec?: string; args?: string[] } = {},
): ScriptCommand {
  const platform = opts.platform ?? process.platform;
  const ext = extname(script).toLowerCase();
  // Only fixed words from the hub ("run"), never text from a request or the settings.
  const extra = opts.args ?? [];
  if (extra.some((a) => !/^[\w.-]+$/.test(a))) throw new TomcatError(`Not a script argument: ${extra.join(' ')}`);
  const tail = extra.length ? ` ${extra.join(' ')}` : '';
  if (platform === 'win32') {
    // Settings may hold forward slashes; cmd.exe reads "C:/x/startup.bat" as a switch in places.
    const path = script.replace(/\//g, '\\');
    if (/["%\r\n]/.test(path)) throw new TomcatError(`The script path cannot contain " or %: ${script}`);
    if (ext === '.bat' || ext === '.cmd') {
      const file = opts.comspec || 'cmd.exe';
      const args = ['/d', '/s', '/c', `""${path}"${tail}"`];
      return { file, args, verbatim: true, display: `${file} ${args.join(' ')}` };
    }
    if (ext === '.ps1') {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, ...extra];
      return { file: 'powershell.exe', args, verbatim: false, display: `powershell.exe ${args.slice(0, -1 - extra.length).join(' ')} "${path}"${tail}` };
    }
    return { file: path, args: extra, verbatim: false, display: `"${path}"${tail}` };
  }
  // A shell script without the executable bit still runs through sh; one with it uses its own #! line.
  if (ext === '.sh' && opts.executable === false) return { file: '/bin/sh', args: [script, ...extra], verbatim: false, display: `/bin/sh '${script}'${tail}` };
  return { file: script, args: extra, verbatim: false, display: `'${script}'${tail}` };
}

const MAX_OUTPUT = 32 * 1024;

interface Running {
  run: ScriptRun;
  logFile: string;
  ended: Promise<ScriptRun>;
}

export interface ScriptHooks {
  /** A run started; its output is in logFile. */
  onStart?: (run: ScriptRun, logFile: string) => void;
  onExit?: (run: ScriptRun) => void;
}

export interface RunOptions {
  /** The environment to run it with. Default: Debug Hub's own. */
  env?: Record<string, string>;
  /** Words after the script, e.g. "run" for catalina. */
  args?: string[];
  /** It is Tomcat itself, in the foreground (catalina run). */
  foreground?: boolean;
}

export class ScriptRunner {
  private runs = new Map<ScriptKind, Running>();

  constructor(private logDir = join(tmpdir(), 'debug-hub', 'tomcat-scripts'), private hooks: ScriptHooks = {}) {}

  /** A run of this kind has not finished yet. */
  isRunning(kind: ScriptKind): ScriptRun | null {
    const r = this.runs.get(kind);
    return r?.run.running ? r.run : null;
  }

  /** The latest run of a kind and the file its output goes to. */
  latest(kind: ScriptKind): { run: ScriptRun; logFile: string } | null {
    const r = this.runs.get(kind);
    return r ? { run: r.run, logFile: r.logFile } : null;
  }

  /** Resolves when the latest run of a kind has ended (at once if it has, or there is none). */
  ended(kind: ScriptKind): Promise<ScriptRun | null> {
    return this.runs.get(kind)?.ended ?? Promise.resolve(null);
  }

  /** Where output files go, for the console to find one from before Debug Hub restarted. */
  get folder(): string {
    return this.logDir;
  }

  async run(kind: ScriptKind, script: string, opts: RunOptions = {}): Promise<ScriptRun> {
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
    const cmd = scriptCommand(script, { executable, comspec: process.env.ComSpec, args: opts.args });

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
      ...(opts.foreground ? { foreground: true } : {}),
    };
    let settle!: (r: ScriptRun) => void;
    const ended = new Promise<ScriptRun>((resolve) => (settle = resolve));
    this.runs.set(kind, { run, logFile, ended });
    this.hooks.onStart?.(run, logFile);
    const finish = (patch: Partial<ScriptRun>) => {
      if (!run.running) return;
      Object.assign(run, patch, { running: false, endedAt: new Date().toISOString() });
      settle(run);
      this.hooks.onExit?.(run);
    };
    const failed = (err: any) =>
      finish({ error: err?.code === 'EACCES' ? `Not allowed to run ${basename(script)}. Is it executable?` : String(err?.message ?? err) });
    try {
      const child = spawn(cmd.file, cmd.args, {
        cwd: dirname(script),
        stdio: ['ignore', fd, fd],
        ...backgroundSpawn(),
        windowsVerbatimArguments: cmd.verbatim,
        env: opts.env,
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

export async function readTail(file: string, max: number): Promise<{ text: string; truncated: boolean }> {
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

/** Bytes at the end of `buf` that start a UTF-8 character not complete in it. */
function partialUtf8(buf: Buffer): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const b = buf[buf.length - back];
    if ((b & 0xc0) === 0x80) continue; // a continuation byte: look further back
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

export interface OutputChunk {
  text: string;
  /** Byte offset in the file where `text` starts. */
  start: number;
  /** Where the next read goes on from. */
  next: number;
  /** The file's size: start > 0 means the first part was not sent. */
  size: number;
}

/**
 * Output written since byte `from`, for the Tomcat page's console. `from` < 0 (a first read)
 * or past the end (a new file of the same name) starts at the last `first` bytes instead, at a
 * line start. At most `max` bytes are read; the rest comes with the next call. A character split
 * by the end of what was written so far is left for the next call too.
 */
export async function readChunk(file: string, from: number, opts: { first?: number; max?: number } = {}): Promise<OutputChunk> {
  const first = opts.first ?? 256 * 1024;
  const max = opts.max ?? 512 * 1024;
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return { text: '', start: 0, next: 0, size: 0 };
  }
  try {
    const { size } = await handle.stat();
    let start = from >= 0 && from <= size ? from : Math.max(0, size - first);
    const fresh = start !== from && start > 0;
    const end = Math.min(size, start + max);
    let buf = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    buf = buf.subarray(0, bytesRead);
    if (fresh) {
      // Starting mid-file: from the next line on.
      const nl = buf.indexOf(10);
      const skip = nl < 0 ? buf.length : nl + 1;
      buf = buf.subarray(skip);
      start += skip;
    }
    buf = buf.subarray(0, buf.length - partialUtf8(buf));
    return { text: buf.toString('utf8'), start, next: start + buf.length, size };
  } finally {
    await handle.close();
  }
}
