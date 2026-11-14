import { existsSync, readFileSync } from 'node:fs';
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
  };
  tomcat: {
    enabled: boolean;
    /** Application logs (catalina.out, localhost.<date>.log, app logs). `*` globs allowed in the file name. */
    appLogs: string[];
    /** Access logs (localhost_access_log.<date>.txt). */
    accessLogs: string[];
    /** Unit of %D in the access log: ms for Tomcat <= 9, us for Tomcat >= 10. */
    accessDurationUnit: 'ms' | 'us' | 's';
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

export const DEFAULT_CONFIG: Config = {
  port: 4000,
  sessionsDir: 'sessions',
  chrome: {
    enabled: true,
    host: '127.0.0.1',
    port: 9222,
    captureBodies: true,
    bodyResourceTypes: ['XHR', 'Fetch', 'Document'],
  },
  tomcat: { enabled: false, appLogs: [], accessLogs: [], accessDurationUnit: 'ms' },
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

function merge<T>(base: T, over: any): T {
  if (over === undefined || over === null) return base;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over as T;
  const out: any = { ...base };
  for (const key of Object.keys(over)) {
    out[key] = key in (base as any) ? merge((base as any)[key], over[key]) : over[key];
  }
  return out;
}

export interface LoadedConfig {
  config: Config;
  /** Path of the config file that was read, or null when running on defaults. */
  file: string | null;
}

export function loadConfig(explicitPath?: string, cwd = process.cwd()): LoadedConfig {
  const file = explicitPath ? resolve(cwd, explicitPath) : resolve(cwd, 'debug-hub.config.json');
  if (!existsSync(file)) {
    if (explicitPath) throw new Error(`Config file not found: ${file}`);
    return { config: structuredClone(DEFAULT_CONFIG), file: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${(err as Error).message}`);
  }
  const config = merge(structuredClone(DEFAULT_CONFIG), raw);
  // Relative paths are relative to the config file, so the hub can be started from anywhere.
  const base = dirname(file);
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  config.sessionsDir = abs(config.sessionsDir);
  config.tomcat.appLogs = config.tomcat.appLogs.map(abs);
  config.tomcat.accessLogs = config.tomcat.accessLogs.map(abs);
  config.postgres.logs = config.postgres.logs.map(abs);
  return { config, file };
}
