import { spawn } from 'node:child_process';
import { editorEnv, type Step } from './editor';

/**
 * Starts the programs editor.ts describes. Two kinds: windows that outlive Debug Hub (the editor,
 * a terminal) are detached, visible and not waited for, apart from a moment to catch one that
 * fails at once; helpers (emacsclient, nvim --remote-*) are run hidden to completion, because
 * their exit status and output are the answer.
 */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when it could not be started at all, or did not finish in time. */
  error?: string;
}

export interface Runner {
  /** A helper: runs hidden and resolves when it exits (or is killed after `timeoutMs`). */
  run(step: Step, timeoutMs: number): Promise<RunResult>;
  /** A window: resolves once started, or with the exit code if it exits within `watchMs`. */
  launch(step: Step, watchMs: number): Promise<RunResult>;
}

const MAX_OUTPUT = 16 * 1024;

export const processRunner: Runner = {
  run(step, timeoutMs) {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (r: RunResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child;
      try {
        child = spawn(step.file, step.args, {
          env: editorEnv(process.env),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          windowsVerbatimArguments: step.verbatim,
        });
      } catch (err) {
        return finish({ code: null, stdout, stderr, error: (err as Error).message });
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ code: null, stdout, stderr, error: `did not finish within ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      child.stdout?.on('data', (c: Buffer) => (stdout = (stdout + c.toString('utf8')).slice(0, MAX_OUTPUT)));
      child.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(0, MAX_OUTPUT)));
      child.once('error', (err) => finish({ code: null, stdout, stderr, error: err.message }));
      child.once('close', (code) => finish({ code, stdout, stderr }));
    });
  },

  launch(step, watchMs) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(step.file, step.args, {
          env: editorEnv(process.env),
          // Detached: closing Debug Hub must not close the editor. Not hidden: windowsHide would
          // ask Windows to start the editor's or terminal's first window hidden.
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: step.verbatim,
        });
      } catch (err) {
        return resolve({ code: null, stdout: '', stderr: '', error: (err as Error).message });
      }
      let done = false;
      const finish = (r: RunResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      // Launchers such as code or idea hand the file to a running instance and exit 0 at once;
      // a non-zero exit within this time is a failure worth reporting.
      const timer = setTimeout(() => finish({ code: null, stdout: '', stderr: '' }), watchMs);
      child.once('error', (err) => finish({ code: null, stdout: '', stderr: '', error: err.message }));
      child.once('exit', (code) => finish({ code, stdout: '', stderr: '' }));
      child.unref();
    });
  },
};
