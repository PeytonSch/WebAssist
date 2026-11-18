import { posix, win32 } from 'node:path';
import type { HubEvent } from '../../shared/types';
import type { Config } from '../config';
import { deployFolder, thisMachine, type DetectMachine } from './defaults';
import { hosted, samePath, type HostedInfo } from './info';

/**
 * Running inside the Tomcat it manages, the hub can saw off the branch it sits on: its own
 * webapp is in the webapps list, and Stop Tomcat stops the hub too. These helpers say when a
 * setting or an action is about the hub's own Tomcat or its own webapp, so the Tomcat page can
 * mark and guard them. They only apply while the webapps folder in Settings is the one this
 * Tomcat deploys from: a hub hosted in one Tomcat may well manage another.
 */

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** The Tomcat in Settings is the one the hub runs in. */
export function ownTomcat(cfg: Config, info: HostedInfo | null = hosted(), m: DetectMachine = thisMachine()): boolean {
  if (!info || !cfg.tomcat.webappsDir) return false;
  const p = pathFor(m.platform);
  const own = [deployFolder(info, m)?.dir, info.catalinaBase ? p.join(info.catalinaBase, 'webapps') : ''];
  return own.some((dir) => !!dir && samePath(dir, cfg.tomcat.webappsDir, m.platform));
}

/** The context path a webapp name stands for: "/" for ROOT, "/a/b" for "a#b", without a ##version. */
function contextOf(name: string): string {
  const base = name.replace(/##.*$/, '');
  return base === 'ROOT' ? '/' : `/${base.replace(/#/g, '/')}`;
}

/** The context path the hub itself is served under, as the Tomcat page writes paths ("/" for ROOT). */
export function selfPath(info: HostedInfo): string {
  return info.contextPath || '/';
}

/** A webapp in the webapps folder (or listed by the Manager) that is the hub itself. */
export function isSelfWebapp(cfg: Config, nameOrPath: { name: string } | { path: string }, info: HostedInfo | null = hosted(), m: DetectMachine = thisMachine()): boolean {
  if (!info || !ownTomcat(cfg, info, m)) return false;
  const path = 'path' in nameOrPath ? nameOrPath.path : contextOf(nameOrPath.name);
  return path === selfPath(info);
}

export const SELF_REFUSED =
  'This webapp is Debug Hub itself, running inside this Tomcat: stopping, reloading, disabling or deleting it from here would cut off the page you are using. ' +
  'Do it from Tomcat instead (the Manager, or the webapps folder). Deploying a new debug-hub.war over it is fine: Debug Hub restarts with the new build.';

/**
 * Requests the hub's own pages make show up in Tomcat's access log, which the hub follows: its
 * own polling would fill the timeline. They are left out.
 */
export function isOwnTraffic(ev: HubEvent, info: HostedInfo): boolean {
  if (ev.source !== 'tomcat' || ev.kind !== 'request') return false;
  const path = String(ev.data?.path ?? '').split('?')[0];
  if (info.contextPath) return path === info.contextPath || path.startsWith(`${info.contextPath}/`);
  // Deployed as ROOT, the hub shares "/" with every other webapp's paths: only its own are known.
  return path === '/' || path === '/index.html' || path === '/app.js' || path === '/styles.css' || path === '/api' || path.startsWith('/api/');
}

/** The hub's own page in the debugged browser, which must not be recorded. `seenHosts` are the addresses it has been served under. */
export function isOwnUi(url: URL, seenHosts: ReadonlySet<string>, info: HostedInfo | null = hosted()): boolean {
  if (!info || !seenHosts.has(url.host.toLowerCase())) return false;
  const base = info.contextPath;
  return url.pathname === `${base}/` || url.pathname === `${base}/index.html` || (base !== '' && url.pathname === base);
}

/** Addresses the hosted UI has been opened under; filled by the HTTP gate. */
export const ownUiHosts = new Set<string>();
