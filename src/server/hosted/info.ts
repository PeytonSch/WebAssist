import { posix, win32 } from 'node:path';

/**
 * Debug Hub can run as a webapp inside Tomcat (the WAR from `npm run build:war`). A small
 * launcher in the webapp (src/webapp/WEB-INF/hub.jsp) starts this Node program as a child
 * process, hands it what it knows about the Tomcat it runs in through DEBUG_HUB_* environment
 * variables, and forwards the browser's requests to it. "Hosted" is that mode.
 */
export interface HostedInfo {
  /** Sent by the launcher with every request; nothing else may talk to the hub. */
  secret: string;
  /** The webapp's context path: "/debug-hub", or "" when deployed as ROOT. */
  contextPath: string;
  /** Where Tomcat unpacked the webapp (webapps/debug-hub), or null when it runs from the WAR. */
  webappDir: string | null;
  /** CATALINA_BASE: conf/, logs/, webapps/ of the Tomcat instance. */
  catalinaBase: string;
  /** CATALINA_HOME: bin/ and lib/ of the Tomcat install. */
  catalinaHome: string;
  /** java.home of the JVM Tomcat runs on. */
  javaHome: string | null;
  /** As Tomcat names itself, e.g. "Apache Tomcat/9.0.89". */
  serverInfo: string;
  /** Where settings, sessions and saved requests live: outside the webapp folder, which Tomcat deletes on redeploy. */
  dataDir: string;
  /** Who may connect besides this machine: "" (nobody), "all", or addresses and networks. */
  remote: string;
  /** Extra host names the hub may be reached under (a DNS name, a reverse proxy's name). */
  hosts: string;
  /** Where the launcher writes what the hub prints. */
  logFile: string | null;
}

const text = (v: string | undefined) => (v ?? '').trim();

/** What the launcher passed, or null when this is not the hosted hub. */
export function readHostedEnv(env: Record<string, string | undefined>): HostedInfo | null {
  if (!text(env.DEBUG_HUB_HOSTED)) return null;
  const secret = text(env.DEBUG_HUB_SECRET);
  const dataDir = text(env.DEBUG_HUB_DATA);
  if (secret.length < 16) throw new Error('DEBUG_HUB_SECRET is missing or too short; the hub only runs hosted when started by its webapp.');
  if (!dataDir) throw new Error('DEBUG_HUB_DATA is not set.');
  let contextPath = text(env.DEBUG_HUB_CONTEXT_PATH).replace(/\/+$/, '');
  if (contextPath && !contextPath.startsWith('/')) contextPath = `/${contextPath}`;
  return {
    secret,
    contextPath,
    webappDir: text(env.DEBUG_HUB_WEBAPP_DIR) || null,
    catalinaBase: text(env.DEBUG_HUB_CATALINA_BASE),
    catalinaHome: text(env.DEBUG_HUB_CATALINA_HOME) || text(env.DEBUG_HUB_CATALINA_BASE),
    javaHome: text(env.DEBUG_HUB_JAVA_HOME) || null,
    serverInfo: text(env.DEBUG_HUB_SERVER_INFO),
    dataDir,
    remote: text(env.DEBUG_HUB_REMOTE),
    hosts: text(env.DEBUG_HUB_HOSTS),
    logFile: text(env.DEBUG_HUB_LOG) || null,
  };
}

let current: HostedInfo | null = null;

/** Set once at start by the hosted entry point (src/server/hosted/main.ts); null everywhere else. */
export function hosted(): HostedInfo | null {
  return current;
}
export function setHosted(info: HostedInfo | null): void {
  current = info;
}

/** "9.0.89" out of "Apache Tomcat/9.0.89". */
export function tomcatVersion(serverInfo: string): { version: string | null; major: number | null } {
  const m = /(\d+)(?:\.\d+)*/.exec(serverInfo.split('/').pop() ?? '');
  return m ? { version: m[0], major: Number(m[1]) } : { version: null, major: null };
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!a || !b) return false;
  const p = pathFor(platform);
  const norm = (x: string) => p.resolve(x).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * The name Tomcat knows the hub's own webapp by: the folder it was unpacked to, else worked out
 * from the context path ("" is ROOT, "/tools/hub" is "tools#hub").
 */
export function selfName(info: HostedInfo, platform: NodeJS.Platform = process.platform): string {
  if (info.webappDir) {
    const base = pathFor(platform).basename(info.webappDir.replace(/[\\/]+$/, ''));
    if (base) return base;
  }
  return info.contextPath ? info.contextPath.slice(1).replace(/\//g, '#') : 'ROOT';
}
