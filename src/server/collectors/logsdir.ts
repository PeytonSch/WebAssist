import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { matchesPattern, type TailSource } from './tail';

/**
 * Following a whole Tomcat logs folder (tomcat.logsDir). Access logs are told apart by name;
 * everything else is an application log. Files the user also listed by hand under appLogs or
 * accessLogs are left to that list, so no file is followed twice or with the wrong parser.
 */

export type LogKind = 'app' | 'access';

// Tomcat's AccessLogValve writes localhost_access_log.<date>.txt; other setups use access.log.
const ACCESS_NAME = /access[_.-]?log/i;
// Compressed or archived rotations, JUL lock files and other files that are not text logs.
const NOT_A_LOG = /\.(?:gz|zip|bz2|xz|zst|z|7z|rar|tar|tgz|lz4|lck|pid|hprof|jar|war|swp)$/i;

/** How a file in the logs folder is read, or null when it is not followed at all. */
export function classifyLogFile(file: string): LogKind | null {
  const name = basename(file);
  if (name.startsWith('.') || NOT_A_LOG.test(name)) return null;
  return ACCESS_NAME.test(name) ? 'access' : 'app';
}

/** Files older than this are followed from their end even when reading logs from the start. */
const FOLDER_HISTORY_MS = 24 * 60 * 60_000;

/** The tail sources that follow every application log, or every access log, in the folder. */
export function folderSource(dir: string, kind: LogKind, appLogs: string[], accessLogs: string[]): TailSource {
  const listed = [...appLogs, ...accessLogs];
  return {
    pattern: join(dir, '*'),
    label: `${join(dir, '*')} (every ${kind === 'access' ? 'access' : 'application'} log in the logs folder)`,
    accept: (file) => classifyLogFile(file) === kind && !listed.some((p) => matchesPattern(p, file)),
    historyMaxAgeMs: FOLDER_HISTORY_MS,
  };
}

export interface FolderScan {
  dir: string;
  app: { path: string; bytes: number; modified: string }[];
  access: { path: string; bytes: number; modified: string }[];
  /** Files left out: archives, lock files, and logs already listed by hand. */
  skipped: number;
  problem: string | null;
}

/** What following the folder would pick up right now, for the settings screen. Newest first. */
export async function scanLogsFolder(dir: string, appLogs: string[], accessLogs: string[]): Promise<FolderScan> {
  const out: FolderScan = { dir, app: [], access: [], skipped: 0, problem: null };
  let names: string[];
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) return { ...out, problem: `Not a folder: ${dir}` };
    names = await fs.readdir(dir);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { ...out, problem: `Folder not found: ${dir}` };
    if (err?.code === 'EACCES' || err?.code === 'EPERM') return { ...out, problem: `No permission to read ${dir}` };
    return { ...out, problem: err?.message ?? String(err) };
  }
  const listed = [...appLogs, ...accessLogs];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = await fs.stat(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const kind = classifyLogFile(path);
    if (!kind || listed.some((p) => matchesPattern(p, path))) {
      out.skipped++;
      continue;
    }
    out[kind].push({ path, bytes: st.size, modified: st.mtime.toISOString() });
  }
  const newestFirst = (a: { modified: string }, b: { modified: string }) => (a.modified < b.modified ? 1 : -1);
  out.app.sort(newestFirst);
  out.access.sort(newestFirst);
  return out;
}
