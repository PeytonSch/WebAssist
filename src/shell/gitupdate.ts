import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { readRawConfig } from '../server/config';
import { splitTemplate } from '../server/source/editor';

/**
 * Updates for a copy run from a git checkout with `npm run app`: the way the owner runs Debug Hub
 * day to day ("git pull, then npm run app"), done for them. Installed copies update from GitHub
 * Releases instead (updater.ts); this only applies when the app is not packaged and sits in a
 * git repository.
 *
 * A check fetches origin/main and counts commits not in the checkout. Applying an update is left
 * to scripts/update-and-restart.mjs, started just before the app quits: on Windows a running
 * Electron keeps its own files locked, so `npm install` can only run once the app is gone.
 *
 * A fetch can fail where the user's terminal succeeds: a proxy git is not told about (the
 * Windows system proxy applies to browsers, not git), variables set only in the shell's
 * profile, or network rules that allow some programs and not others. So a failed fetch does
 * not end the check: origin/main as last fetched (by the terminal, the IDE, or an earlier check)
 * is still compared, and the update itself merges that. A plain fetch that cannot connect is
 * retried through the system proxy, and the fetch can be a command of the user's own
 * (updates.fetchCommand), e.g. run through their shell to get its profile and credentials.
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

/** How the last fetch went, on every status that got as far as comparing. */
interface FetchInfo {
  /** Why fetching failed, or null when it worked (or was not tried). */
  fetchError: string | null;
  /** When origin/main was last fetched by anyone (FETCH_HEAD's time), ISO; null if unknown. */
  lastFetch: string | null;
}

export type GitUpdateStatus =
  | ({ state: 'up-to-date'; head: string } & FetchInfo)
  | ({
      state: 'available';
      head: string;
      /** origin/main: identifies this update, so "Later" is not asked again for it. */
      target: string;
      behind: number;
      /** Newest first, at most 15. */
      commits: GitCommit[];
      /** Set when the update cannot be applied automatically, with why. */
      blocked: string | null;
    } & FetchInfo)
  | { state: 'error'; message: string };

export interface FetchOptions {
  /** The user's own fetch command, as arguments (updates.fetchCommand); null: git fetch. */
  command?: string[] | null;
  /** The system proxy for the remote, e.g. http://proxy:8080; tried when a plain fetch cannot connect. */
  proxy?: string | null;
  timeoutMs?: number;
}

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

const REMOTE_REF = `refs/remotes/${GIT_REMOTE}/${GIT_BRANCH}`;
/** The fetch git does by itself, also used by the update helper. */
export const FETCH_ARGS = ['fetch', '--quiet', '--no-tags', GIT_REMOTE, `+refs/heads/${GIT_BRANCH}:${REMOTE_REF}`];
// What a fetch that could not reach the network says (curl and git's own wording).
const NETWORK_ERROR = /resolve host|resolve proxy|connect to|connection (refused|reset|timed out)|timed out|network is unreachable|proxy|ssl|tls|schannel|unable to access/i;

/** Runs a program in `repo` the way gitRunner runs git: no prompts, hidden, with a timeout. */
function runIn(repo: string, file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: repo,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      const code = (err as NodeJS.ErrnoException).code;
      const why = code === 'ENOENT' ? `${file} was not found (give its full path)` : (err as { killed?: boolean }).killed ? `no answer in ${timeoutMs / 1000} s` : (stderr || err.message).trim().split('\n').pop();
      reject(new Error(`${file}: ${why}`));
    });
  });
}

/**
 * Brings origin/main up to date: with the user's command when there is one, else git fetch, and
 * if that cannot connect, git fetch again through the system proxy. Resolves to null when it
 * worked, else to why not.
 */
export async function fetchRemote(repo: string, git: GitRunner, opts: FetchOptions = {}): Promise<string | null> {
  const timeout = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  try {
    if (opts.command?.length) await runIn(repo, opts.command[0], opts.command.slice(1), timeout);
    else await git(FETCH_ARGS, timeout);
    return null;
  } catch (err) {
    const first = (err as Error).message;
    if (opts.command?.length || !opts.proxy || !NETWORK_ERROR.test(first)) return first;
    try {
      await git(['-c', `http.proxy=${opts.proxy}`, ...FETCH_ARGS], timeout);
      return null;
    } catch (err2) {
      return `${first}; through the system proxy ${opts.proxy}: ${(err2 as Error).message.replace(/^git -c: /, '')}`;
    }
  }
}

/** When origin/main was last fetched, by anything: the time of .git/FETCH_HEAD. */
async function lastFetchTime(git: GitRunner, repo: string): Promise<string | null> {
  try {
    const rel = await git(['rev-parse', '--git-path', 'FETCH_HEAD']);
    return statSync(isAbsolute(rel) ? rel : join(repo, rel)).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Fetches origin/main and says whether the checkout is behind it, and whether it can catch up.
 * When fetching fails, origin/main as last fetched is compared instead, and fetchError says why.
 */
export async function checkForGitUpdate(
  git: GitRunner,
  opts: { fetch?: boolean; fetchTimeoutMs?: number; repo?: string; fetchOptions?: FetchOptions } = {},
): Promise<GitUpdateStatus> {
  try {
    const repo = opts.repo ?? process.cwd();
    const remoteRef = REMOTE_REF;
    const fetchError = opts.fetch === false ? null : await fetchRemote(repo, git, { ...opts.fetchOptions, timeoutMs: opts.fetchTimeoutMs ?? opts.fetchOptions?.timeoutMs });
    const lastFetch = await lastFetchTime(git, repo);
    const head = await git(['rev-parse', 'HEAD']);
    let target: string;
    try {
      target = await git(['rev-parse', '--verify', '--quiet', remoteRef]);
    } catch {
      // Never fetched, and cannot fetch now: nothing to compare with.
      return { state: 'error', message: fetchError ?? `${GIT_REMOTE}/${GIT_BRANCH} has not been fetched yet` };
    }
    const [behind, ahead] = (await git(['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`])).split(/\s+/).map(Number);
    if (!behind) return { state: 'up-to-date', head, fetchError, lastFetch };

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
    return { state: 'available', head, target, behind, commits, blocked, fetchError, lastFetch };
  } catch (err) {
    return { state: 'error', message: (err as Error).message };
  }
}

/** "3 minutes ago" for an ISO time, for "as of the last fetch". */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'at an unknown time';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** What to say when fetching failed: why, and what the comparison is based on instead. */
export function fetchNote(s: FetchInfo): string {
  if (!s.fetchError) return '';
  return `Could not reach ${GIT_REMOTE} just now (${s.fetchError}), so this is as of the last fetch, ${ago(s.lastFetch)}. ` +
    `If your terminal can fetch, set Settings › Advanced › Fetch updates with to a command that does it the same way, e.g. nu -l -c "git fetch ${GIT_REMOTE} ${GIT_BRANCH}".`;
}

/** The prompt's text for an available update. */
export function describeUpdate(s: Extract<GitUpdateStatus, { state: 'available' }>): { message: string; detail: string } {
  const n = `${s.behind} new commit${s.behind === 1 ? '' : 's'}`;
  const list = s.commits.map((c) => `• ${c.subject}  (${c.author}, ${c.when})`).join('\n');
  const more = s.behind > s.commits.length ? `\n…and ${s.behind - s.commits.length} more` : '';
  const note = s.fetchError ? `\n\n${fetchNote(s)}` : '';
  const how = s.blocked
    ? `\n\nIt cannot be updated automatically. ${s.blocked} Update by hand with git pull, then npm run app.`
    : `\n\nUpdating quits Debug Hub, brings in these commits (git fetch, then a fast-forward merge; npm install if dependencies changed), then builds and starts it again, as npm run app would.`;
  return { message: `A Debug Hub update is available: ${n} on ${GIT_REMOTE}/${GIT_BRANCH}`, detail: `${list}${more}${how}${note}` };
}

// ── Fetching differently ────────────────────────────────

/**
 * The fetch command from Settings (updates.fetchCommand), split into arguments; null when unset
 * or unreadable. Read from the settings file each time, so a change applies without a restart.
 */
export function fetchCommandFrom(userData: string): string[] | null {
  try {
    const raw = readRawConfig(join(userData, 'debug-hub.config.json')) as { updates?: { fetchCommand?: unknown } };
    const cmd = raw.updates?.fetchCommand;
    return typeof cmd === 'string' && cmd.trim() ? splitTemplate(cmd) : null;
  } catch {
    return null;
  }
}

/**
 * The proxy Chromium would use for `url`, from Electron's session.resolveProxy answer
 * ("PROXY host:port; DIRECT", "HTTPS host:443", "SOCKS5 host:1080" or "DIRECT"), as a URL git's
 * http.proxy takes; null for a direct connection.
 */
export function proxyFromPac(answer: string): string | null {
  for (const part of answer.split(';')) {
    const m = /^\s*(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+(\S+)\s*$/i.exec(part);
    if (!m) continue;
    const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS4: 'socks4', SOCKS: 'socks4' }[m[1].toUpperCase() as 'PROXY'];
    return `${scheme}://${m[2]}`;
  }
  return null;
}

/** The HTTPS URL of origin, for asking which proxy applies; null for SSH remotes (no proxy). */
export async function remoteHttpUrl(git: GitRunner): Promise<string | null> {
  try {
    const url = await git(['remote', 'get-url', GIT_REMOTE]);
    return /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Facts that tell a network problem from a git one, for the log when a fetch fails: which git,
 * the proxy settings git sees, and the system proxy. Values are trimmed to host names.
 */
export async function fetchDiagnostics(git: GitRunner, proxy: string | null, command: string[] | null): Promise<string> {
  const host = (v: string) => v.replace(/^[a-z0-9+.-]+:\/\/(?:[^@/]*@)?/i, '').replace(/\/.*$/, '');
  const parts: string[] = [];
  try {
    parts.push(await git(['--version']));
  } catch {
    parts.push('git not runnable');
  }
  const env = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'].filter((k) => process.env[k] || process.env[k.toLowerCase()]);
  parts.push(env.length ? `proxy variables set: ${env.join(', ')}` : 'no proxy variables');
  for (const key of ['http.proxy', 'https.proxy']) {
    try {
      const v = await git(['config', '--get', key]);
      if (v) parts.push(`${key}=${host(v)}`);
    } catch {
      /* not set */
    }
  }
  parts.push(proxy ? `system proxy ${host(proxy)}` : 'system proxy: none');
  if (command) parts.push(`fetch command: ${command[0]}`);
  return parts.join('; ');
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
 * Starts the helper that waits for this process to exit, pulls, installs if needed, then builds
 * and starts Electron again as `npm run app` does, but without npm's console window. Call app.quit() right after. It runs on the system's node (the one npm
 * uses), not on this Electron, whose files `npm install` may need to replace.
 */
export function startGitUpdate(repo: string, userData: string, fetch: FetchOptions = {}): void {
  mkdirSync(userData, { recursive: true });
  const log = openSync(join(userData, 'git-update.log'), 'a');
  const child = spawn('node', [
    join(repo, 'scripts', 'update-and-restart.mjs'),
    '--pid', String(process.pid),
    '--repo', repo,
    '--remote', GIT_REMOTE,
    '--branch', GIT_BRANCH,
    '--result', resultFile(userData),
    ...(fetch.command?.length ? ['--fetch-command', JSON.stringify(fetch.command)] : []),
    ...(fetch.proxy ? ['--proxy', fetch.proxy] : []),
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

// ── What an update brings, for the update window ────────

export interface FileStat {
  path: string;
  /** null for a binary file. */
  added: number | null;
  deleted: number | null;
}

export interface UpdateCommit extends GitCommit {
  /** The message after the subject, trimmed; '' when there is none. */
  body: string;
  /** Committer date, ISO. */
  date: string;
  files: FileStat[];
}

export interface UpdateDetails {
  /** Newest first, at most `max`. */
  commits: UpdateCommit[];
  /** Everything that changes between the checkout and origin/main. */
  files: FileStat[];
  added: number;
  deleted: number;
  /** package.json or package-lock.json changes, so npm install will run. */
  dependencies: boolean;
}

const RS = '\x1e';
const US = '\x1f';

/** `git diff --numstat` lines: "12\t3\tpath", or "-\t-\tpath" for a binary file. */
export function parseNumstat(text: string): FileStat[] {
  return text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => /^(\d+|-)\t(\d+|-)\t./.test(l)).map((l) => {
    const [a, d, ...rest] = l.split('\t');
    return { path: rest.join('\t'), added: a === '-' ? null : Number(a), deleted: d === '-' ? null : Number(d) };
  });
}

/** Parses `git log --format=<RS>%h<US>%an<US>%cr<US>%cI<US>%s<US>%b<US> --numstat`. */
export function parseDetailedLog(text: string): UpdateCommit[] {
  return text.split(RS).filter((r) => r.includes(US)).map((record) => {
    const [sha, author, when, date, subject, body, numstat = ''] = record.split(US);
    return { sha: sha.trim(), author, when, date, subject, body: body.trim(), files: parseNumstat(numstat) };
  });
}

/**
 * The commits and files between `head` and `target` (origin/main), for the update window. Paths
 * are shown as git has them; renames show as a delete and an add, which reads fine in a list.
 */
export async function updateDetails(git: GitRunner, head: string, target: string, max = 60): Promise<UpdateDetails> {
  const log = await git(['log', '--no-merges', '--no-renames', '-n', String(max), `--format=${RS}%h${US}%an${US}%cr${US}%cI${US}%s${US}%b${US}`, '--numstat', `${head}..${target}`]);
  const files = parseNumstat(await git(['diff', '--no-renames', '--numstat', head, target]));
  const sum = (k: 'added' | 'deleted') => files.reduce((n, f) => n + (f[k] ?? 0), 0);
  return {
    commits: parseDetailedLog(log),
    files,
    added: sum('added'),
    deleted: sum('deleted'),
    dependencies: files.some((f) => f.path === 'package.json' || f.path === 'package-lock.json'),
  };
}

/** Longer diffs are cut here; the window says so. */
export const MAX_DIFF_BYTES = 512 * 1024;

/**
 * One file's unified diff: across the whole update, or in one commit when `sha` is given. Only
 * paths and commits the window was shown are asked for (src/shell/updatewindow.ts checks).
 */
export async function fileDiff(git: GitRunner, path: string, range: { head: string; target: string } | { sha: string }): Promise<{ text: string; truncated: boolean }> {
  const args = 'sha' in range
    ? ['show', '--no-color', '--no-ext-diff', '--no-renames', '--format=', range.sha, '--', path]
    : ['diff', '--no-color', '--no-ext-diff', '--no-renames', range.head, range.target, '--', path];
  const text = await git(args, 15_000);
  return text.length > MAX_DIFF_BYTES ? { text: text.slice(0, text.lastIndexOf('\n', MAX_DIFF_BYTES)), truncated: true } : { text, truncated: false };
}
