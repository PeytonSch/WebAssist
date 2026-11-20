// What the full-window viewers (jsonviewer.ts, xmlviewer.ts) share: the list that only draws
// the rows in view, the buttons, and the suggestion list under the query box.

import { h, type Child } from './dom';

// ── Virtual list ────────────────────────────────────────

/** A scrolling list that only creates the rows in view. Rows have a fixed height. */
export class VList {
  readonly el: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly layer: HTMLElement;
  private count = 0;
  private frame = 0;

  constructor(cls: string, private readonly rowH: number, private readonly row: (i: number) => HTMLElement, private readonly head: HTMLElement | null = null) {
    this.layer = h('div', { class: 'jv-layer' });
    this.spacer = h('div', { class: 'jv-spacer' }, this.layer);
    this.el = h('div', { class: cls, tabindex: '0' }, head, this.spacer);
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  setCount(n: number): void {
    this.count = n;
    this.spacer.style.height = `${n * this.rowH}px`;
    this.render();
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render(): void {
    // A list from a screen that was just replaced still gets resize and frame callbacks.
    if (!this.el.isConnected) return;
    const top = this.el.scrollTop;
    const view = this.el.clientHeight - this.headH();
    const first = Math.max(0, Math.floor(top / this.rowH) - 10);
    const last = Math.min(this.count, Math.ceil((top + view) / this.rowH) + 10);
    this.layer.style.transform = `translateY(${first * this.rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(this.row(i));
    this.layer.replaceChildren(frag);
  }

  /** Scrolls row `i` into view; `center` puts it mid-list when it has to scroll. */
  reveal(i: number, center = false): void {
    if (i < 0) return;
    const y = i * this.rowH;
    const view = this.el.clientHeight - this.headH();
    const st = this.el.scrollTop;
    if (y >= st && y + this.rowH <= st + view) return this.render();
    if (center) this.el.scrollTop = y - (view - this.rowH) / 2;
    else this.el.scrollTop = y < st ? y : y + this.rowH - view;
    this.render();
  }

  pageRows(): number {
    return Math.max(1, Math.floor((this.el.clientHeight - this.headH()) / this.rowH) - 1);
  }

  private headH(): number {
    return this.head?.offsetHeight ?? 0;
  }
}

// ── Small helpers ───────────────────────────────────────

export function button(label: Child, title: string, onclick: () => void, cls = 'btn btn-sm'): HTMLButtonElement {
  const b = h('button', { class: cls, type: 'button', title }, label) as HTMLButtonElement;
  b.onclick = onclick;
  return b;
}

export async function copyText(btn: HTMLElement, text: string): Promise<void> {
  const label = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => (btn.textContent = label), 1200);
}

export function copyButton(label: string, title: string, text: () => string): HTMLButtonElement {
  const b = button(label, title, () => void copyText(b, text()));
  return b;
}

export function download(text: string, fileName: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `text` with the search term `q` (lower case) wrapped in <mark>. */
export function markText(text: string, q: string): (string | Node)[] {
  if (!q) return [text];
  const low = text.toLowerCase();
  // Lower-casing a few characters changes the length; then offsets would not line up.
  if (low.length !== text.length) return [text];
  const out: (string | Node)[] = [];
  let from = 0;
  for (let k = low.indexOf(q); k !== -1; k = low.indexOf(q, k + q.length)) {
    out.push(text.slice(from, k), h('mark', { class: 'jv-mark' }, text.slice(k, k + q.length)));
    from = k + q.length;
  }
  out.push(text.slice(from));
  return out;
}

// ── Query box suggestions ───────────────────────────────

export interface Suggestion {
  /** The whole box text once accepted. */
  text: string;
  label: string;
  detail: string;
  kind: 'key' | 'index' | 'nested' | 'any-depth';
}

/** Long nested paths lose their middle, not their end: the end is the key that matched. */
function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${text.slice(0, max - 1 - tail)}…${text.slice(-tail)}`;
}

const KIND_TAG: Record<Suggestion['kind'], string> = { key: '', index: '', nested: 'nested', 'any-depth': 'any depth' };

/**
 * The suggestion list under a query box: what `suggest` offers for the text typed so far
 * (jsoncomplete.ts, xmlquery.ts). ↑↓ choose, Tab or Enter take one, Esc closes it. Taking one
 * applies it straight away and offers what comes next. `id` keeps the element ids of two
 * viewers apart.
 */
export function suggestList(input: HTMLInputElement, id: string, suggest: (text: string) => Suggestion[], apply: (text: string) => void): { el: HTMLElement; close: () => boolean } {
  const el = h('div', { class: 'jv-suggest', role: 'listbox', id: `${id}-suggest`, hidden: '' });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', `${id}-suggest`);
  input.setAttribute('aria-expanded', 'false');
  let items: Suggestion[] = [];
  let active = -1;
  let timer = 0;

  const close = (): boolean => {
    clearTimeout(timer);
    const was = !el.hidden;
    el.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
    return was;
  };
  const highlightActive = () => {
    el.querySelectorAll('.jv-sug').forEach((o, i) => o.classList.toggle('active', i === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${id}-sug-${active}`);
      el.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    // Only when the caret is at the end: suggestions replace the text up to the step being typed.
    items = document.activeElement === input && input.selectionStart === input.value.length ? suggest(input.value) : [];
    active = -1;
    if (!items.length) return void close();
    el.replaceChildren(...items.map((s, i) => {
      const tag = KIND_TAG[s.kind];
      const opt = h('div', { class: `jv-sug ${s.kind}`, role: 'option', id: `${id}-sug-${i}`, title: s.text },
        h('span', { class: 'jv-sug-label' }, middleEllipsis(s.label, 56)),
        tag ? h('span', { class: 'jv-sug-tag' }, tag) : null,
        h('span', { class: 'jv-sug-detail' }, s.detail));
      // mousedown, not click: the input must keep focus.
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        take(i);
      });
      return opt;
    }));
    el.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    highlightActive();
  };
  const take = (i: number) => {
    const s = items[i];
    if (!s) return;
    input.value = s.text;
    input.setSelectionRange(s.text.length, s.text.length);
    apply(s.text);
    render();
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(render, 60);
  });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => close());
  input.addEventListener('keydown', (e) => {
    if (el.hidden) {
      if (e.key === 'ArrowDown' || (e.key === ' ' && e.ctrlKey)) {
        e.preventDefault();
        render();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : active <= 0 ? n - 1 : active - 1;
      highlightActive();
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      take(active >= 0 ? active : 0);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      take(active);
    }
  });
  return { el, close };
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const QUERY_KEY = IS_MAC ? '⌘L' : 'Ctrl+L';

