import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Hub } from '../hub';
import { startServer } from '../http';
import { loadHostedConfig } from './defaults';
import { readHostedEnv, setHosted } from './info';
import { isOwnTraffic } from './self';
import { HostedServer } from './server';

/**
 * Entry point of the hub when it runs inside Tomcat: WEB-INF/hub/hub.cjs in the WAR, started as
 * a child process by the launcher (src/webapp/WEB-INF/hub.jsp) with DEBUG_HUB_* variables that
 * say where it is deployed. It listens on a port the OS picks, on 127.0.0.1, tells the launcher
 * which one on stdout, and stops when the launcher closes its stdin or goes away.
 */

/** The line the launcher waits for. Everything else the hub prints goes to its log file. */
const READY = 'DEBUG_HUB_READY port=';

async function main(): Promise<void> {
  const info = readHostedEnv(process.env);
  if (!info) throw new Error('This is the Debug Hub build that runs inside Tomcat. It is started by its webapp, not by hand; use "npm start" to run Debug Hub on its own.');
  // Scripts and start commands the hub runs must not inherit the launcher's secret, and have
  // no use for the rest of what it passed.
  const passed = /^DEBUG_HUB_(HOSTED|SECRET|CONTEXT_PATH|WEBAPP_DIR|CATALINA_BASE|CATALINA_HOME|JAVA_HOME|SERVER_INFO|DATA|LOG|REMOTE|HOSTS)$/i;
  for (const name of Object.keys(process.env)) if (passed.test(name)) delete process.env[name];
  setHosted(info);

  mkdirSync(info.dataDir, { recursive: true });
  const configFile = join(info.dataDir, 'debug-hub.config.json');
  const { config, error, filled } = loadHostedConfig(configFile, info);
  // The port in the settings is for running on its own; here the OS picks a free one.
  config.port = 0;

  const hub = new Hub(config);
  // The hub's own pages are served through Tomcat and so appear in its access log.
  const emit = hub.emit.bind(hub);
  hub.emit = (ev) => {
    if (!isOwnTraffic(ev, info)) emit(ev);
  };
  hub.start();

  const hostedServer = new HostedServer(info, () => hub.cfg);
  const server = await startServer(hub, join(__dirname, 'ui'), { configFile, hosted: hostedServer });
  const port = (server.address() as AddressInfo).port;

  console.log(`Debug Hub ${process.env.DEBUG_HUB_VERSION ?? ''} running inside ${info.serverInfo || 'Tomcat'} at ${info.contextPath || '/'} (Node ${process.version}, hub port ${port} on 127.0.0.1)`);
  console.log(`Settings and sessions: ${info.dataDir}`);
  if (error) console.log(`The settings file could not be read, so defaults are used: ${error}`);
  if (filled.length) console.log(`Detected from Tomcat: ${filled.join(', ')}`);
  const { remote } = hostedServer.gate;
  if (remote.invalid.length) console.log(`debughub.remote has entries that are neither an address nor a network and are ignored: ${remote.invalid.join(', ')}`);
  console.log(`Access: ${remote.all ? 'any computer that can reach Tomcat' : remote.networks.length ? `this computer and ${info.remote}` : 'this computer only'}`);
  console.log(`${READY}${port}`);

  let stopping = false;
  const shutdown = async (why: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`Stopping: ${why}`);
    // Do not wait forever on a stuck collector: Tomcat is waiting to undeploy.
    const giveUp = setTimeout(() => process.exit(0), 4000);
    giveUp.unref();
    try {
      await hub.stop();
    } finally {
      process.exit(0);
    }
  };
  // The launcher holds the other end of stdin. It closes it to stop the hub, and the OS closes
  // it if Tomcat dies, so no hub is left behind either way.
  process.stdin.on('end', () => void shutdown('the webapp stopped'));
  process.stdin.on('close', () => void shutdown('the webapp stopped'));
  process.stdin.on('error', () => void shutdown('the webapp stopped'));
  process.stdin.resume();
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`Debug Hub could not start: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
