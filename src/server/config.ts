import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface Config {
  /** UI and API port. Always bound to 127.0.0.1. */
  port: number;
  sessionsDir: string;
  chrome: {
    enabled: boolean;
    host: string;
    /** Chrome's --remote-debugging-port. */
    port: number;
    captureBodies: boolean;
    /** CDP resource types whose response bodies are captured. */
    bodyResourceTypes: string[];
    /** Chrome's executable for the Start Chrome button. Empty: find the installed Chrome. */
    executable: string;
    /**
     * The --user-data-dir Chrome is started with. Chrome 136 and later ignore
     * --remote-debugging-port on the default profile, so it must be a separate folder.
     */
    profileDir: string;
  };
  tomcat: {
    enabled: boolean;
    /** Application logs (catalina.out, localhost.<date>.log, app logs). `*` globs allowed in the file name. */
    appLogs: string[];
    /** Access logs (localhost_access_log.<date>.txt). */
    accessLogs: string[];
    /** Unit of %D in the access log: ms for Tomcat <= 9, us for Tomcat >= 10. */
    accessDurationUnit: 'ms' | 'us' | 's';
    /**
     * A logs folder (CATALINA_BASE/logs) whose every log file is followed: access logs by their
     * name, everything else as application logs. Empty: off. Adds to appLogs and accessLogs.
     */
    logsDir: string;
    /** CATALINA_BASE/webapps, for the Tomcat page and WAR deploys. Empty: not managed. */
    webappsDir: string;
    /** Where disabled webapps are moved, outside webapps so Tomcat does not see them. */
    disabledDir: string;
    /** Scripts that start and stop the Tomcat server (.bat/.cmd/.sh or any executable). */
    startScript: string;
    stopScript: string;
    /** Optional Tomcat Manager (text interface) used to start and stop single webapps. */
    manager: { url: string; username: string; password: string };
    /** Folders (or `*` patterns) where WARs are built; a new or rebuilt WAR offers a deploy. */
    warWatch: string[];
    /**
     * CATALINA_HOME, for starting and stopping Tomcat with its own bin/startup and bin/shutdown
     * when no start or stop script is set. Empty: the folder above webappsDir, if it has bin/.
     */
    home: string;
    /** JAVA_HOME for Tomcat's own scripts. Empty: whatever Debug Hub's environment has. */
    javaHome: string;
    /** Run, in order, each time Tomcat is started from the Tomcat page: the rest of the dev setup. */
    startCommands: StartCommand[];
    /** Also start Chrome with its debugging port when starting Tomcat. */
    startChrome: boolean;
    /**
     * File names kept from the deployed copy of a webapp when a new WAR replaces it, e.g. local
     * settings the build would overwrite. `*` allowed. Offered as a choice when deploying.
     */
    preserveFiles: string[];
  };
  postgres: {
    enabled: boolean;
    logs: string[];
  };
  tail: {
    /** Read existing file content on startup instead of only new lines. */
    fromStart: boolean;
    pollMs: number;
    /** How long to wait for continuation lines before emitting a multiline entry. */
    flushMs: number;
  };
  redact: { headers: string[] };
  /** Bodies above this size are truncated. */
  maxBodyBytes: number;
  correlation: {
    header: string;
    /** Regexes with one capture group that pull a request ID out of a log line or SQL comment. */
    logPatterns: string[];
    timeWindowMs: number;
  };
}

export interface StartCommand {
  /** Shown on the Tomcat page and the timeline. */
  name: string;
  /** A command line, run by the system shell (cmd.exe on Windows, /bin/sh elsewhere). */
  command: string;
  /** Working folder. Empty: the settings file's folder. */
  cwd: string;
  /** Wait for it to finish, and stop if it fails, before running the next step. */
  wait: boolean;
}

export const DEFAULT_CONFIG: Config = {
  port: 4000,
  sessionsDir: 'sessions',
  chrome: {
    enabled: true,
    host: '127.0.0.1',
    port: 9222,
    captureBodies: true,
    bodyResourceTypes: ['XHR', 'Fetch', 'Document'],
    executable: '',
    profileDir: 'chrome-profile',
  },
  tomcat: {
    enabled: false,
    appLogs: [],
    accessLogs: [],
    accessDurationUnit: 'ms',
    logsDir: '',
    webappsDir: '',
    disabledDir: '',
    startScript: '',
    stopScript: '',
    manager: { url: '', username: '', password: '' },
    warWatch: [],
    home: '',
    javaHome: '',
    startCommands: [],
    startChrome: false,
    preserveFiles: ['config.yaml', 'config.js'],
  },
  postgres: { enabled: false, logs: [] },
  tail: { fromStart: false, pollMs: 200, flushMs: 150 },
  redact: { headers: ['authorization', 'proxy-authorization', 'cookie', 'set-cookie'] },
  maxBodyBytes: 64 * 1024,
  correlation: {
    header: 'X-Request-Id',
    logPatterns: ['(?:\\brid|request[_-]?id|x-request-id)["\']?\\s*[=:]\\s*["\']?([A-Za-z0-9._-]{6,})'],
    timeWindowMs: 2000,
  },
};

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function merge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over as T;
  const out: any = { ...base };
  for (const key of Object.keys(over)) {
    out[key] = key in (base as any) ? merge((base as any)[key], over[key]) : over[key];
  }
  return out;
}

/**
 * Windows paths pasted into JSON ("C:\Users\me\logs" with single backslashes) are invalid or,
 * worse, silently wrong: \t and \b are legal escapes. Every backslash that is not part of \\ or
 * \" becomes a forward slash, which Windows accepts in paths. Regexes in the config must
 * therefore escape their backslashes properly (\\b), as JSON requires anyway.
 */
export function forgiveBackslashes(json: string): string {
  return json.replace(/\\(\\|")|\\/g, (m, keep) => (keep ? m : '/'));
}

export interface LoadedConfig {
  config: Config;
  /** Path of the config file that was read, or null when running on defaults. */
  file: string | null;
}

/** Reads a config file as written, without defaults or path resolution. */
export function readRawConfig(file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(forgiveBackslashes(readFileSync(file, 'utf8')));
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
  if (!isObj(raw)) throw new Error(`${file} must contain a JSON object`);
  return raw;
}

/** Makes the paths in a config absolute. Relative paths are relative to the config file. */
export function resolvePaths(config: Config, base: string): Config {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  // Optional paths stay empty when unset.
  const opt = (p: string) => (p ? abs(p) : p);
  config.sessionsDir = abs(config.sessionsDir);
  config.chrome.executable = opt(config.chrome.executable);
  config.chrome.profileDir = opt(config.chrome.profileDir);
  config.tomcat.appLogs = config.tomcat.appLogs.map(abs);
  config.tomcat.accessLogs = config.tomcat.accessLogs.map(abs);
  config.tomcat.logsDir = opt(config.tomcat.logsDir);
  config.tomcat.webappsDir = opt(config.tomcat.webappsDir);
  config.tomcat.disabledDir = opt(config.tomcat.disabledDir);
  config.tomcat.startScript = opt(config.tomcat.startScript);
  config.tomcat.stopScript = opt(config.tomcat.stopScript);
  config.tomcat.warWatch = config.tomcat.warWatch.map(abs);
  config.tomcat.home = opt(config.tomcat.home);
  config.tomcat.javaHome = opt(config.tomcat.javaHome);
  config.tomcat.startCommands = config.tomcat.startCommands.map((c) => ({ ...c, cwd: abs(c.cwd || '.') }));
  config.postgres.logs = config.postgres.logs.map(abs);
  return config;
}

export function loadConfig(explicitPath?: string, cwd = process.cwd()): LoadedConfig {
  const file = explicitPath ? resolve(cwd, explicitPath) : resolve(cwd, 'debug-hub.config.json');
  if (!existsSync(file)) {
    if (explicitPath) throw new Error(`Config file not found: ${file}`);
    return { config: structuredClone(DEFAULT_CONFIG), file: null };
  }
  const config = merge(structuredClone(DEFAULT_CONFIG), readRawConfig(file));
  // Relative paths are relative to the config file, so the hub can be started from anywhere.
  return { config: resolvePaths(config, dirname(file)), file };
}

// ── Editing from the settings screen ───────────────────

export interface EditableConfig {
  /** Where settings are saved. */
  file: string;
  /** The settings as written in the file, over the defaults. Paths are not resolved. */
  config: Config;
  defaults: Config;
  /** Set when the file exists but could not be read; saving replaces it. */
  error: string | null;
}

export function editableConfig(file: string): EditableConfig {
  const defaults = structuredClone(DEFAULT_CONFIG);
  if (!existsSync(file)) return { file, config: structuredClone(DEFAULT_CONFIG), defaults, error: null };
  try {
    return { file, config: merge(structuredClone(DEFAULT_CONFIG), readRawConfig(file)), defaults, error: null };
  } catch (err) {
    return { file, config: structuredClone(DEFAULT_CONFIG), defaults, error: (err as Error).message };
  }
}

export interface FieldError {
  /** Dotted key, e.g. "chrome.port" or "tomcat.appLogs.1". Empty for the whole form. */
  path: string;
  message: string;
}

/**
 * Checks settings sent from the settings screen and returns a complete config: defaults filled
 * in, blank list entries dropped, text trimmed. Unknown keys are kept, so settings added by hand
 * or by a newer version survive a save.
 */
export function validateConfig(input: unknown): { config: Config; errors: FieldError[] } {
  const errors: FieldError[] = [];
  if (!isObj(input)) errors.push({ path: '', message: 'Settings must be an object' });
  const config = merge(structuredClone(DEFAULT_CONFIG), isObj(input) ? input : {});
  const fmt = (n: number) => n.toLocaleString('en-US');

  const int = (path: string, v: unknown, min: number, max: number, label: string): number => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      errors.push({ path, message: `${label} must be a whole number from ${fmt(min)} to ${fmt(max)}` });
      return typeof n === 'number' && Number.isFinite(n) ? n : min;
    }
    return n;
  };
  const bool = (path: string, v: unknown): boolean => {
    if (typeof v !== 'boolean') errors.push({ path, message: 'Must be on or off' });
    return v === true;
  };
  /** Text that may be left empty. */
  const optText = (path: string, v: unknown, label: string): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') {
      errors.push({ path, message: `${label} must be text` });
      return '';
    }
    return v.trim();
  };
  const text = (path: string, v: unknown, label: string): string => {
    if (typeof v !== 'string') {
      errors.push({ path, message: `${label} must be text` });
      return '';
    }
    if (!v.trim()) errors.push({ path, message: `${label} is required` });
    return v.trim();
  };
  // Positions in error paths refer to the list as sent, so the screen can mark the right row.
  const list = (path: string, v: unknown, check?: (s: string) => string | null): string[] => {
    if (!Array.isArray(v)) {
      errors.push({ path, message: 'Must be a list' });
      return [];
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== 'string') return errors.push({ path: `${path}.${i}`, message: 'Must be text' });
      const s = item.trim();
      if (!s) return;
      const problem = check?.(s);
      if (problem) errors.push({ path: `${path}.${i}`, message: problem });
      out.push(s);
    });
    return out;
  };

  config.port = int('port', config.port, 1, 65535, 'Port');
  config.sessionsDir = text('sessionsDir', config.sessionsDir, 'Sessions folder');

  config.chrome.enabled = bool('chrome.enabled', config.chrome.enabled);
  config.chrome.host = text('chrome.host', config.chrome.host, 'Host');
  config.chrome.port = int('chrome.port', config.chrome.port, 1, 65535, 'Port');
  config.chrome.captureBodies = bool('chrome.captureBodies', config.chrome.captureBodies);
  config.chrome.bodyResourceTypes = list('chrome.bodyResourceTypes', config.chrome.bodyResourceTypes);
  config.chrome.executable = optText('chrome.executable', config.chrome.executable, 'Chrome program');
  config.chrome.profileDir = optText('chrome.profileDir', config.chrome.profileDir, 'Chrome profile folder');
  if (config.chrome.port === config.port && /^(127\.0\.0\.1|localhost)$/.test(config.chrome.host)) {
    errors.push({ path: 'chrome.port', message: 'Must differ from Debug Hub’s own port' });
  }

  config.tomcat.enabled = bool('tomcat.enabled', config.tomcat.enabled);
  config.tomcat.appLogs = list('tomcat.appLogs', config.tomcat.appLogs);
  config.tomcat.accessLogs = list('tomcat.accessLogs', config.tomcat.accessLogs);
  if (!['ms', 'us', 's'].includes(config.tomcat.accessDurationUnit)) {
    errors.push({ path: 'tomcat.accessDurationUnit', message: 'Must be ms, us or s' });
  }
  config.tomcat.logsDir = optText('tomcat.logsDir', config.tomcat.logsDir, 'Logs folder');
  config.tomcat.webappsDir = optText('tomcat.webappsDir', config.tomcat.webappsDir, 'Webapps folder');
  config.tomcat.disabledDir = optText('tomcat.disabledDir', config.tomcat.disabledDir, 'Disabled webapps folder');
  config.tomcat.startScript = optText('tomcat.startScript', config.tomcat.startScript, 'Start script');
  config.tomcat.stopScript = optText('tomcat.stopScript', config.tomcat.stopScript, 'Stop script');
  if (config.tomcat.disabledDir && config.tomcat.disabledDir === config.tomcat.webappsDir) {
    errors.push({ path: 'tomcat.disabledDir', message: 'Must be a different folder from webapps' });
  }
  const mgr = isObj(config.tomcat.manager) ? config.tomcat.manager : { url: '', username: '', password: '' };
  config.tomcat.manager = {
    url: optText('tomcat.manager.url', mgr.url, 'Manager URL').replace(/\/+$/, ''),
    username: optText('tomcat.manager.username', mgr.username, 'User name'),
    // Not trimmed: a password may end in a space.
    password: typeof mgr.password === 'string' ? mgr.password : '',
  };
  if (config.tomcat.manager.url && !/^https?:\/\/[^/\s]+/.test(config.tomcat.manager.url)) {
    errors.push({ path: 'tomcat.manager.url', message: 'Must start with http:// or https://' });
  }
  config.tomcat.warWatch = list('tomcat.warWatch', config.tomcat.warWatch);
  config.tomcat.home = optText('tomcat.home', config.tomcat.home, 'Tomcat folder');
  config.tomcat.javaHome = optText('tomcat.javaHome', config.tomcat.javaHome, 'Java folder');
  config.tomcat.startChrome = bool('tomcat.startChrome', config.tomcat.startChrome);
  config.tomcat.preserveFiles = list('tomcat.preserveFiles', config.tomcat.preserveFiles, (n) =>
    /[\\/]/.test(n) ? 'A file name only, without a folder' : null,
  );
  config.tomcat.startCommands = startCommands(config.tomcat.startCommands);

  config.postgres.enabled = bool('postgres.enabled', config.postgres.enabled);
  config.postgres.logs = list('postgres.logs', config.postgres.logs);

  config.tail.fromStart = bool('tail.fromStart', config.tail.fromStart);
  config.tail.pollMs = int('tail.pollMs', config.tail.pollMs, 50, 10_000, 'Poll interval');
  config.tail.flushMs = int('tail.flushMs', config.tail.flushMs, 10, 10_000, 'Flush delay');

  config.redact.headers = list('redact.headers', config.redact.headers).map((h) => h.toLowerCase());
  config.maxBodyBytes = int('maxBodyBytes', config.maxBodyBytes, 0, 64 * 1024 * 1024, 'Body limit');

  config.correlation.header = text('correlation.header', config.correlation.header, 'Header');
  if (config.correlation.header && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(config.correlation.header)) {
    errors.push({ path: 'correlation.header', message: 'Not a valid HTTP header name' });
  }
  config.correlation.timeWindowMs = int('correlation.timeWindowMs', config.correlation.timeWindowMs, 0, 600_000, 'Time window');
  config.correlation.logPatterns = list('correlation.logPatterns', config.correlation.logPatterns, (p) => {
    try {
      new RegExp(p);
      return null;
    } catch (err) {
      return (err as Error).message.replace(/^Invalid regular expression: /, '');
    }
  });

  /** Rows left completely blank are dropped; a row with anything in it needs a command. */
  function startCommands(v: unknown): StartCommand[] {
    if (!Array.isArray(v)) {
      errors.push({ path: 'tomcat.startCommands', message: 'Must be a list' });
      return [];
    }
    const out: StartCommand[] = [];
    v.forEach((item, i) => {
      const at = `tomcat.startCommands.${i}`;
      if (!isObj(item)) return errors.push({ path: at, message: 'Must be a command' });
      const c: StartCommand = {
        name: optText(`${at}.name`, item.name, 'Name'),
        command: optText(`${at}.command`, item.command, 'Command'),
        cwd: optText(`${at}.cwd`, item.cwd, 'Folder'),
        wait: item.wait === true,
      };
      if (!c.name && !c.command && !c.cwd) return;
      if (!c.command) errors.push({ path: `${at}.command`, message: 'Command is required' });
      out.push(c);
    });
    return out;
  }

  return { config, errors };
}

/**
 * Writes settings to the config file, keeping keys the settings screen does not know about.
 * The write goes through a temporary file, so a crash never leaves half a config behind.
 */
export function saveConfig(file: string, config: Config): void {
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(file)) existing = readRawConfig(file);
  } catch {
    /* unreadable: replaced */
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(merge(existing, config), null, 2) + '\n');
  renameSync(tmp, file);
}
