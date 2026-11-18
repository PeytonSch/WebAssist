import type { TomcatState } from '../shared/tomcat';
import { hostInfo, hostInfoNow } from './base';
import { h, type Child } from './dom';

/**
 * What the UI does differently when Debug Hub runs as a webapp inside Tomcat (see "Running
 * inside Tomcat" in the README): hints on the settings that were detected from that Tomcat, and
 * guards on the Tomcat page for the things that would stop Debug Hub itself. Everything here
 * does nothing when the hub runs on its own.
 */

// ── Settings ────────────────────────────────────────────

/** GET /api/config, hosted: detected values by setting. */
export type Detected = Record<string, { value: string | boolean; why: string }>;

const samePath = (a: string, b: string) => {
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(a.trim()) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * Marks the settings that were filled in from the Tomcat the hub runs in. A value that is still
 * the detected one says so; one that was changed or cleared offers the detected value back.
 * `slots` are the settings screen's error slots by setting, which sit under each control.
 */
export function decorateSettings(opts: {
  root: HTMLElement;
  detected: Detected | undefined;
  slots: Map<string, HTMLElement>;
  getValue: (path: string) => unknown;
  /** Functions the settings screen runs after every change. */
  derived: (() => void)[];
}): void {
  const { root, detected, slots } = opts;
  if (!detected) return;

  // The port is the hub's own when it runs alone; inside Tomcat the address is Tomcat's.
  slots.get('port')?.closest<HTMLElement>('.field')?.setAttribute('hidden', '');

  for (const [path, d] of Object.entries(detected)) {
    const slot = slots.get(path);
    const control = slot?.closest('.field-control');
    if (!slot || !control || typeof d.value !== 'string') continue;
    const value = d.value;
    const input = control.querySelector<HTMLInputElement | HTMLSelectElement>('input[type=text], select');
    const hint = h('div', { class: 'field-detected' });
    slot.before(hint);
    const update = () => {
      const now = String(opts.getValue(path) ?? '');
      if (samePath(now, value)) {
        hint.replaceChildren(h('span', { class: 'detected-mark' }, 'Detected'), ` ${d.why}.`);
        return;
      }
      const use = h('button', { type: 'button', class: 'btn btn-sm btn-ghost' }, 'Use it');
      use.addEventListener('click', () => {
        if (!input) return;
        input.value = value;
        input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      });
      hint.replaceChildren(h('span', { class: 'muted' }, 'Detected: '), h('code', {}, value), h('span', { class: 'muted' }, ` (${d.why})`), ...(input ? [use] : []));
    };
    update();
    opts.derived.push(update);
  }

  const card = h('section', { class: 'card hosted-card' });
  root.querySelector('.settings-scroll .card[data-id]')?.before(card);
  void hostInfo().then((info) => {
    if (!info.hosted) return card.remove();
    const access =
      info.access === 'all'
        ? 'Any computer that can reach Tomcat can use it'
        : info.access === 'list'
          ? 'This computer and the addresses listed in debughub.remote can use it'
          : 'Only this computer can use it';
    const line = (...c: Child[]) => h('p', {}, ...c);
    card.append(
      h(
        'div',
        { class: 'card-body' },
        h('h2', {}, `Running inside ${info.server || 'Tomcat'}`),
        line('Debug Hub is the webapp ', h('code', {}, info.contextPath || '/'), ' of this Tomcat. Settings marked “Detected” were filled in from it; change them like any other.'),
        line('Settings, sessions and saved requests are kept in ', h('code', {}, info.dataDir ?? ''), ', outside the webapp folder, so a redeploy keeps them.'),
        line(`${access}. That is set on the server (debughub.remote), not here; the README says how.`),
        info.local ? null : line('You are using it from another computer: Start Chrome, Show in Explorer and Go to source act on the server, and are turned off for you.'),
      ),
    );
  });
}

// ── Tomcat page ─────────────────────────────────────────

export const SELF_WHY = 'This is Debug Hub itself, running inside this Tomcat. Stop or remove it from Tomcat, not from its own page.';

/** Shown at the top of the Server card when the page manages the Tomcat the hub runs in. */
export function hostedNote(s: TomcatState): HTMLElement | null {
  if (!s.hosted) return null;
  return h(
    'div',
    { class: 'tm-note tm-hosted' },
    `Debug Hub runs inside this Tomcat (${s.hosted.server || 'Tomcat'}), as the webapp ${s.hosted.path}. `,
    'So Tomcat is running, Start has nothing to do, and Stop Tomcat stops Debug Hub too. Its own webapp is marked below.',
  );
}

/** Asks before Stop Tomcat stops the hub itself. Resolves to whether to go ahead. */
export function confirmStopOwnTomcat(): Promise<boolean> {
  return new Promise((resolve) => {
    const ok = h('button', { type: 'submit', class: 'btn btn-danger' }, 'Stop Tomcat');
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    const form = h(
      'form',
      { method: 'dialog' },
      h('h2', {}, 'Stop Tomcat, and Debug Hub with it?'),
      h('p', {}, 'Debug Hub runs inside this Tomcat. When Tomcat stops, this page stops working, and it cannot start Tomcat again.'),
      h('p', { class: 'muted' }, 'To get it back, start Tomcat yourself (bin/startup, your IDE or the service) and reload this page.'),
      h('div', { class: 'dialog-actions' }, cancel, ok),
    );
    const dialog = h('dialog', { class: 'dialog tm-stop-self' }, form) as HTMLDialogElement;
    let done = false;
    // Answered by the buttons themselves, not by the dialog's close event, which a browser may
    // deliver late to a page in the background.
    const finish = (go: boolean) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(go);
    };
    document.body.append(dialog);
    cancel.addEventListener('click', () => finish(false));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });
    // Escape.
    dialog.addEventListener('close', () => finish(false));
    dialog.showModal();
    cancel.focus();
  });
}

/**
 * Whether things the hub does on its own machine make sense for this browser: opening a file
 * manager window, Chrome or the editor. Not when the hub is used from another computer.
 */
export function onHubMachine(): boolean {
  return hostInfoNow().local;
}
