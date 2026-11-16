import type { StartSequence, StartStep } from '../../shared/tomcat';
import type { StartCommand } from '../config';
import { commandLabel, type CommandEnd } from './commands';

/**
 * One Start Tomcat: brings up the whole dev setup in a fixed order.
 *
 *   1. The start commands, in the order of the settings. Usually what Tomcat depends on (the
 *      database), so they come first. A command marked "wait" must finish, and finish well,
 *      before the next step; one that fails stops the sequence and Tomcat is not started.
 *      The others (dev servers, watchers) are started and left running.
 *   2. Tomcat, with the start script or its own bin/startup.
 *   3. Chrome with its debugging port, last, so the app is on its way up when it opens.
 *
 * The steps are injected, so the order and the failure handling can be tested on their own.
 */

export interface StartedCommand {
  id: number;
  pid: number | null;
  ended: Promise<CommandEnd>;
  /** It was already running from before; it was not started again. */
  already: boolean;
}

export interface SequenceSteps {
  commands: StartCommand[];
  /** Starts a command, or returns its run when it is still running from before. Throws if it cannot start. */
  startCommand: (c: StartCommand) => Promise<StartedCommand>;
  /** Starts Tomcat. Returns what happened; throws if it could not. */
  startTomcat: () => Promise<string>;
  /** Starts Chrome, when that is part of the sequence. */
  startChrome?: () => Promise<{ ok: boolean; message: string; hint?: string }>;
  /** How long to wait for a command marked "wait". */
  waitMs: number;
  note: (level: 'info' | 'warn' | 'error', summary: string, data?: Record<string, unknown>) => void;
  /** Something changed, for anyone showing the progress. */
  onChange?: () => void;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

function howEnded(e: CommandEnd): string {
  if (e.error) return `could not run: ${e.error}`;
  if (e.stopped) return 'was stopped';
  return e.exitCode != null ? `exited with code ${e.exitCode}` : `ended by signal ${e.signal}`;
}

export class Sequence {
  readonly state: StartSequence;
  /** Settles when the sequence has finished, whichever way. */
  done: Promise<StartSequence> | null = null;

  constructor(private s: SequenceSteps, only: boolean) {
    const step = (kind: StartStep['kind'], label: string): StartStep => ({ kind, label, status: 'waiting', detail: null, runId: null });
    const steps: StartStep[] = [];
    if (!only) steps.push(...s.commands.map((c) => step('command', commandLabel(c))));
    steps.push(step('tomcat', 'Tomcat'));
    if (!only && s.startChrome) steps.push(step('chrome', 'Chrome'));
    this.state = { startedAt: new Date().toISOString(), endedAt: null, running: true, only, steps, outcome: null, message: null };
  }

  start(): Promise<StartSequence> {
    this.done ??= this.run();
    return this.done;
  }

  private changed(): void {
    this.s.onChange?.();
  }

  private async run(): Promise<StartSequence> {
    const steps = this.state.steps;
    let failed: string | null = null;
    let i = 0;
    for (; i < steps.length && !failed; i++) {
      const step = steps[i];
      step.status = 'running';
      this.changed();
      try {
        if (step.kind === 'command') failed = await this.command(step, this.s.commands[i]);
        else if (step.kind === 'tomcat') {
          step.detail = await this.s.startTomcat();
          step.status = 'done';
        } else {
          const r = await this.s.startChrome!();
          step.status = r.ok ? 'done' : 'failed';
          step.detail = r.hint ? `${r.message} ${r.hint}` : r.message;
          // The last step: nothing is left to hold back, but the outcome says it.
          if (!r.ok) failed = `Chrome did not start: ${step.detail}`;
        }
      } catch (err) {
        step.status = 'failed';
        step.detail = (err as Error).message;
        failed = step.kind === 'tomcat' ? `Tomcat could not be started: ${step.detail}` : `${step.label} could not be started: ${step.detail}${this.notStarting(i)}`;
      }
      this.changed();
    }
    for (; i < steps.length; i++) steps[i].status = 'skipped';

    Object.assign(this.state, { running: false, endedAt: new Date().toISOString(), outcome: failed ? 'failed' : 'ok', message: failed ?? this.summary() });
    // Starting Tomcat alone is already noted by the script run.
    if (failed || steps.length > 1) this.s.note(failed ? 'error' : 'info', failed ?? this.state.message!);
    this.changed();
    return this.state;
  }

  /** Runs one command step. Returns why the sequence must stop, or null to go on. */
  private async command(step: StartStep, c: StartCommand): Promise<string | null> {
    const started = await this.s.startCommand(c);
    step.runId = started.id;
    if (started.already && !c.wait) {
      step.status = 'skipped';
      step.detail = `Already running (process ${started.pid}), so it was not started again.`;
      return null;
    }
    if (!c.wait) {
      step.status = 'done';
      step.detail = 'Started; left running.';
      return null;
    }
    step.detail = started.already ? `Already running (process ${started.pid}); waiting for it to finish.` : 'Waiting for it to finish…';
    this.changed();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), this.s.waitMs)));
    const end = await Promise.race([started.ended, timeout]);
    clearTimeout(timer);
    const index = this.state.steps.indexOf(step);
    if (end === 'timeout') {
      step.status = 'failed';
      step.detail = `Still running after ${minutes(this.s.waitMs)}.`;
      return `${step.label} did not finish within ${minutes(this.s.waitMs)}${this.notStarting(index)} It is still running: stop it on the Tomcat page, or untick “wait” for it in Settings if it is meant to keep running.`;
    }
    if (!end.error && !end.stopped && end.exitCode === 0) {
      step.status = 'done';
      step.detail = 'Finished.';
      return null;
    }
    step.status = 'failed';
    step.detail = `${howEnded(end)[0].toUpperCase()}${howEnded(end).slice(1)}.`;
    return `${step.label} ${howEnded(end)}${this.notStarting(index)}`;
  }

  /** What a failure at step i holds back, for the message. */
  private notStarting(i: number): string {
    const rest = this.state.steps.slice(i + 1);
    if (rest.some((s) => s.kind === 'tomcat')) return ', so Tomcat was not started.';
    return '.';
  }

  private summary(): string {
    const cmds = this.state.steps.filter((s) => s.kind === 'command');
    const parts = [`Started Tomcat`];
    if (cmds.length) parts.push(`after ${cmds.length} start command${cmds.length === 1 ? '' : 's'}`);
    if (this.state.steps.some((s) => s.kind === 'chrome')) parts.push('and Chrome');
    return `${parts.join(' ')}.`;
  }
}
