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

export interface TomcatState {
  settings: {
    webappsDir: string;
    disabledDir: string;
    startScript: string;
    stopScript: string;
    managerUrl: string;
    warWatch: string[];
  };
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
