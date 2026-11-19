import { access, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { HubEvent, Level } from '../../shared/types';
import type {
  AppFolder, CommandRun, ConsoleChunk, ConsoleSource, KeepPreview, RestartState, ScriptKind, ScriptRun, StartSequence, TomcatState, WarInfo, WebappAction, WebappInfo,
  ApplySetResult, WebappSet, WebappSets,
} from '../../shared/tomcat';
import { EntryGrouper } from '../collectors/logfile';
import type { Config } from '../config';
import { makeEvent } from '../normalize';
import { isTomcatEntryStart, parseTomcatEntry } from '../parsers/tomcat';
import { deleteApp, planDelete } from './delete';
import { findKeepSource, findKeptFiles, readKeptFiles, warHas, writeWarWithKept } from './keep';
import type { KeepComparePreview, MergedInput, MergeFile } from '../../shared/keepmerge';
import { compareKept, mergedFiles, readMergeFile } from './merge';
import { appParams, managerCommand, managerList, managerOrigin, type Fetch, type ManagerApp } from './manager';
import { hosted } from '../hosted/info';
import { isSelfWebapp, ownTomcat, SELF_REFUSED, selfPath } from '../hosted/self';
import { CommandRunner, killTree } from './commands';
import { launchPlan, thisLaunchMachine, type LaunchMachine } from './launch';
import { reveal } from './reveal';
import { OutputFollower, readChunk, ScriptRunner } from './scripts';
import { Sequence } from './sequence';
import { checkName, contextPath, deployWar, guessTarget, listApps, moveApp, removeApp, TomcatError, type DiskApp } from './webapps';
import { WarWatcher, type WatchedWar } from './warwatch';
import { planSet, SetError, SETS_FILE, WebappSetStore } from './sets';
import { ZipError, type NewFile, type RewriteResult } from './zip';

export interface TomcatHooks {
  /** Puts an event on the timeline. */
  emit: (ev: HubEvent) => void;
  /** A new or rebuilt WAR is ready to deploy. */
  onWar: (war: WarInfo) => void;
  /** A WAR was deployed as a webapp (the package registries note what is deployed from them). */
  onDeployed?: (file: string, name: string) => void;
}

export interface TomcatServiceOptions {
  /** Where script output is written. Defaults to a folder in the system temp folder. */
  scriptLogDir?: string;
  /** Where start command output is written. Defaults to a folder in the system temp folder. */
  commandLogDir?: string;
  /** How long Start Tomcat waits for a start command marked "wait". Default 5 minutes. */
  commandWaitMs?: number;
  /** How long Restart waits for Tomcat to stop before ending it. Default 60 seconds. */
  restartWaitMs?: number;
  /** Stands in for this machine when working out how Tomcat starts. */
  machine?: LaunchMachine;
  warPollMs?: number;
  fetch?: Fetch;
  /** Shows a path in the file manager; replaced in tests. */
  reveal?: (path: string, select: boolean) => Promise<void>;
}

/** What Start Chrome answers; set by the HTTP server, which knows the settings file's folder. */
export type ChromeStarter = () => Promise<{ ok: boolean; message: string; hint?: string }>;

const COMMAND_WAIT_MS = 5 * 60_000;
const RESTART_WAIT_MS = 60_000;
/** Output from before Debug Hub restarted is offered this long after it was last written. */
const EARLIER_OUTPUT_MS = 24 * 3600_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

const andList = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? ''));

/** "config.yaml (replaced) and WEB-INF/classes/config.js (added)", for the files that were not merged. */
function keptSummary(r: RewriteResult, merged: Set<string> = new Set()): string {
  return andList([...r.replaced.filter((p) => !merged.has(p)).map((p) => `${p} (replaced)`), ...r.added.filter((p) => !merged.has(p)).map((p) => `${p} (added)`)]);
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
  private restartState: RestartState | null = null;
  private started = false;
  /** Starts Chrome for "Also start Chrome"; without it that step reports it is not available. */
  chromeStarter: ChromeStarter | null = null;
  /** Webapp sets, once the settings folder is known. */
  private sets: WebappSetStore | null = null;
  /** The set being applied now. */
  private applying: string | null = null;

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

  /** Where webapp sets are kept: the settings file's folder. Set by the HTTP server, which knows it. */
  useDataDir(dir: string): void {
    this.sets = new WebappSetStore(join(dir, SETS_FILE));
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
    if (run.foreground) this.note('info', `Started Tomcat: ${name} run${run.pid ? ` (process ${run.pid})` : ''}. Its output is in the console on the Tomcat page.`, { script: run.script, command: run.command });
    else this.note('info', `Ran Tomcat ${run.kind} script ${name}`, { script: run.script, command: run.command });
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
    else if (run.foreground) {
      const how = run.exitCode != null ? `exit code ${run.exitCode}` : `signal ${run.signal}`;
      this.note(run.exitCode === 0 || run.signal === 'SIGTERM' ? 'info' : 'warn', `Tomcat stopped (${name} run ended with ${how})`, { script: run.script });
    } else {
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

  /** The names in the webapps folder, and those plus the disabled ones. */
  async appNames(): Promise<{ deployed: string[]; all: string[] }> {
    const { webapps, disabled } = await this.disk();
    const deployed = webapps.map((a) => a.name);
    return { deployed, all: [...deployed, ...disabled.map((a) => a.name)] };
  }

  /**
   * Accepts a WAR from outside the watch folders (a download from a package registry): from
   * here on it can be deployed, shown in the file manager and have files kept, like a watched
   * one. Only the hub calls this, never a request.
   */
  async adoptWar(file: string): Promise<WarInfo> {
    const st = await stat(file);
    const war: WatchedWar = { file, bytes: st.size, modifiedMs: st.mtimeMs, sig: `${st.size}:${Math.round(st.mtimeMs)}`, fresh: false };
    this.watcher.adopt(war);
    return this.warInfo(war, (await this.appNames()).all);
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

    // Running inside this Tomcat: the hub's own webapp is marked, so the page can guard it.
    const host = ownTomcat(this.cfg) ? hosted() : null;
    if (host) for (const a of apps) if (a.path === selfPath(host)) a.self = true;

    const names = [...webapps, ...disabled].map((a) => a.name);
    const snap = (r: CommandRun | null) => (r ? this.commands.snapshot(r) : Promise.resolve(null));
    return {
      ...(host ? { hosted: { path: selfPath(host), server: host.serverInfo } } : {}),
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
      consoles: await this.consoleSources(),
      restart: this.restartState ? structuredClone(this.restartState) : null,
      wars: this.watcher.list().map((w) => this.warInfo(w, names)),
      sets: this.setsInfo(webapps.map((a) => a.name), disabled.map((a) => a.name)),
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
    if ((action === 'stop' || action === 'reload' || action === 'disable') && isSelfWebapp(this.cfg, { name })) throw new TomcatError(SELF_REFUSED, 409);

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

  // ── Webapp sets ───────────────────────────────────────

  /** Never disabled by a set: the Manager this page uses, and Debug Hub itself. */
  private keptBySets = (name: string): boolean => this.isManagerApp(name) || isSelfWebapp(this.cfg, { name });

  private setsInfo(deployed: string[], disabled: string[]): WebappSets {
    if (!this.sets) return { list: [], error: 'Webapp sets need a settings folder, which this Debug Hub was started without.', applying: null };
    const list = this.sets.list().map((set) => {
      const plan = planSet(set, deployed, disabled, this.keptBySets);
      return { ...set, plan, current: !plan.disable.length && !plan.enable.length };
    });
    return { list, error: this.sets.problem, applying: this.applying };
  }

  private needSets(): WebappSetStore {
    if (!this.sets) throw new TomcatError('Webapp sets need a settings folder, which this Debug Hub was started without.', 500);
    return this.sets;
  }

  private setCall<R>(fn: () => R): R {
    try {
      return fn();
    } catch (err) {
      if (err instanceof SetError) throw new TomcatError(err.message, err.status);
      throw err;
    }
  }

  /** Saves a set, new or changed; `previous` is its old name when it is renamed. */
  saveSet(input: unknown, previous?: string): WebappSet {
    const store = this.needSets();
    const set = this.setCall(() => store.save(input, previous));
    this.note('info', `Saved webapp set ${set.name}: ${set.webapps.join(', ') || 'no webapps'}`, { set: set.name });
    return set;
  }

  deleteSet(name: string): void {
    const store = this.needSets();
    this.setCall(() => store.delete(name));
    this.note('info', `Deleted webapp set ${name}`, { set: name });
  }

  /**
   * Makes a set what is deployed: disables the webapps not in it (stopping running ones first,
   * through the Manager), then enables those of it that are disabled. Goes on past a webapp that
   * cannot be moved, and says which. Webapps in the set that are nowhere are listed as missing.
   */
  async applySet(name: string): Promise<ApplySetResult> {
    const set = this.setCall(() => this.needSets().get(name));
    if (this.applying) throw new TomcatError(`The set ${this.applying} is being applied. Wait for it to finish.`, 409);
    this.needFolders(true);
    this.applying = set.name;
    const result: ApplySetResult = { message: '', disabled: [], enabled: [], missing: [], failed: [] };
    try {
      const { webapps, disabled } = await this.disk();
      const plan = planSet(set, webapps.map((a) => a.name), disabled.map((a) => a.name), this.keptBySets);
      result.missing = plan.missing;
      for (const [names, action, done] of [
        [plan.disable, 'disable', result.disabled],
        [plan.enable, 'enable', result.enabled],
      ] as const) {
        for (const app of names) {
          try {
            await this.webappAction(app, action);
            done.push(app);
          } catch (err) {
            result.failed.push({ name: app, error: (err as Error).message });
          }
        }
      }
      const parts = [
        result.disabled.length ? `disabled ${result.disabled.join(', ')}` : '',
        result.enabled.length ? `enabled ${result.enabled.join(', ')}` : '',
      ].filter(Boolean);
      result.message = parts.length ? `Applied ${set.name}: ${parts.join('; ')}.` : `${set.name} is already what is deployed.`;
      if (result.missing.length) result.message += ` Not found, deploy to add: ${result.missing.join(', ')}.`;
      if (result.failed.length) result.message += ` Could not move: ${result.failed.map((f) => f.name).join(', ')}.`;
      this.note(result.failed.length ? 'warn' : 'info', result.message, { set: set.name, ...result, message: undefined });
      return result;
    } finally {
      this.applying = null;
      }
  }

  // ── Delete ────────────────────────────────────────────

  private folderFor(from: AppFolder): string {
    const { webappsDir, disabledDir } = this.needFolders(from === 'disabled');
    return from === 'disabled' ? disabledDir : webappsDir;
  }

  /** The Manager's own webapp: deleting it would cut off this page's control of Tomcat. */
  private isManagerApp(name: string): boolean {
    try {
      const first = new URL(this.cfg.tomcat.manager.url).pathname.split('/')[1];
      return !!first && contextPath(name) === `/${first}`;
    } catch {
      return false;
    }
  }

  /** What Delete would remove, for the confirmation. */
  async deletePlan(name: string, from: AppFolder) {
    return planDelete(name, this.folderFor(from));
  }

  /**
   * Deletes a webapp's WAR and folder for good. `expected` is what the user confirmed; if the
   * folder holds something else by now, nothing is deleted.
   *
   * A running webapp is stopped through the Manager first, when there is one, so Tomcat lets go
   * of its files (on Windows, open files cannot be deleted). The Manager's own undeploy command
   * would also delete the files, but it is not used for that: it follows symbolic links inside
   * the webapp folder and deletes what they point to, it also deletes the webapp's context file
   * in conf/Catalina/<host>, which may be hand-written and is not in the confirmation, and it
   * does not say what is left when a delete fails. Deleting here never leaves the folder.
   */
  async deleteWebapp(name: string, from: AppFolder, expected?: string[]): Promise<string> {
    const problem = checkName(name);
    if (problem) throw new TomcatError(`Not a webapp name: ${problem}`);
    const dir = this.folderFor(from);
    if (from === 'webapps' && this.isManagerApp(name)) {
      throw new TomcatError(`${name} is the Tomcat Manager that Debug Hub uses; it cannot be deleted from here.`);
    }
    if (from === 'webapps' && isSelfWebapp(this.cfg, { name })) throw new TomcatError(SELF_REFUSED, 409);
    const path = contextPath(name);
    const mgr = this.cfg.tomcat.manager;
    let stopped = false;
    if (from === 'webapps' && mgr.url) {
      try {
        const app = (await managerList(mgr, this.opts.fetch)).find((m) => m.name === name);
        if (app?.state === 'running') {
          await managerCommand(mgr, 'stop', appParams(name), this.opts.fetch);
          stopped = true;
        }
      } catch {
        /* Tomcat not running, or no Manager access: deleting is still the point. */
      }
    }
    let deleted;
    try {
      // In webapps, a running Tomcat undeploys the webapp once its WAR is gone, releasing its files.
      ({ deleted } = await deleteApp(name, dir, { expected, tomcatWatches: from === 'webapps' }));
    } catch (err: any) {
      if (stopped && err instanceof Error) err.message += ` ${name} was stopped first and is still stopped.`;
      if (err?.deleted?.length) this.note('warn', `Partly deleted webapp ${path} from ${from}: ${err.message}`, { webapp: name, action: 'delete', from });
      throw err;
    }
    const names = deleted.map((d) => d.name);
    this.note('info', `Deleted webapp ${path} from ${from}: ${names.join(' and ')}`, { webapp: name, action: 'delete', from, paths: deleted.map((d) => d.path) });
    return (
      `Deleted ${names.join(' and ')} from ${dir}${stopped ? ' (stopped it first)' : ''}.` +
      (from === 'webapps' ? ' Tomcat undeploys it within a few seconds.' : '')
    );
  }

  // ── Show in the file manager ──────────────────────────

  /**
   * Shows a watched WAR, a webapp (its folder, else its WAR) or one of the two folders in the
   * file manager. Only paths the hub knows are accepted, never one taken from the request.
   */
  async reveal(target: { file?: string; name?: string; from?: AppFolder }): Promise<void> {
    let path: string;
    let select = true;
    if (target.file !== undefined) {
      if (!this.watcher.get(target.file)) throw new TomcatError('That WAR is not in a watched folder (or is gone).', 404);
      path = target.file;
    } else {
      const dir = this.folderFor(target.from ?? 'webapps');
      if (target.name === undefined) {
        path = dir;
        select = false;
      } else {
        const items = await planDelete(target.name, dir);
        const item = items.find((i) => i.kind !== 'war') ?? items[0];
        if (!item) throw new TomcatError(`${target.name} is not in ${dir}`, 404);
        path = item.path;
      }
    }
    try {
      await (this.opts.reveal ?? reveal)(path, select);
    } catch (err) {
      throw new TomcatError((err as Error).message, 500);
    }
  }

  // ── Kept files ────────────────────────────────────────

  /** The disabled folder, when it can be used. */
  private usableDisabledDir(): string {
    return this.disabledProblem() ? '' : this.cfg.tomcat.disabledDir;
  }

  /**
   * Which files a deploy of `file` as `name` could keep from the copy it replaces, and whether
   * the new WAR has each already (replaced) or not (added).
   */
  async keepPreview(name: string, file?: string): Promise<KeepPreview> {
    const t = this.cfg.tomcat;
    const preview: KeepPreview = { patterns: t.preserveFiles, source: null, files: [], truncated: false, problem: null };
    if (!t.preserveFiles.length || !t.webappsDir || checkName(name)) return preview;
    preview.source = await findKeepSource(name, t.webappsDir, this.usableDisabledDir());
    if (!preview.source) return preview;
    try {
      const found = await findKeptFiles(preview.source, t.preserveFiles);
      preview.files = found.files.map((f) => ({ ...f, inWar: null }));
      preview.truncated = found.truncated;
    } catch (err) {
      preview.problem = `Cannot read ${preview.source.path}: ${(err as Error).message}`;
      return preview;
    }
    if (file && preview.files.length && this.watcher.get(file)) {
      try {
        const has = await warHas(file, preview.files.map((f) => f.path));
        preview.files = preview.files.map((f) => ({ ...f, inWar: has.has(f.path) }));
      } catch (err) {
        preview.problem = `Cannot keep files in ${basename(file)}: ${(err as Error).message}`;
      }
    }
    return preview;
  }

  /**
   * The keep preview with each file compared to the new WAR's file of the same path: identical,
   * only in the deployed copy, or different, and then which settings the build adds, drops and
   * sets differently. The deploy dialog shows this so a merge is opened where it is worth it.
   */
  async keepCompare(name: string, file?: string): Promise<KeepComparePreview> {
    const preview: KeepComparePreview = { ...(await this.keepPreview(name, file)), compare: {} };
    if (!preview.source || !preview.files.length || preview.problem || !file || !this.watcher.get(file)) return preview;
    try {
      preview.compare = await compareKept(preview.source, file, preview.files);
    } catch (err) {
      preview.problem = `Cannot compare the files with ${basename(file)}: ${(err as Error).message}`;
    }
    return preview;
  }

  /** Both versions of one kept file, for the merge view. Only a path the search for kept files finds now. */
  async mergeFile(name: string, file: string, path: string): Promise<MergeFile> {
    if (!this.watcher.get(file)) throw new TomcatError('That WAR is not in a watched folder (or is gone).', 404);
    const { webappsDir } = this.needFolders(false);
    const problem = checkName(name);
    if (problem) throw new TomcatError(problem);
    const source = await findKeepSource(name, webappsDir, this.usableDisabledDir());
    if (!source) throw new TomcatError(`There is no deployed copy of ${name} to merge with any more. Open the deploy dialog again.`, 409);
    try {
      return await readMergeFile(source, this.cfg.tomcat.preserveFiles, file, path);
    } catch (err) {
      if (err instanceof ZipError) throw new TomcatError(`Cannot read ${path}: ${err.message}`, 422);
      throw err;
    }
  }

  /**
   * Reads the files to keep, and prepares the merged ones, before the deploy replaces (and
   * Tomcat deletes) the copy they are in.
   */
  private async filesToKeep(name: string, webappsDir: string, keep: string[], merged: MergedInput[] = [], war = ''): Promise<NewFile[]> {
    const source = await findKeepSource(name, webappsDir, this.usableDisabledDir());
    if (!source) throw new TomcatError(`There is no deployed copy of ${name} to keep files from any more. Open the deploy dialog again.`, 409);
    try {
      const kept = await readKeptFiles(source, this.cfg.tomcat.preserveFiles, keep);
      return merged.length ? [...kept, ...(await mergedFiles(source, this.cfg.tomcat.preserveFiles, war, merged))] : kept;
    } catch (err) {
      if (err instanceof ZipError) throw new TomcatError(`Cannot read the files to keep from ${source.path}: ${err.message} Deploy without keeping files.`, 422);
      throw err;
    }
  }

  private plan() {
    return launchPlan(this.cfg.tomcat, this.opts.machine ?? thisLaunchMachine());
  }

  /** Runs the start or stop script, or else Tomcat's own bin/catalina run or bin/shutdown. */
  async runScript(kind: ScriptKind): Promise<ScriptRun> {
    const { info, env } = this.plan();
    const way = info[kind];
    if (way.how === 'script') return this.scripts.run(kind, way.path!);
    if (way.how === 'tomcat') return this.scripts.run(kind, way.path!, { env: env!, args: way.args, foreground: !!way.args?.includes('run') });
    const verb = kind === 'start' ? 'start' : 'stop';
    throw new TomcatError(`No way to ${verb} Tomcat yet: set the Tomcat folder or a ${verb} script in Settings › Tomcat server. ${info.problems[0] ?? ''}`.trim());
  }

  /**
   * Start Tomcat: the start commands, then Tomcat, then Chrome (see sequence.ts). Returns once
   * the sequence is under way; the Tomcat page follows its progress. What would stop Tomcat from
   * starting at all is checked first, so nothing is started for a Start that cannot work.
   */
  async startTomcat(only = false): Promise<StartSequence> {
    if (ownTomcat(this.cfg)) {
      throw new TomcatError('This Tomcat is already running: Debug Hub runs inside it. Start commands can still be run one at a time with Run.', 409);
    }
    const current = this.sequence?.state;
    if (current?.running) {
      const at = current.steps.findIndex((s) => s.status === 'running');
      throw new TomcatError(`Tomcat is already being started (step ${at + 1} of ${current.steps.length}: ${current.steps[at]?.label}).`, 409);
    }
    const way = this.plan().info.start;
    if (way.how === 'none') await this.runScript('start'); // throws, saying what is missing
    const prev = this.scripts.isRunning('start');
    if (prev?.foreground) throw new TomcatError(`Tomcat is already running (process ${prev.pid}, started ${new Date(prev.startedAt).toLocaleTimeString()}). Use Restart to start it afresh.`, 409);
    if (prev) {
      throw new TomcatError(
        `The start script from ${new Date(prev.startedAt).toLocaleTimeString()} is still running (process ${prev.pid}). If it keeps Tomcat in the foreground, Tomcat is already running.`,
        409,
      );
    }
    if (!(await access(way.path!).then(() => true, () => false))) {
      throw new TomcatError(`${way.how === 'script' ? 'The start script' : 'Tomcat’s catalina script'} was not found: ${way.path}`, 404);
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
          return way.how === 'script' ? `Ran ${basename(run.script)}.` : `Started Tomcat (${basename(run.script)} run); its output is in the console.`;
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

  // ── Console ───────────────────────────────────────────

  /**
   * Tomcat's output file from before Debug Hub restarted (an update), when no Tomcat was started
   * since: a foreground Tomcat outlives Debug Hub and goes on writing to it.
   */
  private async earlierTomcatOutput(): Promise<{ file: string; startedAt: string; modified: number } | null> {
    if (this.scripts.latest('start')) return null;
    const dir = this.scripts.folder;
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^tomcat-start-\d+\.log$/.test(n)).sort();
    const name = names[names.length - 1];
    if (!name) return null;
    const file = join(dir, name);
    const st = await stat(file).catch(() => null);
    if (!st || Date.now() - st.mtimeMs > EARLIER_OUTPUT_MS || st.size === 0) return null;
    return { file, startedAt: new Date(Number(/\d+/.exec(name)![0])).toISOString(), modified: st.mtimeMs };
  }

  private scriptSource(kind: ScriptKind): ConsoleSource | null {
    const r = this.scripts.latest(kind);
    if (!r) return null;
    const { run } = r;
    const label = run.foreground ? 'Tomcat' : kind === 'stop' && this.plan().info.stop.how === 'tomcat' ? 'Shutdown' : basename(run.script);
    return {
      id: kind,
      label,
      runKey: `${kind}-${run.startedAt}`,
      running: run.running,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      ended: run.running ? null : run.error ? `could not run: ${run.error}` : run.exitCode != null ? `exit code ${run.exitCode}` : `signal ${run.signal}`,
      failed: !!run.error || (!run.running && run.exitCode !== 0 && run.signal !== 'SIGTERM'),
      command: run.command,
      tomcat: !!run.foreground,
    };
  }

  /** What the console can show: Tomcat (or the start script), the start commands, the shutdown. */
  async consoleSources(): Promise<ConsoleSource[]> {
    const out: ConsoleSource[] = [];
    const start = this.scriptSource('start');
    if (start) out.push(start);
    else {
      const earlier = await this.earlierTomcatOutput();
      if (earlier) {
        out.push({
          id: 'start', label: 'Tomcat (earlier)', runKey: `earlier-${earlier.startedAt}`, running: null, startedAt: earlier.startedAt, endedAt: null,
          ended: null, failed: false, command: 'Started before Debug Hub restarted', tomcat: false,
        });
      }
    }
    const runs = [
      ...this.cfg.tomcat.startCommands.map((c) => this.commands.latestFor(c)).filter((r): r is CommandRun => !!r),
      ...this.commands.others(this.cfg.tomcat.startCommands),
    ];
    for (const run of runs) {
      out.push({
        id: `cmd:${run.id}`,
        label: run.name,
        runKey: `cmd-${run.id}`,
        running: run.running,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        ended: run.running ? null : run.error ? `could not run: ${run.error}` : run.stopped ? 'stopped' : run.exitCode != null ? `exit code ${run.exitCode}` : `signal ${run.signal}`,
        failed: !!run.error || (!run.running && !run.stopped && run.exitCode !== 0),
        command: run.command,
        tomcat: false,
      });
    }
    const stop = this.scriptSource('stop');
    if (stop) out.push(stop);
    return out;
  }

  /** Output of a console source since byte `from` (-1: the last part of it). */
  async consoleOutput(id: string, from: number): Promise<ConsoleChunk> {
    let file: string | null = null;
    let runKey = '';
    if (id === 'start' || id === 'stop') {
      const src = this.scriptSource(id);
      if (src) {
        file = this.scripts.latest(id)!.logFile;
        runKey = src.runKey;
      } else if (id === 'start') {
        const earlier = await this.earlierTomcatOutput();
        if (earlier) {
          file = earlier.file;
          runKey = `earlier-${earlier.startedAt}`;
        }
      }
    } else {
      const m = /^cmd:(\d+)$/.exec(id);
      const r = m ? this.commands.get(Number(m[1])) : null;
      if (r) {
        file = r.logFile;
        runKey = `cmd-${r.run.id}`;
      }
    }
    if (!file) throw new TomcatError('There is no such output (any more). Refresh the page.', 404);
    const chunk = await readChunk(file, Number.isFinite(from) ? Math.floor(from) : -1);
    return { id, runKey, ...chunk };
  }

  /** Ends a foreground Tomcat (catalina run) at once, for when Stop does not get it to stop. */
  async killTomcat(): Promise<string> {
    const run = this.scripts.isRunning('start');
    if (!run?.foreground || !run.pid) throw new TomcatError('There is no Tomcat process started from here to end.', 409);
    await killTree(run.pid);
    this.note('warn', `Ended the Tomcat process ${run.pid}`, { script: run.script });
    return `Ended Tomcat (process ${run.pid}).`;
  }

  // ── Restart ───────────────────────────────────────────

  /**
   * Restart Tomcat: runs Stop, waits until Tomcat is gone, then starts Tomcat alone (no start
   * commands, no Chrome: those are still running). Returns once under way; the page follows.
   */
  async restartTomcat(): Promise<RestartState> {
    if (ownTomcat(this.cfg)) throw new TomcatError('Debug Hub runs inside this Tomcat, so it cannot restart it: it would stop with it.', 409);
    if (this.restartState?.running) throw new TomcatError('Tomcat is already being restarted.', 409);
    if (this.sequence?.state.running) throw new TomcatError('Tomcat is being started. Wait for that to finish first.', 409);
    const { info } = this.plan();
    if (info.stop.how === 'none' || info.start.how === 'none') {
      throw new TomcatError(`Restart needs a way to both stop and start Tomcat: set the Tomcat folder, or start and stop scripts, in Settings › Tomcat server. ${info.problems[0] ?? ''}`.trim());
    }
    const st: RestartState = { running: true, phase: 'stopping', startedAt: new Date().toISOString(), endedAt: null, message: null };
    this.restartState = st;
    this.note('info', 'Restarting Tomcat');
    void this.restartSteps(st);
    return structuredClone(st);
  }

  private async restartSteps(st: RestartState): Promise<void> {
    const wait = this.opts.restartWaitMs ?? RESTART_WAIT_MS;
    const finish = (phase: 'done' | 'failed', message: string) => {
      Object.assign(st, { running: false, phase, message, endedAt: new Date().toISOString() });
      this.note(phase === 'done' ? 'info' : 'error', message);
    };
    try {
      // Tomcat in the foreground, started from here: its end is the sign it has stopped.
      const tomcat = this.scripts.isRunning('start');
      if (!this.scripts.isRunning('stop')) {
        const run = await this.runScript('stop');
        if (run.error) throw new TomcatError(`the stop script could not run: ${run.error}`);
      }
      await this.scripts.ended('stop');
      st.phase = 'waiting';
      if (tomcat) {
        const gone = await Promise.race([this.scripts.ended('start').then(() => true), sleep(wait).then(() => false)]);
        if (!gone && this.scripts.isRunning('start') === tomcat && tomcat.pid) {
          this.note('warn', `Tomcat had not stopped after ${Math.round(wait / 1000)} s, so its process ${tomcat.pid} was ended.`);
          await killTree(tomcat.pid).catch(() => undefined);
          await Promise.race([this.scripts.ended('start'), sleep(10_000)]);
        }
      } else if (this.cfg.tomcat.manager.url) {
        // Started some other way: stopped once the Manager no longer answers.
        const until = Date.now() + wait;
        while (Date.now() < until) {
          try {
            await managerList(this.cfg.tomcat.manager, this.opts.fetch);
          } catch {
            break;
          }
          await sleep(1000);
        }
      } else {
        // Nothing to watch: give it a moment to let go of its port.
        await sleep(Math.min(3000, wait));
      }
      st.phase = 'starting';
      await this.startTomcat(true);
      const ended = await this.sequence?.done;
      if (ended && ended.outcome === 'failed') throw new TomcatError(ended.message ?? 'Tomcat did not start.');
      finish('done', 'Restarted Tomcat.');
    } catch (err) {
      finish('failed', `Could not restart Tomcat: ${(err as Error).message}`);
    }
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
   *
   * `keep` are files taken from the copy being replaced as they are; `merged` are files whose
   * content was merged from both (see merge.ts). Both are written into the WAR before Tomcat
   * sees it. A path in both is merged.
   */
  async deploy(file: string, name: string, disabledCopy: 'remove' | 'keep' = 'remove', keep: string[] = [], merged: MergedInput[] = []): Promise<string> {
    if (!this.watcher.get(file)) throw new TomcatError('That WAR is not in a watched folder (or is gone).', 404);
    const { webappsDir, disabledDir } = this.needFolders(false);
    const problem = checkName(name);
    if (problem) throw new TomcatError(problem);
    const mergedPaths = new Set(merged.map((m) => m.path));
    keep = keep.filter((p) => !mergedPaths.has(p));
    const kept = keep.length || merged.length ? await this.filesToKeep(name, webappsDir, keep, merged, file) : [];
    let rewrite = null as RewriteResult | null;
    const write = kept.length ? async (tmp: string) => void (rewrite = await writeWarWithKept(file, tmp, kept)) : undefined;
    const { replaced } = await deployWar(file, webappsDir, name, write);
    let removed = false;
    if (disabledDir && disabledCopy === 'remove' && !this.disabledProblem()) {
      removed = await removeApp(name, disabledDir);
    }
    this.watcher.settle(file);
    this.hooks.onDeployed?.(file, name);
    const path = contextPath(name);
    const keptPaths = rewrite ? [...rewrite.replaced, ...rewrite.added].filter((p) => !mergedPaths.has(p)) : [];
    const keptNote =
      (keptPaths.length ? ` Kept ${keptSummary(rewrite!, mergedPaths)} from the deployed copy.` : '') +
      (rewrite && mergedPaths.size ? ` Wrote your merge of ${andList([...mergedPaths])}.` : '');
    this.note('info', `Deployed ${basename(file)} as ${name}.war (${path})${replaced ? ', replacing the previous build' : ''}.${keptNote}`, {
      webapp: name,
      action: 'deploy',
      war: file,
      ...(keptPaths.length ? { kept: keptPaths } : {}),
      ...(rewrite && mergedPaths.size ? { merged: [...mergedPaths] } : {}),
    });
    return (
      `Deployed ${basename(file)} as ${name}.war. Tomcat ${replaced ? 'redeploys' : 'deploys'} ${path} within a few seconds.` +
      keptNote +
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
