import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Looks in the usual places for what the setup guide asks about (src/ui/setupguide.ts): Tomcat
 * installs and the run folders IntelliJ makes for them, Postgres server logs, JDKs, and project
 * folders with a built WAR. Only names, no file contents beyond a version line; nothing is
 * changed. Everything found is a suggestion the user picks from.
 */

export interface TomcatFound {
  /** CATALINA_HOME: bin/ and lib/. */
  home: string | null;
  /** CATALINA_BASE: conf/, logs/, webapps/. Often the same folder as home. */
  base: string;
  logs: string | null;
  webapps: string | null;
  /** e.g. "9.0.85". */
  version: string | null;
  major: number | null;
  /** Where it was found, in words: "CATALINA_HOME", "IntelliJ IDEA run folder", "installed". */
  from: string;
}

export interface PostgresLogFound {
  /** What to follow, e.g. C:/Program Files/PostgreSQL/16/data/log/postgresql-*.log */
  pattern: string;
  dir: string;
  version: string | null;
  /** Set when the folder exists but could not be read, with why. */
  note: string | null;
}

export interface JavaFound {
  dir: string;
  version: string | null;
  from: string;
}

export interface WarFolderFound {
  dir: string;
  wars: string[];
}

export interface Detected {
  tomcat: TomcatFound[];
  postgresLogs: PostgresLogFound[];
  javaHomes: JavaFound[];
  warFolders: WarFolderFound[];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Extra folders to look for projects in (tests). */
  projectRoots?: string[];
}

const MAX = 12;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const list = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const norm = (p: string) => p.replace(/\\/g, '/');

/** Expands `*` in any segment: C:/Program Files/Apache Software Foundation/Tomcat*. */
export function expand(pattern: string): string[] {
  const parts = norm(pattern).split('/');
  let found = [parts[0] === '' ? '/' : /^[a-z]:$/i.test(parts[0]) ? `${parts[0]}/` : parts[0]];
  for (const seg of parts.slice(1)) {
    if (!seg) continue;
    const next: string[] = [];
    for (const base of found) {
      if (!seg.includes('*')) {
        const p = join(base, seg);
        if (existsSync(p)) next.push(p);
        continue;
      }
      const re = new RegExp(`^${seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
      for (const name of list(base).sort()) if (re.test(name)) next.push(join(base, name));
    }
    found = next.slice(0, 200);
    if (!found.length) break;
  }
  return found.map(norm);
}

const firstLine = (file: string, re: RegExp): string | null => {
  try {
    return re.exec(readFileSync(file, 'utf8').slice(0, 4000))?.[1] ?? null;
  } catch {
    return null;
  }
};

function tomcatVersion(home: string | null, base: string): string | null {
  for (const dir of [home, base]) {
    if (!dir) continue;
    const v = firstLine(join(dir, 'RELEASE-NOTES'), /Apache Tomcat Version (\d+(?:\.\d+)*)/i)
      ?? /tomcat[-_ ]?(\d+(?:\.\d+)*)/i.exec(basename(dir))?.[1]
      ?? null;
    if (v) return v;
  }
  return null;
}

const looksLikeHome = (d: string) => existsSync(join(d, 'bin', 'catalina.sh')) || existsSync(join(d, 'bin', 'catalina.bat')) || existsSync(join(d, 'lib', 'catalina.jar'));
const looksLikeBase = (d: string) => existsSync(join(d, 'conf', 'server.xml'));

function tomcatAt(dir: string, from: string, home: string | null = null): TomcatFound | null {
  const d = norm(dir);
  if (!isDir(d)) return null;
  const h = home ?? (looksLikeHome(d) ? d : null);
  if (!h && !looksLikeBase(d)) return null;
  const version = tomcatVersion(h, d);
  const major = version ? Number(version.split('.')[0]) : null;
  return {
    home: h,
    base: d,
    logs: isDir(join(d, 'logs')) ? norm(join(d, 'logs')) : null,
    webapps: isDir(join(d, 'webapps')) ? norm(join(d, 'webapps')) : null,
    version,
    major: Number.isFinite(major) ? major : null,
    from,
  };
}

function findTomcats(o: Required<Omit<DetectOptions, 'projectRoots'>>): TomcatFound[] {
  const out: TomcatFound[] = [];
  const seen = new Set<string>();
  const add = (t: TomcatFound | null) => {
    if (!t || seen.has(t.base.toLowerCase())) return;
    seen.add(t.base.toLowerCase());
    out.push(t);
  };
  const home = o.env.CATALINA_HOME && isDir(o.env.CATALINA_HOME) ? norm(o.env.CATALINA_HOME) : null;
  if (o.env.CATALINA_BASE) add(tomcatAt(o.env.CATALINA_BASE, 'CATALINA_BASE', home));
  if (home) add(tomcatAt(home, 'CATALINA_HOME'));

  // Run folders IntelliJ IDEA makes (a CATALINA_BASE per run configuration), newest first: when
  // Tomcat runs from IntelliJ, its logs are written there, not in the Tomcat install.
  const jb = o.platform === 'win32'
    ? [join(o.env.LOCALAPPDATA ?? join(o.home, 'AppData', 'Local'), 'JetBrains', '*', 'tomcat', '*')]
    : o.platform === 'darwin'
      ? [join(o.home, 'Library', 'Caches', 'JetBrains', '*', 'tomcat', '*')]
      : [join(o.home, '.cache', 'JetBrains', '*', 'tomcat', '*')];
  const runs = jb.flatMap(expand).filter(looksLikeBase);
  runs.sort((a, b) => mtime(join(b, 'logs')) - mtime(join(a, 'logs')));
  for (const r of runs.slice(0, 4)) {
    const ide = basename(dirname(dirname(r)));
    add(tomcatAt(r, `IntelliJ IDEA run folder (${ide})`, null));
  }

  const patterns = o.platform === 'win32'
    ? [
        'C:/Program Files/Apache Software Foundation/Tomcat*',
        'C:/Program Files (x86)/Apache Software Foundation/Tomcat*',
        'C:/apache-tomcat*', 'C:/tomcat*', 'C:/dev/apache-tomcat*', 'C:/dev/tomcat*', 'C:/tools/apache-tomcat*', 'C:/opt/apache-tomcat*',
        'D:/apache-tomcat*', 'D:/tomcat*', 'D:/dev/apache-tomcat*',
        join(o.home, 'apache-tomcat*'), join(o.home, 'tomcat*'), join(o.home, 'dev', 'apache-tomcat*'), join(o.home, 'Downloads', 'apache-tomcat*'),
      ]
    : [
        '/opt/tomcat*', '/opt/apache-tomcat*', '/usr/local/tomcat*', '/usr/local/apache-tomcat*', '/usr/share/tomcat*', '/var/lib/tomcat*',
        '/Library/Tomcat*', '/opt/homebrew/opt/tomcat*/libexec', '/usr/local/opt/tomcat*/libexec',
        join(o.home, 'apache-tomcat*'), join(o.home, 'tomcat*'), join(o.home, 'dev', 'apache-tomcat*'), join(o.home, 'Downloads', 'apache-tomcat*'),
      ];
  for (const p of patterns) for (const d of expand(p)) add(tomcatAt(d, 'installed'));
  return out.slice(0, MAX);
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function findPostgresLogs(o: Required<Omit<DetectOptions, 'projectRoots'>>): PostgresLogFound[] {
  const out: PostgresLogFound[] = [];
  const seen = new Set<string>();
  const add = (dir: string, version: string | null) => {
    const d = norm(dir);
    if (seen.has(d.toLowerCase())) return;
    seen.add(d.toLowerCase());
    let names: string[] | null = null;
    let note: string | null = null;
    try {
      names = readdirSync(d);
    } catch (err) {
      note = (err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EPERM'
        ? 'This folder could not be read: Postgres keeps it private. Give your user read access to it, or set log_directory to a folder you can read.'
        : null;
      if (!note) return;
    }
    const logs = (names ?? []).filter((n) => /\.(log|csv)$/i.test(n));
    if (names && !logs.length) return;
    const stem = logs.some((n) => /^postgresql-/.test(n)) ? 'postgresql-*.log' : logs.some((n) => /^postgresql@/.test(n)) ? 'postgresql@*.log' : '*.log';
    out.push({ pattern: `${d}/${stem}`, dir: d, version, note });
  };
  const ver = (p: string) => /(?:PostgreSQL[/\\]|postgresql@|pgsql[/\\]|postgresql[/\\]|var-)(\d+(?:\.\d+)?)/i.exec(p)?.[1] ?? null;
  if (o.platform === 'win32') {
    for (const v of expand('C:/Program Files/PostgreSQL/*')) {
      const data = join(v, 'data');
      if (!existsSync(data)) continue;
      const log = join(data, 'log');
      // The data folder is usually readable only by the Postgres service account.
      if (existsSync(log) || !canList(data)) add(existsSync(log) ? log : data, basename(v));
    }
    if (o.env.PGDATA) add(join(o.env.PGDATA, 'log'), null);
  } else {
    const dirs = [
      ...(o.env.PGDATA ? [join(o.env.PGDATA, 'log')] : []),
      ...expand('/var/log/postgresql'),
      ...expand('/var/lib/pgsql/*/data/log'), ...expand('/var/lib/pgsql/data/log'),
      ...expand('/var/lib/postgresql/*/main/log'),
      ...expand('/usr/local/var/postgres*/log'), ...expand('/opt/homebrew/var/postgres*/log'),
      ...expand('/opt/homebrew/var/log'), ...expand('/usr/local/var/log'),
      ...expand(join(o.home, 'Library', 'Application Support', 'Postgres', 'var-*', 'log')),
    ];
    for (const d of dirs) if (existsSync(d)) add(d, ver(d));
  }
  return out.slice(0, MAX);
}

const canList = (d: string) => {
  try {
    readdirSync(d);
    return true;
  } catch {
    return false;
  }
};

function findJava(o: Required<Omit<DetectOptions, 'projectRoots'>>): JavaFound[] {
  const out: JavaFound[] = [];
  const seen = new Set<string>();
  const exe = o.platform === 'win32' ? 'java.exe' : 'java';
  const add = (dir: string, from: string) => {
    const d = norm(dir);
    if (seen.has(d.toLowerCase()) || !existsSync(join(d, 'bin', exe))) return;
    seen.add(d.toLowerCase());
    out.push({ dir: d, version: firstLine(join(d, 'release'), /JAVA_VERSION="([^"]+)"/), from });
  };
  if (o.env.JAVA_HOME) add(o.env.JAVA_HOME, 'JAVA_HOME');
  const patterns = o.platform === 'win32'
    ? ['C:/Program Files/Java/*', 'C:/Program Files/Eclipse Adoptium/*', 'C:/Program Files/Microsoft/jdk*', 'C:/Program Files/Zulu/*', 'C:/Program Files/Amazon Corretto/*', 'C:/Program Files/BellSoft/*', join(o.home, '.jdks', '*')]
    : o.platform === 'darwin'
      ? ['/Library/Java/JavaVirtualMachines/*/Contents/Home', join(o.home, 'Library', 'Java', 'JavaVirtualMachines', '*', 'Contents', 'Home'), join(o.home, '.jdks', '*'), join(o.home, '.sdkman', 'candidates', 'java', '*')]
      : ['/usr/lib/jvm/*', join(o.home, '.jdks', '*'), join(o.home, '.sdkman', 'candidates', 'java', '*')];
  for (const p of patterns) for (const d of expand(p)) add(d, d.includes('.jdks') ? 'downloaded by IntelliJ' : 'installed');
  return out.slice(0, MAX);
}

/** Folders where a project's build leaves a WAR: <root>/<project>/target, build/libs, a module's. */
function findWarFolders(o: Required<DetectOptions>): WarFolderFound[] {
  const roots = [
    ...o.projectRoots,
    ...['IdeaProjects', 'dev', 'projects', 'workspace', 'src', 'code', 'git', 'repos', join('source', 'repos')].map((r) => join(o.home, r)),
    ...(o.platform === 'win32' ? ['C:/dev', 'C:/projects', 'C:/workspace', 'C:/src', 'C:/git', 'D:/dev', 'D:/projects'] : []),
  ].filter(isDir);
  const out: WarFolderFound[] = [];
  const seen = new Set<string>();
  const look = (dir: string) => {
    const d = norm(dir);
    if (seen.has(d.toLowerCase())) return;
    seen.add(d.toLowerCase());
    const wars = list(d).filter((n) => /\.war$/i.test(n));
    if (wars.length) out.push({ dir: d, wars: wars.slice(0, 5) });
  };
  for (const root of roots) {
    for (const project of list(root).slice(0, 200)) {
      const p = join(root, project);
      if (project.startsWith('.') || !isDir(p)) continue;
      for (const build of ['target', join('build', 'libs')]) look(join(p, build));
      // One level of modules: shop/shop-web/target.
      for (const mod of list(p).slice(0, 60)) {
        if (mod.startsWith('.') || mod === 'node_modules' || mod === 'target' || mod === 'build') continue;
        for (const build of ['target', join('build', 'libs')]) {
          const b = join(p, mod, build);
          if (isDir(b)) look(b);
        }
      }
      if (out.length >= MAX) return out;
    }
  }
  return out;
}

export function detectSetup(opts: DetectOptions = {}): Detected {
  const o = { env: opts.env ?? process.env, platform: opts.platform ?? process.platform, home: opts.home ?? homedir(), projectRoots: opts.projectRoots ?? [] };
  const safe = <T>(fn: () => T[]): T[] => {
    try {
      return fn();
    } catch {
      return [];
    }
  };
  return {
    tomcat: safe(() => findTomcats(o)),
    postgresLogs: safe(() => findPostgresLogs(o)),
    javaHomes: safe(() => findJava(o)),
    warFolders: safe(() => findWarFolders(o)),
  };
}
