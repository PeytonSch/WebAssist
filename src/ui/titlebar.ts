import type { DesktopBridge } from '../desktop/preload';
import { h } from './dom';

/**
 * In the desktop app the window has no native title bar, so the top bar takes its place: it
 * drags the window, and gets a menu button and minimize / maximize / close buttons (on macOS
 * the native traffic lights stay and the bar only leaves room for them). In a plain browser
 * none of this runs and the page is unchanged.
 */

const desktop = (window as unknown as { debugHubDesktop?: DesktopBridge }).debugHubDesktop;

const svg = (paths: string) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 10 10');
  el.setAttribute('width', '10');
  el.setAttribute('height', '10');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = paths;
  return el;
};

const ICON = {
  minimize: '<path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/>',
  maximize: '<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>',
  restore:
    '<rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/>' +
    '<path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/>',
  close: '<path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1.1"/>',
};

export function initTitlebar(): void {
  const win = desktop?.window;
  if (!win) return;
  const topbar = document.querySelector<HTMLElement>('.topbar')!;

  if (win.platform === 'darwin') {
    document.documentElement.dataset.frame = 'mac';
    return;
  }
  document.documentElement.dataset.frame = 'custom';

  const menu = h('button', { id: 'btn-menu', class: 'btn btn-icon btn-ghost titlebar-menu', title: 'Menu', 'aria-label': 'Menu', 'aria-haspopup': 'menu' });
  menu.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  menu.onclick = () => {
    const r = menu.getBoundingClientRect();
    void win.popupMenu(r.left, r.bottom + 4);
  };
  topbar.prepend(menu);

  const control = (cls: string, label: string, icon: string, act: () => void) => {
    const b = h('button', { class: `window-btn ${cls}`, title: label, 'aria-label': label, tabindex: '-1' });
    b.append(svg(icon));
    b.onclick = act;
    return b;
  };
  const max = control('window-max', 'Maximize', ICON.maximize, () => void win.toggleMaximize());
  topbar.append(
    h(
      'div',
      { class: 'window-controls' },
      control('window-min', 'Minimize', ICON.minimize, () => void win.minimize()),
      max,
      control('window-close', 'Close', ICON.close, () => void win.close()),
    ),
  );

  const setMaximized = (on: boolean) => {
    document.documentElement.classList.toggle('maximized', on);
    const label = on ? 'Restore' : 'Maximize';
    max.title = label;
    max.setAttribute('aria-label', label);
    max.replaceChildren(svg(on ? ICON.restore : ICON.maximize));
  };
  win.onMaximizedChange(setMaximized);
  void win.isMaximized().then(setMaximized);
}

