import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('splash', {
  onStatus: (cb: (status: unknown) => void) => ipcRenderer.on('splash:status', (_e, status) => cb(status)),
});
