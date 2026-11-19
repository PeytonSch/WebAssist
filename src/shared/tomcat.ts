// What the Tomcat page and the new-WAR notification exchange with the hub.

/**
 * running / stopped: as the Tomcat Manager reports it.
 * not-loaded: in the webapps folder, but the Manager does not list it (still deploying, or it failed).
 * deployed: in the webapps folder; without a Manager nothing more is known.
 * disabled: in the disabled folder, so Tomcat does not see it.
 */
export type WebappState = 'running' | 'stopped' | 'not-loaded' | 'deployed' | 'disabled';

export interface WebappInfo {
  /** The base name Tomcat uses: "ROOT", "shop", "api#v2" (context /api/v2), "shop##3" (version 3). */
  name: string;
  /** Context path, e.g. "/" for ROOT. */
  path: string;
  hasWar: boolean;
  /** An unpacked folder of the same name. */
  hasDir: boolean;
  /** Newest modification time of the WAR or folder. */
  modified: string | null;
  /** Size of the WAR. */
  bytes: number | null;
  state: WebappState;
  /** Active sessions, when the Manager reports them. */
  sessions: number | null;
  /** Listed by the Manager but not in the webapps folder (deployed from elsewhere), so it cannot be disabled. */
  external: boolean;
  /** Debug Hub's own webapp, when it runs inside this Tomcat: not to be stopped, disabled or deleted from its own page. */
  self?: boolean;
}

export type ScriptKind = 'start' | 'stop';

export interface ScriptRun {
  kind: ScriptKind;
  script: string;
  /** The command line as run, for display. */
  command: string;
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  /** Why the script could not be started. */
  error: string | null;
  /** The end of what the script printed. */
  output: string;
  outputTruncated: boolean;
  /** Tomcat itself, in the foreground (catalina run): it runs until Tomcat stops. */
  foreground?: boolean;
}

export interface WarInfo {
  file: string;
  /** File name, e.g. shop-1.4.0-SNAPSHOT.war. */
  name: string;
  bytes: number;
  modified: string;
  /** Changes whenever the file is rebuilt; identifies one build. */
  sig: string;
  /** The webapp name it would be deployed as, guessed from the file name and what is deployed. */
  target: string;
  /** Built while Debug Hub was running, and not yet deployed or dismissed. */
  fresh: boolean;
}

/** How Start Tomcat and Stop Tomcat run: the user's script, or Tomcat's own bin/startup and bin/shutdown. */
export interface LaunchWay {
  how: 'script' | 'tomcat' | 'none';
  /** The script, or Tomcat's bin/catalina or bin/shutdown, that runs. */
  path: string | null;
  /** Words after it: "run" for catalina, which keeps Tomcat in the foreground, its output in the console. */
  args?: string[];
}

export interface TomcatLaunch {
  start: LaunchWay;
  stop: LaunchWay;
  /** CATALINA_HOME for Tomcat's own scripts, and where it came from. */
  home: string | null;
  homeSource: 'settings' | 'webapps' | null;
  /** CATALINA_BASE, the folder above webapps, when it is a Tomcat base (has conf/). */
  base: string | null;
  /** JAVA_HOME given to Tomcat's own scripts: the setting, else Debug Hub's environment. */
  javaHome: string | null;
  javaSource: 'settings' | 'environment' | 'setenv' | null;
  /** Why Tomcat's own scripts cannot be used. */
  problems: string[];
  /** What may go wrong when they run. */
  warnings: string[];
}

/** One run of a start command (Settings › Tomcat server › Start commands). */
export interface CommandRun {
  /** Identifies this run, for stopping it. */
  id: number;
  name: string;
  command: string;
  cwd: string;
  /** The command line as run, for display. */
  shell: string;
  startedAt: string;
  endedAt: string | null;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  /** Why it could not be started. */
  error: string | null;
  /** Stopped from the Tomcat page. */
  stopped: boolean;
  /** The end of what it printed. */
  output: string;
  outputTruncated: boolean;
}

export interface StartCommandInfo {
  /** Position in the settings, for running it on its own. */
  index: number;
  name: string;
  command: string;
  cwd: string;
  wait: boolean;
  /** Its latest run, if any. */
  run: CommandRun | null;
}

export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

export interface StartStep {
  kind: 'command' | 'tomcat' | 'chrome';
  label: string;
  status: StepStatus;
  /** What happened, in a sentence. */
  detail: string | null;
  /** The command run, for command steps. */
  runId: number | null;
}

/** One Start Tomcat: the start commands in order, then Tomcat, then Chrome. */
export interface StartSequence {
  startedAt: string;
  endedAt: string | null;
  running: boolean;
  /** Started with "Start Tomcat only": no commands, no Chrome. */
  only: boolean;
  steps: StartStep[];
  outcome: 'ok' | 'failed' | null;
  message: string | null;
}

/** A process whose output the Tomcat page's console shows: Tomcat, its shutdown, a start command. */
export interface ConsoleSource {
  /** "start", "stop" or "cmd:<run id>". */
  id: string;
  /** "Tomcat", "Shutdown", a script's or a start command's name. */
  label: string;
  /** Changes with each run, so the console starts afresh. */
  runKey: string;
  /** null: not known, for output from before Debug Hub restarted. */
  running: boolean | null;
  startedAt: string | null;
  endedAt: string | null;
  /** How it ended, e.g. "exit code 0", once it has. */
  ended: string | null;
  failed: boolean;
  /** The command line, for the console's heading. */
  command: string;
  /** Tomcat itself in the foreground: Restart and End process apply to it. */
  tomcat: boolean;
}

/** GET /api/tomcat/console: output of one console source written since a byte offset. */
export interface ConsoleChunk {
  id: string;
  runKey: string;
  text: string;
  /** Byte offset of `text` in the output; above 0 on a first read means earlier output was left out. */
  start: number;
  /** The offset to ask from next time. */
  next: number;
  size: number;
}

/** Restart Tomcat: stop it, wait until it is gone, start it again. */
export interface RestartState {
  running: boolean;
  phase: 'stopping' | 'waiting' | 'starting' | 'done' | 'failed';
  startedAt: string;
  endedAt: string | null;
  message: string | null;
}

export interface TomcatState {
  settings: {
    webappsDir: string;
    disabledDir: string;
    startScript: string;
    stopScript: string;
    managerUrl: string;
    warWatch: string[];
    startChrome: boolean;
  };
  launch: TomcatLaunch;
  /** The start commands from the settings, each with its latest run. */
  commands: StartCommandInfo[];
  /** Runs still going whose command is no longer in the settings, so they can still be stopped. */
  otherRuns: CommandRun[];
  /** The latest Start Tomcat sequence. */
  sequence: StartSequence | null;
  /** Folders that are set but cannot be used, e.g. not found. */
  problems: { key: 'webappsDir' | 'disabledDir' | 'startScript' | 'stopScript' | 'warWatch'; message: string }[];
  webapps: WebappInfo[];
  disabled: WebappInfo[];
  manager: {
    configured: boolean;
    ok: boolean;
    error: string | null;
    /** Where the webapps are served, e.g. http://localhost:8080, derived from the Manager URL. */
    origin: string | null;
  };
  scripts: { start: ScriptRun | null; stop: ScriptRun | null };
  /** What the console can show, Tomcat first. */
  consoles: ConsoleSource[];
  /** The latest Restart Tomcat. */
  restart: RestartState | null;
  wars: WarInfo[];
  /** Saved sets of webapps, each with what applying it would move. */
  sets: WebappSets;
  /** Set when Debug Hub runs as a webapp inside the Tomcat this page manages. */
  hosted?: {
    /** The context path Debug Hub is served under, "/" for ROOT. */
    path: string;
    /** e.g. "Apache Tomcat/9.0.89". */
    server: string;
  };
}

export type WebappAction = 'start' | 'stop' | 'reload' | 'disable' | 'enable';

export type AppFolder = 'webapps' | 'disabled';

/** One thing Delete removes from the webapps or disabled folder. */
export interface DeleteItem {
  /** Its name in the folder: "shop.war" or "shop". */
  name: string;
  path: string;
  /** A link (or Windows junction) is removed as a link; what it points to is left alone. */
  kind: 'war' | 'folder' | 'link';
  bytes: number;
  files: number;
  /** The folder was too big to count completely; there is at least this much. */
  partial: boolean;
}

/** Where the files kept on a deploy are read from: the copy of the webapp being replaced. */
export interface KeepSource {
  kind: 'folder' | 'war';
  path: string;
  where: AppFolder;
}

export interface KeptFile {
  /** Relative to the webapp, with forward slashes, e.g. "WEB-INF/classes/config.yaml". */
  path: string;
  bytes: number;
  /** The new WAR has a file there, which the kept one replaces; otherwise it is added. Null if not known. */
  inWar?: boolean | null;
}

/** GET /api/tomcat/keep: what a deploy could keep from the copy it replaces. */
export interface KeepPreview {
  /** File names (with *) from Settings › Tomcat. */
  patterns: string[];
  source: KeepSource | null;
  files: KeptFile[];
  /** The search stopped early: there may be more. */
  truncated: boolean;
  /** Why files cannot be kept, e.g. the new WAR is a ZIP64 archive. */
  problem: string | null;
}

// ── Webapp sets ─────────────────────────────────────────

/** A named set of webapps to have deployed together, e.g. for one debugging task. */
export interface WebappSet {
  name: string;
  /** Webapp names (as in webapps: shop, ROOT, shop##2). */
  webapps: string[];
  updated: string;
}

/** What applying a set would do now. */
export interface WebappSetPlan {
  /** Deployed and not in the set: moved to the disabled folder. */
  disable: string[];
  /** In the set and disabled: moved back into webapps. */
  enable: string[];
  /** In the set, but neither deployed nor disabled: deploy them to have them. */
  missing: string[];
  /** Deployed, not in the set, but never disabled by a set: the Tomcat Manager, Debug Hub itself. */
  kept: string[];
}

export interface WebappSetInfo extends WebappSet {
  plan: WebappSetPlan;
  /** Nothing to move: what is deployed is this set (missing webapps aside). */
  current: boolean;
}

export interface WebappSets {
  list: WebappSetInfo[];
  /** Why sets cannot be saved or read, e.g. no settings folder, or an unreadable file. */
  error: string | null;
  /** The set being applied now, if one is. */
  applying: string | null;
}

/** POST /api/tomcat/sets/apply. */
export interface ApplySetResult {
  message: string;
  disabled: string[];
  enabled: string[];
  missing: string[];
  failed: { name: string; error: string }[];
}
