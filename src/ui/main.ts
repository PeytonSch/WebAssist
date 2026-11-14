import { correlate, type CorrItem, type Correlation } from '../shared/correlate';
import type { HubEvent, HubStatus, Level, ServerMessage, SessionInfo } from '../shared/types';
import { $, fmtBytes, h, type Child } from './dom';
import { initSettings, openSettings, settingsOpen, updateSettingsStatus } from './settings';

// Everything captured is untrusted text. It is only ever placed in the DOM through
// textContent (see `h`), never as HTML.

type Group = 'console' | 'network' | 'log' | 'query' | 'marker';

interface Row {
  key: string;
  t: number;
  tEnd?: number;
  /** The event that created the row; for network rows this is the request. */
  ev: HubEvent;
  /** The response, folded into its request's row. */
  res?: HubEvent;
  hay?: string;
}

interface Filters {
  q: string;
  /** Disabled facets, e.g. "source:tomcat", "level:debug", "group:console". */
  off: string[];
  hideStatic: boolean;
}

interface Preset extends Filters {
  name: string;
}

const ROW_H = 30;
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const STATIC_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Manifest', 'Ping', 'Other']);
const SOURCES = [
  ['browser', 'Browser'],
  ['tomcat', 'Tomcat'],
  ['postgres', 'Postgres'],
] as const;
const LEVELS: Level[] = ['error', 'warn', 'info', 'debug'];
const GROUPS = [
  ['network', 'Network'],
  ['console', 'Console'],
  ['log', 'Logs'],
  ['query', 'Queries'],
] as const;
const DEFAULT_FILTERS: Filters = { q: '', off: [], hideStatic: true };
const BUILT_IN: Preset[] = [
  { name: 'Errors and warnings', q: '', off: ['level:info', 'level:debug'], hideStatic: true },
  { name: 'API traffic', q: '', off: ['group:console', 'group:log', 'group:query'], hideStatic: true },
  { name: 'Server side', q: '', off: ['source:browser'], hideStatic: true },
];

// ── Small DOM helpers ───────────────────────────────────

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

const fmtInt = (n: number) => n.toLocaleString('en-US');
function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
/** The recorded wall-clock time, exactly as stored (no re-conversion in the browser). */
const clock = (iso: string) => iso.slice(11, 23);

// ── State ───────────────────────────────────────────────

const state = {
  mode: 'live' as 'live' | 'replay',
  connected: false,
  session: '',
  liveSession: '',
  status: null as HubStatus | null,
  rows: [] as Row[],
  view: [] as Row[],
  byKey: new Map<string, Row>(),
  byNet: new Map<string, Row>(),
  seen: new Set<string>(),
  counts: { error: 0, warn: 0, info: 0, debug: 0 } as Record<Level, number>,
  selected: null as Row | null,
  relatedKeys: new Set<string>(),
  follow: true,
  filters: { ...DEFAULT_FILTERS, ...load<Partial<Filters>>('dh.filters', {}) } as Filters,
  presets: load<Preset[]>('dh.presets', []),
};

// ── Row model ───────────────────────────────────────────

const resOf = (r: Row): HubEvent | undefined => r.res ?? (r.ev.kind === 'response' ? r.ev : undefined);

function groupOf(r: Row): Group {
  switch (r.ev.kind) {
    case 'marker': return 'marker';
    case 'console': return 'console';
    case 'request':
    case 'response': return 'network';
    case 'query':
    case 'stats': return 'query';
    default: return 'log';
  }
}
function levelOf(r: Row): Level {
  return r.res && RANK[r.res.level] > RANK[r.ev.level] ? r.res.level : r.ev.level;
}
const ridOf = (r: Row): string | null => r.res?.requestId ?? r.ev.requestId;
const statusOf = (r: Row): number | null => resOf(r)?.data.status ?? r.ev.data.status ?? null;
const durationOf = (r: Row): number | null => resOf(r)?.data.durationMs ?? r.ev.data.durationMs ?? null;
const failedOf = (r: Row): boolean => !!resOf(r)?.data.failed;
const typeOf = (r: Row): string => resOf(r)?.data.resourceType ?? r.ev.data.resourceType ?? '';
const isStatic = (r: Row) => r.ev.source === 'browser' && groupOf(r) === 'network' && STATIC_TYPES.has(typeOf(r));

function hay(r: Row): string {
  if (r.hay === undefined) {
    const d = r.ev.data;
    const rd = r.res?.data ?? {};
    r.hay = [
      r.ev.summary, r.res?.summary, ridOf(r), d.url, d.message, d.text, d.body, rd.body,
      r.ev.source, r.ev.kind, statusOf(r), rd.errorText,
    ].filter((x) => x != null && x !== '').join('\n').toLowerCase();
  }
  return r.hay;
}

function toItem(r: Row): CorrItem {
  return {
    id: r.key,
    t: r.t,
    tEnd: r.tEnd,
    source: r.ev.source,
    group: groupOf(r),
    level: levelOf(r),
    requestId: ridOf(r),
    path: r.ev.data.path,
    method: r.ev.data.method,
  };
}

function insertSorted(rows: Row[], row: Row): void {
  const n = rows.length;
  if (n === 0 || rows[n - 1].t <= row.t) {
    rows.push(row);
    return;
  }
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= row.t) lo = mid + 1;
    else hi = mid;
  }
  rows.splice(lo, 0, row);
}

function ingest(events: HubEvent[], bulk = false): void {
  let touchedSelected = false;
  for (const ev of events) {
    if (state.seen.has(ev.id)) continue;
    state.seen.add(ev.id);
    const t = Date.parse(ev.ts);
    const netId: string | undefined = ev.source === 'browser' ? ev.data.netId : undefined;

    if (ev.kind === 'response' && netId) {
      const existing = state.byNet.get(netId);
      if (existing && !existing.res && existing.ev.kind === 'request') {
        existing.res = ev;
        existing.tEnd = t;
        existing.hay = undefined;
        if (existing === state.selected) touchedSelected = true;
        continue;
      }
    }
    const row: Row = { key: ev.id, t, ev };
    if (ev.kind === 'response') row.tEnd = t;
    if (ev.source === 'tomcat' && ev.kind === 'request' && ev.data.durationMs != null) row.tEnd = t + ev.data.durationMs;
    if (netId && (ev.kind === 'request' || ev.kind === 'response')) state.byNet.set(netId, row);
    state.byKey.set(row.key, row);
    if (bulk) state.rows.push(row);
    else insertSorted(state.rows, row);
  }
  if (bulk) state.rows.sort((a, b) => a.t - b.t);
  scheduleRefilter();
  if (state.selected) {
    if (touchedSelected) renderDetail();
    else refreshRelated();
  }
}

function resetRows(): void {
  state.rows = [];
  state.view = [];
  state.byKey.clear();
  state.byNet.clear();
  state.seen.clear();
  state.selected = null;
  state.relatedKeys.clear();
  renderDetail();
}

// ── Filtering ───────────────────────────────────────────

function passes(r: Row, off: Set<string>, terms: string[]): boolean {
  const g = groupOf(r);
  if (g !== 'marker') {
    const lvl = levelOf(r);
    if (off.has(`source:${r.ev.source}`) || off.has(`level:${lvl}`) || off.has(`group:${g}`)) return false;
    if (state.filters.hideStatic && RANK[lvl] < RANK.warn && isStatic(r)) return false;
  }
  if (terms.length) {
    const text = hay(r);
    for (const term of terms) if (!text.includes(term)) return false;
  }
  return true;
}

let refilterQueued = false;
function scheduleRefilter(): void {
  if (refilterQueued) return;
  refilterQueued = true;
  requestAnimationFrame(() => {
    refilterQueued = false;
    refilter();
  });
}

function refilter(): void {
  const off = new Set(state.filters.off);
  const terms = state.filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const counts: Record<Level, number> = { error: 0, warn: 0, info: 0, debug: 0 };
  const view: Row[] = [];
  for (const r of state.rows) {
    if (r.ev.kind !== 'marker') counts[levelOf(r)]++;
    if (passes(r, off, terms)) view.push(r);
  }
  state.view = view;
  state.counts = counts;
  renderChips();
  renderList();
  if (state.follow && state.mode === 'live') viewport.scrollTop = viewport.scrollHeight;
}

function setFilters(next: Partial<Filters>): void {
  state.filters = { ...state.filters, ...next };
  save('dh.filters', state.filters);
  if ($<HTMLInputElement>('q').value !== state.filters.q) $<HTMLInputElement>('q').value = state.filters.q;
  $<HTMLInputElement>('f-static').checked = state.filters.hideStatic;
  syncPresetSelect();
  scheduleRefilter();
}

function toggleFacet(facet: string, family: string[], solo: boolean): void {
  const off = new Set(state.filters.off);
  if (solo) {
    const others = family.filter((f) => f !== facet);
    const alreadySolo = !off.has(facet) && others.every((f) => off.has(f));
    for (const f of family) off.delete(f);
    if (!alreadySolo) for (const f of others) off.add(f);
  } else if (off.has(facet)) off.delete(facet);
  else off.add(facet);
  setFilters({ off: [...off] });
}

// ── Timeline rendering ──────────────────────────────────

const viewport = $('viewport');
const spacerEl = $('spacer');
const rowsEl = $('rows');

function statusPill(r: Row): HTMLElement | null {
  if (groupOf(r) !== 'network') return null;
  if (failedOf(r)) return h('span', { class: 'pill fail', title: resOf(r)?.data.errorText }, resOf(r)?.data.canceled ? 'CXL' : 'ERR');
  const status = statusOf(r);
  if (status == null) return h('span', { class: 'pill pending' }, '···');
  return h('span', { class: `pill s${Math.floor(status / 100)}` }, String(status || '—'));
}

function mainCell(r: Row): Child[] {
  const g = groupOf(r);
  if (g === 'network') {
    const d = r.ev.data;
    const text = r.ev.source === 'browser' ? r.ev.summary.replace(/^\S+\s/, '').replace(/ [→✕] .*$/, '') : d.path;
    return [
      h('span', { class: 'kind' }, r.ev.source === 'browser' ? (typeOf(r) || 'net').toLowerCase() : 'access'),
      h('span', { class: 'method' }, d.method ?? ''),
      h('span', { class: 'text' }, text),
      ridOf(r) &&
        h('span', { class: 'linked', title: `Request ID ${ridOf(r)}` }, linkIcon()),
    ];
  }
  const kind = g === 'console' ? (r.ev.data.type === 'exception' ? 'throw' : 'console') : g;
  return [
    h('span', { class: 'kind' }, kind),
    h('span', { class: 'text' }, r.ev.summary),
    ridOf(r) && h('span', { class: 'linked', title: `Request ID ${ridOf(r)}` }, linkIcon()),
  ];
}

function linkIcon(): Node {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7');
  p.setAttribute('fill', 'none');
  p.setAttribute('stroke', 'currentColor');
  p.setAttribute('stroke-width', '1.5');
  p.setAttribute('stroke-linecap', 'round');
  svg.append(p);
  return svg;
}

function sourceBadge(source: string): HTMLElement {
  const label = source === 'hub' ? 'Marker' : source[0].toUpperCase() + source.slice(1);
  return h('span', { class: `src src-${source}` }, label);
}

function renderRow(r: Row): HTMLElement {
  if (r.ev.kind === 'marker') {
    return h('div', { class: `row marker${r === state.selected ? ' sel' : ''}`, 'data-key': r.key },
      h('span', { class: 'c-time' }, clock(r.ev.ts)),
      h('span', { class: 'c-src' }, sourceBadge('hub')),
      h('span', { class: 'c-main' }, h('span', { class: 'text' }, r.ev.summary), h('span', { class: 'rule' })),
      h('span'), h('span'));
  }
  const lvl = levelOf(r);
  const dur = durationOf(r);
  const cls = ['row', `lvl-${lvl}`];
  if (r === state.selected) cls.push('sel');
  else if (state.relatedKeys.has(r.key)) cls.push('is-related');
  return h('div', { class: cls.join(' '), 'data-key': r.key },
    h('span', { class: 'c-time' }, clock(r.ev.ts)),
    h('span', { class: 'c-src' }, sourceBadge(r.ev.source)),
    h('span', { class: 'c-main' }, ...mainCell(r)),
    h('span', { class: 'c-status' }, statusPill(r)),
    h('span', { class: `c-dur${dur != null && dur >= 1000 ? ' slow' : ''}` }, fmtDuration(dur)));
}

function renderList(): void {
  const total = state.view.length;
  spacerEl.style.height = `${total * ROW_H}px`;
  const start = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - 10);
  const end = Math.min(total, Math.ceil((viewport.scrollTop + viewport.clientHeight) / ROW_H) + 10);
  rowsEl.style.transform = `translateY(${start * ROW_H}px)`;
  rowsEl.replaceChildren(...state.view.slice(start, end).map(renderRow));
  $('count').textContent =
    total === state.rows.length ? `${fmtInt(total)} events` : `${fmtInt(total)} of ${fmtInt(state.rows.length)} events`;
  renderEmpty();
}

function renderEmpty(): void {
  const empty = $('empty');
  if (state.view.length > 0) {
    empty.hidden = true;
    return;
  }
  empty.hidden = false;
  if (state.rows.length > 0) {
    const reset = h('button', { class: 'btn' }, 'Reset filters');
    reset.onclick = () => setFilters({ ...DEFAULT_FILTERS });
    empty.replaceChildren(
      h('h3', {}, 'No events match these filters'),
      h('div', {}, `${fmtInt(state.rows.length)} events are hidden.`),
      h('div', { style: 'margin-top:10px' }, reset),
    );
    return;
  }
  if (state.mode === 'replay') {
    empty.replaceChildren(h('h3', {}, 'This session is empty'));
    return;
  }
  const list = h('ul');
  for (const c of state.status?.collectors ?? []) {
    list.append(h('li', {}, h('b', {}, c.name), h('span', {}, c.state === 'off' ? `Off. ${c.detail}` : c.detail.split('\n')[0])));
  }
  empty.replaceChildren(
    h('h3', {}, state.connected ? 'Recording. Waiting for the first event' : 'Not connected to the hub'),
    h('div', {}, state.connected ? 'Use your app and events will appear here as they happen.' : 'Is debug-hub still running? Reconnecting…'),
    list,
  );
}

function renderChips(): void {
  const off = new Set(state.filters.off);
  const build = (host: HTMLElement, family: string[], items: { facet: string; label: string; color?: string; n?: number }[]) => {
    host.replaceChildren(
      ...items.map((it) => {
        const chip = h('button', { class: `chip${off.has(it.facet) ? ' off' : ''}`, type: 'button', 'aria-pressed': String(!off.has(it.facet)) },
          it.color ? h('span', { class: 'dot', style: `--c:var(--${it.color})` }) : null,
          h('span', { class: 'label' }, it.label),
          it.n !== undefined ? h('span', { class: 'n' }, fmtInt(it.n)) : null);
        chip.onclick = (e) => toggleFacet(it.facet, family, e.shiftKey);
        return chip;
      }),
    );
  };
  const src = SOURCES.map(([id]) => `source:${id}`);
  build($('f-source'), src, SOURCES.map(([id, label]) => ({ facet: `source:${id}`, label, color: id })));
  const lv = LEVELS.map((l) => `level:${l}`);
  build($('f-level'), lv, LEVELS.map((l) => ({
    facet: `level:${l}`,
    label: l[0].toUpperCase() + l.slice(1),
    color: l === 'error' ? 'error' : l === 'warn' ? 'warn' : undefined,
    n: state.counts[l],
  })));
  const gr = GROUPS.map(([id]) => `group:${id}`);
  build($('f-group'), gr, GROUPS.map(([id, label]) => ({ facet: `group:${id}`, label })));
}

// ── Selection ───────────────────────────────────────────

function select(row: Row | null, scroll = false): void {
  state.selected = row;
  if (row && scroll) {
    const i = state.view.indexOf(row);
    if (i !== -1) {
      const top = i * ROW_H;
      if (top < viewport.scrollTop || top + ROW_H > viewport.scrollTop + viewport.clientHeight) {
        setFollow(false);
        viewport.scrollTop = Math.max(0, top - viewport.clientHeight / 2);
      }
    }
  }
  renderDetail();
  renderList();
}

function move(delta: number): void {
  if (state.view.length === 0) return;
  const i = state.selected ? state.view.indexOf(state.selected) : -1;
  const next = i === -1 ? (delta > 0 ? 0 : state.view.length - 1) : Math.min(state.view.length - 1, Math.max(0, i + delta));
  setFollow(false);
  select(state.view[next], true);
}

function setFollow(on: boolean): void {
  state.follow = on;
  $('btn-follow').classList.toggle('active', on && state.mode === 'live');
  if (on && state.mode === 'live') viewport.scrollTop = viewport.scrollHeight;
}

// ── Detail panel ────────────────────────────────────────

const detail = $('detail');
let relatedHost: HTMLElement | null = null;

function section(title: string, body: Node, opts: { note?: string; copy?: string } = {}): HTMLElement {
  const head = h('div', { class: 'sec-head' }, h('h4', {}, title), opts.note ? h('span', { class: 'note' }, opts.note) : null);
  if (opts.copy !== undefined) {
    const btn = h('button', { class: 'btn copy', type: 'button' }, 'Copy');
    btn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(opts.copy!);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    };
    head.append(btn);
  }
  return h('div', { class: 'sec' }, head, body);
}

function facts(pairs: [string, Child | number | null | undefined][]): HTMLElement {
  const dl = h('dl', { class: 'facts' });
  for (const [k, v] of pairs) {
    if (v == null || v === '' || v === false) continue;
    dl.append(h('dt', {}, k), h('dd', {}, typeof v === 'number' ? String(v) : v));
  }
  return dl;
}

function code(text: string, stack = false): HTMLElement {
  const pre = h('pre', { class: 'code' });
  if (!stack) {
    pre.textContent = text;
    return pre;
  }
  for (const line of text.split('\n')) {
    const cls = /^\s*Caused by:/.test(line) ? 'cause' : /^\s+(at\s|\.\.\. \d+ (more|common))/.test(line) ? 'frame' : null;
    pre.append(cls ? h('span', { class: cls }, line) : line, '\n');
  }
  return pre;
}

function prettyBody(body: string, mime?: string | null): string {
  const t = body.trim();
  if ((mime && /json/i.test(mime)) || t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* truncated or not JSON; show as-is */
    }
  }
  return body;
}

function bodySection(title: string, d: Record<string, any>, mime?: string | null): HTMLElement | null {
  if (typeof d.body !== 'string') {
    return d.bodyUnavailable ? section(title, h('div', { class: 'rel-empty' }, 'Chrome had already discarded this body.')) : null;
  }
  if (d.body === '') return section(title, h('div', { class: 'rel-empty' }, 'Empty body.'));
  const text = prettyBody(d.body, mime);
  const el = section(title, code(text), { note: fmtBytes(d.bodyBytes), copy: text });
  if (d.bodyTruncated) {
    el.append(h('div', { class: 'notice' }, `Truncated: showing the first ${fmtBytes(new Blob([d.body]).size)} of ${fmtBytes(d.bodyBytes)}.`));
  }
  return el;
}

function headersSection(title: string, headers: Record<string, string> | undefined): HTMLElement | null {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return null;
  return section(title, facts(entries.map(([k, v]) => [k, v])), { note: String(entries.length) });
}

function relatedFor(row: Row): Correlation {
  const items = state.rows.map(toItem);
  const windowMs = state.status?.correlation.timeWindowMs ?? 2000;
  // Chrome links "Failed to load resource" console entries to the request that failed.
  const linked = groupOf(row) === 'console' && row.ev.data.netId ? state.byNet.get(row.ev.data.netId) : undefined;
  if (linked) {
    const c = correlate(toItem(linked), items, windowMs);
    return { exact: [toItem(linked), ...c.exact.filter((x) => x.id !== row.key)], approx: c.approx };
  }
  return correlate(toItem(row), items, windowMs);
}

function relCard(r: Row): HTMLElement {
  const lvl = levelOf(r);
  const card = h('div', { class: `rel ${lvl}`, title: 'Open this event' },
    h('div', { class: 'rel-head' },
      h('span', { class: 'c-time' }, clock(r.ev.ts)),
      sourceBadge(r.ev.source),
      h('span', { class: 'text' }, r.ev.summary),
      statusPill(r),
    ));
  const g = groupOf(r);
  const d = r.ev.data;
  let excerpt: string | null = null;
  if (g === 'log' && d.lines > 1) excerpt = d.message;
  if (g === 'query') excerpt = [d.statement, d.plan].filter(Boolean).join('\n\n') || null;
  if (excerpt) {
    const lines = excerpt.split('\n');
    const pre = h('pre', {}, lines.slice(0, 16).join('\n') + (lines.length > 16 ? `\n… ${lines.length - 16} more lines` : ''));
    // Selecting text in the excerpt should not navigate away; a plain click still opens the event.
    pre.onclick = (e) => {
      if (String(getSelection() ?? '') !== '') e.stopPropagation();
    };
    card.append(pre);
  }
  card.onclick = () => select(r, true);
  return card;
}

function refreshRelated(): void {
  const row = state.selected;
  if (!row || !relatedHost || row.ev.kind === 'marker') return;
  const c = relatedFor(row);
  const exact = c.exact.map((x) => state.byKey.get(x.id)!).filter(Boolean);
  const approx = c.approx.map((x) => state.byKey.get(x.id)!).filter(Boolean);
  const keys = new Set([...exact, ...approx].map((r) => r.key));
  const changed = keys.size !== state.relatedKeys.size || [...keys].some((k) => !state.relatedKeys.has(k));
  if (!changed && relatedHost.childElementCount > 0) return;
  state.relatedKeys = keys;

  const header = state.status?.correlation.header ?? 'X-Request-Id';
  const rid = ridOf(row);
  const nodes: HTMLElement[] = [];
  if (exact.length) {
    nodes.push(h('div', {}, h('span', { class: 'match exact' }, rid ? `Same request ID · ${exact.length}` : `Linked by Chrome · ${exact.length}`)));
    nodes.push(...exact.map(relCard));
  }
  if (approx.length) {
    nodes.push(h('div', {}, h('span', { class: 'match approx', title: 'No shared request ID, so these were matched by URL path and time. Treat as a hint.' }, `Matched by time · ${approx.length}`)));
    nodes.push(...approx.map(relCard));
  }
  if (nodes.length === 0) {
    nodes.push(h('div', { class: 'rel-empty' },
      rid
        ? `No other events carry request ID ${rid} yet.`
        : `Nothing matched by time. For exact matches, send ${header} through the dev proxy (see docs/correlation.md).`));
  }
  relatedHost.replaceChildren(...nodes);
  renderList();
}

function renderDetail(): void {
  const row = state.selected;
  relatedHost = null;
  if (!row) {
    detail.hidden = true;
    if (state.relatedKeys.size) {
      state.relatedKeys = new Set();
      renderList();
    }
    return;
  }
  detail.hidden = false;
  state.relatedKeys = new Set();
  const g = groupOf(row);
  const lvl = levelOf(row);
  const d = row.ev.data;
  const res = resOf(row);
  const rd = res?.data ?? {};

  const close = h('button', { class: 'btn btn-ghost btn-icon', title: 'Close (Esc)', 'aria-label': 'Close' }, '✕');
  close.onclick = () => select(null);
  const head = h('div', { class: 'd-head' },
    sourceBadge(row.ev.source),
    h('span', { class: `tag ${lvl}` }, g === 'marker' ? 'marker' : lvl),
    h('span', { class: 'when' }, `${row.ev.ts.slice(0, 10)} ${clock(row.ev.ts)}`),
    h('span', { class: 'spacer' }), close);
  const title = h('div', { class: 'd-title' }, res && res !== row.ev ? res.summary : row.ev.summary);
  const body = h('div', { class: 'd-body' });
  const add = (el: HTMLElement | null) => el && body.append(el);

  if (g === 'network' && row.ev.source === 'browser') {
    const status = failedOf(row) ? rd.errorText : statusOf(row) != null ? `${statusOf(row)} ${rd.statusText ?? ''}` : 'Pending';
    add(section('Request', facts([
      ['URL', d.url], ['Method', d.method], ['Status', status], ['Type', typeOf(row)],
      ['Duration', fmtDuration(durationOf(row))], ['Transferred', fmtBytes(rd.encodedBytes)],
      ['Content type', rd.mimeType], ['Request ID', ridOf(row)], ['Page', d.pageUrl],
    ])));
  } else if (g === 'network') {
    add(section('Access log', facts([
      ['Path', d.path], ['Method', d.method], ['Status', d.status], ['Duration', fmtDuration(d.durationMs)],
      ['Bytes', fmtBytes(d.bytes)], ['Remote', d.remote], ['Request ID', ridOf(row)], ['File', d.file],
    ])));
  } else if (g === 'console') {
    add(section('Console', facts([
      ['Type', d.type], ['Location', d.url ? `${d.url}${d.line ? ':' + d.line : ''}` : null], ['Page', d.pageUrl],
    ])));
  } else if (g === 'log') {
    add(section('Log entry', facts([
      ['Exception', d.exception], ['Root cause', d.rootCause !== d.exception ? d.rootCause : null],
      ['Thread', d.thread], ['Severity', d.severity], ['Request ID', ridOf(row)], ['File', d.file],
    ])));
  } else if (g === 'query') {
    add(section('Query', facts([
      ['Duration', fmtDuration(d.durationMs)], ['Backend PID', d.pid], ['Request ID', ridOf(row)], ['File', d.file],
    ])));
  }

  if (g !== 'marker') {
    relatedHost = h('div', { class: 'related' });
    add(section(row.ev.source === 'browser' ? 'Server events' : 'Related events', relatedHost));
  }

  if (g === 'network' && row.ev.source === 'browser') {
    add(bodySection('Response body', rd, rd.mimeType));
    add(bodySection('Request body', row.ev.kind === 'request' ? d : {}));
    add(headersSection('Response headers', rd.headers));
    add(headersSection('Request headers', row.ev.kind === 'request' ? d.headers : undefined));
  } else if (g === 'console') {
    const text = d.stack && !String(d.text).includes('\n    at ') ? `${d.text}\n${d.stack}` : d.text;
    add(section('Message', code(text ?? '', true), { copy: text ?? '' }));
  } else if (g === 'log') {
    add(section(d.stackFrames ? 'Stack trace' : 'Message', code(d.message ?? '', true), {
      note: d.lines > 1 ? `${d.lines} lines` : undefined,
      copy: d.message ?? '',
    }));
  } else if (g === 'query') {
    if (d.statement) add(section('Statement', code(d.statement), { copy: d.statement }));
    if (d.plan) {
      const plan = code(d.plan);
      plan.classList.add('nowrap');
      add(section('Plan', plan, { copy: d.plan }));
    }
    if (d.detail) add(section('Detail', code(d.detail)));
    if (d.hint) add(section('Hint', code(d.hint)));
    if (!d.statement && !d.plan) add(section('Message', code(d.message ?? '')));
  }

  const raw = h('details', { class: 'raw' }, h('summary', {}, 'Raw event'));
  raw.addEventListener('toggle', () => {
    if (raw.childElementCount === 1) raw.append(code(JSON.stringify(res && res !== row.ev ? [row.ev, res] : row.ev, null, 2)));
  });
  body.append(raw);

  detail.replaceChildren(head, title, body);
  refreshRelated();
}

// ── Top bar ─────────────────────────────────────────────

function renderStatus(): void {
  const s = state.status;
  $('collectors').replaceChildren(
    ...(s?.collectors ?? []).map((c) => h('span', { class: `collector ${c.state}`, title: c.detail }, c.name)),
  );
  const mode = $('mode');
  if (!state.connected) {
    mode.className = 'mode mode-offline';
    mode.textContent = 'Offline';
  } else if (state.mode === 'live') {
    mode.className = 'mode mode-live';
    mode.textContent = 'Live';
  } else {
    mode.className = 'mode mode-replay';
    mode.textContent = 'Replay';
  }
  const live = state.mode === 'live' && state.connected;
  $<HTMLButtonElement>('btn-marker').disabled = !live;
  $<HTMLButtonElement>('btn-follow').disabled = !live;
  $<HTMLButtonElement>('btn-new').disabled = !state.connected;
  $('btn-follow').classList.toggle('active', state.follow && live);
  if (state.rows.length === 0) renderEmpty();
}

const sessionLabel = (id: string) => id.replace(/^(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)-(\d\d)/, '$1 $2:$3:$4');

async function refreshSessions(): Promise<void> {
  let sessions: SessionInfo[] = [];
  try {
    sessions = await (await fetch('/api/sessions')).json();
  } catch {
    return;
  }
  const sel = $<HTMLSelectElement>('session');
  sel.replaceChildren(
    ...sessions.map((s) => {
      const o = h('option', { value: s.id }, s.live ? `Current session · ${sessionLabel(s.id)}` : `${sessionLabel(s.id)} · ${fmtBytes(s.bytes)}`);
      return o;
    }),
  );
  sel.value = state.session;
}

async function openSession(id: string): Promise<void> {
  state.session = id;
  state.mode = id === state.liveSession ? 'live' : 'replay';
  resetRows();
  renderStatus();
  $<HTMLSelectElement>('session').value = id;
  try {
    const text = await (await fetch(`/api/sessions/${encodeURIComponent(id)}/events`)).text();
    if (state.session !== id) return;
    const events: HubEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a partially written last line */
      }
    }
    ingest(events, true);
  } catch {
    /* the socket handler shows the offline state */
  }
  state.follow = state.mode === 'live';
  if (state.mode === 'replay') viewport.scrollTop = 0;
  renderStatus();
}

// ── Presets ─────────────────────────────────────────────

const sameFilters = (a: Filters, b: Filters) =>
  a.q === b.q && a.hideStatic === b.hideStatic && a.off.length === b.off.length && a.off.every((x) => b.off.includes(x));

function syncPresetSelect(): void {
  const sel = $<HTMLSelectElement>('presets');
  const all = [...BUILT_IN, ...state.presets];
  const active = all.findIndex((p) => sameFilters(p, state.filters));
  const isDefault = sameFilters(DEFAULT_FILTERS, state.filters);
  const opts: HTMLElement[] = [h('option', { value: 'default' }, isDefault || active !== -1 ? 'All events' : 'Custom filter')];
  all.forEach((p, i) => opts.push(h('option', { value: `p${i}` }, p.name)));
  opts.push(h('option', { disabled: '' }, '──────────'));
  opts.push(h('option', { value: 'save' }, 'Save current filter…'));
  if (active >= BUILT_IN.length) opts.push(h('option', { value: 'delete' }, `Delete “${all[active].name}”`));
  sel.replaceChildren(...opts);
  sel.value = active !== -1 ? `p${active}` : 'default';
}

async function onPresetChange(): Promise<void> {
  const sel = $<HTMLSelectElement>('presets');
  const all = [...BUILT_IN, ...state.presets];
  const v = sel.value;
  if (v === 'default') setFilters({ ...DEFAULT_FILTERS });
  else if (v === 'save') {
    const name = await ask('Save filter preset', 'Preset name', 'Save');
    if (name) {
      state.presets = [...state.presets.filter((p) => p.name !== name), { name, ...state.filters }];
      save('dh.presets', state.presets);
    }
    syncPresetSelect();
  } else if (v === 'delete') {
    const active = all.findIndex((p) => sameFilters(p, state.filters));
    state.presets = state.presets.filter((p) => p !== all[active]);
    save('dh.presets', state.presets);
    syncPresetSelect();
  } else {
    const p = all[Number(v.slice(1))];
    if (p) setFilters({ q: p.q, off: [...p.off], hideStatic: p.hideStatic });
  }
}

// ── Dialogs ─────────────────────────────────────────────

function ask(title: string, placeholder: string, okLabel: string): Promise<string | null> {
  const dialog = $<HTMLDialogElement>('prompt');
  const input = $<HTMLInputElement>('prompt-input');
  $('prompt-title').textContent = title;
  $('prompt-ok').textContent = okLabel;
  input.placeholder = placeholder;
  input.value = '';
  return new Promise((resolve) => {
    let result: string | null = null;
    $('prompt-form').onsubmit = () => {
      result = input.value.trim() || null;
    };
    $('prompt-cancel').onclick = () => dialog.close();
    dialog.onclose = () => resolve(result);
    dialog.showModal();
    input.focus();
  });
}

async function addMarker(): Promise<void> {
  if (state.mode !== 'live' || !state.connected) return;
  const label = await ask('Add marker', 'e.g. Clicked “Save order”', 'Add marker');
  if (!label) return;
  await fetch('/api/markers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label }),
  });
}

// ── Live connection ─────────────────────────────────────

function onStatus(status: HubStatus): void {
  const sessionChanged = status.session !== state.liveSession;
  const wasLive = state.mode === 'live';
  state.status = status;
  state.liveSession = status.session;
  updateSettingsStatus(status);
  if (sessionChanged) {
    void refreshSessions();
    if (wasLive || !state.session) void openSession(status.session);
  }
  renderStatus();
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    state.connected = true;
    renderStatus();
    // Pick up anything recorded while the socket was down.
    if (state.mode === 'live' && state.session) void openSession(state.session);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMessage;
    if (msg.type === 'status') onStatus(msg.status);
    else if (state.mode === 'live' && msg.session === state.session) ingest(msg.events);
  };
  ws.onclose = () => {
    state.connected = false;
    renderStatus();
    setTimeout(connect, 1000);
  };
}

// ── Wiring ──────────────────────────────────────────────

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme;
}

function init(): void {
  applyTheme(load<string | null>('dh.theme', null) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $<HTMLInputElement>('q').value = state.filters.q;
  $<HTMLInputElement>('f-static').checked = state.filters.hideStatic;
  renderChips();
  syncPresetSelect();
  renderStatus();

  viewport.addEventListener('scroll', () => {
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < ROW_H * 2;
    if (state.mode === 'live' && atBottom !== state.follow) {
      state.follow = atBottom;
      $('btn-follow').classList.toggle('active', atBottom);
    }
    renderList();
  }, { passive: true });
  new ResizeObserver(() => renderList()).observe(viewport);

  rowsEl.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.row');
    const row = el ? state.byKey.get(el.dataset.key!) : null;
    if (row) select(row === state.selected ? null : row);
  });

  let qTimer = 0;
  $('q').addEventListener('input', () => {
    clearTimeout(qTimer);
    qTimer = window.setTimeout(() => setFilters({ q: $<HTMLInputElement>('q').value }), 120);
  });
  $('f-static').addEventListener('change', () => setFilters({ hideStatic: $<HTMLInputElement>('f-static').checked }));
  $('presets').addEventListener('change', () => void onPresetChange());
  $('session').addEventListener('change', () => void openSession($<HTMLSelectElement>('session').value));

  $('btn-marker').onclick = () => void addMarker();
  $('btn-follow').onclick = () => setFollow(!state.follow);
  $('btn-new').onclick = async () => {
    await fetch('/api/sessions/new', { method: 'POST' });
  };
  $('btn-theme').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    save('dh.theme', next);
  };
  const help = $<HTMLDialogElement>('help');
  $('btn-help').onclick = () => help.showModal();
  $('help-close').onclick = () => help.close();

  initSettings({ onToggle: () => renderList() });
  $('btn-settings').onclick = () => openSettings();

  document.addEventListener('keydown', (e) => {
    // The settings screen has its own keys.
    if (settingsOpen()) return;
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return;
      if (typing) target.blur();
      else if (state.selected) select(null);
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    switch (e.key) {
      case '/': e.preventDefault(); $('q').focus(); break;
      case 'm': case 'M': e.preventDefault(); void addMarker(); break;
      case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'f': case 'F': setFollow(!state.follow); break;
      case 'e': case 'E': {
        const errorsOnly = ['level:info', 'level:debug'];
        const on = errorsOnly.every((x) => state.filters.off.includes(x));
        const rest = state.filters.off.filter((x) => !x.startsWith('level:'));
        setFilters({ off: on ? rest : [...rest, ...errorsOnly] });
        break;
      }
      case 'r': case 'R': setFilters({ ...DEFAULT_FILTERS }); break;
      case '?': help.showModal(); break;
    }
  });

  connect();
}

init();
