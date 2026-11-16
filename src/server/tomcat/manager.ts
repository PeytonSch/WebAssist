import { contextPath, TomcatError, versionOf } from './webapps';

/**
 * A client for the Tomcat Manager's text interface (/manager/text), used to start, stop and
 * reload single webapps and to read which ones are running. The Manager answers every command
 * with "OK - ..." or "FAIL - ..." on the first line.
 */

export interface ManagerSettings {
  url: string;
  username: string;
  password: string;
}

export interface ManagerApp {
  path: string;
  state: 'running' | 'stopped';
  sessions: number | null;
  /** Where Tomcat loads it from: a name in webapps ("shop##3"), or a full path for one deployed from elsewhere. */
  docBase: string;
  /** The Tomcat base name for its path and version, e.g. "ROOT", "api#v2", "shop##3". */
  name: string;
}

export type Fetch = typeof fetch;

const TIMEOUT_MS = 5000;

function describeNetworkError(err: any, url: string): string {
  const code = err?.cause?.code ?? err?.code;
  let where = url;
  try {
    where = new URL(url).host;
  } catch {
    /* shown as typed */
  }
  if (code === 'ECONNREFUSED') return `Tomcat is not running: nothing answers at ${where}.`;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `The Tomcat Manager at ${where} did not answer within ${TIMEOUT_MS / 1000} s.`;
  if (code === 'ENOTFOUND') return `Unknown host in the Manager URL: ${where}.`;
  return `Could not reach the Tomcat Manager at ${where}: ${err?.cause?.message ?? err?.message ?? err}`;
}

/** Runs one Manager command and returns the text after "OK - ". */
export async function managerCommand(
  mgr: ManagerSettings,
  command: 'list' | 'start' | 'stop' | 'reload',
  params: Record<string, string> = {},
  fetchImpl: Fetch = fetch,
): Promise<string> {
  if (!mgr.url) throw new TomcatError('The Tomcat Manager is not set up. Add its URL in Settings › Tomcat.');
  const url = new URL(`${mgr.url.replace(/\/+$/, '')}/${command}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (mgr.username || mgr.password) {
    headers.authorization = `Basic ${Buffer.from(`${mgr.username}:${mgr.password}`, 'utf8').toString('base64')}`;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
  } catch (err) {
    throw new TomcatError(describeNetworkError(err, mgr.url), 502);
  }
  const body = await res.text().catch(() => '');
  if (res.status === 401) {
    throw new TomcatError(
      'Tomcat refused the Manager user name or password. Check them in Settings › Tomcat; the user needs the manager-script role in tomcat-users.xml.',
      502,
    );
  }
  if (res.status === 403) {
    throw new TomcatError(
      'Tomcat denied access to the Manager. The user needs the manager-script role (manager-gui is not enough for the text interface), and the Manager only accepts connections from localhost by default.',
      502,
    );
  }
  if (res.status === 404) throw new TomcatError(`No Tomcat Manager at ${mgr.url}. The URL usually ends in /manager/text, and the manager webapp must be deployed.`, 502);
  if (res.status >= 300 && res.status < 400) {
    throw new TomcatError(`The Manager URL redirects (HTTP ${res.status}). Use the text interface, e.g. http://localhost:8080/manager/text.`, 502);
  }
  if (!res.ok) throw new TomcatError(`The Tomcat Manager answered HTTP ${res.status}.`, 502);
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  if (first.startsWith('OK')) return body.replace(/^OK\s*-\s*/, '');
  if (first.startsWith('FAIL')) throw new TomcatError(`Tomcat: ${first.replace(/^FAIL\s*-\s*/, '')}`, 409);
  throw new TomcatError(`Unexpected answer from ${mgr.url}. Is this the text interface (…/manager/text), not the HTML one?`, 502);
}

/**
 * Parses the list command's lines, "path:state:sessions:name". The name can contain colons on
 * Windows (a docBase outside webapps, "C:\apps\shop"), so only the first three are separators.
 */
export function parseList(text: string): ManagerApp[] {
  const apps: ManagerApp[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\/[^:]*):(running|stopped):(\d+|):(.*)$/.exec(line.trim());
    if (!m) continue;
    const docBase = m[4].trim();
    const version = versionOf(docBase.split(/[\\/]/).pop()!.replace(/\.war$/i, ''));
    apps.push({ path: m[1], state: m[2] as ManagerApp['state'], sessions: m[3] ? Number(m[3]) : null, docBase, name: nameFromPath(m[1], version) });
  }
  return apps;
}

/** The reverse of contextPath: "/api/v2" with version 3 is "api#v2##3". */
export function nameFromPath(path: string, version: string | null = null): string {
  const base = path === '/' || path === '' ? 'ROOT' : path.replace(/^\//, '').replace(/\//g, '#');
  return version ? `${base}##${version}` : base;
}

export async function managerList(mgr: ManagerSettings, fetchImpl: Fetch = fetch): Promise<ManagerApp[]> {
  return parseList(await managerCommand(mgr, 'list', {}, fetchImpl));
}

/** The parameters that address one webapp: its context path, and its version for "name##version". */
export function appParams(name: string): Record<string, string> {
  const params: Record<string, string> = { path: contextPath(name) };
  const version = versionOf(name);
  if (version) params.version = version;
  return params;
}

/** Where webapps are served, from the Manager URL: http://localhost:8080/manager/text gives http://localhost:8080. */
export function managerOrigin(url: string): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}
