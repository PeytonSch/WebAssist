import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, type Config } from './config';
import { runDoctor } from './doctor';
import { Hub } from './hub';
import { BIND_HOST, startServer } from './http';

/** Runs the hub inside another process (the desktop app) instead of from the command line. */

export interface RunningHub {
  port: number;
  url: string;
  /** Follows changes made in Settings. */
  sessionsDir: () => string;
  /** Set when the config file could not be read and defaults were used instead. */
  configError: string | null;
  stop: () => Promise<void>;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, BIND_HOST, () => probe.close(() => resolve(true)));
  });
}

function readConfig(configFile: string): { config: Config; error: string | null } {
  try {
    return { config: loadConfig(configFile).config, error: null };
  } catch (err) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.sessionsDir = join(dirname(configFile), 'sessions');
    return { config, error: (err as Error).message };
  }
}

export async function startHub(configFile: string, uiDir: string): Promise<RunningHub> {
  const { config, error } = readConfig(configFile);
  // A second copy, or anything else on the port, should not stop the app from opening.
  const wanted = config.port;
  while (config.port < wanted + 20 && !(await portFree(config.port))) config.port++;

  const hub = new Hub(config);
  hub.start();
  const server = await startServer(hub, uiDir, { configFile });
  return {
    port: config.port,
    // Not "localhost": Windows resolves that to ::1 first, and the hub only listens on IPv4.
    url: `http://127.0.0.1:${config.port}`,
    sessionsDir: () => hub.cfg.sessionsDir,
    configError: error,
    stop: async () => {
      server.close();
      await hub.stop();
    },
  };
}

export async function environmentReport(configFile: string, projectDir: string | null): Promise<string> {
  return runDoctor(readConfig(configFile).config, projectDir);
}
