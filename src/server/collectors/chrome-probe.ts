/**
 * Asks Chrome's debugging port who is there, and says in plain words what the answer means.
 * "Waiting" alone left people guessing; the usual causes (Chrome started without the flag,
 * on the default profile, or another program on the port) each need a different fix.
 */

export type ProbeResult =
  | { kind: 'chrome'; host: string; browser: string; webSocketDebuggerUrl: string }
  /** Nothing listens on the port: Chrome is not running with the flag, or ignored it. */
  | { kind: 'refused'; host: string }
  /** Something accepted the connection but did not answer in time. */
  | { kind: 'timeout'; host: string }
  /** Something answered, but not Chrome's /json/version. */
  | { kind: 'other'; host: string; detail: string }
  /** The host could not be reached at all (unknown name, no route). */
  | { kind: 'error'; host: string; detail: string };

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Hosts to dial for a configured host. Node may resolve "localhost" to ::1 while Chrome binds
 * its debugging port to 127.0.0.1 only, so 127.0.0.1 is tried first.
 */
export function hostsToTry(host: string): string[] {
  return host.toLowerCase() === 'localhost' ? ['127.0.0.1', 'localhost'] : [host];
}

/** host:port as it goes into a URL; an IPv6 literal needs brackets. */
export function hostPort(host: string, port: number): string {
  return `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
}

function errorCode(err: any): string {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'TIMEOUT';
  const cause = err?.cause;
  return String(cause?.code ?? cause?.errors?.[0]?.code ?? err?.code ?? err?.message ?? 'unknown');
}

export async function probeHost(host: string, port: number, timeoutMs = 2000, fetchFn: FetchLike = fetch): Promise<ProbeResult> {
  let res;
  try {
    res = await fetchFn(`http://${hostPort(host, port)}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = errorCode(err);
    if (code === 'ECONNREFUSED') return { kind: 'refused', host };
    if (code === 'TIMEOUT' || code === 'ETIMEDOUT') return { kind: 'timeout', host };
    if (/^(ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL)$/.test(code)) return { kind: 'error', host, detail: code };
    // Reset connections and HTTP parse errors: something is there, and it is not Chrome.
    return { kind: 'other', host, detail: code === 'HPE_INVALID_CONSTANT' ? 'not HTTP' : code };
  }
  if (!res.ok) return { kind: 'other', host, detail: `HTTP ${res.status}` };
  let body: any;
  try {
    body = await res.json();
  } catch (err) {
    return errorCode(err) === 'TIMEOUT' ? { kind: 'timeout', host } : { kind: 'other', host, detail: 'not JSON' };
  }
  if (typeof body?.webSocketDebuggerUrl !== 'string') return { kind: 'other', host, detail: 'no debugger URL' };
  return { kind: 'chrome', host, browser: String(body.Browser ?? 'Chrome'), webSocketDebuggerUrl: body.webSocketDebuggerUrl };
}

// When no host finds Chrome, report the most telling answer.
const RANK: Record<ProbeResult['kind'], number> = { chrome: 4, other: 3, timeout: 2, refused: 1, error: 0 };

export async function probeChrome(host: string, port: number, timeoutMs = 2000, fetchFn: FetchLike = fetch): Promise<ProbeResult> {
  let best: ProbeResult | null = null;
  for (const h of hostsToTry(host)) {
    const r = await probeHost(h, port, timeoutMs, fetchFn);
    if (r.kind === 'chrome') return r;
    if (!best || RANK[r.kind] > RANK[best.kind]) best = r;
  }
  return best!;
}

/**
 * The collector's "waiting" detail. The first line is short (it is shown in the top bar and
 * the timeline); the lines after it say what to do.
 */
export function describeProbe(r: ProbeResult, port: number): string {
  const at = hostPort(r.host, port);
  switch (r.kind) {
    case 'chrome':
      return `${r.browser} at ${at}`;
    case 'refused':
      return [
        `Waiting for Chrome: nothing is listening on ${at}`,
        `Use Start Chrome, or start Chrome with --remote-debugging-port=${port} and its own --user-data-dir.`,
        'Chrome 136 and later ignore the debugging port on the everyday profile, and if Chrome is already running on the profile you start, the new window joins it and the flags are dropped.',
      ].join('\n');
    case 'timeout':
      return [`Waiting for Chrome: ${at} accepted the connection but did not answer`, 'Chrome may still be starting, or another program holds this port.'].join('\n');
    case 'other':
      return [`Waiting for Chrome: something other than Chrome is on ${at} (${r.detail})`, 'Choose another debugging port in Settings, or close the program that uses this one.'].join('\n');
    case 'error':
      return [`Waiting for Chrome: cannot reach ${at} (${r.detail})`, 'Check the Chrome host under Settings > Advanced.'].join('\n');
  }
}
