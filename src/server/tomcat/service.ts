import { access } from 'node:fs/promises';
import { basename, isAbsolute, relative } from 'node:path';
import type { HubEvent, Level } from '../../shared/types';
import type { CommandRun, ScriptKind, ScriptRun, StartSequence, TomcatState, WarInfo, WebappAction, WebappInfo } from '../../shared/tomcat';
import { EntryGrouper } from '../collectors/logfile';
import type { Config } from '../config';
import { makeEvent } from '../normalize';
import { isTomcatEntryStart, parseTomcatEntry } from '../parsers/tomcat';
import { appParams, managerCommand, managerList, managerOrigin, type Fetch, type ManagerApp } from './manager';
import { CommandRunner } from './commands';
import { launchPlan, thisLaunchMachine, type LaunchMachine } from './launch';
import { OutputFollower, ScriptRunner } from './scripts';
import { Sequence } from './sequence';
import { checkName, contextPath, deployWar, guessTarget, listApps, moveApp, removeApp, TomcatError, type DiskApp } from './webapps';
import { WarWatcher, type WatchedWar } from './warwatch';

export interface TomcatHooks {
  /** Puts an event on the timeline. */
  emit: (ev: HubEvent) => void;
  /** A new or rebuilt WAR is ready to deploy. */
  onWar: (war: WarInfo) => void;
}

export interface TomcatServiceOptions {
  /** Where script output is written. Defaults to a folder in the system temp folder. */
  scriptLogDir?: string;
  /** Where start command output is written. Defaults to a folder in the system temp folder. */
  commandLogDir?: string;
  /** How long Start Tomcat waits for a start command marked "wait". Default 5 minutes. */
  commandWaitMs?: number;
  /** Stands in for this machine when working out how Tomcat starts. */
  machine?: LaunchMachine;
  warPollMs?: number;
  fetch?: Fetch;
}

/** What Start Chrome answers; set by the HTTP server, which knows the settings file's folder. */
export type ChromeStarter = () => Promise<{ ok: boolean; message: string; hint?: string }>;

const COMMAND_WAIT_MS = 5 * 60_000;

/** A line of command output that reads like a problem, for the timeline's level colours. */
function lineLevel(line: string): Level {
  if (/\b(error|exception|fatal|failed)\b/i.test(line)) return 'error';
  if (/\bwarn(ing)?\b/i.test(line)) return 'warn';
  return 'info';
}

/** Inside, or the same as, another folder. */
function within(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The Tomcat page's back end: what is deployed and disabled, the Tomcat Manager, the start and
 * stop scripts, and the WAR watcher. Everything it does is also noted on the timeline, so a
 * redeploy shows up next to the errors that followed it.
 */
export class TomcatService {
  private watcher: WarWatcher;
  private scripts: ScriptRunner;
  private outputs = new Map<ScriptKind, { follower: OutputFollower; grouper: EntryGrouper }>();
  private commands: CommandRunner;
  private commandOutputs = new Map<number, { follower: OutputFollower; grouper: EntryGrouper }>();
  private sequence: Sequence | null = null;
  private started = false;
  /** Starts Chrome for "Also start Chrome"; without it that step reports it is not available. */
  chromeStarter: ChromeStarter | null = null;

  constructor(private cfg: Config, private hooks: TomcatHooks, private opts: TomcatServiceOptions = {}) {
    this.watcher = this.makeWatcher();
    this.scripts = new ScriptRunner(opts.scriptLogDir, {
      onStart: (run, logFile) => this.followOutput(run, logFile),
      onExit: (run) => void this.scriptExited(run),
    });
    this.commands = new CommandRunner(opts.commandLogDir, {
      onStart: (run, logFile) => this.followCommand(run, logFile),
      onExit: (run) => void this.commandExited(run),
    });
  }

  private makeWatcher(): WarWatcher {
    return new WarWatcher(this.cfg.tomcat.warWatch, {
      pollMs: this.opts.warPollMs ?? 2000,
      onNew: (war) => void this.warBuilt(war),
    });
  }

  start(): void {
    this.started = true;
    this.watcher.start();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.watcher.stop();
    await Promise.all([...this.outputs.values(), ...this.commandOutputs.values()].map(async (o) => {
      await o.follower.stop();
      o.grouper.flushAll();
    }));
    this.outputs.clear();
    this.commandOutputs.clear();
  }

  /** New settings: the watcher restarts on the new folders. Running scripts are left alone. */
  reconfigure(cfg: Config): void {
    this.cfg = cfg;
    const old = this.watcher;
    old.stop();
    this.watcher = this.makeWatcher();
    this.watcher.inherit(old);
    if (this.started) this.watcher.start();
  }

  /** Exposed for tests. */
  get warWatcher(): WarWatcher {
    return this.watcher;
  }

  // ── Timeline ──────────────────────────────────────────

  private note(level: Level, summary: string, data: Record<string, unknown> = {}): void {
    this.hooks.emit(makeEvent({ tsMs: Date.now(), source: 'tomcat', kind: 'log', level, summary, data: { message: summary, ...data } }));
  }

  /** Tomcat's log files are being followed, so its own log records need not be copied from script output. */
  private followingLogs(): boolean {
    const t = this.cfg.tomcat;
    return t.enabled && (t.appLogs.length > 0 || !!t.logsDir);
  }

  /**
   * Script output goes on the timeline as Tomcat log events. Lines that are Tomcat log records
   * (they start with a timestamp: a foreground Tomcat prints its log to the console too) are
   * left out when the log files are followed, so they do not show up twice.
   */
  private followOutput(run: ScriptRun, logFile: string): void {
    const prev = this.outputs.get(run.kind);
    if (prev) void prev.follower.stop().then(() => prev.grouper.flushAll());
    const name = basename(run.script);
    const grouper = new EntryGrouper(isTomcatEntryStart, this.cfg.tail.flushMs, (file, lines, firstSeenMs) => {
      if (this.followingLogs() && isTomcatEntryStart(lines[0])) return;
      const input = parseTomcatEntry(lines, { file, ridPatterns: [], nowMs: firstSeenMs });
      this.hooks.emit(makeEvent({ ...input, summary: `${name}: ${input.summary}`, data: { ...input.data, script: run.script } }));
    });
    const follower = new OutputFollower(logFile, this.cfg.tail.pollMs, (line) => grouper.push(logFile, line));
    this.outputs.set(run.kind, { follower, grouper });
    follower.start();
    this.note('info', `Ran Tomcat ${run.kind} script ${name}`, { script: run.script, command: run.command });
  }

  private async scriptExited(run: ScriptRun): Promise<void> {
    const out = this.outputs.get(run.kind);
    if (out) {
      // Read what is left before saying it ended. Output after this (a script that started a
      // background process sharing the file) is no longer followed.
      await out.follower.stop();
      out.grouper.flushAll();
    }
    const name = basename(run.script);
    if (run.error) this.note('error', `Tomcat ${run.kind} script ${name} could not run: ${run.error}`, { script: run.script });
    else {
      const how = run.exitCode != null ? `exit code ${run.exitCode}` : `signal ${run.signal}`;
      this.note(run.exitCode === 0 ? 'info' : 'warn', `Tomcat ${run.kind} script ${name} finished with ${how}`, { script: run.script });
    }
  }

  /**
   * Start command output goes on the timeline line by line, labelled with the command's name.
   * Indented lines (a stack trace) stay with the line before them.
   */
  private followCommand(run: CommandRun, logFile: string): void {
    const grouper = new EntryGrouper((line) => !/^\s/.test(line), this.cfg.tail.flushMs, (_file, lines, firstSeenMs) => {
      const message = lines.join('\n');
      this.hooks.emit(
        makeEvent({ tsMs: firstSeenMs, source: 'tomcat', kind: 'log', level: lineLevel(lines[0]), summary: `${run.name}: ${lines[0]}`, data: { message, startCommand: run.name, command: run.command } }),
      );
    });
    const follower = new OutputFollower(logFile, this.cfg.tail.pollMs, (line) => grouper.push(logFile, line));
    this.commandOutputs.set(run.id, { follower, grouper });
    follower.start();
    this.note('info', `Started command ${run.name}${run.pid ? ` (process ${run.pid})` : ''}`, { startCommand: run.name, command: run.command, cwd: run.cwd });
  }

  private async commandExited(run: CommandRun): Promise<void> {
    const out = this.commandOutputs.get(run.id);
    if (out) {
      await out.follower.stop();
      out.grouper.flushAll();
      this.commandOutputs.delete(run.id);
    }
    const data = { startCommand: run.name, command: run.command };
    if (run.error) this.note('error', `Command ${run.name} could not run: ${run.error}`, data);
    else if (run.stopped) this.note('info', `Stopped command ${run.name}`, data);
    else {
      const how = run.exitCode != null ? `exit code ${run.exitCode}` : `signal ${run.signal}`;
      this.note(run.exitCode === 0 ? 'info' : 'warn', `Command ${run.name} finished with ${how}`, data);
    }
  }

  // ── State ─────────────────────────────────────────────

  private disabledProblem(): string | null {
    const { webappsDir, disabledDir } = this.cfg.tomcat;
    if (!disabledDir) return null;
    if (webappsDir && within(disabledDir, webappsDir)) {
      return 'The disabled folder is inside the webapps folder, where Tomcat would deploy it as a webapp. Choose a folder outside webapps.';
    }
    if (webappsDir && within(webappsDir, disabledDir)) return 'The webapps folder is inside the disabled folder. Choose separate folders.';
    return null;
  }

  private async disk(): Promise<{ webapps: DiskApp[]; disabled: DiskApp[]; problems: TomcatState['problems'] }> {
    const { webappsDir, disabledDir, startScript, stopScript } = this.cfg.tomcat;
    const problems: TomcatState['problems'] = [];
    let webapps: DiskApp[] = [];
    let disabled: DiskApp[] = [];
    if (webappsDir) {
      try {
        webapps = await listApps(webappsDir);
      } catch (err: any) {
        problems.push({ key: 'webappsDir', message: err?.code === 'ENOENT' ? `Webapps folder not found: ${webappsDir}` : `Cannot read ${webappsDir}: ${err?.message}` });
      }
    }
    const dp = this.disabledProblem();
    if (dp) problems.push({ key: 'disabledDir', message: dp });
    else if (disabledDir) {
      // A missing disabled folder is fine: it is created by the first Disable.
      disabled = await listApps(disabledDir).catch(() => []);
    }
    for (const [key, script] of [['startScript', startScript], ['stopScript', stopScript]] as const) {
      if (script && !(await access(script).then(() => true, () => false))) problems.push({ key, message: `Script not found: ${script}` });
    }
    return { webapps, disabled, problems };
  }

  private warInfo(w: WatchedWar, names: string[]): WarInfo {
    return {
      file: w.file,
      name: basename(w.file),
      bytes: w.bytes,
      modified: new Date(w.modifiedMs).toISOString(),
      sig: w.sig,
      target: guessTarget(w.file, names),
      fresh: w.fresh,
    };
  }

  async wars(): Promise<WarInfo[]> {
    const { webapps, disabled } = await this.disk();
    const names = [...webapps, ...disabled].map((a) => a.name);
    return this.watcher.list().map((w) => this.warInfo(w, names));
  }

  async state(): Promise<TomcatState> {
    const t = this.cfg.tomcat;
    const { webapps, disabled, problems } = await this.disk();
    for (const p of this.watcher.problems) problems.push({ key: 'warWatch', message: p.problem });

    const manager: TomcatState['manager'] = { configured: !!t.manager.url, ok: false, error: null, origin: managerOrigin(t.manager.url) };
    let listed: ManagerApp[] = [];
    if (manager.configured) {
      try {
        listed = await managerList(t.manager, this.opts.fetch);
        manager.ok = true;
      } catch (err) {
        manager.error = (err as Error).message;
      }
    }

    const byName = new Map(listed.map((m) => [m.name, m]));
    const apps: WebappInfo[] = webapps.map((a) => {
      const m = byName.get(a.name);
      byName.delete(a.name);
      return {
        ...a,
        path: contextPath(a.name),
        state: manager.ok ? (m?.state ?? 'not-loaded') : 'deployed',
        sessions: m?.sessions ?? null,
        external: false,
      };
    });
    // Webapps Tomcat runs from elsewhere (a context file, another appBase) can still be started and stopped.
    for (const m of byName.values()) {
      apps.push({ name: m.name, path: m.path, hasWar: false, hasDir: false, modified: null, bytes: null, state: m.state, sessions: m.sessions, external: true });
    }

    const names = [...webapps, ...disabled].map((a) => a.name);
    const snap = (r: CommandRun | null) => (r ? this.commands.snapshot(r) : Promise.resolve(null));
    return {
      settings: {
        webappsDir: t.webappsDir,
        disabledDir: t.disabledDir,
        startScript: t.startScript,
        stopScript: t.stopScript,
        managerUrl: t.manager.url,
        warWatch: t.warWatch,
        startChrome: t.startChrome,
      },
      launch: this.plan().info,
      commands: await Promise.all(
        t.startCommands.map(async (c, index) => ({ index, name: c.name, command: c.command, cwd: c.cwd, wait: c.wait, run: await snap(this.commands.latestFor(c)) })),
      ),
      otherRuns: await Promise.all(this.commands.others(t.startCommands).map((r) => this.commands.snapshot(r))),
      sequence: this.sequence ? structuredClone(this.sequence.state) : null,
      problems,
      webapps: apps,
      disabled: disabled.map((a) => ({ ...a, path: contextPath(a.name), state: 'disabled', sessions: null, external: false })),
      manager,
      scripts: { start: await this.scripts.snapshot('start'), stop: await this.scripts.snapshot('stop') },
      wars: this.watcher.list().map((w) => this.warInfo(w, names)),
    };
  }

  // ── Actions ───────────────────────────────────────────

  private needFolders(both: boolean): { webappsDir: string; disabledDir: string } {
    const { webappsDir, disabledDir } = this.cfg.tomcat;
    if (!webappsDir) throw new TomcatError('Set the webapps folder in Settings › Tomcat first.');
    if (both && !disabledDir) throw new TomcatError('Set a folder for disabled webapps in Settings › Tomcat first.');
    const dp = both ? this.disabledProblem() : null;
    if (dp) throw new TomcatError(dp);
    return { webappsDir, disabledDir };
  }

  /** Runs an action on one webapp and returns a sentence saying what happened. */
  async webappAction(name: string, action: WebappAction): Promise<string> {
    const problem = checkName(name);
    if (problem) throw new TomcatError(`Not a webapp name: ${problem}`);
    const path = contextPath(name);
    const mgr = this.cfg.tomcat.manager;

    if (action === 'start' || action === 'stop' || action === 'reload') {
      if (!mgr.url) throw new TomcatError('Starting and stopping single webapps needs the Tomcat Manager. Set it up in Settings › Tomcat, or use Disable and Enable.');
      await managerCommand(mgr, action, appParams(name), this.opts.fetch);
      const done = { start: 'Started', stop: 'Stopped', reload: 'Reloaded' }[action];
      this.note('info', `${done} webapp ${path}`, { webapp: name, action });
      return `${done} ${path}.`;
    }

    const { webappsDir, disabledDir } = this.needFolders(true);
    if (action === 'disable') {
      let stopped = false;
      // Stopping first lets go of the files a running webapp holds, which on Windows can block the move.
      if (mgr.url) {
        try {
          const app = (await managerList(mgr, this.opts.fetch)).find((m) => m.name === name);
          if (app?.state === 'running') {
            await managerCommand(mgr, 'stop', appParams(name), this.opts.fetch);
            stopped = true;
          }
        } catch {
          /* Tomcat not running, or no Manager access: moving is still the point. */
        }
      }
      let moved: string[];
      try {
        ({ moved } = await moveApp(name, webappsDir, disabledDir));
      } catch (err) {
        if (stopped && err instanceof Error) err.message += ` ${name} was stopped before the move and is still stopped; Start brings it back.`;
        throw err;
      }
      this.note('info', `Disabled webapp ${path}: moved ${moved.join(' and ')} out of webapps`, { webapp: name, action, to: disabledDir });
      return `Disabled ${name}${stopped ? ' (stopped it first)' : ''}: moved ${moved.join(' and ')} to ${disabledDir}. Tomcat undeploys it within a few seconds.`;
    }
    const { moved } = await moveApp(name, disabledDir, webappsDir);
    this.note('info', `Enabled webapp ${path}: moved ${moved.join(' and ')} back into webapps`, { webapp: name, action });
    return `Enabled ${name}: moved ${moved.join(' and ')} back to webapps. Tomcat deploys it within a few seconds.`;
  }

  private plan() {
    return launchPlan(this.cfg.tomcat, this.opts.machine ?? thisLaunchMachine());
  }

  /** Runs the start or stop script, or else Tomcat's own bin/startup or bin/shutdown. */
  async runScript(kind: ScriptKind): Promise<ScriptRun> {
    const { info, env } = this.plan();
    const way = info[kind];
    if (way.how === 'script') return this.scripts.run(kind, way.path!);
    if (way.how === 'tomcat') return this.scripts.run(kind, way.path!, { env: env!, windowsHide: false });
    const verb = kind === 'start' ? 'start' : 'stop';
    throw new TomcatError(`No way to ${verb} Tomcat yet: set the Tomcat folder or a ${verb} script in Settings › Tomcat server. ${info.problems[0] ?? ''}`.trim());
  }

  /**
   * Start Tomcat: the start commands, then Tomcat, then Chrome (see sequence.ts). Returns once
   * the sequence is under way; the Tomcat page follows its progress. What would stop Tomcat from
   * starting at all is checked first, so nothing is started for a Start that cannot work.
   */
  async startTomcat(only = false): Promise<StartSequence> {
    const current = this.sequence?.state;
    if (current?.running) {
      const at = current.steps.findIndex((s) => s.status === 'running');
      throw new TomcatError(`Tomcat is already being started (step ${at + 1} of ${current.steps.length}: ${current.steps[at]?.label}).`, 409);
    }
    const way = this.plan().info.start;
    if (way.how === 'none') await this.runScript('start'); // throws, saying what is missing
    const prev = this.scripts.isRunning('start');
    if (prev) {
      throw new TomcatError(
        `The start script from ${new Date(prev.startedAt).toLocaleTimeString()} is still running (process ${prev.pid}). If it keeps Tomcat in the foreground, Tomcat is already running.`,
        409,
      );
    }
    if (!(await access(way.path!).then(() => true, () => false))) {
      throw new TomcatError(`${way.how === 'script' ? 'The start script' : 'Tomcat’s startup script'} was not found: ${way.path}`, 404);
    }

    const t = this.cfg.tomcat;
    const seq = new Sequence(
      {
        commands: t.startCommands,
        startCommand: async (c) => {
          const running = this.commands.runningFor(c);
          if (running) return { id: running.run.id, pid: running.run.pid, ended: running.ended, already: true };
          const run = await this.commands.start(c);
          return { id: run.id, pid: run.pid, ended: this.commands.ended(run.id), already: false };
        },
        startTomcat: async () => {
          const run = await this.runScript('start');
          if (run.error) throw new TomcatError(run.error);
          return way.how === 'script' ? `Ran ${basename(run.script)}.` : `Ran Tomcat’s ${basename(run.script)}.`;
        },
        startChrome: t.startChrome
          ? async () => (this.chromeStarter ? this.chromeStarter() : { ok: false, message: 'Starting Chrome is not available here.' })
          : undefined,
        waitMs: this.opts.commandWaitMs ?? COMMAND_WAIT_MS,
        note: (level, summary) => this.note(level, summary),
      },
      only,
    );
    this.sequence = seq;
    if (seq.state.steps.length > 1) this.note('info', `Starting Tomcat: ${seq.state.steps.map((s) => s.label).join(' → ')}`);
    void seq.start();
    return structuredClone(seq.state);
  }

  /** The latest start sequence, for tests. */
  get startSequence(): Sequence | null {
    return this.sequence;
  }

  /**
   * Runs one start command on its own. `command` is the line the page showed: if the settings
   * changed since, the position may point at another command, so it is refused.
   */
  async runCommand(index: number, command?: string): Promise<CommandRun> {
    const c = this.cfg.tomcat.startCommands[index];
    if (!c || (command !== undefined && command.trim() !== c.command.trim())) {
      throw new TomcatError('The start commands have changed. Refresh the page and try again.', 409);
    }
    return this.commands.start(c);
  }

  /** Stops a start command's run and everything it started. */
  async stopCommand(id: number): Promise<string> {
    const run = await this.commands.stop(id);
    return `Stopping ${run.name}${run.pid ? ` (process ${run.pid})` : ''}.`;
  }

  /**
   * Deploys a WAR from a watch folder as <name>.war. If a webapp of that name is disabled, the
   * deploy brings it back with the new build and, unless asked to keep it, deletes the old
   * disabled copy: otherwise the same webapp would be listed as both deployed and disabled, and
   * enabling the old copy later could not work while the new one is deployed.
   */
  async deploy(file: string, name: string, disabledCopy: 'remove' | 'keep' = 'remove'): Promise<string> {
    if (!this.watcher.get(file)) throw new TomcatError('That WAR is not in a watched folder (or is gone).', 404);
    const { webappsDir, disabledDir } = this.needFolders(false);
    const { replaced } = await deployWar(file, webappsDir, name);
    let removed = false;
    if (disabledDir && disabledCopy === 'remove' && !this.disabledProblem()) {
      removed = await removeApp(name, disabledDir);
    }
    this.watcher.settle(file);
    const path = contextPath(name);
    this.note('info', `Deployed ${basename(file)} as ${name}.war (${path})${replaced ? ', replacing the previous build' : ''}`, {
      webapp: name,
      action: 'deploy',
      war: file,
    });
    return (
      `Deployed ${basename(file)} as ${name}.war. Tomcat ${replaced ? 'redeploys' : 'deploys'} ${path} within a few seconds.` +
      (removed ? ' The old disabled copy was removed.' : '')
    );
  }

  dismiss(file: string): void {
    this.watcher.settle(file);
  }

  private async warBuilt(w: WatchedWar): Promise<void> {
    const { webapps, disabled } = await this.disk();
    const war = this.warInfo(w, [...webapps, ...disabled].map((a) => a.name));
    this.note('info', `New WAR built: ${war.name}`, { war: w.file, bytes: w.bytes });
    this.hooks.onWar(war);
  }
}
