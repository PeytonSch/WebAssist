import { existsSync, statSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { configFromRaw, readRawConfig, resolvePaths, type Config, type EditableConfig } from '../config';
import { samePath, tomcatVersion, type HostedInfo } from './info';

/**
 * Settings worked out from where the webapp is deployed. Running inside Tomcat, the hub knows
 * the Tomcat it would otherwise have to be pointed at: its webapps and logs folders, its install
 * folder and its Java. Settings the user has not set are filled in from these, and the Settings
 * screen shows them as ordinary values, marked as detected, that can be changed like any other.
 */
export interface DetectedSetting {
  /** Dotted key, e.g. "tomcat.webappsDir". */
  path: string;
  value: string | boolean;
  /** Where the value comes from, for the hint under the setting. */
  why: string;
}

/** The parts of the machine detection looks at, so tests can stand in for them. */
export interface DetectMachine {
  platform: NodeJS.Platform;
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

export function thisMachine(): DetectMachine {
  return { platform: process.platform, isDir: (p) => !!stat(p)?.isDirectory(), isFile: (p) => !!stat(p)?.isFile() };
}

const pathFor = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
const trimEnd = (p: string) => (p.length > 3 ? p.replace(/[\\/]+$/, '') : p);

/** Settings paths are written with forward slashes on every platform, as the setup guide does. */
const shown = (p: string, platform: NodeJS.Platform) => (platform === 'win32' ? p.replace(/\\/g, '/') : p);

function within(child: string, parent: string, platform: NodeJS.Platform): boolean {
  if (!parent) return false;
  const rel = pathFor(platform).relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !pathFor(platform).isAbsolute(rel);
}

/**
 * The folder Tomcat deploys webapps from, judged by where it put this one. Normally the parent
 * of the unpacked webapp, which is CATALINA_BASE/webapps or a Host's own appBase. When the
 * webapp lives somewhere else entirely (a context file pointing at a build folder, or Tomcat
 * running it from the WAR without unpacking), that parent says nothing, and CATALINA_BASE/webapps
 * is used if it exists.
 */
export function deployFolder(info: HostedInfo, m: DetectMachine = thisMachine()): { dir: string; why: string } | null {
  const p = pathFor(m.platform);
  const baseWebapps = info.catalinaBase ? p.join(info.catalinaBase, 'webapps') : '';
  if (info.webappDir) {
    const dir = trimEnd(info.webappDir);
    const parent = p.dirname(dir);
    const deployedHere =
      samePath(parent, baseWebapps, m.platform) ||
      within(parent, info.catalinaBase, m.platform) ||
      m.isFile(p.join(parent, `${p.basename(dir)}.war`));
    if (parent !== dir && deployedHere) return { dir: parent, why: 'the folder Tomcat deployed Debug Hub in' };
  }
  if (baseWebapps && m.isDir(baseWebapps)) return { dir: baseWebapps, why: 'webapps in the Tomcat Debug Hub runs in (CATALINA_BASE)' };
  return null;
}

/** Everything that can be told reliably from the Tomcat the hub runs in. */
export function detectSettings(info: HostedInfo, m: DetectMachine = thisMachine()): DetectedSetting[] {
  const p = pathFor(m.platform);
  const out: DetectedSetting[] = [];
  const add = (path: string, value: string | boolean, why: string) => out.push({ path, value: typeof value === 'string' ? shown(value, m.platform) : value, why });
  const tomcat = info.serverInfo || 'Tomcat';

  const webapps = deployFolder(info, m);
  if (webapps) {
    add('tomcat.webappsDir', webapps.dir, webapps.why);
    // Next to webapps, where Tomcat does not look. It is only created by the first Disable.
    add('tomcat.disabledDir', p.join(p.dirname(webapps.dir), 'webapps-disabled'), 'next to the webapps folder, where Tomcat does not deploy from');
  }
  const logs = info.catalinaBase ? p.join(info.catalinaBase, 'logs') : '';
  if (logs && m.isDir(logs)) {
    add('tomcat.logsDir', logs, `the logs folder of the Tomcat Debug Hub runs in (CATALINA_BASE)`);
    add('tomcat.enabled', true, 'Debug Hub runs inside Tomcat, so its logs are followed');
  }
  if (info.catalinaHome && m.isDir(p.join(info.catalinaHome, 'bin'))) {
    add('tomcat.home', info.catalinaHome, `where ${tomcat} is installed (CATALINA_HOME)`);
  }
  if (info.javaHome && m.isFile(p.join(info.javaHome, 'bin', m.platform === 'win32' ? 'java.exe' : 'java'))) {
    add('tomcat.javaHome', info.javaHome, 'the Java this Tomcat is running on');
  }
  // %D in the access log is milliseconds up to Tomcat 9 and microseconds from Tomcat 10.
  const { major } = tomcatVersion(info.serverInfo);
  if (major !== null && major >= 10) add('tomcat.accessDurationUnit', 'us', `${tomcat} writes access log durations in microseconds`);
  return out;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function getAt(obj: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

function setAt(obj: Record<string, any>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

/**
 * Fills detected values into a config as written in the file, for the keys the file does not
 * have. A key that is there is the user's, also when it is empty: clearing a detected value in
 * Settings and saving keeps it cleared. Returns the keys that were filled.
 */
export function fillDetected(raw: Record<string, unknown>, detected: DetectedSetting[]): string[] {
  const filled: string[] = [];
  for (const d of detected) {
    if (getAt(raw, d.path) !== undefined) continue;
    setAt(raw, d.path, d.value);
    filled.push(d.path);
  }
  return filled;
}

function rawOrEmpty(file: string): { raw: Record<string, unknown>; error: string | null } {
  if (!existsSync(file)) return { raw: {}, error: null };
  try {
    return { raw: readRawConfig(file), error: null };
  } catch (err) {
    return { raw: {}, error: (err as Error).message };
  }
}

/** The config the hosted hub runs with: the file (if any), detected values where it is silent, then the defaults. */
export function loadHostedConfig(file: string, info: HostedInfo, m: DetectMachine = thisMachine()): { config: Config; error: string | null; filled: string[] } {
  const { raw, error } = rawOrEmpty(file);
  const filled = fillDetected(raw, detectSettings(info, m));
  return { config: resolvePaths(configFromRaw(raw), dirname(file)), error, filled };
}

export interface HostedEditable extends EditableConfig {
  /** Detected values by setting, for the "detected" hints in Settings. */
  detected: Record<string, { value: string | boolean; why: string }>;
}

/** What the Settings screen edits when hosted: as editableConfig, with detected values filled in. */
export function hostedEditable(file: string, info: HostedInfo, m: DetectMachine = thisMachine()): HostedEditable {
  const { raw, error } = rawOrEmpty(file);
  const found = detectSettings(info, m);
  fillDetected(raw, found);
  const detected: HostedEditable['detected'] = {};
  for (const d of found) detected[d.path] = { value: d.value, why: d.why };
  return { file, config: configFromRaw(raw), defaults: configFromRaw({}), error, detected };
}
