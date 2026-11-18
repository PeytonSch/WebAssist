import { statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { LaunchWay, ScriptKind, TomcatLaunch } from '../../shared/tomcat';
import type { Config } from '../config';

/**
 * Starting Tomcat with its own scripts (bin/catalina run, bin/shutdown) when no start or stop
 * script is set. Works out CATALINA_HOME, CATALINA_BASE and JAVA_HOME from the settings and says
 * what is missing, because catalina.bat on its own only fails with a terse message.
 */

/** The parts of the machine this depends on, so tests can stand in for them. */
export interface LaunchMachine {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isDir: (path: string) => boolean;
  isFile: (path: string) => boolean;
}

const stat = (p: string) => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

export function thisLaunchMachine(): LaunchMachine {
  return {
    platform: process.platform,
    env: process.env,
    isDir: (p) => !!stat(p)?.isDirectory(),
    isFile: (p) => !!stat(p)?.isFile(),
  };
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);

/** Environment variable names are case-insensitive on Windows, and a plain object is not. */
function envKey(env: Record<string, string | undefined>, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return name in env ? name : undefined;
  return Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
}

function envVar(m: LaunchMachine, name: string): string | undefined {
  const key = envKey(m.env, name, m.platform);
  const v = key ? m.env[key] : undefined;
  return v?.trim() ? v : undefined;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const norm = (x: string) => p.resolve(x).replace(/[\\/]+$/, '');
  return platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * What starts and stops Tomcat: bin/catalina.bat, run as "catalina run" so Tomcat stays in the
 * foreground and its console output goes to the Tomcat page (startup.bat would open a window of
 * its own for it), and bin/shutdown.bat. .sh elsewhere.
 */
export function catalinaScript(home: string, kind: ScriptKind, platform: NodeJS.Platform = process.platform): string {
  const ext = platform === 'win32' ? 'bat' : 'sh';
  return pathFor(platform).join(home, 'bin', `${kind === 'start' ? 'catalina' : 'shutdown'}.${ext}`);
}

/** The words after catalinaScript: "run" to start. */
export const catalinaArgs = (kind: ScriptKind): string[] => (kind === 'start' ? ['run'] : []);

export interface TomcatHome {
  home: string | null;
  homeSource: 'settings' | 'webapps' | null;
  base: string | null;
  problem: string | null;
}

/**
 * CATALINA_HOME is the Tomcat folder setting, else the folder above webapps if it has bin/.
 * CATALINA_BASE is the folder above webapps when it has conf/: with a separate base (one Tomcat
 * install, several instances) that is the instance whose webapps the page manages.
 */
export function tomcatHome(t: Config['tomcat'], m: LaunchMachine): TomcatHome {
  const p = pathFor(m.platform);
  const above = t.webappsDir ? p.dirname(t.webappsDir) : null;
  const base = above && m.isDir(p.join(above, 'conf')) ? above : null;
  if (t.home) {
    const problem = m.isDir(p.join(t.home, 'bin')) ? null : `The Tomcat folder has no bin folder: ${t.home}. Choose the folder Tomcat is installed in (CATALINA_HOME).`;
    return { home: t.home, homeSource: 'settings', base, problem };
  }
  if (above && m.isDir(p.join(above, 'bin'))) return { home: above, homeSource: 'webapps', base, problem: null };
  return {
    home: null,
    homeSource: null,
    base,
    problem: t.webappsDir
      ? `The folder above webapps (${above}) has no bin folder, so it is not Tomcat’s own folder. Set the Tomcat folder (CATALINA_HOME).`
      : 'Set the Tomcat folder (CATALINA_HOME), or the webapps folder inside it.',
  };
}

/**
 * The environment Tomcat's own scripts run with: Debug Hub's, plus CATALINA_HOME, CATALINA_BASE
 * and JAVA_HOME. JRE_HOME is dropped when a Java folder is set, since Tomcat prefers JRE_HOME
 * over JAVA_HOME and an old one in the environment would win.
 */
export function tomcatEnv(
  base: Record<string, string | undefined>,
  vars: { home: string; base: string | null; javaHome: string },
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  const set = (name: string, value: string | null) => {
    const key = envKey(env, name, platform);
    if (key) delete env[key];
    if (value) env[name] = value;
  };
  // Windows reads backslashes; catalina.bat builds paths like %CATALINA_HOME%\bin\catalina.bat.
  const native = (p: string) => (platform === 'win32' ? p.replace(/\//g, '\\') : p);
  set('CATALINA_HOME', native(vars.home));
  if (vars.base) set('CATALINA_BASE', native(vars.base));
  if (vars.javaHome) {
    set('JAVA_HOME', native(vars.javaHome));
    set('JRE_HOME', null);
  }
  return env;
}

export interface LaunchPlan {
  info: TomcatLaunch;
  /** For Tomcat's own scripts: the environment to run them with. */
  env: Record<string, string> | null;
}

/** How Start and Stop will run, and what is missing for Tomcat's own scripts. */
export function launchPlan(t: Config['tomcat'], m: LaunchMachine = thisLaunchMachine()): LaunchPlan {
  const p = pathFor(m.platform);
  const where = tomcatHome(t, m);
  const problems: string[] = [];
  const warnings: string[] = [];
  const needOwn = !t.startScript || !t.stopScript;
  if (where.problem) problems.push(where.problem);

  const own = (kind: ScriptKind): string | null => {
    if (!where.home || where.problem) return null;
    const file = catalinaScript(where.home, kind, m.platform);
    if (m.isFile(file)) return file;
    problems.push(`Tomcat’s ${p.basename(file)} was not found in ${p.dirname(file)}.`);
    return null;
  };
  const way = (kind: ScriptKind): LaunchWay => {
    const script = kind === 'start' ? t.startScript : t.stopScript;
    if (script) return { how: 'script', path: script };
    const file = own(kind);
    if (!file) return { how: 'none', path: null };
    const args = catalinaArgs(kind);
    return args.length ? { how: 'tomcat', path: file, args } : { how: 'tomcat', path: file };
  };
  const start = way('start');
  const stop = way('stop');

  let javaHome: string | null = null;
  let javaSource: TomcatLaunch['javaSource'] = null;
  if (t.javaHome) {
    javaHome = t.javaHome;
    javaSource = 'settings';
    const java = p.join(t.javaHome, 'bin', m.platform === 'win32' ? 'java.exe' : 'java');
    if (!m.isFile(java)) warnings.push(`No ${p.join('bin', p.basename(java))} in the Java folder ${t.javaHome}. Choose the folder of a JDK or JRE (JAVA_HOME).`);
  } else {
    javaHome = envVar(m, 'JRE_HOME') ?? envVar(m, 'JAVA_HOME') ?? null;
    if (javaHome) javaSource = 'environment';
    else if (where.home) {
      // setenv.bat is Tomcat's place for JAVA_HOME; catalina.bat reads it from the base, then the home.
      const setenv = `setenv.${m.platform === 'win32' ? 'bat' : 'sh'}`;
      if ([where.base, where.home].some((d) => d && m.isFile(p.join(d, 'bin', setenv)))) javaSource = 'setenv';
    }
    const used = start.how === 'tomcat' || stop.how === 'tomcat';
    // catalina.sh finds java on the PATH; catalina.bat insists on JAVA_HOME or JRE_HOME.
    if (used && !javaSource && m.platform === 'win32') {
      warnings.push('Neither JAVA_HOME nor JRE_HOME is set for Debug Hub, so catalina.bat would stop with “Neither the JAVA_HOME nor the JRE_HOME environment variable is defined”. Set the Java folder in Settings.');
    }
  }

  const env =
    where.home && !where.problem && needOwn ? tomcatEnv(m.env, { home: where.home, base: where.base, javaHome: t.javaHome }, m.platform) : null;
  return {
    info: { start, stop, home: where.home, homeSource: where.homeSource, base: where.base, javaHome, javaSource, problems: needOwn ? problems : [], warnings: needOwn ? warnings : [] },
    env,
  };
}
