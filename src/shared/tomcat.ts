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
  /** The script or bin/startup file that runs. */
  path: string | null;
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
  wars: WarInfo[];
}

export type WebappAction = 'start' | 'stop' | 'reload' | 'disable' | 'enable';
