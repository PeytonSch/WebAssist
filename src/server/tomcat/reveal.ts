import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { dirname } from 'node:path';

/**
 * Shows a file in the system file manager: Explorer or Finder with the file selected, or the
 * folder it is in elsewhere. Done by the hub rather than the desktop app so it works the same
 * in a browser tab (the hub always runs on the user's machine), and so only paths the hub
 * already knows about can be shown.
 */

export interface RevealCommand {
  file: string;
  args: string[];
  /** Windows only: pass the arguments as written, since explorer parses its own command line. */
  verbatim: boolean;
}

/** The command that shows `path`: selected inside its folder when `select`, else the folder itself. */
export function revealCommand(path: string, select: boolean, platform: NodeJS.Platform = process.platform): RevealCommand {
  if (platform === 'win32') {
    // explorer wants backslashes, and "/select," followed by the quoted path as one argument.
    // Windows paths cannot contain quotes, so quoting it here is safe.
    const p = path.replace(/\//g, '\\');
    return { file: 'explorer.exe', args: [select ? `/select,"${p}"` : `"${p}"`], verbatim: true };
  }
  if (platform === 'darwin') return { file: 'open', args: select ? ['-R', path] : [path], verbatim: false };
  // There is no portable way to select a file on Linux; open the folder it is in.
  return { file: 'xdg-open', args: [select ? dirname(path) : path], verbatim: false };
}

type Spawn = (file: string, args: string[], opts: SpawnOptions) => {
  once(event: 'spawn' | 'error', fn: (err?: Error) => void): unknown;
  unref(): void;
};

/**
 * Starts the file manager and returns once it has started. Its exit code is not checked:
 * explorer exits with 1 even when it worked.
 */
export function reveal(path: string, select: boolean, opts: { platform?: NodeJS.Platform; spawn?: Spawn } = {}): Promise<void> {
  const cmd = revealCommand(path, select, opts.platform);
  const spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: cmd.verbatim });
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(new Error(`Could not start ${cmd.file}: ${err?.message ?? err}`)));
      child.unref();
    } catch (err) {
      reject(new Error(`Could not start ${cmd.file}: ${(err as Error).message}`));
    }
  });
}
