import { basename, dirname } from 'node:path';
import type { Config } from '../config';
import {
  EDITOR_NAMES,
  EditorError,
  editorStep,
  customStep,
  findEditor,
  findNvimServers,
  makeStep,
  nvimOpenKeys,
  nvimQueryArgs,
  nvimSendArgs,
  pickNvimServer,
  splitTemplate,
  terminalStep,
  TERMINAL_PRESETS,
  thisEditorMachine,
  type EditorKind,
  type EditorMachine,
  type ProgramLocation,
  type Step,
  type Target,
} from './editor';
import { SourceIndex, outerClass, type Candidate, type IndexStatus } from './index';
import { processRunner, type Runner } from './launch';
import { declarationLine, readHead } from './scan';

/**
 * "Go to source": the source index plus opening a file in the configured editor. Only files in
 * the index are ever opened; a request names a class, never a path (see open()).
 */

/** A problem the user can act on. `status` is the HTTP status; the rest goes into the answer. */
export class SourceError extends Error {
  constructor(
    message: string,
    public status: number,
    public extra: { hint?: string; settings?: boolean; candidates?: Candidate[]; output?: string; command?: string } = {},
  ) {
    super(message);
  }
}

export interface OpenRequest {
  className: string;
  /** From the stack frame: OrderService.java. */
  file?: string;
  line?: number;
  column?: number;
  webapp?: string;
  /** When several files define the class: the one the user chose (must be one of them). */
  pick?: string;
}

export interface OpenResult {
  file: string;
  line: number;
  project: string;
  module: string;
  editor: string;
  /** How it was opened, e.g. "the running nvim in C:/dev/shop", "a new WezTerm window". */
  how: string;
  message: string;
  command: string;
}

export interface EditorStatus {
  kind: EditorKind;
  name: string;
  program: ProgramLocation | null;
  /** Neovim: the running instances found right now. */
  nvimServers?: number;
}

export interface SourceServiceOptions {
  machine?: EditorMachine;
  runner?: Runner;
  pollMs?: number;
  /** How long a launched window is watched for a failing exit. */
  watchMs?: number;
}

const HELPER_MS = 8_000;
const QUERY_MS = 3_000;

export class SourceService {
  index: SourceIndex;
  private m: EditorMachine;
  private runner: Runner;

  constructor(private cfg: Config, private opts: SourceServiceOptions = {}) {
    this.m = opts.machine ?? thisEditorMachine();
    this.runner = opts.runner ?? processRunner;
    this.index = new SourceIndex(cfg.tomcat.warWatch, cfg.editor.sourceDirs, { pollMs: opts.pollMs });
  }

  start(): void {
    this.index.start();
  }

  stop(): void {
    this.index.stop();
  }

  reconfigure(cfg: Config): void {
    this.cfg = cfg;
    this.index.reconfigure(cfg.tomcat.warWatch, cfg.editor.sourceDirs);
  }

  /** For Settings: the editor that would be used with these (possibly unsaved) values. */
  editorStatus(kind: EditorKind = this.cfg.editor.kind, program = this.cfg.editor.program): EditorStatus {
    if (!kind) return { kind, name: 'None', program: null };
    const status: EditorStatus = { kind, name: EDITOR_NAMES[kind], program: kind === 'custom' ? null : findEditor(kind, program, this.m) };
    if (kind === 'nvim') status.nvimServers = findNvimServers(this.m).length;
    return status;
  }

  status(): { index: IndexStatus; generation: number; sample: string | null } {
    return { index: this.index.status(), generation: this.index.generation, sample: this.index.sampleClass() };
  }

  /** Which of `names` are in the sources, for the detail panel to link them. */
  known(names: string[], webapp?: string): { generation: number; known: Record<string, number> } {
    return { generation: this.index.generation, known: this.index.known(names, webapp) };
  }

  /** Opens the first indexed class, for the Test button. */
  async test(): Promise<OpenResult> {
    await this.firstBuild();
    const sample = this.index.sampleClass();
    if (!sample) throw new SourceError('No source files are indexed yet, so there is nothing to open.', 404, { hint: 'Add a WAR watch folder or a source folder in Settings.', settings: true });
    return this.open({ className: sample });
  }

  /** The first build, when a lookup comes before it has finished. */
  private async firstBuild(): Promise<void> {
    if (this.index.status().builtAt) return;
    await Promise.race([this.index.ready(), new Promise((r) => setTimeout(r, 20_000))]);
  }

  async open(req: OpenRequest): Promise<OpenResult> {
    const kind = this.cfg.editor.kind;
    if (!kind) throw new SourceError('No editor is set up for Go to source.', 400, { hint: 'Choose your editor in Settings › Source code.', settings: true });
    const name = String(req.className ?? '').trim();
    if (!name || name.length > 500) throw new SourceError('Say which class to open.', 400);
    await this.firstBuild();
    const fileName = typeof req.file === 'string' && /^[\w$.-]{1,200}$/.test(req.file) ? req.file : undefined;
    const candidates = await this.index.resolve(name, { file: fileName, line: Number(req.line) || 0, webapp: req.webapp });
    if (!candidates.length) {
      const n = this.index.status().projects.length;
      throw new SourceError(`${outerClass(name)} is not in the indexed sources.`, 404, {
        hint: n
          ? `Searched ${n === 1 ? 'one project' : `${n} projects`}. If it is your code, add its project folder in Settings › Source code.`
          : 'No projects are indexed. Add a WAR watch folder or a source folder in Settings › Source code.',
        settings: true,
      });
    }
    let chosen: Candidate;
    if (req.pick !== undefined) {
      // The choice must be one of the files the index offered; any other path is refused.
      const hit = candidates.find((c) => c.file === req.pick);
      if (!hit) throw new SourceError('That file is not one of the sources of this class.', 400);
      chosen = hit;
    } else if (candidates.length > 1) {
      throw new SourceError(`${candidates.length} files define ${outerClass(name)}. Choose one.`, 409, { candidates });
    } else chosen = candidates[0];
    if (!this.index.has(chosen.file)) throw new SourceError('That file is not in the index.', 400);

    let line = chosen.line;
    if (!line) {
      // A logger or exception name has no line: open at the class declaration.
      const text = await readHead(chosen.file);
      const simple = outerClass(name).split('.').pop()!;
      line = (text && declarationLine(text, simple)) || 1;
    }
    const target: Target = { file: chosen.file, line, column: Math.max(1, Math.floor(Number(req.column) || 1)), dir: chosen.root || dirname(chosen.file) };
    const { how, step } = await this.launch(kind, target);
    const where = `${basename(chosen.file)}:${line}`;
    const editor = EDITOR_NAMES[kind];
    return {
      file: chosen.file,
      line,
      project: chosen.project,
      module: chosen.module,
      editor,
      how,
      message: kind === 'custom' ? `Opened ${where}` : `Opened ${where} in ${editor}${how ? ` (${how})` : ''}`,
      command: step.display,
    };
  }

  private async launch(kind: Exclude<EditorKind, ''>, t: Target): Promise<{ how: string; step: Step }> {
    const e = this.cfg.editor;
    try {
      if (kind === 'custom') return { how: '', step: await this.window(customStep(e.custom, t, this.m), 'The command') };
      const loc = findEditor(kind, e.program, this.m);
      if (!loc.path) throw new SourceError(loc.problem ?? 'Editor not found.', 400, { settings: true });
      if (kind === 'nvim') return await this.nvim(loc.path, t);
      if (kind === 'emacs') {
        const step = editorStep('emacs', loc.path, t, this.m);
        const r = await this.runner.run(step, HELPER_MS);
        if (r.code === 0) return { how: '', step };
        const output = (r.stderr || r.stdout || r.error || '').trim();
        const noServer = /server|connect|socket|no such file/i.test(output) || r.code === 1;
        throw new SourceError(
          noServer ? 'emacsclient could not reach a running Emacs.' : `emacsclient failed${r.code != null ? ` with exit code ${r.code}` : `: ${r.error}`}.`,
          502,
          {
            hint: noServer ? 'Start the Emacs server: M-x server-start, or add (server-start) to your init file (Doom: to config.el), then try again.' : undefined,
            output,
            command: step.display,
          },
        );
      }
      return { how: '', step: await this.window(editorStep(kind, loc.path, t, this.m), EDITOR_NAMES[kind]) };
    } catch (err) {
      if (err instanceof EditorError) throw new SourceError(err.message, 400, { hint: err.hint, settings: true, output: err.output });
      throw err;
    }
  }

  /** Starts a window (editor or terminal) and reports a launcher that fails straight away. */
  private async window(step: Step, label: string): Promise<Step> {
    const r = await this.runner.launch(step, this.opts.watchMs ?? 1_500);
    if (r.error) throw new SourceError(`${label} could not be started: ${r.error}`, 502, { command: step.display, settings: true });
    if (r.code !== null && r.code !== 0) throw new SourceError(`${label} exited with code ${r.code}.`, 502, { command: step.display, settings: true });
    return step;
  }

  /**
   * Neovim: a running nvim gets the file (the one working in this project, else the newest);
   * without one, or with reuse turned off, nvim starts in a new terminal window.
   */
  private async nvim(nvim: string, t: Target): Promise<{ how: string; step: Step }> {
    const e = this.cfg.editor;
    let sendProblem = '';
    if (e.nvimReuse) {
      const servers = findNvimServers(this.m).slice(0, 12);
      const cwds = new Map<string, string>();
      await Promise.all(
        servers.map(async (s) => {
          const r = await this.runner.run(makeStep(nvim, nvimQueryArgs(s.addr), true, this.m), QUERY_MS);
          if (r.code === 0 && r.stdout.trim()) cwds.set(s.addr, r.stdout.trim());
        }),
      );
      const server = pickNvimServer(servers, cwds, t.dir, this.m.platform);
      if (server) {
        const step = makeStep(nvim, nvimSendArgs(server.addr, nvimOpenKeys(t.file, t.line, t.column)), true, this.m);
        const r = await this.runner.run(step, HELPER_MS);
        if (r.code === 0) return { how: `the running nvim in ${cwds.get(server.addr)}`, step };
        sendProblem = (r.stderr || r.error || `exit code ${r.code}`).trim();
      }
    }
    const step = terminalStep(e.terminal, nvim, t, this.m);
    const preset = TERMINAL_PRESETS.find((p) => splitTemplate(p.template)[0] === splitTemplate(e.terminal || p.template)[0]);
    await this.window(step, preset?.label ?? 'The terminal');
    const how = `a new ${preset?.label ?? 'terminal'} window`;
    return { how: sendProblem ? `${how}; the running nvim did not answer: ${sendProblem}` : how, step };
  }
}
