import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type Config } from '../src/server/config';
import { backgroundSpawn, readChunk, scriptCommand } from '../src/server/tomcat/scripts';
import { TomcatService } from '../src/server/tomcat/service';
import type { HubEvent } from '../src/shared/types';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dh-console-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('reading output for the console', () => {
  it('reads on from an offset, and starts a first read near the end at a line', async () => {
    const f = join(dir, 'out.log');
    writeFileSync(f, 'one\ntwo\n');
    const a = await readChunk(f, -1);
    expect(a).toEqual({ text: 'one\ntwo\n', start: 0, next: 8, size: 8 });
    appendFileSync(f, 'three\nfo');
    const b = await readChunk(f, a.next);
    expect(b.text).toBe('three\nfo');
    expect(b.next).toBe(16);
    // Past the end (a new file of the same name): from the end again.
    writeFileSync(f, 'x'.repeat(50) + '\nlast\n');
    expect((await readChunk(f, 1000, { first: 10 })).text).toBe('last\n');
    // A missing file is empty.
    expect(await readChunk(join(dir, 'none.log'), 0)).toEqual({ text: '', start: 0, next: 0, size: 0 });
  });

  it('leaves a character split by the end of what was written for the next read', async () => {
    const f = join(dir, 'utf8.log');
    const euro = Buffer.from('€', 'utf8'); // 3 bytes
    writeFileSync(f, Buffer.concat([Buffer.from('price '), euro.subarray(0, 2)]));
    const a = await readChunk(f, 0);
    expect(a.text).toBe('price ');
    expect(a.next).toBe(6);
    appendFileSync(f, Buffer.concat([euro.subarray(2), Buffer.from('5\n')]));
    expect((await readChunk(f, a.next)).text).toBe('€5\n');
  });

  it('reads at most max bytes at a time', async () => {
    const f = join(dir, 'big.log');
    writeFileSync(f, 'abcdefghij');
    const a = await readChunk(f, 0, { max: 4 });
    expect(a).toMatchObject({ text: 'abcd', next: 4 });
    expect((await readChunk(f, a.next, { max: 4 })).text).toBe('efgh');
  });
});

describe('script command lines', () => {
  it('adds catalina’s run after the script, quoted for cmd.exe on Windows', () => {
    const c = scriptCommand('C:/Program Files/Tomcat 9/bin/catalina.bat', { platform: 'win32', comspec: 'cmd.exe', args: ['run'] });
    expect(c.args).toEqual(['/d', '/s', '/c', '""C:\\Program Files\\Tomcat 9\\bin\\catalina.bat" run"']);
    expect(c.verbatim).toBe(true);
    expect(scriptCommand('/opt/tomcat/bin/catalina.sh', { platform: 'linux', executable: true, args: ['run'] })).toMatchObject({ file: '/opt/tomcat/bin/catalina.sh', args: ['run'] });
    expect(scriptCommand('/opt/tomcat/bin/catalina.sh', { platform: 'linux', executable: false, args: ['run'] })).toMatchObject({ file: '/bin/sh', args: ['/opt/tomcat/bin/catalina.sh', 'run'] });
    expect(() => scriptCommand('/x.sh', { args: ['run & del'] })).toThrow(/Not a script argument/);
  });

  it('keeps consoles hidden on Windows without detaching, and detaches elsewhere', () => {
    // Detached on Windows would leave Tomcat's java.exe to open a console window of its own.
    expect(backgroundSpawn('win32')).toEqual({ detached: false, windowsHide: true });
    expect(backgroundSpawn('linux')).toEqual({ detached: true, windowsHide: true });
  });
});

describe.skipIf(process.platform === 'win32')('console, restart and end process', () => {
  /** A Tomcat that stays in the foreground until its shutdown.sh leaves a flag, like catalina run. */
  function fakeTomcat(opts: { shutdownWorks?: boolean } = {}): void {
    const bin = join(dir, 'tomcat', 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(dir, 'tomcat', 'conf'), { recursive: true });
    mkdirSync(join(dir, 'tomcat', 'webapps'), { recursive: true });
    writeFileSync(
      join(bin, 'catalina.sh'),
      '#!/bin/sh\necho "Tomcat $1: started"\nwhile [ ! -f "$CATALINA_HOME/stop-flag" ]; do sleep 0.05; done\nrm -f "$CATALINA_HOME/stop-flag"\necho "Tomcat stopped"\n',
    );
    chmodSync(join(bin, 'catalina.sh'), 0o755);
    writeFileSync(join(bin, 'shutdown.sh'), opts.shutdownWorks === false ? '#!/bin/sh\necho "no luck"\n' : '#!/bin/sh\necho "stopping"\ntouch "$CATALINA_HOME/stop-flag"\n');
  }

  function service(events: HubEvent[] = [], restartWaitMs = 5000) {
    const cfg: Config = structuredClone(DEFAULT_CONFIG);
    Object.assign(cfg.tomcat, { webappsDir: join(dir, 'tomcat', 'webapps') });
    cfg.tail.pollMs = 20;
    cfg.tail.flushMs = 20;
    return new TomcatService(cfg, { emit: (e) => events.push(e), onWar: () => undefined }, { scriptLogDir: join(dir, 'slogs'), commandLogDir: join(dir, 'clogs'), restartWaitMs });
  }

  it('shows Tomcat’s output as it runs, and restarts it', async () => {
    fakeTomcat();
    const events: HubEvent[] = [];
    const svc = service(events);
    await svc.startTomcat();
    await until(async () => (await svc.state()).consoles[0]?.running === true);
    let st = await svc.state();
    expect(st.consoles[0]).toMatchObject({ id: 'start', label: 'Tomcat', running: true, tomcat: true });
    expect(st.scripts.start?.foreground).toBe(true);
    await until(async () => (await svc.consoleOutput('start', -1)).text.includes('Tomcat run: started'));
    const first = await svc.consoleOutput('start', -1);

    // A second Start is refused: Tomcat is running.
    await expect(svc.startTomcat()).rejects.toThrow(/already running/);

    const runKey = st.consoles[0].runKey;
    await svc.restartTomcat();
    await expect(svc.restartTomcat()).rejects.toThrow(/already being restarted/);
    await until(async () => (await svc.state()).restart?.running === false);
    st = await svc.state();
    expect(st.restart).toMatchObject({ phase: 'done', message: 'Restarted Tomcat.' });
    // A new run of Tomcat, and the shutdown's output beside it.
    expect(st.consoles[0]).toMatchObject({ id: 'start', running: true });
    expect(st.consoles[0].runKey).not.toBe(runKey);
    expect(st.consoles.map((c) => c.label)).toEqual(['Tomcat', 'Shutdown']);
    expect((await svc.consoleOutput('stop', -1)).text).toContain('stopping');
    // The first run's output ended with Tomcat stopping; it was read on from where it was.
    expect(events.map((e) => e.summary)).toContainEqual(expect.stringMatching(/^Tomcat stopped \(catalina\.sh run ended with exit code 0\)/));
    expect(first.next).toBeGreaterThan(0);

    // Stop for good.
    await svc.runScript('stop');
    await until(async () => (await svc.state()).consoles[0].running === false);
    expect((await svc.state()).consoles[0].ended).toBe('exit code 0');
    await svc.stop();
  });

  it('ends a Tomcat that does not stop, on Restart and with End process', async () => {
    fakeTomcat({ shutdownWorks: false });
    const events: HubEvent[] = [];
    const svc = service(events, 300);
    await svc.startTomcat();
    await until(async () => (await svc.state()).scripts.start?.running === true);
    const pid = (await svc.state()).scripts.start!.pid;
    await svc.restartTomcat();
    await until(async () => (await svc.state()).restart?.running === false);
    expect((await svc.state()).restart?.phase).toBe('done');
    expect(events.map((e) => e.summary)).toContainEqual(expect.stringMatching(/had not stopped after 0 s, so its process \d+ was ended/));
    const again = (await svc.state()).scripts.start!;
    expect(again.running).toBe(true);
    expect(again.pid).not.toBe(pid);

    expect(await svc.killTomcat()).toMatch(/^Ended Tomcat/);
    await until(async () => (await svc.state()).scripts.start?.running === false);
    await expect(svc.killTomcat()).rejects.toThrow(/no Tomcat process/);
    await svc.stop();
  });

  it('refuses Restart without a way to stop and start Tomcat, and unknown console sources', async () => {
    const svc = service();
    await expect(svc.restartTomcat()).rejects.toThrow(/needs a way to both stop and start/);
    await expect(svc.consoleOutput('cmd:99', 0)).rejects.toThrow(/no such output/);
    await expect(svc.consoleOutput('../etc', 0)).rejects.toThrow(/no such output/);
  });
});
