import { contextBridge, ipcRenderer } from 'electron';

/**
 * What the desktop app adds to the web UI: native file pickers and a restart. It ships in the
 * payload (not the shell), so it updates with everything else. In a plain browser none of this
 * exists and the UI falls back to typing paths.
 */
export interface DesktopBridge {
  /** Opens a native picker. Resolves to the chosen path, or null if cancelled. */
  pickPath(opts: { kind: 'file' | 'folder'; title?: string; defaultPath?: string }): Promise<string | null>;
  /** Opens the config file or the sessions folder in the system's default app. */
  reveal(what: 'config' | 'sessions'): Promise<void>;
  restart(): Promise<void>;
  onOpenSettings(cb: () => void): void;
}

const bridge: DesktopBridge = {
  pickPath: (opts) => ipcRenderer.invoke('dh:pick-path', opts),
  reveal: (what) => ipcRenderer.invoke('dh:reveal', what),
  restart: () => ipcRenderer.invoke('dh:restart'),
  onOpenSettings: (cb) => {
    ipcRenderer.on('dh:open-settings', () => cb());
  },
};

contextBridge.exposeInMainWorld('debugHubDesktop', bridge);
