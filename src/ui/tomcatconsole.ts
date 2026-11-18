import type { ConsoleChunk, ConsoleSource } from '../shared/tomcat';
import { confirmDialog } from './confirm';
import { h } from './dom';

/**
 * The console on the Tomcat page: what Tomcat prints (run in the foreground with catalina run,
 * so there is no window of its own for it), its shutdown and the start commands, each in a tab,
 * like a terminal. Output is read from the hub a piece at a time (GET /api/tomcat/console),
 * from where the last read stopped, while the page shows the console.
 */

const POLL_MS = 600;
/** Lines kept per tab; older ones are dropped from the top. */
const MAX_LINES = 5000;
const PREF_WRAP = 'dh.console.wrap';
const PREF_HEIGHT = 'dh.console.height';

interface Buffer {
  runKey: string;
  /** Byte offset to read from next; -1 before the first read. */
  next: number;
  /** Earlier output was left out (only the end of a long one is read at first). */
  clipped: boolean;
  lines: string[];
  /** The last line, while it has no newline yet. */
  partial: string;
  /** Output read after the source ended, so nothing more will come. */
  final: boolean;
}

export interface ConsoleHost {
  /** Ends the foreground Tomcat process (End process). */
  kill: () => Promise<void>;
}

function pref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: not remembered */
  }
}

// ── Colours ─────────────────────────────────────────────

const ANSI = /\x1b\[([0-9;]*)m/g;
const OTHER_ESC = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const TOMCAT_LINE = /^(\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)(\s+)(SEVERE|WARNING|INFO|CONFIG|FINE|FINER|FINEST|ERROR|WARN|DEBUG|TRACE)(\s+)(\[[^\]]*\])(\s+)(\S+)(.*)$/;
const LEVEL_CLASS: Record<string, string> = {
  SEVERE: 'err', ERROR: 'err', WARNING: 'warn', WARN: 'warn', INFO: 'info', CONFIG: 'dim', FINE: 'dim', FINER: 'dim', FINEST: 'dim', DEBUG: 'dim', TRACE: 'dim',
};

function span(cls: string, text: string): HTMLElement {
  return h('span', { class: cls }, text);
}

/** A line with ANSI colour codes (Spring Boot, Maven, npm) as coloured spans. */
function ansiLine(line: string): Node[] {
  const out: Node[] = [];
  let fg = '';
  let bold = false;
  let at = 0;
  const push = (text: string) => {
    if (!text) return;
    const cls = [fg && `a-${fg}`, bold && 'a-b'].filter(Boolean).join(' ');
    out.push(cls ? span(cls, text) : document.createTextNode(text));
  };
  for (const m of line.matchAll(ANSI)) {
    push(line.slice(at, m.index).replace(OTHER_ESC, ''));
    at = m.index! + m[0].length;
    for (const code of (m[1] || '0').split(';').map(Number)) {
      if (code === 0) {
        fg = '';
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) fg = '';
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
    }
  }
  push(line.slice(at).replace(OTHER_ESC, ''));
  return out;
}

/** One line of output, coloured: Tomcat's log records by level, errors and stack traces, ANSI colours. */
export function lineEl(line: string): HTMLElement {
  const el = h('div', { class: 'tc-line' });
  if (line.includes('\x1b[')) {
    el.append(...ansiLine(line));
    return el;
  }
  const m = TOMCAT_LINE.exec(line);
  if (m) {
    const lvl = LEVEL_CLASS[m[3]] ?? '';
    el.append(span('tc-ts', m[1]), m[2], span(`tc-lvl ${lvl}`, m[3]), m[4], span('tc-thread', m[5]), m[6], span('tc-logger', m[7]), m[8]);
    if (lvl === 'err' || lvl === 'warn') el.classList.add(lvl);
    if (/Server startup in/.test(m[8])) el.classList.add('ok');
    return el;
  }
  el.textContent = line;
  if (/^\s+at\s|^\s*\.\.\. \d+ more|^Caused by:/.test(line)) el.classList.add('trace');
  else if (/\b(SEVERE|ERROR|FATAL|Exception|Error:)\b/.test(line)) el.classList.add('err');
  else if (/\b(WARNING|WARN)\b/.test(line)) el.classList.add('warn');
  return el;
}

// ── The console ─────────────────────────────────────────

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '');

export class TomcatConsole {
  /** Kept across the page's redraws, so the output and its scroll position stay. */
  readonly el: HTMLElement;
  private tabs: HTMLElement;
  private cmd: HTMLElement;
  private tools: HTMLElement;
  private screen: HTMLElement;
  private lines: HTMLElement;
  private live: HTMLElement;
  private foot: HTMLElement;
  private jump: HTMLButtonElement;
  private sources: ConsoleSource[] = [];
  private buffers = new Map<string, Buffer>();
  private selected: string | null = null;
  /** Chosen by the user, so a new source does not take the tab away. */
  private chosen = false;
  private follow = true;
  private active = false;
  private timer = 0;
  private reading = false;
  private savedScroll = 0;

  constructor(private host: ConsoleHost) {
    this.tabs = h('div', { class: 'tc-tabs', role: 'tablist', 'aria-label': 'Output' });
    this.cmd = h('code', { class: 'tc-cmd' });
    this.tools = h('div', { class: 'tc-tools' });
    this.lines = h('div', { class: 'tc-lines' });
    this.live = h('div', { class: 'tc-line tc-live' });
    this.screen = h('div', { class: 'tc-screen', role: 'log', 'aria-live': 'off', tabindex: '0' }, this.lines, this.live);
    this.jump = h('button', { type: 'button', class: 'tc-jump' }, 'Latest output ↓') as HTMLButtonElement;
    this.jump.hidden = true;
    this.jump.addEventListener('click', () => {
      this.follow = true;
      this.toEnd();
    });
    this.foot = h('div', { class: 'tc-foot' });
    const wrap = pref(PREF_WRAP) !== '0';
    this.screen.classList.toggle('wrap', wrap);
    const height = Number(pref(PREF_HEIGHT));
    if (height >= 160 && height <= 2000) this.screen.style.height = `${height}px`;
    this.el = h(
      'div',
      { class: 'tc' },
      h('div', { class: 'tc-top' }, this.tabs, this.tools),
      h('div', { class: 'tc-term' }, h('div', { class: 'tc-bar' }, this.cmd), this.screen, this.jump),
      this.foot,
    );
    this.screen.addEventListener('scroll', () => {
      const atEnd = this.screen.scrollTop + this.screen.clientHeight >= this.screen.scrollHeight - 6;
      this.follow = atEnd;
      this.jump.hidden = atEnd;
    });
    // Remember a height the user dragged the console to.
    new ResizeObserver(() => {
      const hgt = this.screen.offsetHeight;
      if (this.screen.isConnected && hgt >= 160) setPref(PREF_HEIGHT, String(Math.round(hgt)));
    }).observe(this.screen);
  }

  /** The page's latest state: which sources there are, and whether the console is on screen. */
  update(sources: ConsoleSource[], active: boolean): void {
    this.sources = sources;
    // Sources gone (a command's old run) take their output with them.
    for (const id of [...this.buffers.keys()]) if (!sources.some((s) => s.id === id)) this.buffers.delete(id);
    if (!this.selected || !sources.some((s) => s.id === this.selected)) {
      this.chosen = false;
      this.selected = null;
    }
    if (!this.chosen) {
      // Tomcat if it runs, else whatever runs, else the first.
      this.select((sources.find((s) => s.tomcat && s.running) ?? sources.find((s) => s.running) ?? sources[0])?.id ?? null, false);
    } else this.renderChrome();
    this.setActive(active);
  }

  /** Called before the page redraws and after it put the console back, to keep the scroll position. */
  detach(): void {
    this.savedScroll = this.screen.scrollTop;
  }
  attached(): void {
    if (this.follow) this.toEnd();
    else this.screen.scrollTop = this.savedScroll;
  }

  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    clearTimeout(this.timer);
    if (active) void this.poll();
  }

  private source(): ConsoleSource | null {
    return this.sources.find((s) => s.id === this.selected) ?? null;
  }

  private select(id: string | null, byUser: boolean): void {
    const changed = id !== this.selected;
    this.selected = id;
    if (byUser) this.chosen = true;
    this.renderChrome();
    if (changed) {
      this.follow = true;
      this.redrawLines();
      if (this.active) {
        clearTimeout(this.timer);
        void this.poll();
      }
    }
  }

  private renderChrome(): void {
    const src = this.source();
    this.tabs.replaceChildren(
      ...this.sources.map((s) => {
        const state = s.running === null ? 'earlier' : s.running ? 'running' : s.failed ? 'failed' : 'ended';
        const tab = h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: `tc-tab ${state}`,
            'aria-selected': String(s.id === this.selected),
            title: `${s.command}${s.running ? ' · running' : s.ended ? ` · ended with ${s.ended}` : ''}`,
          },
          h('span', { class: 'tc-dot', 'aria-hidden': 'true' }),
          s.label,
        );
        tab.addEventListener('click', () => this.select(s.id, true));
        return tab;
      }),
    );
    this.cmd.textContent = src ? src.command : '';
    this.cmd.title = src?.command ?? '';

    const wrapBtn = h('button', { type: 'button', class: `btn btn-sm btn-ghost tc-toggle${this.screen.classList.contains('wrap') ? ' on' : ''}`, 'aria-pressed': String(this.screen.classList.contains('wrap')), title: 'Wrap long lines' }, 'Wrap');
    wrapBtn.addEventListener('click', () => {
      const on = !this.screen.classList.contains('wrap');
      this.screen.classList.toggle('wrap', on);
      setPref(PREF_WRAP, on ? '1' : '0');
      this.renderChrome();
      if (this.follow) this.toEnd();
    });
    const copy = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Copy what the console shows' }, 'Copy') as HTMLButtonElement;
    copy.addEventListener('click', async () => {
      const b = this.selected ? this.buffers.get(this.selected) : null;
      try {
        await navigator.clipboard.writeText([...(b?.lines ?? []), b?.partial ?? ''].join('\n').replace(/\x1b\[[0-9;]*m/g, ''));
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Copy failed';
      }
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    const clear = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Clear the console (new output still shows)' }, 'Clear');
    clear.addEventListener('click', () => {
      const b = this.selected ? this.buffers.get(this.selected) : null;
      if (b) {
        b.lines = [];
        b.partial = '';
        b.clipped = false;
      }
      this.redrawLines();
    });
    const tools: HTMLElement[] = [wrapBtn, copy, clear];
    if (src?.tomcat && src.running) {
      const kill = h('button', { type: 'button', class: 'btn btn-sm btn-danger-quiet', title: 'End the Tomcat process at once, for when Stop Tomcat does not get it to stop' }, 'End process');
      kill.addEventListener('click', async () => {
        const go = await confirmDialog({
          title: 'End the Tomcat process?',
          text: 'Tomcat is stopped at once, without its normal shutdown. Use this when Stop Tomcat does not get it to stop.',
          ok: 'End process',
          danger: true,
        });
        if (go) await this.host.kill();
      });
      tools.push(kill);
    }
    this.tools.replaceChildren(...(src ? tools : []));
    this.renderFoot();
  }

  private renderFoot(): void {
    const src = this.source();
    const b = this.selected ? this.buffers.get(this.selected) : null;
    if (!src) {
      this.foot.replaceChildren(h('span', { class: 'muted' }, 'Start Tomcat and its output shows here.'));
      return;
    }
    const parts: (Node | string)[] = [];
    if (src.running === null) parts.push(span('tc-state earlier', 'From before Debug Hub restarted'), ` · started ${time(src.startedAt)}`);
    else if (src.running) parts.push(span('tc-state running', 'Running'), ` · since ${time(src.startedAt)}`);
    else parts.push(span(`tc-state ${src.failed ? 'failed' : 'ended'}`, `Ended with ${src.ended ?? 'no exit code'}`), src.endedAt ? ` at ${time(src.endedAt)}` : '');
    if (b?.clipped) parts.push(span('muted', ' · showing the end of a long output'));
    this.foot.replaceChildren(...parts);
  }

  private redrawLines(): void {
    const b = this.selected ? this.buffers.get(this.selected) : null;
    const lines = b?.lines ?? [];
    const els = lines.map(lineEl);
    if (b?.clipped) els.unshift(h('div', { class: 'tc-line tc-note' }, '… earlier output not shown'));
    if (!b || (!lines.length && !b.partial)) {
      const src = this.source();
      els.push(h('div', { class: 'tc-line tc-note tc-empty' }, !src ? 'Nothing has run yet.' : b ? 'No output yet.' : 'Loading…'));
    }
    this.lines.replaceChildren(...els);
    this.live.replaceChildren(...(b?.partial ? lineEl(b.partial).childNodes : []));
    this.renderFoot();
    if (this.follow) this.toEnd();
  }

  private toEnd(): void {
    this.screen.scrollTop = this.screen.scrollHeight;
    this.jump.hidden = true;
  }

  private async poll(): Promise<void> {
    if (!this.active) return;
    try {
      await this.read();
    } finally {
      clearTimeout(this.timer);
      const src = this.source();
      const b = this.selected ? this.buffers.get(this.selected) : null;
      // Done with a source that ended once its last output is in; check now and then otherwise.
      const idle = !src || (b?.final ?? false);
      if (this.active) this.timer = window.setTimeout(() => void this.poll(), idle ? POLL_MS * 4 : POLL_MS);
    }
  }

  private async read(): Promise<void> {
    const src = this.source();
    if (!src || this.reading || document.hidden) return;
    let b = this.buffers.get(src.id);
    if (b && b.runKey !== src.runKey) b = undefined; // a new run: start afresh
    if (b?.final) return;
    this.reading = true;
    try {
      // A source still running, or of unknown state, may write more; one that ended is read once more to be sure.
      const ended = src.running === false;
      for (let i = 0; i < 8; i++) {
        const res = await fetch(`/api/tomcat/console?id=${encodeURIComponent(src.id)}&from=${b?.next ?? -1}`);
        if (!res.ok) return;
        const chunk = (await res.json()) as ConsoleChunk;
        if (this.selected !== src.id) return;
        if (!b || b.runKey !== chunk.runKey) {
          b = { runKey: chunk.runKey, next: -1, clipped: chunk.start > 0, lines: [], partial: '', final: false };
          this.buffers.set(src.id, b);
          this.redrawLines();
        }
        this.append(b, chunk);
        if (chunk.next >= chunk.size) {
          if (ended) b.final = true;
          break;
        }
      }
    } catch {
      /* offline for a moment: the next poll tries again */
    } finally {
      this.reading = false;
    }
  }

  private append(b: Buffer, chunk: ConsoleChunk): void {
    b.next = chunk.next;
    if (!chunk.text) return;
    const parts = (b.partial + chunk.text).split('\n');
    b.partial = parts.pop() ?? '';
    const fresh = parts.map((l) => l.replace(/\r$/, ''));
    b.lines.push(...fresh);
    if (b.lines.length > MAX_LINES + 500) {
      // Trimmed in batches, so a busy console is not redrawn on every read.
      b.lines.splice(0, b.lines.length - MAX_LINES);
      b.clipped = true;
      this.redrawLines();
    } else if (fresh.length) {
      for (const el of this.lines.querySelectorAll('.tc-empty')) el.remove();
      const frag = document.createDocumentFragment();
      for (const l of fresh) frag.append(lineEl(l));
      this.lines.append(frag);
    }
    this.live.replaceChildren(...(b.partial ? lineEl(b.partial.replace(/\r$/, '')).childNodes : []));
    this.renderFoot();
    if (this.follow) this.toEnd();
    else this.jump.hidden = false;
  }
}
