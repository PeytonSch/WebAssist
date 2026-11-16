import { promises as fs } from 'node:fs';
import { basename } from 'node:path';

/**
 * Works out which webapp a Tomcat log entry or access-log request belongs to, so the timeline
 * can label it and filter by it.
 *
 * Sources, most reliable first: the log file's own name (myapp.2026-11-16.log), Tomcat's
 * context markers in the message ("in context with path [/myapp]"), and for access logs the
 * request's context path. Names listed in the webapps folders, or seen in a log file name or
 * a deployment message, make the last two dependable: a bracketed "[/x]" or a path's first
 * segment is only taken as a webapp when x is known to be one.
 */

/** Log files Tomcat itself (or a generic setup) writes; their names do not name a webapp. */
const GENERIC_LOG = /^(?:catalina|localhost|manager|host-manager|commons-daemon|tomcat\d*(?:-std(?:out|err))?|std(?:out|err)|console|gc|jvm|spring|application|app|server|.*access[_.-]?log)$/i;

/** "/" and "" are the ROOT webapp; "/shop/admin" is deployed as shop#admin. */
export function contextToName(contextPath: string): string {
  const trimmed = contextPath.replace(/^\/+|\/+$/g, '');
  return trimmed ? trimmed.replace(/\//g, '#') : 'ROOT';
}

/** The inverse: ROOT is "/", shop#admin##2 (a parallel-deployment version) is "/shop/admin". */
export function nameToContext(name: string): string {
  const base = name.replace(/##.*$/, '');
  return base === 'ROOT' ? '/' : `/${base.replace(/#/g, '/')}`;
}

/** A log file's name without dates, rotation numbers and extensions: myapp.2026-11-16.log → myapp. */
export function logBaseName(file: string): string {
  let s = basename(file);
  // Everything from a date stamp on: myapp.2026-11-16.log, myapp.log.2026-11-16, myapp-20261116.1.log.
  s = s.replace(/[._-]?\d{4}-?\d\d-?\d\d(?!\d).*$/, '');
  // Extensions and rotation indexes in any order: myapp.log.1, myapp.0.log, myapp.out.
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(/\.(?:log|txt|out|err|json|\d+)$/i, '');
  }
  return s;
}

// Tomcat's own wording when it reports on a webapp. Group 1 is a context path.
const CONTEXT_MARKERS = [
  /\bcontext with (?:path|name) \[([^\]]*)\]/i, // "… in context with path [/shop] threw exception"
  /\bcontext \[(\/[^\]]*|)\]/i, // "Context [/shop] startup failed", "Undeploying context [/shop]"
  /\[localhost\]\.\[(\/[^\]]*|)\]/, // a logger name: ContainerBase.[Catalina].[localhost].[/shop]
  /ApplicationContext\.log \[(\/[^\]]*|)\]/,
];
// "The web application [shop] appears to have started a thread …" (Tomcat 7 wrote [/shop]).
const WEBAPP_MARKER = /\bweb application \[([^\]\\/]*|\/[^\]]*)\]/i;
// "Deploying web application directory [/opt/tomcat/webapps/shop]", "… archive [….war]".
const DEPLOY_MARKER = /\b(?:web application (?:directory|archive)|(?:deployment|configuration) descriptor) \[([^\]]+)\]/i;
// Any path into a webapps folder: …/webapps/shop/WEB-INF/…
const WEBAPPS_PATH = /[\\/]webapps[\\/]([^\\/\]\s"']+)/;
const BRACKETED = /\[\/?([^\]\s/]+)\]/g;

const stripArchive = (name: string) => name.replace(/\.(?:war|xml)$/i, '');

/** Webapp names that a message states outright, whether or not they are known. */
export function webappFromMessage(text: string): string | null {
  for (const re of CONTEXT_MARKERS) {
    const m = re.exec(text);
    if (m) return contextToName(m[1]);
  }
  const w = WEBAPP_MARKER.exec(text);
  if (w) return w[1].startsWith('/') || w[1] === '' ? contextToName(w[1]) : w[1];
  const d = DEPLOY_MARKER.exec(text);
  // Split by hand: a Windows path in a log read on another system still has backslashes.
  if (d) return stripArchive(d[1].replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '') || null;
  const p = WEBAPPS_PATH.exec(text);
  if (p) return stripArchive(p[1]);
  return null;
}

export class Webapps {
  /** Names from the webapps folders, replaced on every listing. */
  private listed = new Set<string>();
  /** Names seen in log file names and deployment messages. */
  private learned = new Set<string>();
  /** Context path → name, rebuilt when the names change. */
  private contexts: Map<string, string> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private dirs: string[] = []) {}

  names(): string[] {
    return [...new Set([...this.listed, ...this.learned])].sort();
  }

  /** Adds names known from elsewhere. Exposed for tests. */
  learn(name: string): void {
    if (!name || this.listed.has(name) || this.learned.has(name)) return;
    this.learned.add(name);
    this.contexts = null;
  }

  private contextMap(): Map<string, string> {
    if (!this.contexts) {
      this.contexts = new Map();
      for (const name of this.names()) this.contexts.set(nameToContext(name), name);
    }
    return this.contexts;
  }

  private known(name: string): string | null {
    const ctx = this.contextMap();
    return ctx.get(nameToContext(name)) ?? null;
  }

  /** Which webapp a log file belongs to by its name alone, or null for Tomcat's shared logs. */
  fromFile(file: string): string | null {
    const base = logBaseName(file);
    if (!base) return null;
    // A known name followed by a suffix (shop-debug.log, shop_sql.log) still belongs to it.
    let best: string | null = null;
    for (const name of this.names()) {
      const n = name.toLowerCase();
      const b = base.toLowerCase();
      if ((b === n || (b.startsWith(n) && /[-_.]/.test(b[n.length]))) && (!best || name.length > best.length)) best = name;
    }
    if (best) return best;
    return GENERIC_LOG.test(base) ? null : base;
  }

  /** The webapp for an application-log entry: the file's name, else what its first lines say. */
  forLog(file: string, head: string): string | null {
    const byFile = this.fromFile(file);
    if (byFile) {
      this.learn(byFile);
      return byFile;
    }
    const stated = webappFromMessage(head);
    if (stated) {
      this.learn(stated);
      return stated;
    }
    // A known name in brackets: "[/shop]" or "[shop]", as many app log patterns print it.
    for (const m of head.matchAll(BRACKETED)) {
      const name = this.known(m[1]);
      if (name) return name;
    }
    return null;
  }

  /** The webapp that served a request, by the longest known context path that prefixes it. */
  forPath(path: string): string | null {
    const ctx = this.contextMap();
    if (ctx.size === 0) return null;
    const segments = path.replace(/[?#].*$/, '').split('/').filter(Boolean);
    for (let n = Math.min(segments.length, 3); n > 0; n--) {
      const name = ctx.get(`/${segments.slice(0, n).join('/')}`);
      if (name) return name;
    }
    return ctx.get('/') ?? null;
  }

  /** Lists the webapps folders now and every few seconds, so newly deployed apps are known. */
  start(refreshMs = 15_000): void {
    if (this.timer || this.dirs.length === 0) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    const next = new Set<string>();
    for (const dir of this.dirs) for (const name of await listWebapps(dir)) next.add(name);
    const same = next.size === this.listed.size && [...next].every((n) => this.listed.has(n));
    if (same) return;
    this.listed = next;
    for (const n of next) this.learned.delete(n);
    this.contexts = null;
  }
}

/** Webapp names in a webapps folder: its directories and .war files (ROOT is the "/" app). */
export async function listWebapps(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) names.add(e.name);
    else if (e.isFile() && /\.war$/i.test(e.name)) names.add(e.name.slice(0, -4));
  }
  return [...names];
}
