import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config, type StartCommand } from '../src/server/config';
import { CommandRunner, shellCommand, type CommandEnd } from '../src/server/tomcat/commands';
import { catalinaScript, launchPlan, tomcatEnv, tomcatHome, type LaunchMachine } from '../src/server/tomcat/launch';
import { Sequence, type SequenceSteps, type StartedCommand } from '../src/server/tomcat/sequence';
import { TomcatService } from '../src/server/tomcat/service';
import { TomcatError } from '../src/server/tomcat/webapps';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-start-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('shellCommand', () => {
  it('runs a command line through cmd.exe on Windows, passing it on exactly as typed', () => {
    const c = shellCommand('  net start "postgresql-x64-16" && echo ok  ', { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(c.file).toBe('C:\\Windows\\system32\\cmd.exe');
    // /s strips just the outer quotes, so the user's own quotes survive.
    expect(c.args).toEqual(['/d', '/s', '/c', '"net start "postgresql-x64-16" && echo ok"']);
    expect(c.verbatim).toBe(true);
    expect(shellCommand('npm run dev', { platform: 'win32' }).file).toBe('cmd.exe');
  });

  it('runs it through /bin/sh -c elsewhere', () => {
    expect(shellCommand('npm run dev', { platform: 'linux' })).toMatchObject({ file: '/bin/sh', args: ['-c', 'npm run dev'], verbatim: false });
    expect(shellCommand("cd 'my dir' && make", { platform: 'darwin' }).args).toEqual(['-c', "cd 'my dir' && make"]);
  });

  it('refuses empty and multi-line commands', () => {
    expect(() => shellCommand('  ', { platform: 'linux' })).toThrow(TomcatError);
    expect(() => shellCommand('a\nb', { platform: 'win32' })).toThrow(/one line/);
  });
});

describe('Tomcat home and base', () => {
  /** A machine with these folders and files, on a platform. */
  function machine(paths: string[], platform: NodeJS.Platform = 'linux', env: Record<string, string> = {}): LaunchMachine {
    const set = new Set(paths);
    return {
      platform,
      env,
      isDir: (p) => [...set].some((x) => x === p || x.startsWith(p + (platform === 'win32' ? '\\' : '/'))),
      isFile: (p) => set.has(p),
    };
  }
  const tomcat = (over: Partial<Config['tomcat']>): Config['tomcat'] => ({ ...structuredClone(DEFAULT_CONFIG.tomcat), ...over });

  it('takes the Tomcat folder from the settings, else the folder above webapps when it has bin/', () => {
    const m = machine(['/opt/tomcat/bin/startup.sh', '/opt/tomcat/conf/server.xml', '/srv/base/conf/server.xml']);
    expect(tomcatHome(tomcat({ webappsDir: '/opt/tomcat/webapps' }), m)).toEqual({ home: '/opt/tomcat', homeSource: 'webapps', base: '/opt/tomcat', problem: null });
    // A separate base (conf/ but no bin/) needs the home set; the base is the webapps' parent.
    expect(tomcatHome(tomcat({ webappsDir: '/srv/base/webapps' }), m)).toMatchObject({ home: null, base: '/srv/base', problem: expect.stringMatching(/no bin folder/) });
    expect(tomcatHome(tomcat({ webappsDir: '/srv/base/webapps', home: '/opt/tomcat' }), m)).toEqual({ home: '/opt/tomcat', homeSource: 'settings', base: '/srv/base', problem: null });
    expect(tomcatHome(tomcat({ home: '/nowhere' }), m).problem).toMatch(/no bin folder/);
    expect(tomcatHome(tomcat({}), m).problem).toMatch(/Set the Tomcat folder/);
  });

  it('says which way Start and Stop run, and what is missing', () => {
    const m = machine(['C:\\tomcat\\bin\\catalina.bat', 'C:\\tomcat\\bin\\shutdown.bat', 'C:\\tomcat\\conf\\server.xml'], 'win32', { Path: 'C:\\Windows' });
    const own = launchPlan(tomcat({ webappsDir: 'C:\\tomcat\\webapps' }), m);
    // catalina run: Tomcat in the foreground, its output in the console rather than a window.
    expect(own.info.start).toEqual({ how: 'tomcat', path: 'C:\\tomcat\\bin\\catalina.bat', args: ['run'] });
    expect(own.info.stop).toEqual({ how: 'tomcat', path: 'C:\\tomcat\\bin\\shutdown.bat' });
    // catalina.bat insists on JAVA_HOME or JRE_HOME.
    expect(own.info.warnings.join(' ')).toMatch(/Neither JAVA_HOME nor JRE_HOME/);
    expect(own.env).toMatchObject({ CATALINA_HOME: 'C:\\tomcat', CATALINA_BASE: 'C:\\tomcat', Path: 'C:\\Windows' });

    const withJava = launchPlan(tomcat({ webappsDir: 'C:\\tomcat\\webapps', javaHome: 'C:\\jdk17' }), machine(['C:\\tomcat\\bin\\catalina.bat', 'C:\\tomcat\\bin\\shutdown.bat', 'C:\\jdk17\\bin\\java.exe'], 'win32'));
    expect(withJava.info).toMatchObject({ javaHome: 'C:\\jdk17', javaSource: 'settings', warnings: [] });

    const fromEnv = launchPlan(tomcat({ webappsDir: 'C:\\tomcat\\webapps' }), machine(['C:\\tomcat\\bin\\catalina.bat'], 'win32', { java_home: 'C:\\jdk21' }));
    expect(fromEnv.info).toMatchObject({ javaHome: 'C:\\jdk21', javaSource: 'environment', warnings: [] });
    expect(fromEnv.info.stop.how).toBe('none');
    expect(fromEnv.info.problems).toEqual(['Tomcat’s shutdown.bat was not found in C:\\tomcat\\bin.']);

    // Scripts win, and then nothing about Tomcat's own scripts matters.
    const scripts = launchPlan(tomcat({ startScript: '/x/up.sh', stopScript: '/x/down.sh' }), machine([]));
    expect(scripts.info).toMatchObject({ start: { how: 'script', path: '/x/up.sh' }, stop: { how: 'script' }, problems: [], warnings: [] });
    expect(scripts.env).toBeNull();
    expect(launchPlan(tomcat({}), machine([])).info.start.how).toBe('none');
  });

  it('builds the environment, replacing variables whatever their case on Windows', () => {
    const env = tomcatEnv({ Path: 'C:\\Windows', catalina_home: 'C:\\old', JRE_HOME: 'C:\\jre8', Java_Home: 'C:\\jdk8' }, { home: 'C:/tomcat', base: 'D:/base', javaHome: 'C:/jdk17' }, 'win32');
    expect(env).toEqual({ Path: 'C:\\Windows', CATALINA_HOME: 'C:\\tomcat', CATALINA_BASE: 'D:\\base', JAVA_HOME: 'C:\\jdk17' });
    expect(tomcatEnv({ PATH: '/bin' }, { home: '/opt/tomcat', base: null, javaHome: '' }, 'linux')).toEqual({ PATH: '/bin', CATALINA_HOME: '/opt/tomcat' });
    expect(catalinaScript('C:/tomcat', 'stop', 'win32')).toBe('C:\\tomcat\\bin\\shutdown.bat');
    expect(catalinaScript('/opt/tomcat', 'start', 'linux')).toBe('/opt/tomcat/bin/catalina.sh');
  });
});

describe('start sequence', () => {
  const cmd = (name: string, wait: boolean): StartCommand => ({ name, command: `run ${name}`, cwd: '/', wait });

  /** Steps that record what ran; each command ends as `ends` says, or never. */
  function steps(commands: StartCommand[], ends: Record<string, CommandEnd | 'never'>, over: Partial<SequenceSteps> = {}) {
    const log: string[] = [];
    const notes: string[] = [];
    let id = 0;
    const s: SequenceSteps = {
      commands,
      startCommand: async (c): Promise<StartedCommand> => {
        log.push(c.name);
        const end = ends[c.name] ?? { exitCode: 0, signal: null, error: null, stopped: false };
        return { id: ++id, pid: 100 + id, already: false, ended: end === 'never' ? new Promise(() => undefined) : Promise.resolve(end) };
      },
      startTomcat: async () => {
        log.push('tomcat');
        return 'Ran startup.sh.';
      },
      waitMs: 50,
      note: (_level, summary) => notes.push(summary),
      ...over,
    };
    return { s, log, notes };
  }
  const exit = (code: number): CommandEnd => ({ exitCode: code, signal: null, error: null, stopped: false });

  it('runs the commands in order, then Tomcat, then Chrome', async () => {
    const { s, log, notes } = steps([cmd('db', true), cmd('web', false)], { web: 'never' }, {
      startChrome: async () => {
        log.push('chrome');
        return { ok: true, message: 'Started Chrome.' };
      },
    });
    const seq = new Sequence(s, false);
    const done = await seq.start();
    expect(log).toEqual(['db', 'web', 'tomcat', 'chrome']);
    expect(done.steps.map((x) => [x.label, x.status])).toEqual([['db', 'done'], ['web', 'done'], ['Tomcat', 'done'], ['Chrome', 'done']]);
    expect(done).toMatchObject({ running: false, outcome: 'ok' });
    expect(notes).toEqual(['Started Tomcat after 2 start commands and Chrome.']);
  });

  it('stops at a waited command that fails, and does not start Tomcat', async () => {
    const { s, log } = steps([cmd('db', true), cmd('web', false)], { db: exit(2) });
    const done = await new Sequence(s, false).start();
    expect(log).toEqual(['db']);
    expect(done.steps.map((x) => x.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(done.outcome).toBe('failed');
    expect(done.message).toBe('db exited with code 2, so Tomcat was not started.');
  });

  it('gives up on a waited command that runs too long, leaving it running', async () => {
    const { s, log } = steps([cmd('db', true)], { db: 'never' });
    const done = await new Sequence(s, false).start();
    expect(log).toEqual(['db']);
    expect(done.message).toMatch(/^db did not finish within 0 s, so Tomcat was not started\. It is still running/);
  });

  it('reports a stopped command and one that could not start', async () => {
    const stopped = await new Sequence(steps([cmd('db', true)], { db: { exitCode: null, signal: 'SIGTERM', error: null, stopped: true } }).s, false).start();
    expect(stopped.message).toBe('db was stopped, so Tomcat was not started.');
    const bad = steps([cmd('db', false)], {}, {
      startCommand: async () => {
        throw new TomcatError('The folder for db was not found: /nope');
      },
    });
    const done = await new Sequence(bad.s, false).start();
    expect(done.message).toBe('db could not be started: The folder for db was not found: /nope, so Tomcat was not started.');
  });

  it('leaves a command running from before alone, and waits on one that must finish', async () => {
    const { s, log } = steps([cmd('web', false), cmd('db', true)], {}, {
      startCommand: async (c) => ({ id: 7, pid: 70, already: true, ended: Promise.resolve(exit(0)) }),
    });
    const done = await new Sequence(s, false).start();
    expect(done.steps.map((x) => [x.status, x.detail])).toEqual([
      ['skipped', 'Already running (process 70), so it was not started again.'],
      ['done', 'Finished.'],
      ['done', 'Ran startup.sh.'],
    ]);
    expect(log).toEqual(['tomcat']);
  });

  it('starts just Tomcat when asked, and notes nothing extra', async () => {
    const { s, log, notes } = steps([cmd('db', true)], {}, { startChrome: async () => ({ ok: true, message: '' }) });
    const done = await new Sequence(s, true).start();
    expect(log).toEqual(['tomcat']);
    expect(done.steps.map((x) => x.kind)).toEqual(['tomcat']);
    expect(notes).toEqual([]);
  });

  it('marks the outcome failed when Chrome does not start', async () => {
    const { s } = steps([], {}, { startChrome: async () => ({ ok: false, message: 'Chrome was not found.', hint: 'Set it in Settings.' }) });
    const done = await new Sequence(s, false).start();
    expect(done.steps.map((x) => x.status)).toEqual(['done', 'failed']);
    expect(done.message).toBe('Chrome did not start: Chrome was not found. Set it in Settings.');
  });
});

describe.skipIf(process.platform === 'win32')('CommandRunner', () => {
  it('runs a command in its folder, captures output and exit code, and refuses a duplicate', async () => {
    mkdirSync(join(dir, 'web app'));
    const runner = new CommandRunner(join(dir, 'logs'));
    const c: StartCommand = { name: 'web', command: 'echo "in $(pwd)"; echo oops >&2; exit 4', cwd: join(dir, 'web app'), wait: true };
    const run = await runner.start(c);
    const end = await runner.ended(run.id);
    expect(end).toEqual({ exitCode: 4, signal: null, error: null, stopped: false });
    const snap = await runner.snapshot(run);
    expect(snap.output).toContain(`in ${join(dir, 'web app')}`);
    expect(snap.output).toContain('oops');

    const slow: StartCommand = { name: '', command: 'sleep 5', cwd: dir, wait: false };
    const r = await runner.start(slow);
    expect(r.name).toBe('sleep 5');
    await expect(runner.start(slow)).rejects.toMatchObject({ status: 409 });
    await runner.stop(r.id);
    expect(await runner.ended(r.id)).toMatchObject({ stopped: true, signal: 'SIGTERM' });
    await expect(runner.start({ ...slow, cwd: join(dir, 'missing') })).rejects.toMatchObject({ status: 404 });
  });

  it('stops everything the command started, not just the shell', async () => {
    const runner = new CommandRunner(join(dir, 'logs'));
    // The shell waits for its child: stopping only the shell would leave the sleep running.
    const run = await runner.start({ name: 'tree', command: `sleep 30 & echo $! > ${join(dir, 'child.pid')}; wait`, cwd: dir, wait: false });
    await until(() => readFileSafe(join(dir, 'child.pid')).trim() !== '');
    const child = Number(readFileSafe(join(dir, 'child.pid')));
    expect(alive(child)).toBe(true);
    await runner.stop(run.id);
    await runner.ended(run.id);
    await until(() => !alive(child));
  });
});

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

describe.skipIf(process.platform === 'win32')('Start Tomcat', () => {
  function fakeTomcat(): void {
    mkdirSync(join(dir, 'tomcat', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'tomcat', 'conf'), { recursive: true });
    mkdirSync(join(dir, 'tomcat', 'webapps'), { recursive: true });
    writeFileSync(join(dir, 'tomcat', 'bin', 'catalina.sh'), '#!/bin/sh\necho "$1: home=$CATALINA_HOME base=$CATALINA_BASE java=$JAVA_HOME"\n');
    writeFileSync(join(dir, 'tomcat', 'bin', 'shutdown.sh'), '#!/bin/sh\necho stopping\n');
    chmodSync(join(dir, 'tomcat', 'bin', 'catalina.sh'), 0o755);
  }
  function service(over: Partial<Config['tomcat']>, events: HubEvent[] = []) {
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'tomcat', 'webapps') }, over);
    cfg.tail.pollMs = 20;
    cfg.tail.flushMs = 20;
    return new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'slogs'), commandLogDir: join(dir, 'clogs'), commandWaitMs: 3000 });
  }

  it('runs Tomcat’s own catalina.sh run with CATALINA_HOME, CATALINA_BASE and JAVA_HOME', async () => {
    fakeTomcat();
    const svc = service({ javaHome: '/opt/jdk' });
    const st = await svc.state();
    expect(st.launch).toMatchObject({ start: { how: 'tomcat', path: join(dir, 'tomcat', 'bin', 'catalina.sh'), args: ['run'] }, home: join(dir, 'tomcat'), homeSource: 'webapps' });
    await svc.startTomcat();
    await svc.startSequence!.done;
    await until(async () => (await svc.state()).scripts.start?.running === false);
    const out = (await svc.state()).scripts.start!.output;
    expect(out).toContain(`run: home=${join(dir, 'tomcat')} base=${join(dir, 'tomcat')} java=/opt/jdk`);
    // shutdown.sh is not executable: run through sh.
    const stop = await svc.runScript('stop');
    expect(stop.command).toContain('/bin/sh');
    await svc.stop();
  });

  it('runs the start commands first, refuses a second Start meanwhile, and stops at a failure', async () => {
    fakeTomcat();
    const events: HubEvent[] = [];
    const svc = service(
      {
        startCommands: [
          { name: 'db', command: 'echo db up; sleep 0.3', cwd: dir, wait: true },
          { name: 'web', command: 'echo serving; exec sleep 30', cwd: dir, wait: false },
        ],
      },
      events,
    );
    const seq = await svc.startTomcat();
    expect(seq.steps.map((s) => s.label)).toEqual(['db', 'web', 'Tomcat']);
    await expect(svc.startTomcat()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already being started \(step 1 of 3: db\)/) });
    const done = await svc.startSequence!.done;
    expect(done).toMatchObject({ outcome: 'ok', message: 'Started Tomcat after 2 start commands.' });

    let st = await svc.state();
    expect(st.commands.map((c) => [c.name, c.run?.running])).toEqual([['db', false], ['web', true]]);
    await until(async () => (await svc.state()).commands[1].run!.output.includes('serving'));

    // Starting again leaves the running dev server alone.
    await until(async () => (await svc.state()).scripts.start?.running === false);
    const again = await svc.startTomcat();
    await svc.startSequence!.done;
    expect(svc.startSequence!.state.steps[1]).toMatchObject({ status: 'skipped', detail: expect.stringMatching(/Already running/) });
    expect(again.steps.length).toBe(3);

    st = await svc.state();
    const web = st.commands[1].run!;
    await svc.stopCommand(web.id);
    await until(async () => (await svc.state()).commands[1].run!.running === false);
    expect((await svc.state()).commands[1].run).toMatchObject({ stopped: true });

    await until(() => events.some((e) => e.summary === 'db: db up'));
    const summaries = events.map((e) => e.summary);
    expect(summaries).toContain('Starting Tomcat: db → web → Tomcat');
    expect(summaries).toContain('Command db finished with exit code 0');
    expect(summaries).toContain('Stopped command web');

    // A failing waited command keeps Tomcat from starting.
    svc.reconfigure({ ...structuredClone(DEFAULT_CONFIG), tomcat: { ...structuredClone(DEFAULT_CONFIG.tomcat), webappsDir: join(dir, 'tomcat', 'webapps'), startCommands: [{ name: 'migrate', command: 'exit 3', cwd: dir, wait: true }] } });
    await until(async () => (await svc.state()).scripts.start?.running === false);
    const scriptStarted = (await svc.state()).scripts.start!.startedAt;
    await svc.startTomcat();
    expect(await svc.startSequence!.done).toMatchObject({ outcome: 'failed', message: 'migrate exited with code 3, so Tomcat was not started.' });
    expect((await svc.state()).scripts.start!.startedAt).toBe(scriptStarted);

    // Running one command on its own, with a guard against settings that changed meanwhile.
    await expect(svc.runCommand(0, 'something else')).rejects.toMatchObject({ status: 409 });
    const one = await svc.runCommand(0, 'exit 3');
    expect(one.name).toBe('migrate');
    await svc.stop();
  });

  it('refuses to start anything when Tomcat cannot be started', async () => {
    const svc = service({ startCommands: [{ name: 'touch', command: 'touch started', cwd: dir, wait: false }] });
    await expect(svc.startTomcat()).rejects.toThrow(/No way to start Tomcat yet/);
    expect(readFileSafe(join(dir, 'started'))).toBe('');
    expect(svc.startSequence).toBeNull();
  });
});
