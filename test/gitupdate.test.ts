import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ago, checkForGitUpdate, describeUpdate, dismiss, dismissedTarget, fetchCommandFrom, fetchRemote, findRepo, gitRunner, proxyFromPac,
  takeUpdateResult, type GitRunner, fileDiff, updateDetails,
} from '../src/shell/gitupdate';

const HELPER = resolve('scripts/update-and-restart.mjs');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir(),
};

let dir: string;
let origin: string;
let checkout: string;
let other: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
};
/** A new commit on origin/main, made from a second clone. */
const publish = (file: string, text: string, msg: string) => {
  git(other, 'pull', '-q', 'origin', 'main');
  commit(other, file, text, msg);
  git(other, 'push', '-q', 'origin', 'main');
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-git-'));
  origin = join(dir, 'origin.git');
  checkout = join(dir, 'checkout');
  other = join(dir, 'other');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, other);
  git(other, 'checkout', '-q', '-b', 'main');
  commit(other, 'package.json', JSON.stringify({ name: 'debug-hub', private: true, scripts: { app: 'echo app' } }), 'Start');
  git(other, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'clone', '-q', origin, checkout);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const check = (fetchOptions = {}) => checkForGitUpdate(gitRunner(checkout), { repo: checkout, fetchOptions });

describe('findRepo', () => {
  it('finds the checkout above dist/shell, and nothing for an installed app', () => {
    mkdirSync(join(checkout, 'dist', 'shell'), { recursive: true });
    expect(findRepo(join(checkout, 'dist', 'shell'))).toBe(resolve(checkout));
    expect(findRepo(join(dir, 'nowhere', 'resources'))).toBeNull();
  });
});

describe('checkForGitUpdate', () => {
  it('is up to date at origin/main', async () => {
    expect(await check()).toMatchObject({ state: 'up-to-date' });
  });

  it('lists new commits on origin/main, newest first', async () => {
    publish('a.txt', '1', 'Add the API screen');
    publish('b.txt', '2', 'Fix the top bar');
    const s = await check();
    expect(s).toMatchObject({ state: 'available', behind: 2, blocked: null });
    if (s.state !== 'available') return;
    expect(s.commits.map((c) => c.subject)).toEqual(['Fix the top bar', 'Add the API screen']);
    expect(s.target).toBe(git(other, 'rev-parse', 'HEAD'));
    const text = describeUpdate(s);
    expect(text.message).toContain('2 new commits');
    expect(text.detail).toContain('• Fix the top bar');
    expect(text.detail).toContain('npm run app');
  });

  it('says why it cannot update a checkout with changes, another branch, or its own commits', async () => {
    publish('a.txt', '1', 'New');
    writeFileSync(join(checkout, 'package.json'), '{}');
    expect(await check()).toMatchObject({ state: 'available', blocked: expect.stringContaining('uncommitted changes: package.json') });
    git(checkout, 'checkout', '-q', '--', 'package.json');

    // Untracked files do not get in the way of a pull.
    writeFileSync(join(checkout, 'notes.txt'), 'mine');
    expect(await check()).toMatchObject({ blocked: null });

    commit(checkout, 'mine.txt', 'x', 'Local work');
    expect(await check()).toMatchObject({ blocked: expect.stringContaining('1 commit that origin/main does not') });

    git(checkout, 'checkout', '-q', '-b', 'feature');
    expect(await check()).toMatchObject({ blocked: expect.stringContaining('branch feature') });
  });

  it('compares with origin/main as last fetched when fetching fails', async () => {
    // Fetched earlier (by the terminal, the IDE or an earlier check), then the network went away.
    publish('a.txt', '1', 'Fetched before the network went away');
    git(checkout, 'fetch', '-q', 'origin');
    git(checkout, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const s = await check();
    expect(s).toMatchObject({ state: 'available', behind: 1, blocked: null, fetchError: expect.stringMatching(/git fetch/) });
    if (s.state !== 'available') return;
    expect(s.lastFetch).not.toBeNull();
    expect(describeUpdate(s).detail).toMatch(/Could not reach origin just now .* as of the last fetch, just now/);
  });

  it('is an error only when there is nothing fetched to compare with', async () => {
    git(checkout, 'update-ref', '-d', 'refs/remotes/origin/main');
    git(checkout, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    expect(await check()).toMatchObject({ state: 'error', message: expect.stringMatching(/git fetch/) });
  });

  it('fetches with the command from Settings instead of git fetch', async () => {
    publish('a.txt', '1', 'New');
    const marker = join(dir, 'ran.txt');
    // Stands in for e.g. nu -l -c "git fetch origin main": a program of the user's that fetches.
    const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); require('child_process').execFileSync('git', ['fetch', '-q', 'origin', 'main'])`];
    expect(await check({ command })).toMatchObject({ state: 'available', behind: 1, fetchError: null });
    expect(readFileSync(marker, 'utf8')).toBe('x');
    expect(await check({ command: ['no-such-program-xyz'] })).toMatchObject({ fetchError: expect.stringMatching(/no-such-program-xyz was not found/) });
  });
});

describe('updateDetails', () => {
  it('lists the commits with their files and messages, and the files of the whole update', async () => {
    publish('notes.md', 'one\n', 'Add notes\n\nWith a body line.');
    publish('package.json', JSON.stringify({ name: 'debug-hub', private: true, version: 2 }), 'Bump version');
    const s = await check();
    if (s.state !== 'available') throw new Error(s.state);
    const runner = gitRunner(checkout);
    const d = await updateDetails(runner, s.head, s.target);
    expect(d.commits.map((c) => c.subject)).toEqual(['Bump version', 'Add notes']);
    expect(d.commits[1].body).toBe('With a body line.');
    expect(d.commits[1].files).toEqual([{ path: 'notes.md', added: 1, deleted: 0 }]);
    expect(d.commits[0].date).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(d.files.map((f) => f.path).sort()).toEqual(['notes.md', 'package.json']);
    expect(d.dependencies).toBe(true);
    expect(d.added).toBe(2);

    const whole = await fileDiff(runner, 'notes.md', { head: s.head, target: s.target });
    expect(whole.text).toContain('+one');
    const one = await fileDiff(runner, 'package.json', { sha: d.commits[0].sha });
    expect(one.text).toMatch(/^-.*"scripts"/m);
  });
});

describe('fetching through the system proxy', () => {
  it('retries a fetch that cannot connect through the proxy, and only then', async () => {
    const calls: string[][] = [];
    const flaky: GitRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'fetch') throw new Error("git fetch: fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com");
      return '';
    };
    expect(await fetchRemote(dir, flaky, { proxy: 'http://proxy.corp:8080' })).toBeNull();
    expect(calls[1].slice(0, 3)).toEqual(['-c', 'http.proxy=http://proxy.corp:8080', 'fetch']);

    calls.length = 0;
    expect(await fetchRemote(dir, flaky, {})).toMatch(/Could not resolve host/);
    expect(calls).toHaveLength(1);

    // Not a network problem (e.g. a missing branch): no retry.
    const missing: GitRunner = async (args) => {
      calls.push(args);
      throw new Error("git fetch: fatal: couldn't find remote ref refs/heads/main");
    };
    calls.length = 0;
    expect(await fetchRemote(dir, missing, { proxy: 'http://proxy.corp:8080' })).toMatch(/remote ref/);
    expect(calls).toHaveLength(1);
  });

  it('reads the proxy from Chromium\'s answer', () => {
    expect(proxyFromPac('PROXY proxy.corp:8080; DIRECT')).toBe('http://proxy.corp:8080');
    expect(proxyFromPac('HTTPS secure.corp:443')).toBe('https://secure.corp:443');
    expect(proxyFromPac('SOCKS5 127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
    expect(proxyFromPac('DIRECT')).toBeNull();
  });
});

describe('fetch command setting', () => {
  it('is read from the settings file and split into arguments', () => {
    expect(fetchCommandFrom(dir)).toBeNull();
    writeFileSync(join(dir, 'debug-hub.config.json'), JSON.stringify({ updates: { fetchCommand: 'nu -l -c "git fetch origin main"' } }));
    expect(fetchCommandFrom(dir)).toEqual(['nu', '-l', '-c', 'git fetch origin main']);
  });

  it('says how long ago the last fetch was', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(ago('2026-11-17T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-11-17T11:20:00Z', now)).toBe('40 minutes ago');
    expect(ago('2026-11-16T20:00:00Z', now)).toBe('16 hours ago');
    expect(ago(null, now)).toBe('at an unknown time');
  });
});

describe('Later', () => {
  it('remembers the dismissed origin/main commit', () => {
    expect(dismissedTarget(dir)).toBeNull();
    dismiss(dir, 'abc123');
    expect(dismissedTarget(dir)).toBe('abc123');
  });
});

describe('scripts/update-and-restart.mjs', () => {
  const runHelper = (...extra: string[]) => {
    const result = join(dir, 'result.json');
    const r = spawnSync(process.execPath, [HELPER, '--pid', '0', '--repo', checkout, '--result', result, '--no-restart', ...extra], { env: ENV, encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return { out: r.stdout, result: JSON.parse(readFileSync(result, 'utf8')) };
  };

  it('pulls the new commits', () => {
    publish('a.txt', '1', 'New');
    const before = git(checkout, 'rev-parse', 'HEAD');
    const { result } = runHelper();
    expect(result).toMatchObject({ ok: true, from: before, to: git(other, 'rev-parse', 'HEAD'), installed: false, error: null });
    expect(readFileSync(join(checkout, 'a.txt'), 'utf8')).toBe('1');
  });

  it('runs npm install when package.json changed', () => {
    publish('package.json', JSON.stringify({ name: 'debug-hub', private: true, version: '0.0.2', scripts: { app: 'echo app' } }), 'Bump');
    const { result, out } = runHelper();
    expect(result).toMatchObject({ ok: true, installed: true });
    expect(out).toContain('npm install');
  });

  it('leaves the checkout as it was when the pull cannot fast-forward, and says why', () => {
    publish('a.txt', '1', 'Theirs');
    commit(checkout, 'b.txt', '2', 'Mine');
    const before = git(checkout, 'rev-parse', 'HEAD');
    const { result } = runHelper();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/git merge failed/);
    expect(result.to).toBe(before);
  });

  it('merges commits fetched earlier when it cannot fetch now', () => {
    publish('a.txt', '1', 'Fetched by the terminal');
    git(checkout, 'fetch', '-q', 'origin');
    git(checkout, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const { result } = runHelper();
    expect(result).toMatchObject({ ok: true, to: git(other, 'rev-parse', 'HEAD'), fetchError: expect.stringMatching(/git fetch/) });
  });

  it('fails clearly when it can neither fetch nor find anything fetched earlier', () => {
    git(checkout, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const { result } = runHelper();
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Could not reach origin/) });
  });

  it('fetches with the command it is given', () => {
    publish('a.txt', '1', 'New');
    const marker = join(dir, 'ran.txt');
    const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); require('child_process').execFileSync('git', ['fetch', '-q', 'origin', 'main'])`];
    const { result } = runHelper('--fetch-command', JSON.stringify(command));
    expect(result).toMatchObject({ ok: true, fetchError: null, to: git(other, 'rev-parse', 'HEAD') });
    expect(readFileSync(marker, 'utf8')).toBe('x');
  });

  it('hands its result to the next start once', () => {
    writeFileSync(join(dir, 'git-update-result.json'), JSON.stringify({ ok: false, from: 'a', to: 'a', error: 'boom', installed: false, at: '' }));
    expect(takeUpdateResult(dir)).toMatchObject({ ok: false, error: 'boom' });
    expect(takeUpdateResult(dir)).toBeNull();
  });
});
