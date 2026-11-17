// Updates a Debug Hub checkout and starts it again. The desktop app starts this when the user
// accepts a git update (src/shell/gitupdate.ts), then quits; this waits for it to be gone,
// because on Windows a running Electron keeps its files locked and npm install may replace them.
//
//   node scripts/update-and-restart.mjs --pid <app pid> --repo <checkout> --result <file.json>
//        [--remote origin] [--branch main] [--fetch-command '["nu","-l","-c","git fetch origin main"]']
//        [--proxy http://proxy:8080] [--no-restart]
//
// Steps: fetch origin/main (with the user's fetch command if there is one, else git fetch, then
// once more through the system proxy if that cannot connect), fast-forward to origin/main, run
// npm install when package.json or package-lock.json changed, then npm run app. A fetch that
// fails is not the end: commits fetched earlier (by the app's check, the terminal or the IDE) are
// still merged. If the merge or install fails, the version that was there is started again, and
// the result file says what went wrong so the app can tell the user. Output goes to the log file
// the app opened for it (git-update.log in the app's data folder).
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const pid = Number(opt('pid', '0'));
const repo = opt('repo', process.cwd());
const remote = opt('remote', 'origin');
const branch = opt('branch', 'main');
const resultFile = opt('result');
const restart = !args.includes('--no-restart');
const fetchCommand = (() => {
  try {
    const c = JSON.parse(opt('fetch-command', 'null'));
    return Array.isArray(c) && c.length && c.every((x) => typeof x === 'string') ? c : null;
  } catch {
    return null;
  }
})();
const proxy = opt('proxy');
const win = process.platform === 'win32';

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

function alive(p) {
  try {
    process.kill(p, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitForExit(p, maxMs = 60_000) {
  const until = Date.now() + maxMs;
  while (p && alive(p) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  if (p && alive(p)) throw new Error(`Debug Hub (process ${p}) did not quit within ${maxMs / 1000} s`);
}

function run(cmd, cmdArgs, { npm = false, timeout } = {}) {
  log(`$ ${cmd} ${cmdArgs.join(' ')}`);
  // npm is a .cmd on Windows, which Node only runs through a shell. The arguments are fixed here,
  // never user input.
  const r = spawnSync(cmd, cmdArgs, {
    cwd: repo,
    encoding: 'utf8',
    shell: npm && win,
    windowsHide: true,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stdout.write(r.stderr);
  if (r.error) throw new Error(`${cmd} ${cmdArgs[0] ?? ''}: ${r.error.code === 'ETIMEDOUT' ? `no answer in ${timeout / 1000} s` : r.error.message}`);
  if (r.status !== 0) {
    const last = `${r.stderr || r.stdout || ''}`.trim().split('\n').pop();
    throw new Error(`${cmd} ${cmdArgs[0]} failed (exit ${r.status})${last ? `: ${last}` : ''}`);
  }
  return (r.stdout ?? '').trim();
}

const result = { ok: false, from: '', to: '', error: null, installed: false, at: '', fetchError: null };
const remoteRef = `refs/remotes/${remote}/${branch}`;
const fetchArgs = ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:${remoteRef}`];
const NETWORK_ERROR = /resolve host|resolve proxy|connect to|connection (refused|reset|timed out)|timed out|network is unreachable|proxy|ssl|tls|schannel|unable to access/i;

/** Fetches origin/main as the app's check does (src/shell/gitupdate.ts fetchRemote); returns why it failed, or null. */
function fetchRemote() {
  try {
    if (fetchCommand) run(fetchCommand[0], fetchCommand.slice(1), { timeout: 120_000 });
    else run('git', fetchArgs, { timeout: 120_000 });
    return null;
  } catch (err) {
    if (fetchCommand || !proxy || !NETWORK_ERROR.test(err.message)) return err.message;
    try {
      log(`retrying through the system proxy ${proxy}`);
      run('git', ['-c', `http.proxy=${proxy}`, ...fetchArgs], { timeout: 120_000 });
      return null;
    } catch (err2) {
      return `${err.message}; through the system proxy: ${err2.message}`;
    }
  }
}

try {
  log(`waiting for Debug Hub (${pid}) to quit`);
  await waitForExit(pid);
  result.from = run('git', ['rev-parse', 'HEAD']);
  try {
    result.fetchError = fetchRemote();
    if (result.fetchError) log(`fetch failed (${result.fetchError}); using ${remote}/${branch} as last fetched`);
    const behind = Number(run('git', ['rev-list', '--count', `HEAD..${remoteRef}`]));
    if (!behind && result.fetchError) throw new Error(`Could not reach ${remote}: ${result.fetchError}`);
    if (behind) run('git', ['merge', '--ff-only', remoteRef]);
    result.to = run('git', ['rev-parse', 'HEAD']);
    const changed = result.from === result.to ? '' : run('git', ['diff', '--name-only', result.from, result.to, '--', 'package.json', 'package-lock.json']);
    if (changed) {
      log(`dependencies changed (${changed.split('\n').join(', ')}): installing`);
      run(win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { npm: true });
      result.installed = true;
    }
    result.ok = true;
    log(`updated ${result.from.slice(0, 7)} → ${result.to.slice(0, 7)}`);
  } catch (err) {
    result.error = err.message;
    result.to = run('git', ['rev-parse', 'HEAD']);
    log(`update failed: ${err.message}`);
  }
} catch (err) {
  result.error = err.message;
  log(`update failed: ${err.message}`);
}

result.at = new Date().toISOString();
if (resultFile) {
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    log(`could not write ${resultFile}: ${err.message}`);
  }
}

if (restart) {
  // Started detached, so it outlives this script. npm run app builds, then opens the app.
  log('$ npm run app');
  const child = spawn(win ? 'npm.cmd' : 'npm', ['run', 'app'], {
    cwd: repo,
    detached: true,
    stdio: 'ignore',
    shell: win,
    windowsHide: true,
  });
  child.on('error', (err) => log(`could not start npm run app: ${err.message}`));
  child.unref();
}
