import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Updates for a copy run from a git checkout with `npm run app`: the way the owner runs Debug Hub
 * day to day ("git pull, then npm run app"), done for them. Installed copies update from GitHub
 * Releases instead (updater.ts); this only applies when the app is not packaged and sits in a
 * git repository.
 *
 * A check fetches origin/main and counts commits not in the checkout. Applying an update is left
 * to scripts/update-and-restart.mjs, started just before the app quits: on Windows a running
 * Electron keeps its own files locked, so `npm install` can only run once the app is gone.
 */

/** Set DEBUG_HUB_GIT_UPDATES=0 to turn git updates off for a run. */
export const gitUpdatesEnabled = () => process.env.DEBUG_HUB_GIT_UPDATES !== '0';
/** How often the running app looks for new commits; DEBUG_HUB_GIT_UPDATE_MINUTES overrides it. */
export const checkEveryMs = () => Math.max(0.1, Number(process.env.DEBUG_HUB_GIT_UPDATE_MINUTES) || 5) * 60_000;

export const GIT_REMOTE = 'origin';
export const GIT_BRANCH = 'main';
const FETCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 10_000;

export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  /** e.g. "3 hours ago". */
  when: string;
}

export type GitUpdateStatus =
  | { state: 'up-to-date'; head: string }
  | {
      state: 'available';
      head: string;
      /** origin/main: identifies this update, so "Later" is not asked again for it. */
      target: string;
      behind: number;
      /** Newest first, at most 15. */
      commits: GitCommit[];
      /** Set when the update cannot be applied automatically, with why. */
      blocked: string | null;
    }
  | { state: 'error'; message: string };

/** The repository a copy started with `npm run app` lives in, or null (an installed app). */
export function findRepo(fromDir: string): string | null {
  // dist/shell or dist/payload → the checkout.
  const root = resolve(fromDir, '..', '..');
  if (!existsSync(join(root, '.git')) || !existsSync(join(root, 'package.json'))) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg?.scripts?.app ? root : null;
  } catch {
    return null;
  }
}

export type GitRunner = (args: string[], timeoutMs?: number) => Promise<string>;

/** Runs git in `repo`. It never waits for a password: a fetch that needs one just fails. */
export function gitRunner(repo: string): GitRunner {
  return (args, timeoutMs = GIT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: repo,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' },
      }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          const why = code === 'ENOENT' ? 'git is not installed or not on PATH' : (stderr || err.message).trim().split('\n').pop();
          reject(new Error(`git ${args[0]}: ${why}`));
        } else resolve(stdout.trim());
      });
    });
}

/** Fetches origin/main and says whether the checkout is behind it, and whether it can catch up. */
export async function checkForGitUpdate(git: GitRunner, opts: { fetch?: boolean; fetchTimeoutMs?: number } = {}): Promise<GitUpdateStatus> {
  try {
    const remoteRef = `refs/remotes/${GIT_REMOTE}/${GIT_BRANCH}`;
    if (opts.fetch !== false) {
      await git(['fetch', '--quiet', '--no-tags', GIT_REMOTE, `+refs/heads/${GIT_BRANCH}:${remoteRef}`], opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS);
    }
    const head = await git(['rev-parse', 'HEAD']);
    const target = await git(['rev-parse', remoteRef]);
    const [behind, ahead] = (await git(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`])).split(/\s+/).map(Number);
    if (!behind) return { state: 'up-to-date', head };

    const log = await git(['log', '--no-merges', '-n', '15', '--format=%h%x09%an%x09%cr%x09%s', `HEAD..${remoteRef}`]);
    const commits = log ? log.split('\n').map((line) => {
      const [sha, author, when, ...subject] = line.split('\t');
      return { sha, author, when, subject: subject.join('\t') };
    }) : [];

    let blocked: string | null = null;
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch !== GIT_BRANCH) blocked = `The checkout is on ${branch === 'HEAD' ? 'a detached HEAD' : `branch ${branch}`}, not ${GIT_BRANCH}.`;
    else if (ahead) blocked = `The checkout has ${ahead} commit${ahead === 1 ? '' : 's'} that ${GIT_REMOTE}/${GIT_BRANCH} does not.`;
    else {
      const changed = await git(['status', '--porcelain', '--untracked-files=no']);
      if (changed) {
        // " M path": the runner trims output, so the first line may have lost its leading space.
        const files = changed.split('\n').map((l) => l.replace(/^\s*\S{1,2}\s+/, ''));
        blocked = `The checkout has uncommitted changes: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}.`;
      }
    }
    return { state: 'available', head, target, behind, commits, blocked };
  } catch (err) {
    return { state: 'error', message: (err as Error).message };
  }
}

/** The prompt's text for an available update. */
export function describeUpdate(s: Extract<GitUpdateStatus, { state: 'available' }>): { message: string; detail: string } {
  const n = `${s.behind} new commit${s.behind === 1 ? '' : 's'}`;
  const list = s.commits.map((c) => `• ${c.subject}  (${c.author}, ${c.when})`).join('\n');
  const more = s.behind > s.commits.length ? `\n…and ${s.behind - s.commits.length} more` : '';
  const how = s.blocked
    ? `\n\nIt cannot be updated automatically. ${s.blocked} Update by hand with git pull, then npm run app.`
    : `\n\nUpdating quits Debug Hub, runs git pull${' '}(and npm install if dependencies changed), then starts it again with npm run app.`;
  return { message: `A Debug Hub update is available: ${n} on ${GIT_REMOTE}/${GIT_BRANCH}`, detail: `${list}${more}${how}` };
}

// ── "Later", remembered ─────────────────────────────────

const stateFile = (userData: string) => join(userData, 'git-update.json');

/** The origin/main commit the user last said "Later" to; not asked again until main moves on. */
export function dismissedTarget(userData: string): string | null {
  try {
    return JSON.parse(readFileSync(stateFile(userData), 'utf8')).dismissed ?? null;
  } catch {
    return null;
  }
}

export function dismiss(userData: string, target: string): void {
  try {
    writeFileSync(stateFile(userData), JSON.stringify({ dismissed: target }) + '\n');
  } catch {
    /* only means being asked again */
  }
}

// ── Applying ────────────────────────────────────────────

/** What scripts/update-and-restart.mjs leaves behind, for the next start to report. */
export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string;
  /** Set when the pull or install failed; the old version was started again. */
  error: string | null;
  installed: boolean;
  at: string;
}

const resultFile = (userData: string) => join(userData, 'git-update-result.json');

/**
 * Starts the helper that waits for this process to exit, pulls, installs if needed and runs
 * `npm run app` again. Call app.quit() right after. It runs on the system's node (the one npm
 * uses), not on this Electron, whose files `npm install` may need to replace.
 */
export function startGitUpdate(repo: string, userData: string): void {
  mkdirSync(userData, { recursive: true });
  const log = openSync(join(userData, 'git-update.log'), 'a');
  const child = spawn('node', [
    join(repo, 'scripts', 'update-and-restart.mjs'),
    '--pid', String(process.pid),
    '--repo', repo,
    '--remote', GIT_REMOTE,
    '--branch', GIT_BRANCH,
    '--result', resultFile(userData),
  ], { cwd: repo, detached: true, stdio: ['ignore', log, log], windowsHide: true, env: process.env });
  child.on('error', () => undefined);
  child.unref();
}

/** The outcome of the last update, once: it is removed after reading. */
export function takeUpdateResult(userData: string): UpdateResult | null {
  const file = resultFile(userData);
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as UpdateResult;
    writeFileSync(file, '');
    return r && typeof r.ok === 'boolean' ? r : null;
  } catch {
    return null;
  }
}

export const updateLogFile = (userData: string) => join(userData, 'git-update.log');
