import { contextBridge, ipcRenderer } from 'electron';

/**
 * What the desktop app adds to the web UI: native file pickers, a restart, and the window
 * controls of the frameless window. It ships in the payload (not the shell), so it updates with
 * everything else. In a plain browser none of this exists: the UI falls back to typing paths and
 * shows no window controls.
 */
export interface DesktopBridge {
  /** Opens a native picker. Resolves to the chosen path, or null if cancelled. */
  pickPath(opts: { kind: 'file' | 'folder'; title?: string; defaultPath?: string }): Promise<string | null>;
  /** Opens the config file or the sessions folder in the system's default app. */
  reveal(what: 'config' | 'sessions'): Promise<void>;
  restart(): Promise<void>;
  onOpenSettings(cb: () => void): void;
  /** Lets the UI's top bar act as the title bar, since the window has no native frame. */
  window: {
    /** 'darwin' keeps the native traffic lights; other platforms get the UI's own buttons. */
    platform: string;
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChange(cb: (maximized: boolean) => void): void;
    /** Pops up the application menu with its top-left corner at (x, y), in CSS pixels. */
    popupMenu(x: number, y: number): Promise<void>;
  };
}

const bridge: DesktopBridge = {
  pickPath: (opts) => ipcRenderer.invoke('dh:pick-path', opts),
  reveal: (what) => ipcRenderer.invoke('dh:reveal', what),
  restart: () => ipcRenderer.invoke('dh:restart'),
  onOpenSettings: (cb) => {
    ipcRenderer.on('dh:open-settings', () => cb());
  },
  window: {
    platform: process.platform,
    minimize: () => ipcRenderer.invoke('dh:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('dh:window', 'toggle-maximize'),
    close: () => ipcRenderer.invoke('dh:window', 'close'),
    isMaximized: () => ipcRenderer.invoke('dh:is-maximized'),
    onMaximizedChange: (cb) => {
      ipcRenderer.on('dh:maximized', (_e, maximized: boolean) => cb(!!maximized));
    },
    popupMenu: (x, y) => ipcRenderer.invoke('dh:popup-menu', { x, y }),
  },
};

contextBridge.exposeInMainWorld('debugHubDesktop', bridge);
