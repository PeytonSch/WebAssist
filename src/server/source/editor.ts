import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * How each editor is started to show a file at a line. Pure: everything about the machine comes
 * in through EditorMachine, so the commands for Windows, macOS and Linux can all be tested here.
 *
 * Programs are always started without a shell, with the file as an argument of its own, so a
 * path is never read as shell syntax. The one exception is a .cmd or .bat launcher on Windows,
 * which only cmd.exe can run; see cmdStep.
 */

export type EditorKind = '' | 'vscode' | 'idea' | 'emacs' | 'nvim' | 'custom';

export interface EditorSettings {
  kind: EditorKind;
  /** The editor's program; empty: found in the usual places. */
  program: string;
  /** Neovim: open the file in a running nvim when there is one. */
  nvimReuse: boolean;
  /** Neovim: the command that opens a terminal window running {cmd}. */
  terminal: string;
  /** Custom: the command line, with placeholders. */
  custom: string;
}

export const EDITOR_NAMES: Record<Exclude<EditorKind, ''>, string> = {
  vscode: 'VS Code',
  idea: 'IntelliJ IDEA',
  emacs: 'Emacs',
  nvim: 'Neovim',
  custom: 'your editor',
};

/** Terminal presets for opening nvim in a new window, per platform. */
export const TERMINAL_PRESETS: { id: string; label: string; template: string; platforms: NodeJS.Platform[] }[] = [
  { id: 'wezterm', label: 'WezTerm', template: 'wezterm start --cwd {dir} -- {cmd}', platforms: ['win32', 'darwin', 'linux'] },
  { id: 'wt', label: 'Windows Terminal', template: 'wt -d {dir} {cmd}', platforms: ['win32'] },
  { id: 'kitty', label: 'kitty', template: 'kitty --directory {dir} {cmd}', platforms: ['darwin', 'linux'] },
  { id: 'alacritty', label: 'Alacritty', template: 'alacritty --working-directory {dir} -e {cmd}', platforms: ['win32', 'darwin', 'linux'] },
  { id: 'gnome', label: 'GNOME Terminal', template: 'gnome-terminal --working-directory={dir} -- {cmd}', platforms: ['linux'] },
  { id: 'konsole', label: 'Konsole', template: 'konsole --workdir {dir} -e {cmd}', platforms: ['linux'] },
  { id: 'xterm', label: 'xterm', template: 'xterm -e {cmd}', platforms: ['linux'] },
];

export const DEFAULT_TERMINAL = TERMINAL_PRESETS[0].template;

export class EditorError extends Error {
  constructor(message: string, public hint?: string, public output?: string) {
    super(message);
  }
}

// ── Machine ─────────────────────────────────────────────

export interface EditorMachine {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  tmpdir: string;
  user: string;
  isFile(path: string): boolean;
  /** Names in a folder; empty when it cannot be read. */
  listDir(path: string): string[];
  readText(path: string): string | null;
  /** Modification time, or 0. */
  mtimeMs(path: string): number;
}

export function thisEditorMachine(): EditorMachine {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    tmpdir: tmpdir(),
    user: (() => {
      try {
        return userInfo().username;
      } catch {
        return process.env.USER ?? process.env.USERNAME ?? '';
      }
    })(),
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        // Windows app execution aliases (wt.exe in WindowsApps) cannot be followed by stat, but
        // they run; the link itself is there.
        try {
          return process.platform === 'win32' && !lstatSync(p).isDirectory();
        } catch {
          return false;
        }
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8').slice(0, 64 * 1024);
      } catch {
        return null;
      }
    },
    mtimeMs: (p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    },
  };
}

const pathFor = (m: EditorMachine) => (m.platform === 'win32' ? win32 : posix);

/** Environment variable names are case-insensitive on Windows. */
export function envVar(m: EditorMachine, name: string): string | undefined {
  if (m.platform !== 'win32') return m.env[name];
  const key = Object.keys(m.env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? m.env[key] : undefined;
}

/**
 * The environment editors start with. Without these, an Electron editor (VS Code) started from
 * the Debug Hub desktop app, itself Electron, would run as plain Node instead of opening.
 */
export function editorEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^ELECTRON_(RUN_AS_NODE|NO_ATTACH_CONSOLE)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Finds a program the way a shell would: a path as it is, otherwise each PATH folder, trying the
 * PATHEXT extensions on Windows (code → code.cmd).
 */
export function which(name: string, m: EditorMachine): string | null {
  const path = pathFor(m);
  if (!name) return null;
  if (path.isAbsolute(name) || /[\\/]/.test(name)) return m.isFile(name) ? name : null;
  const dirs = (envVar(m, 'PATH') ?? '').split(m.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = m.platform === 'win32'
    ? (path.extname(name) ? [''] : (envVar(m, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()))
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir.replace(/^"(.*)"$/, '$1'), name + ext);
      if (m.isFile(p)) return p;
    }
  }
  return null;
}

/** Folders in `dir` whose name matches `re`, newest version first (by name). */
function globDirs(m: EditorMachine, dir: string | undefined, re: RegExp): string[] {
  if (!dir) return [];
  return m.listDir(dir)
    .filter((n) => re.test(n))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map((n) => pathFor(m).join(dir, n));
}

// ── Finding the editor ──────────────────────────────────

export interface ProgramLocation {
  path: string | null;
  source: 'settings' | 'found' | 'none';
  tried: string[];
  problem: string | null;
}

/**
 * The real program behind a Windows .cmd launcher, when it is a one-line wrapper around an .exe:
 * VS Code's bin\code.cmd runs ..\Code.exe, and JetBrains Toolbox's scripts\idea.cmd starts the
 * IDE's idea64.exe. Running the .exe directly avoids cmd.exe altogether.
 */
export function unwrapCmd(cmdFile: string, m: EditorMachine): string | null {
  const path = win32;
  const dir = path.dirname(cmdFile);
  const text = m.readText(cmdFile);
  if (text) {
    // "%~dp0..\Code.exe": relative to the script's own folder.
    const rel = /"%~dp0([^"%]+\.exe)"/i.exec(text);
    if (rel) {
      const exe = path.normalize(path.join(dir, rel[1]));
      if (m.isFile(exe)) return exe;
    }
    for (const mm of text.matchAll(/"([A-Za-z]:\\[^"%]+\.exe)"/gi)) if (m.isFile(mm[1])) return mm[1];
  }
  // VS Code's layout, should the script change: <install>\bin\code.cmd next to <install>\Code.exe.
  if (/^code(-insiders)?\.cmd$/i.test(path.basename(cmdFile))) {
    const exe = path.join(dir, '..', /insiders/i.test(cmdFile) ? 'Code - Insiders.exe' : 'Code.exe');
    if (m.isFile(path.normalize(exe))) return path.normalize(exe);
  }
  return null;
}

/** Where each editor is usually installed, most likely first. PATH comes first, then fixed places. */
export function editorCandidates(kind: EditorKind, m: EditorMachine): string[] {
  const path = pathFor(m);
  const out: (string | null | undefined)[] = [];
  const env = (n: string) => envVar(m, n);
  const win = m.platform === 'win32';
  const mac = m.platform === 'darwin';
  if (kind === 'vscode') {
    out.push(which('code', m));
    if (win) {
      out.push(...['LOCALAPPDATA', 'PROGRAMFILES'].map((v) => env(v) && path.join(env(v)!, v === 'LOCALAPPDATA' ? 'Programs' : '', 'Microsoft VS Code', 'Code.exe')));
    } else if (mac) {
      for (const base of ['/Applications', path.join(m.home, 'Applications')]) out.push(path.join(base, 'Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'));
    } else out.push('/usr/bin/code', '/snap/bin/code', '/usr/share/code/bin/code');
  } else if (kind === 'idea') {
    if (win) {
      out.push(which('idea64.exe', m), which('idea', m));
      const local = env('LOCALAPPDATA');
      if (local) out.push(path.join(local, 'JetBrains', 'Toolbox', 'scripts', 'idea.cmd'));
      out.push(...globDirs(m, local && path.join(local, 'Programs'), /^IntelliJ IDEA/i).map((d) => path.join(d, 'bin', 'idea64.exe')));
      for (const v of ['PROGRAMFILES', 'PROGRAMFILES(X86)']) {
        out.push(...globDirs(m, env(v) && path.join(env(v)!, 'JetBrains'), /^IntelliJ IDEA/i).map((d) => path.join(d, 'bin', 'idea64.exe')));
      }
    } else if (mac) {
      out.push(which('idea', m));
      for (const base of ['/Applications', path.join(m.home, 'Applications')]) {
        out.push(...globDirs(m, base, /^IntelliJ IDEA.*\.app$/i));
      }
    } else {
      out.push(which('idea', m), which('idea.sh', m), which('intellij-idea-ultimate', m), which('intellij-idea-community', m));
      out.push(path.join(m.home, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts', 'idea'), '/snap/bin/intellij-idea-ultimate', '/snap/bin/intellij-idea-community');
      out.push(...globDirs(m, '/opt', /^(idea|intellij)/i).map((d) => path.join(d, 'bin', 'idea.sh')));
    }
  } else if (kind === 'emacs') {
    out.push(which('emacsclient', m));
    if (win) {
      for (const v of ['PROGRAMFILES', 'PROGRAMFILES(X86)']) {
        const base = env(v) && path.join(env(v)!, 'Emacs');
        if (!base) continue;
        out.push(path.join(base, 'bin', 'emacsclient.exe'), ...globDirs(m, base, /^emacs-/i).map((d) => path.join(d, 'bin', 'emacsclient.exe')));
      }
      const profile = env('USERPROFILE');
      if (profile) out.push(path.join(profile, 'scoop', 'apps', 'emacs', 'current', 'bin', 'emacsclient.exe'));
    } else {
      out.push('/opt/homebrew/bin/emacsclient', '/usr/local/bin/emacsclient', '/usr/bin/emacsclient');
      if (mac) out.push('/Applications/Emacs.app/Contents/MacOS/bin/emacsclient');
    }
  } else if (kind === 'nvim') {
    out.push(which('nvim', m));
    if (win) {
      for (const v of ['PROGRAMFILES', 'PROGRAMFILES(X86)']) out.push(env(v) && path.join(env(v)!, 'Neovim', 'bin', 'nvim.exe'));
      const local = env('LOCALAPPDATA');
      if (local) out.push(path.join(local, 'Programs', 'Neovim', 'bin', 'nvim.exe'), path.join(local, 'Microsoft', 'WinGet', 'Links', 'nvim.exe'));
      const profile = env('USERPROFILE');
      if (profile) out.push(path.join(profile, 'scoop', 'shims', 'nvim.exe'));
    } else {
      out.push('/opt/homebrew/bin/nvim', '/usr/local/bin/nvim', '/usr/bin/nvim', '/snap/bin/nvim', path.join(m.home, '.local', 'bin', 'nvim'));
    }
  }
  return [...new Set(out.filter((p): p is string => !!p))];
}

const isApp = (p: string) => /\.app\/?$/i.test(p);

/** The editor's program: the one in Settings, or the first that exists where it is usually installed. */
export function findEditor(kind: EditorKind, configured: string, m: EditorMachine): ProgramLocation {
  const wanted = configured.trim().replace(/^"(.*)"$/, '$1');
  const label = kind ? EDITOR_NAMES[kind] : 'editor';
  const exists = (p: string) => m.isFile(p) || (m.platform === 'darwin' && isApp(p) && m.listDir(p).length > 0);
  if (wanted) {
    const p = which(wanted, m) ?? (exists(wanted) ? wanted : null);
    if (p) return { path: p, source: 'settings', tried: [wanted], problem: null };
    return { path: null, source: 'settings', tried: [wanted], problem: `There is no program at ${wanted}. Fix the editor program in Settings, or clear it to find ${label} automatically.` };
  }
  const tried = editorCandidates(kind, m);
  const found = tried.find(exists);
  if (found) return { path: found, source: 'found', tried, problem: null };
  return { path: null, source: 'none', tried, problem: `${label} was not found on PATH or where it is usually installed. Set its program in Settings › Source code.` };
}

// ── Steps ───────────────────────────────────────────────

/** One program to start. */
export interface Step {
  file: string;
  args: string[];
  /** Windows only: the arguments are already quoted for cmd.exe. */
  verbatim: boolean;
  /**
   * A helper whose exit status says whether it worked (emacsclient, nvim --remote-send): run hidden,
   * with its output read. Otherwise a window that outlives Debug Hub: detached and visible.
   */
  helper: boolean;
  /** The command line, for showing the user. */
  display: string;
}

/** A command line for showing to the user (never run through a shell). */
export function displayLine(file: string, args: string[], platform: NodeJS.Platform): string {
  return [file, ...args].map((a) => quoteArg(a, platform)).join(' ');
}

/** Quotes a value for a command line shown to the user, the way it would be typed. */
export function quoteArg(v: string, platform: NodeJS.Platform): string {
  const plain = platform === 'win32' ? /^[\w@+=:,./\\~-]+$/ : /^[\w@+=:,./~-]+$/;
  if (plain.test(v)) return v;
  if (platform === 'win32') return `"${v.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  return nestedQuote(v, platform);
}

/**
 * Quotes a value for a command line that another program will split: the argument after
 * nu -c, sh -c or cmd /c. Plain values stay as they are. Elsewhere than Windows the value goes in
 * single quotes, which no common shell expands inside. On Windows the program may be cmd.exe
 * (no single quotes), PowerShell or nushell (both read backslashes in double quotes as escapes),
 * so a path is written with forward slashes, which Windows and nvim accept, in double quotes.
 */
export function nestedQuote(v: string, platform: NodeJS.Platform): string {
  const plain = platform === 'win32' ? /^[\w@+=:,./\\~-]+$/ : /^[\w@+=:,./~-]+$/;
  if (plain.test(v)) return v;
  if (platform === 'win32') {
    if (v.includes('"')) throw new EditorError(`Cannot put ${v} inside a quoted argument of the command`);
    return `"${v.replace(/\\/g, '/')}"`;
  }
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * How to start `program` with `args`. A .cmd or .bat on Windows cannot be started without
 * cmd.exe in current Node (since the 2024 "BatBadBut" fix), and cmd.exe has its own syntax. So:
 * first the .exe the script wraps, if it is a known one-line wrapper; otherwise cmd.exe /d /s /c
 * with every argument quoted, refusing arguments with characters cmd.exe would still interpret
 * inside quotes (" and %; delayed ! expansion is turned off with /v:off).
 */
export function makeStep(program: string, args: string[], helper: boolean, m: EditorMachine): Step {
  if (m.platform === 'win32' && /\.(cmd|bat)$/i.test(program)) {
    const exe = unwrapCmd(program, m);
    if (exe) return { file: exe, args, verbatim: false, helper, display: displayLine(exe, args, 'win32') };
    return cmdStep(program, args, helper, m);
  }
  return { file: program, args, verbatim: false, helper, display: displayLine(program, args, m.platform) };
}

export function cmdStep(script: string, args: string[], helper: boolean, m: EditorMachine): Step {
  const all = [script.replace(/\//g, '\\'), ...args];
  const bad = all.find((a) => /["%\r\n\0]/.test(a));
  if (bad !== undefined) {
    throw new EditorError(
      `Cannot pass ${bad} to ${win32.basename(script)}: a .cmd or .bat script cannot safely be given text containing " or %.`,
      'Point the editor program in Settings at the .exe instead of the script.',
    );
  }
  const comspec = envVar(m, 'ComSpec') || 'cmd.exe';
  const line = all.map((a) => `"${a}"`).join(' ');
  const cmdArgs = ['/d', '/v:off', '/s', '/c', `"${line}"`];
  return { file: comspec, args: cmdArgs, verbatim: true, helper, display: `${comspec} ${cmdArgs.join(' ')}` };
}

// ── Templates ───────────────────────────────────────────

export const PLACEHOLDERS = ['file', 'line', 'column', 'dir', 'cmd'] as const;

/**
 * Splits a command line template into arguments. Double or single quotes group text with spaces
 * into one argument and are removed; a backslash is an ordinary character (Windows paths), so
 * a quote cannot be escaped. Splitting happens before the placeholders are filled in, so a path
 * with spaces stays one argument wherever it goes.
 */
export function splitTemplate(template: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inArg = false;
  let quote: string | null = null;
  for (const c of template.trim()) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) out.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (quote) throw new EditorError(`The command has an unclosed ${quote}: ${template}`);
  if (inArg) out.push(cur);
  return out;
}

/** Problems with a template, for Settings: bad quoting and unknown {placeholders}. */
export function checkTemplate(template: string, required: string[] = []): string | null {
  if (!template.trim()) return null;
  try {
    splitTemplate(template);
  } catch (err) {
    return (err as Error).message.replace(/: .*$/, '');
  }
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) return `Unknown placeholder {${m[1]}}; use ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`;
  }
  for (const r of required) if (!template.includes(`{${r}}`)) return `Must contain {${r}}`;
  return null;
}

export interface TemplateVars {
  file: string;
  line: number;
  column: number;
  dir: string;
  /** For terminal templates: the nvim command, as separate arguments. */
  cmd?: string[];
}

/**
 * Fills in a template's placeholders. {cmd} standing alone becomes several arguments. A
 * placeholder inside an argument that contains spaces (a command line for another program, as
 * in nu -c "nvim +{line} {file}") gets values quoted for that program, see nestedQuote; anywhere
 * else the value goes in as it is.
 */
export function expandTemplate(template: string, vars: TemplateVars, platform: NodeJS.Platform): string[] {
  const args = splitTemplate(template);
  const out: string[] = [];
  for (const arg of args) {
    if (arg === '{cmd}') {
      out.push(...(vars.cmd ?? []));
      continue;
    }
    const nested = /\s/.test(arg);
    const val = (v: string) => (nested ? nestedQuote(v, platform) : v);
    out.push(
      arg.replace(/\{(file|line|column|dir|cmd)\}/g, (_, k: string) => {
        if (k === 'cmd') return (vars.cmd ?? []).map((c) => nestedQuote(c, platform)).join(' ');
        return val(String(vars[k as 'file' | 'line' | 'column' | 'dir']));
      }),
    );
  }
  return out;
}

// ── Per-editor commands ─────────────────────────────────

export interface Target {
  file: string;
  line: number;
  column: number;
  /** The project root, for {dir} and the terminal's working folder. */
  dir: string;
}

/**
 * The command that opens `t` in VS Code, IDEA or Emacs. On Windows VS Code is started through
 * Code.exe itself (what code.cmd runs), with the same --goto argument.
 */
export function editorStep(kind: 'vscode' | 'idea' | 'emacs', program: string, t: Target, m: EditorMachine): Step {
  if (kind === 'vscode') {
    // On Windows, code.cmd becomes Code.exe; Code.exe given directly takes the same arguments.
    return makeStep(program, ['--goto', `${t.file}:${t.line}:${t.column}`], false, m);
  }
  if (kind === 'idea') {
    if (m.platform === 'darwin' && isApp(program)) {
      const args = ['-na', program.replace(/\/$/, ''), '--args', '--line', String(t.line), t.file];
      return { file: 'open', args, verbatim: false, helper: false, display: displayLine('open', args, 'darwin') };
    }
    return makeStep(program, ['--line', String(t.line), t.file], false, m);
  }
  // emacsclient -n returns at once; its exit status says whether a server took the file.
  return makeStep(program, ['-n', `+${t.line}:${t.column}`, t.file], true, m);
}

/** The custom command: its first word is the program, found on PATH like any other. */
export function customStep(template: string, t: Target, m: EditorMachine): Step {
  if (!template.trim()) throw new EditorError('No command is set for the custom editor.', 'Enter one in Settings › Source code, e.g. myeditor --line {line} {file}.');
  const args = expandTemplate(template, t, m.platform);
  const program = which(args[0], m) ?? args[0];
  return makeStep(program, args.slice(1), false, m);
}

/** nvim in a new terminal window: the terminal template with {cmd} = nvim +<line> <file>. */
export function terminalStep(template: string, nvim: string, t: Target, m: EditorMachine): Step {
  const tpl = template.trim() || DEFAULT_TERMINAL;
  const cmd = [nvim, `+${t.line}`, t.file];
  const args = expandTemplate(tpl, { ...t, cmd }, m.platform);
  const program = which(args[0], m);
  if (!program) {
    throw new EditorError(
      `The terminal ${args[0]} was not found on PATH.`,
      'Pick the terminal you use under Settings › Source code, or give its full path in the command.',
    );
  }
  // Windows Terminal reads ";" in its arguments as "and then open another tab"; \; is a literal one.
  const rest = /^wt(\.exe)?$/i.test(program.split(/[\\/]/).pop() ?? '') ? args.slice(1).map((a) => a.replace(/;/g, '\\;')) : args.slice(1);
  return makeStep(program, rest, false, m);
}

// ── Neovim ──────────────────────────────────────────────

export interface NvimServer {
  /** What --server takes: a named pipe on Windows, a socket path elsewhere. */
  addr: string;
  pid: number;
  /** When the socket was created, where that is known; 0 otherwise. */
  startedMs: number;
}

const NVIM_SOCKET = /^nvim\.(\d+)\.(\d+)$/;

/**
 * Running Neovim instances. Since 0.9 every nvim listens on an RPC address of its own, even when
 * started without --listen: a named pipe \\.\pipe\nvim.<pid>.<n> on Windows, and on Linux and
 * macOS a socket nvim.<pid>.<n> in $XDG_RUNTIME_DIR, or in a folder under $TMPDIR/nvim.<user>/.
 * Some of these may be left over from an nvim that crashed; the caller checks each one answers.
 */
export function findNvimServers(m: EditorMachine): NvimServer[] {
  const out: NvimServer[] = [];
  const add = (dir: string, name: string, path: string) => {
    const mm = NVIM_SOCKET.exec(name);
    if (mm) out.push({ addr: path, pid: Number(mm[1]), startedMs: m.platform === 'win32' ? 0 : m.mtimeMs(path) });
    void dir;
  };
  if (m.platform === 'win32') {
    const dir = '\\\\.\\pipe\\';
    for (const name of m.listDir(dir)) add(dir, name, `${dir}${name}`);
    return out.sort(newestFirst);
  }
  const path = posix;
  const runtime = m.env.XDG_RUNTIME_DIR;
  if (runtime) for (const name of m.listDir(runtime)) add(runtime, name, path.join(runtime, name));
  const tmpRoots = [...new Set([m.tmpdir, m.env.TMPDIR, '/tmp'].filter((d): d is string => !!d))];
  for (const tmp of tmpRoots) {
    const base = path.join(tmp, `nvim.${m.user}`);
    for (const sub of m.listDir(base)) {
      const dir = path.join(base, sub);
      for (const name of m.listDir(dir)) add(dir, name, path.join(dir, name));
    }
  }
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.addr) && seen.add(s.addr)).sort(newestFirst);
}

/** Most recently started first: by socket time where known, else by process id. */
const newestFirst = (a: NvimServer, b: NvimServer) => b.startedMs - a.startedMs || b.pid - a.pid;

/** Text inside a Vim single-quoted string: only ' needs doubling. */
export const vimString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * The keys sent to a running nvim with --remote-send to open `file` at a line. <C-\><C-N> first
 * leaves insert, visual, command-line or terminal mode, whatever the user was in. The path is
 * passed as a Vim string through fnameescape(), so spaces, %, #, | and wildcards in it are not
 * read as Ex syntax; < is written <lt> so it is not taken for a key name like <CR>.
 */
export function nvimOpenKeys(file: string, line: number, column: number): string {
  const path = vimString(file).replace(/</g, '<lt>');
  return `<C-\\><C-N>:execute 'edit ' .. fnameescape(${path}) | call cursor(${line}, ${column}) | normal! zvzz<CR>`;
}

/** Escapes a path for an Ex command line typed by hand (:e path), the way fnameescape() does. */
export function exEscape(path: string, platform: NodeJS.Platform): string {
  // On Windows the backslash is the path separator, so it is not an escape there.
  const special = platform === 'win32' ? /[ \t\n*?[{`$%#'"|!<]/g : /[ \t\n*?[{`$\\%#'"|!<]/g;
  const out = path.replace(special, '\\$&');
  return /^[+>-]/.test(out) ? `\\${out}` : out;
}

/** Arguments for asking a running nvim something, or telling it to open a file. */
export const nvimQueryArgs = (addr: string) => ['--server', addr, '--remote-expr', 'getcwd()'];
export const nvimSendArgs = (addr: string, keys: string) => ['--server', addr, '--remote-send', keys];

/**
 * Which running nvim should open a file of the project at `root`: the one whose working folder is
 * in the project (or holds it), else the most recently started. `cwds` maps each server that
 * answered to its working folder; servers that did not answer are gone and are skipped.
 */
export function pickNvimServer(servers: NvimServer[], cwds: Map<string, string>, root: string, platform: NodeJS.Platform): NvimServer | null {
  const norm = (p: string) => {
    let s = p.replace(/[\\/]+$/, '');
    if (platform === 'win32') s = s.replace(/\//g, '\\').toLowerCase();
    return s;
  };
  const sep = platform === 'win32' ? '\\' : '/';
  const r = norm(root);
  const alive = servers.filter((s) => cwds.has(s.addr));
  const within = (a: string, b: string) => a === b || a.startsWith(b + sep);
  return (
    alive.find((s) => r && within(norm(cwds.get(s.addr)!), r)) ??
    alive.find((s) => r && within(r, norm(cwds.get(s.addr)!))) ??
    alive[0] ??
    null
  );
}
