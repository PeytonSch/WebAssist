/**
 * The command line that starts Chrome for Debug Hub. Shared by the server, which runs it
 * directly (no shell involved), and the settings screen, which shows it for copying into a
 * terminal, a shortcut or an IntelliJ run configuration.
 */

export interface ChromeCommandLine {
  /** Where the text works: "Command Prompt", "PowerShell" or "Terminal". */
  label: string;
  text: string;
}

/**
 * Chrome 136 and later refuse --remote-debugging-port on the default profile, so a profile
 * folder of its own is not optional. The two --no-* flags keep a fresh profile from opening
 * welcome and default-browser prompts on its first start.
 */
export function chromeArgs(port: number, profileDir: string): string[] {
  return [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'];
}

/** Where Chrome usually is, for the copyable command when it was not found on this machine. */
export function typicalChromePath(platform: string): string {
  if (platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return 'google-chrome';
}

/** Splits `--flag=value` so only the value is quoted, the way people write it by hand. */
function quoteFlagValue(arg: string, quote: (s: string) => string): string {
  const m = /^(--[\w-]+=)(.*)$/s.exec(arg);
  return m ? m[1] + quote(m[2]) : quote(arg);
}

// Command Prompt: double quotes protect spaces and & | < > ^ ( ). Windows paths cannot contain ".
const cmdQuote = (s: string) => (s === '' || /[\s&|<>^()]/.test(s) ? `"${s}"` : s);

// PowerShell: single quotes are fully literal ($ and ` are not special inside them); a single
// quote is written twice. Whole arguments are quoted, which PowerShell 5 and 7 pass on intact.
const psQuote = (s: string) => (s === '' || /[^\w@%+=:,./\\-]/.test(s) ? `'${s.replace(/'/g, "''")}'` : s);

// POSIX shells: single quotes, with a quote inside written as '\''.
const shQuote = (s: string) => (s === '' || /[^\w@%+=:,./-]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s);

/**
 * The command for each shell a user on this platform is likely to paste it into. Paths are
 * written out in full: environment variables such as %LOCALAPPDATA% are expanded by Command
 * Prompt but passed on literally by PowerShell, which silently gave Chrome the wrong profile.
 */
export function chromeCommandLines(platform: string, executable: string, args: string[]): ChromeCommandLine[] {
  if (platform === 'win32') {
    return [
      { label: 'Command Prompt', text: [cmdQuote(executable), ...args.map((a) => quoteFlagValue(a, cmdQuote))].join(' ') },
      // A line that starts with a quoted path is just a string in PowerShell; & runs it.
      { label: 'PowerShell', text: ['&', `'${executable.replace(/'/g, "''")}'`, ...args.map(psQuote)].join(' ') },
    ];
  }
  return [{ label: 'Terminal', text: [shQuote(executable), ...args.map((a) => quoteFlagValue(a, shQuote))].join(' ') }];
}
