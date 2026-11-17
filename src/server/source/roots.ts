import { promises as fs } from 'node:fs';
import { basename, dirname, join, parse } from 'node:path';
import { expandWatchPattern, findWars } from '../tomcat/warwatch';
import { stripVersion } from '../tomcat/webapps';

/**
 * Finds the projects whose source "Go to source" opens. The WAR watch folders already say where
 * the owner builds (C:/dev/shop/target); the project is a folder or two above, where the build
 * file is. Folders listed under editor.sourceDirs are taken as they are.
 */

/** Files that make a folder a project (or a module of one). */
export const BUILD_FILES = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'];
/** How far above a WAR watch folder a project root may be. */
export const MAX_UP = 4;

export interface ProjectRoot {
  root: string;
  /** Where it came from: the WAR watch entries that led to it, or "Source folders". */
  from: string[];
  /** Names a webapp built here could be deployed as: the WARs' names and the folder names on the way up. */
  names: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hasBuildFile(dir: string): Promise<boolean> {
  for (const f of BUILD_FILES) if (await exists(join(dir, f))) return true;
  return false;
}

/**
 * The project a build folder belongs to: walking up from `start` (itself included, at most
 * MAX_UP levels above it), the outermost folder with a build file, so a module's target folder
 * leads to the whole multi-module build. The walk stops at a folder holding .git, the top of a
 * repository, and at the drive root, which is never a project.
 */
export async function findProjectRoot(start: string, maxUp = MAX_UP): Promise<string | null> {
  let found: string | null = null;
  let dir = start;
  for (let i = 0; i <= maxUp; i++) {
    if (dir === parse(dir).root) break;
    if (await hasBuildFile(dir)) found = dir;
    if (await exists(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return found;
}

/**
 * Folders to start looking for a project from, for one WAR watch entry. A WAR file or WAR pattern
 * means its folder. The build folder itself is deleted by "mvn clean", so when its name has no *
 * the folders above it count too, as long as they hold a build file.
 */
async function startFolders(pattern: string): Promise<string[]> {
  const out = new Set<string>();
  const { paths } = await expandWatchPattern(pattern);
  for (const p of paths) {
    const st = await fs.stat(p).catch(() => null);
    if (st?.isDirectory()) out.add(p);
    else if (st?.isFile()) out.add(dirname(p));
  }
  const last = basename(pattern);
  const parent = dirname(pattern);
  if (!/[*?]/.test(last) && parent !== pattern) {
    const up = await expandWatchPattern(parent);
    for (const p of up.paths) if (await hasBuildFile(p)) out.add(p);
  }
  return [...out];
}

/** "shop-1.2.0.war" can be deployed as shop-1.2.0 or shop. */
function warNames(file: string): string[] {
  const base = basename(file).replace(/\.war$/i, '');
  return [base, stripVersion(base)];
}

/**
 * The projects behind the WAR watch entries plus the extra source folders, each root once. A
 * source folder without a build file still counts: it may be a plain folder of sources.
 */
export async function findProjects(warWatch: string[], sourceDirs: string[]): Promise<{ projects: ProjectRoot[]; problems: string[] }> {
  const byRoot = new Map<string, ProjectRoot>();
  const problems: string[] = [];
  const add = (root: string, from: string, names: string[]) => {
    const p = byRoot.get(root) ?? { root, from: [], names: [] };
    if (!p.from.includes(from)) p.from.push(from);
    for (const n of names) if (n && !p.names.includes(n.toLowerCase())) p.names.push(n.toLowerCase());
    byRoot.set(root, p);
  };
  for (const pattern of warWatch) {
    const starts = await startFolders(pattern);
    const wars = (await findWars(pattern)).files;
    let any = false;
    for (const start of starts) {
      const root = await findProjectRoot(start);
      if (!root) continue;
      any = true;
      // Folder names between the build folder and the root: the module and project names.
      const names: string[] = [];
      for (let d = start; d.length >= root.length; d = dirname(d)) {
        names.push(basename(d));
        if (d === root || dirname(d) === d) break;
      }
      const here = wars.filter((w) => w.startsWith(start));
      add(root, pattern, [...names.filter((n) => !/^(target|build|out|libs)$/i.test(n)), ...here.flatMap(warNames)]);
    }
    if (!any) problems.push(`No project (pom.xml, build.gradle or settings.gradle) found above ${pattern}`);
  }
  for (const dir of sourceDirs) {
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) {
      problems.push(`Folder not found: ${dir}`);
      continue;
    }
    add(dir, 'Source folders', [basename(dir)]);
  }
  // A folder inside another one found is already covered by it; its names still count.
  const roots = [...byRoot.values()];
  const outer = roots.filter((p) => !roots.some((q) => isInside(p.root, q.root)));
  for (const p of roots) {
    const host = outer.find((q) => isInside(p.root, q.root));
    if (host) for (const from of p.from) add(host.root, from, p.names);
  }
  return { projects: outer, problems };
}

/** `child` is a folder below `parent` (not the same folder). */
export function isInside(child: string, parent: string): boolean {
  return child !== parent && child.startsWith(parent) && /[\\/]/.test(child.charAt(parent.length));
}
