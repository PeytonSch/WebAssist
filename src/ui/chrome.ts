import type { LaunchResult } from '../server/chrome-launch';
import { h } from './dom';

/**
 * The Start Chrome button, shared by the top bar, the empty timeline and Settings. The
 * launch state lives here rather than in the buttons, because the timeline redraws its empty
 * state often and a button drawn mid-launch must still say "Starting…".
 */

const S = {
  launching: false,
  last: null as LaunchResult | null,
};

/** Fired on window whenever a launch starts or finishes, so every place can redraw. */
export const CHROME_LAUNCH_EVENT = 'dh:chrome-launch';

const changed = () => window.dispatchEvent(new Event(CHROME_LAUNCH_EVENT));

export function chromeLaunching(): boolean {
  return S.launching;
}

export function lastChromeLaunch(): LaunchResult | null {
  return S.last;
}

export async function startChrome(): Promise<LaunchResult> {
  S.launching = true;
  S.last = null;
  changed();
  let result: LaunchResult;
  try {
    const res = await fetch('/api/chrome/launch', { method: 'POST' });
    const body = await res.json();
    result = res.ok ? body : { ok: false, outcome: 'failed', message: body.error ?? `HTTP ${res.status}` };
  } catch (err) {
    result = { ok: false, outcome: 'failed', message: `Could not reach Debug Hub: ${(err as Error).message}` };
  }
  S.launching = false;
  S.last = result;
  changed();
  return result;
}

/** A Start Chrome button that reflects a launch in progress. */
export function chromeButton(opts: { primary?: boolean; label?: string; title?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const label = opts.label ?? 'Start Chrome';
  const btn = h(
    'button',
    {
      type: 'button',
      class: `btn${opts.primary ? ' btn-primary' : ''}`,
      title: opts.title ?? 'Open Chrome with its debugging port, on a profile folder of its own',
    },
    S.launching ? 'Starting Chrome…' : label,
  ) as HTMLButtonElement;
  btn.disabled = S.launching || !!opts.disabled;
  btn.addEventListener('click', () => void startChrome());
  return btn;
}

/** The outcome of the last launch, or nothing. */
export function chromeLaunchNote(): HTMLElement | null {
  const r = S.last;
  if (!r) return null;
  return h(
    'div',
    { class: 'launch-note', role: 'status' },
    h('span', { class: `pm ${r.ok ? 'ok' : 'warn'}` }, r.message),
    r.hint ? h('span', { class: 'launch-hint' }, r.hint) : null,
  );
}
