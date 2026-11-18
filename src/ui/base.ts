import type { HostInfo } from '../shared/hosting';

/**
 * Where the hub's API lives, relative to the page. On its own the hub is served from the root of
 * its port, so the API is at /api/…. As a webapp inside Tomcat it is served under a context
 * path, e.g. /debug-hub/, and the API is at /debug-hub/api/….
 *
 * UI code does not need to care: it calls `fetch('/api/…')` (directly or through the helpers
 * `api()` in tomcat.ts and `call()` in api.ts) exactly as before. This module, imported first by
 * main.ts, wraps `window.fetch` so that a root-relative /api/ URL is sent to the right place.
 * Only for what does not go through fetch (an EventSource, a WebSocket, a link or image `src`)
 * is `apiUrl('/api/…')` needed.
 */

/** The folder the page's script was loaded from: "" on its own, "/debug-hub" inside Tomcat. */
function basePath(): string {
  try {
    if (typeof document === 'undefined') return '';
    // The script is always next to the page, also when the page was opened as /debug-hub/index.html.
    const script = document.querySelector<HTMLScriptElement>('script[src$="app.js"]');
    const dir = new URL('.', script?.src || document.baseURI);
    if (dir.origin !== location.origin) return '';
    return dir.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export const BASE = basePath();

/** The URL of an API path ("/api/status") or of the live WebSocket ("/ws") under the page's base. */
export function apiUrl(path: string): string {
  return BASE + path;
}

const isApiPath = (url: string) => url === '/api' || url.startsWith('/api/') || url.startsWith('/api?');

/** Sends root-relative /api/ requests to the hub under the page's base path. Nothing else is touched. */
function installFetch(): void {
  if (!BASE || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && isApiPath(input)) return original(BASE + input, init);
    if (input instanceof URL && input.origin === location.origin && isApiPath(input.pathname)) {
      return original(new URL(BASE + input.pathname + input.search, location.origin), init);
    }
    return original(input, init);
  };
}
installFetch();

let info: Promise<HostInfo> | null = null;
let known: HostInfo = { hosted: false, local: true };

/** How the hub is being run: on its own or inside Tomcat, and whether this browser is on its machine. Asked once. */
export function hostInfo(): Promise<HostInfo> {
  info ??= window
    .fetch('/api/host')
    .then((res) => (res.ok ? (res.json() as Promise<HostInfo>) : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((h) => (known = h))
    .catch(() => {
      // Asked again next time; until then, as if the hub ran on its own.
      info = null;
      return known;
    });
  return info;
}

/** The answer of hostInfo() if it has arrived, for code that draws synchronously. */
export function hostInfoNow(): HostInfo {
  return known;
}

if (typeof window !== 'undefined' && typeof window.fetch === 'function') void hostInfo();
