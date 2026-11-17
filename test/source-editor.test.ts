import { describe, expect, it } from 'vitest';
import {
  checkTemplate,
  cmdStep,
  customStep,
  editorEnv,
  editorStep,
  exEscape,
  expandTemplate,
  findEditor,
  findNvimServers,
  nestedQuote,
  nvimOpenKeys,
  pickNvimServer,
  splitTemplate,
  terminalStep,
  which,
  type EditorMachine,
} from '../src/server/source/editor';

/** A machine made of a list of files, folder listings and file contents. */
function machine(platform: NodeJS.Platform, o: { env?: Record<string, string>; files?: string[]; dirs?: Record<string, string[]>; text?: Record<string, string>; mtimes?: Record<string, number> } = {}): EditorMachine {
  const files = new Set(o.files ?? []);
  return {
    platform,
    env: o.env ?? {},
    home: platform === 'win32' ? 'C:\\Users\\me' : '/home/me',
    tmpdir: '/tmp',
    user: 'me',
    isFile: (p) => files.has(p),
    listDir: (p) => o.dirs?.[p] ?? [],
    readText: (p) => o.text?.[p] ?? null,
    mtimeMs: (p) => o.mtimes?.[p] ?? 0,
  };
}

const target = { file: 'C:\\dev\\my shop\\src\\main\\java\\com\\x\\OrderService.java', line: 87, column: 5, dir: 'C:\\dev\\my shop' };
const posixTarget = { file: '/home/me/dev/my shop/src/main/java/com/x/OrderService.java', line: 87, column: 5, dir: '/home/me/dev/my shop' };

describe('templates', () => {
  it('splits on spaces, keeps quoted text together and treats backslashes as text', () => {
    expect(splitTemplate('wezterm start --cwd {dir} -- {cmd}')).toEqual(['wezterm', 'start', '--cwd', '{dir}', '--', '{cmd}']);
    expect(splitTemplate('"C:\\Program Files\\Ed\\ed.exe" --goto={file}:{line} \'a b\'')).toEqual(['C:\\Program Files\\Ed\\ed.exe', '--goto={file}:{line}', 'a b']);
    expect(splitTemplate('nu -c "nvim +{line} {file}"')).toEqual(['nu', '-c', 'nvim +{line} {file}']);
    expect(splitTemplate('a""b "" c')).toEqual(['ab', '', 'c']);
    expect(() => splitTemplate('ed "{file}')).toThrow(/unclosed "/);
  });

  it('fills in placeholders, keeping a path with spaces one argument', () => {
    expect(expandTemplate('ed --line {line} --col {column} {file}', target, 'win32')).toEqual(['ed', '--line', '87', '--col', '5', target.file]);
    expect(expandTemplate('ed {file}:{line}', target, 'win32')).toEqual(['ed', `${target.file}:87`]);
  });

  it('expands {cmd} into separate arguments, or quoted inside a command line for another program', () => {
    const cmd = ['nvim', '+87', target.file];
    expect(expandTemplate('wt -d {dir} {cmd}', { ...target, cmd }, 'win32')).toEqual(['wt', '-d', target.dir, 'nvim', '+87', target.file]);
    // Inside nu -c "…": Windows paths with spaces get forward slashes and double quotes.
    expect(expandTemplate('wezterm start -- nu -c "nvim +{line} {file}"', target, 'win32')).toEqual(['wezterm', 'start', '--', 'nu', '-c', 'nvim +87 "C:/dev/my shop/src/main/java/com/x/OrderService.java"']);
    expect(expandTemplate('kitty sh -c "{cmd}; exec $SHELL"', { ...posixTarget, cmd: ['nvim', '+87', posixTarget.file] }, 'linux')).toEqual(['kitty', 'sh', '-c', `nvim +87 '${posixTarget.file}'; exec $SHELL`]);
  });

  it('quotes values for nested command lines safely', () => {
    expect(nestedQuote('/a/b.java', 'linux')).toBe('/a/b.java');
    expect(nestedQuote('/a/$(rm x)/b.java', 'linux')).toBe("'/a/$(rm x)/b.java'");
    expect(nestedQuote("/a/it's/b.java", 'linux')).toBe('"/a/it\'s/b.java"');
    expect(nestedQuote("/a/it's $x/b", 'linux')).toBe('"/a/it\'s \\$x/b"');
    expect(nestedQuote('C:\\a b\\c', 'win32')).toBe('"C:/a b/c"');
    expect(nestedQuote('C:\\plain\\c.java', 'win32')).toBe('C:\\plain\\c.java');
  });

  it('checks templates for quoting, placeholders and what they must contain', () => {
    expect(checkTemplate('ed {file}', ['file'])).toBeNull();
    expect(checkTemplate('ed "{file}')).toMatch(/unclosed/);
    expect(checkTemplate('ed {path}')).toMatch(/Unknown placeholder \{path\}/);
    expect(checkTemplate('ed --line {line}', ['file'])).toBe('Must contain {file}');
  });
});

describe('Neovim', () => {
  it('sends keys that leave any mode and pass the path as a Vim string', () => {
    expect(nvimOpenKeys('/p/a b.java', 3, 1)).toBe("<C-\\><C-N>:execute 'edit ' .. fnameescape('/p/a b.java') | call cursor(3, 1) | normal! zvzz<CR>");
    // ' is doubled inside the string, < cannot start a key name.
    expect(nvimOpenKeys("C:\\it's\\<x>|%#.java", 1, 1)).toContain("fnameescape('C:\\it''s\\<lt>x>|%#.java')");
  });

  it('escapes paths for a hand-typed Ex command', () => {
    expect(exEscape('/a b/%#|x.java', 'linux')).toBe('/a\\ b/\\%\\#\\|x.java');
    expect(exEscape('C:\\a b\\x.java', 'win32')).toBe('C:\\a\\ b\\x.java');
    expect(exEscape('+x', 'linux')).toBe('\\+x');
  });

  it('finds running instances by their named pipes on Windows', () => {
    const m = machine('win32', { dirs: { '\\\\.\\pipe\\': ['mojo.1.2', 'nvim.4120.0', 'nvim.880.0', 'nvim-other'] } });
    expect(findNvimServers(m).map((s) => s.addr)).toEqual(['\\\\.\\pipe\\nvim.4120.0', '\\\\.\\pipe\\nvim.880.0']);
  });

  it('finds sockets in XDG_RUNTIME_DIR and the temp folder elsewhere, newest first', () => {
    const m = machine('linux', {
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      dirs: { '/run/user/1000': ['nvim.10.0', 'bus'], '/tmp/nvim.me': ['abc'], '/tmp/nvim.me/abc': ['nvim.20.0'] },
      mtimes: { '/run/user/1000/nvim.10.0': 2000, '/tmp/nvim.me/abc/nvim.20.0': 1000 },
    });
    expect(findNvimServers(m).map((s) => s.addr)).toEqual(['/run/user/1000/nvim.10.0', '/tmp/nvim.me/abc/nvim.20.0']);
  });

  it('prefers the nvim working in the project, skips dead ones, else the newest', () => {
    const servers = [
      { addr: 'a', pid: 3, startedMs: 0 },
      { addr: 'b', pid: 2, startedMs: 0 },
      { addr: 'dead', pid: 1, startedMs: 0 },
    ];
    const cwds = new Map([['a', 'C:/dev/other'], ['b', 'C:\\Dev\\Shop\\web']]);
    expect(pickNvimServer(servers, cwds, 'C:\\dev\\shop', 'win32')?.addr).toBe('b');
    expect(pickNvimServer(servers, new Map([['a', '/x'], ['b', '/home/me']]), '/home/me/dev/shop', 'linux')?.addr).toBe('b');
    expect(pickNvimServer(servers, new Map([['a', '/x']]), '/elsewhere', 'linux')?.addr).toBe('a');
    expect(pickNvimServer(servers, new Map(), '/x', 'linux')).toBeNull();
  });

  it('opens nvim in a new terminal window from the template', () => {
    const m = machine('win32', { env: { PATH: 'C:\\Program Files\\WezTerm' }, files: ['C:\\Program Files\\WezTerm\\wezterm.exe'] });
    const step = terminalStep('wezterm start --cwd {dir} -- {cmd}', 'C:\\nvim\\nvim.exe', target, m);
    expect(step).toMatchObject({ file: 'C:\\Program Files\\WezTerm\\wezterm.exe', args: ['start', '--cwd', target.dir, '--', 'C:\\nvim\\nvim.exe', '+87', target.file], verbatim: false, helper: false });
    expect(() => terminalStep('kitty {cmd}', 'nvim', target, m)).toThrow(/kitty was not found/);
  });
});

describe('finding and starting editors', () => {
  it('finds programs on PATH with PATHEXT on Windows', () => {
    const m = machine('win32', { env: { Path: 'C:\\bin;C:\\tools', PATHEXT: '.EXE;.CMD' }, files: ['C:\\tools\\code.cmd', 'C:\\bin\\code'] });
    expect(which('code', m)).toBe('C:\\tools\\code.cmd');
    expect(which('C:\\bin\\code', m)).toBe('C:\\bin\\code');
    expect(which('nope', m)).toBeNull();
  });

  it('VS Code on Windows: runs the Code.exe that code.cmd wraps, with --goto', () => {
    const cmd = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd';
    const m = machine('win32', {
      env: { PATH: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin' },
      files: [cmd, 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe'],
      text: { [cmd]: '@echo off\nsetlocal\nset ELECTRON_RUN_AS_NODE=1\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\n' },
    });
    const loc = findEditor('vscode', '', m);
    expect(loc).toMatchObject({ path: cmd, source: 'found' });
    expect(editorStep('vscode', loc.path!, target, m)).toMatchObject({
      file: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      args: ['--goto', `${target.file}:87:5`],
      verbatim: false,
    });
  });

  it('VS Code found in its install folder when not on PATH', () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
    const m = machine('win32', { env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, files: [exe] });
    expect(findEditor('vscode', '', m).path).toBe(exe);
    expect(findEditor('vscode', '', machine('win32')).problem).toMatch(/VS Code was not found/);
    expect(findEditor('vscode', 'D:\\nope\\Code.exe', m).problem).toMatch(/There is no program at D:\\nope\\Code.exe/);
  });

  it('IDEA on Windows: the exe a Toolbox script starts, the newest install, or cmd.exe with strict quoting', () => {
    const local = 'C:\\Users\\me\\AppData\\Local';
    const script = `${local}\\JetBrains\\Toolbox\\scripts\\idea.cmd`;
    const exe = `${local}\\Programs\\IntelliJ IDEA Ultimate\\bin\\idea64.exe`;
    const m = machine('win32', { env: { LOCALAPPDATA: local }, files: [script, exe], text: { [script]: `@echo off\r\nstart "" "${exe}" %*\r\n` } });
    expect(findEditor('idea', '', m).path).toBe(script);
    expect(editorStep('idea', script, target, m)).toMatchObject({ file: exe, args: ['--line', '87', target.file], verbatim: false });

    const pf = machine('win32', {
      env: { PROGRAMFILES: 'C:\\Program Files' },
      dirs: { 'C:\\Program Files\\JetBrains': ['IntelliJ IDEA 2024.3', 'IntelliJ IDEA 2025.2', 'PyCharm'] },
      files: ['C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe', 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe'],
    });
    expect(findEditor('idea', '', pf).path).toBe('C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe');

    // A script that cannot be unwrapped runs through cmd.exe, every argument quoted.
    const odd = machine('win32', { env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, files: ['C:\\tools\\idea.cmd'], text: { 'C:\\tools\\idea.cmd': 'call somewhere %*' } });
    expect(editorStep('idea', 'C:\\tools\\idea.cmd', target, odd)).toEqual({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', `""C:\\tools\\idea.cmd" "--line" "87" "${target.file}""`],
      verbatim: true,
      helper: false,
      display: expect.any(String),
    });
    expect(() => cmdStep('C:\\tools\\idea.cmd', ['C:\\dev\\100%\\A.java'], false, odd)).toThrow(/" or %/);
  });

  it('IDEA on macOS: open -na with the app; Linux: idea on PATH', () => {
    const app = '/Applications/IntelliJ IDEA Ultimate.app';
    const mac = machine('darwin', { dirs: { '/Applications': ['IntelliJ IDEA Ultimate.app', 'Safari.app'], [app]: ['Contents'] } });
    expect(findEditor('idea', '', mac).path).toBe(app);
    expect(editorStep('idea', app, posixTarget, mac)).toMatchObject({ file: 'open', args: ['-na', app, '--args', '--line', '87', posixTarget.file] });
    const linux = machine('linux', { env: { PATH: '/usr/bin:/home/me/.local/bin' }, files: ['/home/me/.local/bin/idea'] });
    expect(editorStep('idea', findEditor('idea', '', linux).path!, posixTarget, linux)).toMatchObject({ file: '/home/me/.local/bin/idea', args: ['--line', '87', posixTarget.file] });
  });

  it('Emacs: emacsclient -n +line:col, run as a helper whose exit status counts', () => {
    const win = machine('win32', { env: { PROGRAMFILES: 'C:\\Program Files' }, dirs: { 'C:\\Program Files\\Emacs': ['emacs-29.4'] }, files: ['C:\\Program Files\\Emacs\\emacs-29.4\\bin\\emacsclient.exe'] });
    const loc = findEditor('emacs', '', win);
    expect(loc.path).toBe('C:\\Program Files\\Emacs\\emacs-29.4\\bin\\emacsclient.exe');
    expect(editorStep('emacs', loc.path!, target, win)).toMatchObject({ args: ['-n', '+87:5', target.file], helper: true });
  });

  it('custom: the first word is found on PATH and the file stays one argument', () => {
    const m = machine('linux', { env: { PATH: '/usr/bin' }, files: ['/usr/bin/subl'] });
    expect(customStep('subl {file}:{line}:{column}', posixTarget, m)).toMatchObject({ file: '/usr/bin/subl', args: [`${posixTarget.file}:87:5`] });
    expect(() => customStep('  ', posixTarget, m)).toThrow(/No command/);
  });

  it('drops the variables that would make an Electron editor run as Node', () => {
    expect(editorEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ATTACH_CONSOLE: '1', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
