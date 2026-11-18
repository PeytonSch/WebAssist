import { h, type Child } from './dom';

/**
 * Debug Hub's own "are you sure?" window, in place of the browser's confirm(): styled like the
 * rest of the app, with the thing in question shown, and the safe answer focused so Enter or
 * Esc never does the destructive thing by accident.
 */

export interface ConfirmOptions {
  title: string;
  /** What happens, in a sentence or two. */
  text?: Child;
  /** The item concerned (a request, a file), shown in a box under the text. */
  subject?: Child;
  /** The button that goes ahead, e.g. "Delete". */
  ok: string;
  /** The button that does not. Default "Cancel". */
  cancel?: string;
  /** Going ahead deletes or discards something: a red button and a warning mark. */
  danger?: boolean;
  /** A small print line under the text, e.g. "This cannot be undone." */
  note?: string;
}

const ICON = {
  // A bin for deleting, a circled "!" otherwise.
  danger: 'M3.5 5h13M8 5V3.5h4V5M5 5l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h5.4a1.5 1.5 0 0 0 1.5-1.3L15 5M8.5 8.5v5.5M11.5 8.5v5.5',
  ask: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM10 6v4.8M10 13.6v.1',
};

function icon(path: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

/** Resolves to true when the user goes ahead; false for Cancel, Esc or a click outside. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const ok = h('button', { type: 'submit', class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}` }, opts.ok);
    const cancel = h('button', { type: 'button', class: 'btn' }, opts.cancel ?? 'Cancel');
    const titleId = `confirm-${Math.random().toString(36).slice(2)}`;
    const form = h(
      'form',
      { method: 'dialog', class: 'confirm-form' },
      h('div', { class: `confirm-icon${opts.danger ? ' danger' : ''}` }, icon(opts.danger ? ICON.danger : ICON.ask)),
      h(
        'div',
        { class: 'confirm-main' },
        h('h2', { id: titleId }, opts.title),
        opts.text ? h('p', { class: 'confirm-text' }, opts.text) : null,
        opts.subject ? h('div', { class: 'confirm-subject' }, opts.subject) : null,
        opts.note ? h('p', { class: 'confirm-note' }, opts.note) : null,
      ),
      h('div', { class: 'dialog-actions confirm-actions' }, cancel, ok),
    );
    const dialog = h('dialog', { class: 'dialog confirm', 'aria-labelledby': titleId }, form) as HTMLDialogElement;
    let done = false;
    // Answered by the buttons themselves, not only the close event, which a browser may deliver
    // late to a page in the background.
    const finish = (go: boolean) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(go);
    };
    cancel.addEventListener('click', () => finish(false));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      finish(true);
    });
    // Esc.
    dialog.addEventListener('close', () => finish(false));
    // A click on the backdrop (outside the box) is a no.
    dialog.addEventListener('mousedown', (e) => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) finish(false);
    });
    // Keys stay in here: the page behind must not act on Esc or shortcuts too.
    dialog.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
