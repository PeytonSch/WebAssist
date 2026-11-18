import { h } from './dom';

/**
 * Route highlights: routes the user wants to spot at once on the timeline, each with a colour
 * of their choosing ("every POST to /api/orders/{id} in green"). Kept by route template in this
 * browser's storage, so they last across sessions.
 */

const KEY = 'dh.routeHighlights';

/** Colours that read on both the light and the dark theme. */
export const HIGHLIGHT_COLORS: { name: string; color: string }[] = [
  { name: 'Rose', color: '#e11d48' },
  { name: 'Orange', color: '#ea580c' },
  { name: 'Amber', color: '#d99a06' },
  { name: 'Green', color: '#16a34a' },
  { name: 'Teal', color: '#0d9488' },
  { name: 'Sky', color: '#0284c7' },
  { name: 'Indigo', color: '#6366f1' },
  { name: 'Fuchsia', color: '#c026d3' },
];

const HEX = /^#[0-9a-f]{6}$/i;

function read(): Map<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return new Map();
    return new Map(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string' && HEX.test(e[1])));
  } catch {
    return new Map();
  }
}

const highlights = read();
const listeners = new Set<() => void>();

/** The colour a route template is highlighted with, if any. */
export function highlightOf(template: string): string | null {
  return highlights.get(template) ?? null;
}

export function allHighlights(): [string, string][] {
  return [...highlights.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Highlights a route with a colour, or (null) stops highlighting it. */
export function setHighlight(template: string, color: string | null): void {
  if (color && HEX.test(color)) highlights.set(template, color.toLowerCase());
  else highlights.delete(template);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(highlights)));
  } catch {
    /* private mode: kept until the page reloads */
  }
  for (const fn of listeners) fn();
}

/** Called after any highlight changes (here or in another window of the app). */
export function onHighlightsChange(fn: () => void): void {
  listeners.add(fn);
}

// Another window changed them.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    highlights.clear();
    for (const [k, v] of read()) highlights.set(k, v);
    for (const fn of listeners) fn();
  });
}

// ── The picker ──────────────────────────────────────────

let openPicker: { el: HTMLElement; close: () => void } | null = null;

export function closeHighlightPicker(): boolean {
  if (!openPicker) return false;
  openPicker.close();
  return true;
}

/**
 * A small popup under `anchor` for choosing a route's highlight: preset colours, any colour,
 * or none. Also lists the other highlighted routes, so they can be removed from one place.
 */
export function openHighlightPicker(anchor: HTMLElement, template: string): void {
  if (openPicker) {
    const same = openPicker.el.dataset.template === template;
    openPicker.close();
    if (same) return;
  }
  const current = highlightOf(template);
  const swatches = HIGHLIGHT_COLORS.map(({ name, color }) => {
    const b = h('button', {
      type: 'button',
      class: `hl-swatch${current === color ? ' on' : ''}`,
      title: name,
      'aria-label': `${name}${current === color ? ' (current)' : ''}`,
      'aria-pressed': String(current === color),
      style: `--sw: ${color}`,
    });
    b.addEventListener('click', () => {
      setHighlight(template, color);
      close();
    });
    return b;
  });
  const custom = h('input', { type: 'color', class: 'hl-custom', 'aria-label': 'Any colour', title: 'Any colour' }) as HTMLInputElement;
  custom.value = current ?? '#6366f1';
  // Live while the system picker is open; the popup stays until it is closed.
  custom.addEventListener('input', () => setHighlight(template, custom.value));
  const remove = h('button', { type: 'button', class: 'btn btn-sm' }, 'Remove highlight') as HTMLButtonElement;
  remove.disabled = !current;
  remove.addEventListener('click', () => {
    setHighlight(template, null);
    close();
  });

  const others = allHighlights().filter(([t]) => t !== template);
  const list = others.length
    ? h(
        'div',
        { class: 'hl-others' },
        h('div', { class: 'hl-sub' }, `Other highlighted routes · ${others.length}`),
        ...others.map(([t, c]) => {
          const x = h('button', { type: 'button', class: 'btn btn-ghost btn-icon hl-x', title: `Stop highlighting ${t}`, 'aria-label': `Stop highlighting ${t}` }, '×');
          const row = h('div', { class: 'hl-other' }, h('span', { class: 'hl-dot', style: `--sw: ${c}` }), h('code', { title: t }, t), x);
          x.addEventListener('click', () => {
            setHighlight(t, null);
            row.remove();
          });
          return row;
        }),
      )
    : null;

  const el = h(
    'div',
    { class: 'hl-picker', role: 'dialog', 'aria-label': `Highlight ${template}` },
    h('div', { class: 'hl-title' }, 'Highlight ', h('code', {}, template)),
    h('div', { class: 'hl-note' }, 'Requests to this route stand out on the timeline in this colour.'),
    h('div', { class: 'hl-swatches' }, ...swatches, h('label', { class: 'hl-custom-wrap', title: 'Any colour' }, custom, h('span', {}, 'Custom'))),
    h('div', { class: 'hl-actions' }, remove),
    list,
  );
  el.dataset.template = template;
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  el.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
  const below = r.bottom + 6;
  el.style.top = `${below + el.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - el.offsetHeight - 6) : below}px`;

  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      anchor.focus({ preventScroll: true });
    }
  };
  function close(): void {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    el.remove();
    if (openPicker?.el === el) openPicker = null;
  }
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  openPicker = { el, close };
  (swatches.find((b) => b.classList.contains('on')) ?? swatches[0]).focus();
}
