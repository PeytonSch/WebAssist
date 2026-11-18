import { app, nativeImage, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Debug Hub's own icon for its windows, the taskbar and the Dock. An installed copy has it in
 * its .exe or .app already; run with `npm run app`, the program is Electron's, so without this
 * Windows would show Electron's icon. scripts/build.mjs puts icon.ico and icon.png beside each
 * bundle (dist/shell, dist/payload), drawn from build/icon.svg.
 */
let cached: NativeImage | null | undefined;
export function appIcon(): NativeImage | undefined {
  if (cached !== undefined) return cached ?? undefined;
  cached = null;
  // Windows picks the right size from the .ico for the taskbar (24 px), title bar and Alt+Tab;
  // its 16-32 px sizes are drawn on the pixel grid. Electron reads .ico on Windows only.
  for (const name of process.platform === 'win32' ? ['icon.ico', 'icon.png'] : ['icon.png']) {
    const file = join(__dirname, name);
    if (!existsSync(file)) continue;
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      cached = img;
      break;
    }
  }
  return cached ?? undefined;
}

/** Once, before the first window: the taskbar groups and labels the windows as Debug Hub. */
export function setAppIdentity(): void {
  if (process.platform === 'win32') app.setAppUserModelId('com.debughub.app');
  const icon = appIcon();
  if (process.platform === 'darwin' && !app.isPackaged && icon) app.dock?.setIcon(icon);
}
