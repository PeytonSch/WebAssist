import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkForGitUpdate, describeUpdate, dismiss, dismissedTarget, findRepo, gitRunner, takeUpdateResult,
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

const check = () => checkForGitUpdate(gitRunner(checkout));

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

  it('reports a failed fetch instead of throwing', async () => {
    git(checkout, 'remote', 'set-url', 'origin', join(dir, 'missing.git'));
    const s = await check();
    expect(s.state).toBe('error');
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
  const runHelper = () => {
    const result = join(dir, 'result.json');
    const r = spawnSync(process.execPath, [HELPER, '--pid', '0', '--repo', checkout, '--result', result, '--no-restart'], { env: ENV, encoding: 'utf8' });
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
    expect(result.error).toMatch(/git pull failed/);
    expect(result.to).toBe(before);
  });

  it('hands its result to the next start once', () => {
    writeFileSync(join(dir, 'git-update-result.json'), JSON.stringify({ ok: false, from: 'a', to: 'a', error: 'boom', installed: false, at: '' }));
    expect(takeUpdateResult(dir)).toMatchObject({ ok: false, error: 'boom' });
    expect(takeUpdateResult(dir)).toBeNull();
  });
});
