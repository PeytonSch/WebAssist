// The find bar in the detail panel: search the selected event's text, bodies included.
//
// Matches are shown with the CSS Custom Highlight API, which paints ranges without touching the
// DOM, so syntax-highlight spans, copy buttons and the lazily painted tail of a big body are left
// alone. Where the API is missing the bar still counts matches, scrolls to the current one and
// selects it.
//
// The panel is searched block by block: each <pre> is one block (its text is split across
// highlight spans, and a match may cross them), and any other text node is a block of its own,
// so a match never runs from a label into its value. See findtext.ts for the matching itself.

import { h } from './dom';
import { compileQuery, countLabel, findAll, locate, MAX_MATCHES, pieceStarts, step } from './findtext';

export interface FinderOptions {
  /** The elements to search, in display order; empty when nothing is selected. */
  roots: () => HTMLElement[];
  /** Called before searching, to render content that is only built on demand (Raw event). */
  prepare: () => void;
  /** Where Escape sends focus when there is nothing better to return to. */
  fallbackFocus: () => HTMLElement;
}

export interface Finder {
  bar: HTMLElement;
  /**
   * Searches again after the panel was rebuilt. `newEvent` starts from the first match, as for a
   * new query; otherwise the current match is kept (a live update of the same event).
   */
  refresh(newEvent: boolean): void;
  /** Ctrl/Cmd+F and F3 from anywhere in the main view. Returns true when it handled the key. */
  handleKey(e: KeyboardEvent): boolean;
}

const ALL = 'dh-find';
const CURRENT = 'dh-find-current';
const TYPE_DELAY = 120;
/** Rescans caused by the panel changing under the matches (lazy painting, related events). */
const SETTLE_DELAY = 150;
/** Scanning one block may take this long before the count gives up and says "N+". */
const BUDGET_MS = 250;

const hasHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function icon(d: string): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('stroke-linejoin', 'round');
  svg.append(p);
  return svg;
}

function loadToggles(): { caseSensitive: boolean; regex: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem('dh.find') ?? '{}');
    return { caseSensitive: !!v.caseSensitive, regex: !!v.regex };
  } catch {
    return { caseSensitive: false, regex: false };
  }
}

/** One searchable stretch of text and the text nodes it is made of. */
interface Block {
  nodes: Text[];
  starts: number[];
  text: string;
}

/**
 * The text of `roots` as blocks. Buttons (Copy, Close) are not content, and [hidden] elements
 * are not shown, so both are skipped. Closed <details> are searched: a match there opens them.
 */
function collectBlocks(roots: HTMLElement[]): Block[] {
  const blocks: Block[] = [];
  let pre: Element | null = null;
  let cur: Text[] = [];
  const flush = () => {
    if (cur.length) {
      const lengths = cur.map((t) => t.data.length);
      blocks.push({ nodes: cur, starts: pieceStarts(lengths), text: cur.map((t) => t.data).join('') });
    }
    cur = [];
  };
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === Node.ELEMENT_NODE && ((n as Element).tagName === 'BUTTON' || (n as Element).hasAttribute('hidden'))
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const t = n as Text;
      if (t.data === '') continue;
      const p = t.parentElement?.closest('pre') ?? null;
      if (!p || p !== pre) flush();
      pre = p;
      cur.push(t);
    }
    flush();
    pre = null;
  }
  return blocks;
}

/** Scrolls every scroller between the range and `stop` so the range is centred in each. */
function centre(range: Range, stop: HTMLElement): void {
  const scrollers: HTMLElement[] = [];
  for (let el = range.startContainer.parentElement; el; el = el.parentElement) {
    const s = getComputedStyle(el);
    if (/auto|scroll/.test(s.overflowY + s.overflowX)) scrollers.push(el);
    if (el === stop) break;
  }
  // Innermost first: scrolling a <pre> moves the range before its outer scroller is measured.
  for (const el of scrollers) {
    const r = range.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (el.scrollHeight > el.clientHeight) el.scrollTop += r.top + r.height / 2 - (box.top + el.clientHeight / 2);
    if (el.scrollWidth > el.clientWidth) el.scrollLeft += r.left + r.width / 2 - (box.left + el.clientWidth / 2);
  }
}

export function createFinder(opts: FinderOptions): Finder {
  const toggles = loadToggles();
  const input = h('input', {
    type: 'search',
    class: 'find-input',
    placeholder: 'Find in event',
    'aria-label': 'Find in this event',
    title: `Find in this event (${isMac ? '⌘F' : 'Ctrl+F'}). Enter / Shift+Enter or F3 / Shift+F3 for next / previous; Esc clears.`,
    autocomplete: 'off',
    spellcheck: 'false',
  }) as HTMLInputElement;
  const count = h('span', { class: 'find-count', 'aria-live': 'polite' });
  const toggle = (label: string, title: string, on: boolean) =>
    h('button', { type: 'button', class: 'find-btn find-toggle', title, 'aria-label': title, 'aria-pressed': String(on) }, label);
  const caseBtn = toggle('Aa', 'Match case', toggles.caseSensitive);
  const regexBtn = toggle('.*', 'Regular expression', toggles.regex);
  const button = (title: string, d: string) => h('button', { type: 'button', class: 'find-btn', title, 'aria-label': title }, icon(d));
  const prevBtn = button('Previous match (Shift+Enter)', 'M4 10l4-4 4 4');
  const nextBtn = button('Next match (Enter)', 'M4 6l4 4 4-4');
  const clearBtn = button('Clear (Esc)', 'M4.5 4.5l7 7m0-7-7 7');
  const field = h('div', { class: 'find-field' },
    icon('M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm3.5 8 3 3'),
    input, count, caseBtn, regexBtn);
  const bar = h('div', { class: 'd-find', role: 'search' }, field, prevBtn, nextBtn, clearBtn);

  let ranges: Range[] = [];
  /** The matches painted as highlighted: all of them except those in text still being painted. */
  let shown: Range[] = [];
  let more = false;
  let current = -1;
  let returnFocus: HTMLElement | null = null;
  let typeTimer = 0;
  let settleTimer = 0;

  /** Paints the matches; `onlyCurrent` when stepping, since the set of matches is unchanged. */
  function setHighlights(onlyCurrent = false): void {
    if (!hasHighlights) return;
    if (ranges.length === 0) {
      CSS.highlights.delete(ALL);
      CSS.highlights.delete(CURRENT);
      return;
    }
    if (!onlyCurrent) CSS.highlights.set(ALL, new Highlight(...shown));
    const cur = new Highlight(ranges[current]);
    cur.priority = 1;
    CSS.highlights.set(CURRENT, cur);
  }

  function showCount(error?: string): void {
    const q = input.value;
    bar.classList.toggle('has-query', q !== '');
    bar.classList.toggle('no-match', q !== '' && !error && ranges.length === 0);
    bar.classList.toggle('bad', !!error);
    input.setAttribute('aria-invalid', String(!!error));
    count.textContent = error ? 'Invalid regex' : q ? countLabel(current, ranges.length, more) : '';
    count.title = error ?? '';
    (prevBtn as HTMLButtonElement).disabled = (nextBtn as HTMLButtonElement).disabled = ranges.length === 0;
  }

  /**
   * Finds every match again. `keep` holds on to the current match (the panel changed under it);
   * otherwise the search starts over at the first. `reveal` scrolls the current match into view.
   */
  function run(keep: boolean, reveal: boolean): void {
    clearTimeout(settleTimer);
    settleTimer = 0;
    const compiled = compileQuery(input.value, toggles);
    const prev = keep ? ranges[current] : undefined;
    ranges = [];
    shown = [];
    more = false;
    const roots = compiled && 're' in compiled ? opts.roots() : [];
    if (compiled && 're' in compiled && roots.length) {
      opts.prepare();
      let left = MAX_MATCHES;
      for (const block of collectBlocks(roots)) {
        const found = findAll(block.text, compiled.re, left, BUDGET_MS);
        // While highlight.ts paints a big body, its tail is one huge text node that shrinks every
        // step. Chromium re-lays it out each time, and highlights on it make that several times
        // slower (seconds per frame for a 3 MB body). Those matches are still counted and can be
        // stepped to; they are all shown once painting ends and the panel is searched again.
        const tail = block.nodes[0].parentElement?.closest('pre[data-painting]') ? block.nodes[block.nodes.length - 1] : null;
        for (const m of found.matches) {
          const [si, so] = locate(block.starts, m.start);
          const [ei, eo] = locate(block.starts, m.end, true);
          const r = document.createRange();
          r.setStart(block.nodes[si], so);
          r.setEnd(block.nodes[ei], eo);
          ranges.push(r);
          if (block.nodes[ei] !== tail) shown.push(r);
        }
        left -= found.matches.length;
        if (found.more) {
          more = true;
          if (left === 0) break;
        }
      }
    }
    // What this search rendered (Raw event) is not a change to react to.
    observer.takeRecords();
    current = ranges.length === 0 ? -1 : keep ? Math.min(Math.max(current, 0), ranges.length - 1) : 0;
    // When matches were added above it (related events arriving), stay on the same match. Its old
    // range is still good unless its text node was replaced, and then the index is the best guess.
    if (prev && !prev.collapsed) {
      const same = ranges.findIndex((r) => r.startContainer === prev.startContainer && r.startOffset === prev.startOffset);
      if (same !== -1) current = same;
    }
    setHighlights();
    showCount(compiled && 'error' in compiled ? compiled.error : undefined);
    if (reveal) show();
  }

  /** Opens any closed <details> around the current match, then scrolls it into view. */
  function show(): void {
    const r = ranges[current];
    if (!r) return;
    for (let el = r.startContainer.parentElement; el; el = el.parentElement) {
      if (el instanceof HTMLDetailsElement && !el.open) el.open = true;
    }
    if (bar.parentElement) centre(r, bar.parentElement);
    if (!hasHighlights) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r.cloneRange());
    }
  }

  function go(delta: number): void {
    if (typeTimer) {
      // Enter before the typing delay ran: search now and land on the first match.
      clearTimeout(typeTimer);
      typeTimer = 0;
      run(false, true);
      return;
    }
    if (ranges.length === 0) return;
    current = step(current, delta, ranges.length);
    setHighlights(true);
    showCount();
    show();
  }

  function clear(): void {
    clearTimeout(typeTimer);
    typeTimer = 0;
    input.value = '';
    run(false, false);
  }

  function setToggle(btn: HTMLElement, key: 'caseSensitive' | 'regex'): void {
    toggles[key] = !toggles[key];
    btn.setAttribute('aria-pressed', String(toggles[key]));
    try {
      localStorage.setItem('dh.find', JSON.stringify(toggles));
    } catch {
      /* private mode */
    }
    run(false, true);
  }

  // Lazy painting of a big body, related events arriving and the Raw event being filled all
  // replace text nodes, which collapses the ranges on them. The text itself is the same, so
  // search again once things settle and keep the current match. The end of painting (its
  // data-painting mark going) is a change too: the tail's matches can be shown then.
  const observer = new MutationObserver((records) => {
    if (!input.value || settleTimer || records.every((r) => bar.contains(r.target))) return;
    // Not pushed back by further changes: while a big body paints, matches catch up every so often.
    settleTimer = window.setTimeout(() => run(true, false), SETTLE_DELAY);
  });

  input.addEventListener('input', () => {
    clearTimeout(typeTimer);
    typeTimer = window.setTimeout(() => {
      typeTimer = 0;
      run(false, true);
    }, TYPE_DELAY);
  });
  input.addEventListener('focus', (e) => {
    const from = e.relatedTarget as HTMLElement | null;
    if (from && !bar.contains(from)) returnFocus = from;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'F3') {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      // Handled here so the panel does not also close.
      e.preventDefault();
      e.stopPropagation();
      clear();
      const back = returnFocus?.isConnected ? returnFocus : opts.fallbackFocus();
      returnFocus = null;
      back.focus();
    }
  });
  caseBtn.onclick = () => setToggle(caseBtn, 'caseSensitive');
  regexBtn.onclick = () => setToggle(regexBtn, 'regex');
  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);
  clearBtn.onclick = () => {
    clear();
    input.focus();
  };
  showCount();

  return {
    bar,
    refresh(newEvent) {
      if (bar.parentElement) {
        observer.observe(bar.parentElement, { childList: true, subtree: true, characterData: true, attributeFilter: ['data-painting'] });
      }
      if (!opts.roots().length) {
        ranges = [];
        shown = [];
        current = -1;
        setHighlights();
        showCount();
        return;
      }
      if (!input.value) return;
      // A rebuilt panel is scrolled back to the top, so bring the current match back either way.
      run(!newEvent, true);
    },
    handleKey(e) {
      if (document.querySelector('dialog[open]') || !opts.roots().length) return false;
      const t = e.target as HTMLElement;
      const inOtherField = t !== input && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if (e.key.toLowerCase() === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && !inOtherField) {
        e.preventDefault();
        input.focus();
        input.select();
        return true;
      }
      if (e.key === 'F3' && t !== input && !inOtherField && input.value) {
        e.preventDefault();
        go(e.shiftKey ? -1 : 1);
        return true;
      }
      return false;
    },
  };
}
