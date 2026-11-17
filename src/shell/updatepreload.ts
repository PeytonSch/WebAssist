import { contextBridge, ipcRenderer } from 'electron';

// The update window's bridge (src/shell/updatewindow.ts): what to show, diffs on request, and
// the answer. Nothing else of Electron or Node reaches the page.
contextBridge.exposeInMainWorld('updateWindow', {
  view: () => ipcRenderer.invoke('update:view'),
  diff: (path: string, sha: string | null) => ipcRenderer.invoke('update:diff', path, sha),
  choose: (id: string | null) => ipcRenderer.send('update:choose', id),
  fit: (height: number) => ipcRenderer.send('update:fit', height),
});
