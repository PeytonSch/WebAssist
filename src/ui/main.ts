import { correlate, type CorrItem, type Correlation } from '../shared/correlate';
import { RouteMatcher, serverPath, type Route, type RouteTemplate } from '../shared/route';
import type { HubEvent, HubStatus, Level, ServerMessage, SessionInfo } from '../shared/types';
import { apiOpen, closeApi, editEventInApi, initApi, openApi, replayEvent, saveEventToCatalog, setJsonViewerOpener } from './api';
import { CHROME_LAUNCH_EVENT, chromeButton, chromeLaunching, chromeLaunchNote, startChrome } from './chrome';
import { $, fmtBytes, h, type Child } from './dom';
import { createFinder } from './find';
import { bodyLang, highlight, paint, type Lang, type Token } from './highlight';
import { findJsonIn } from './jsonmodel';
import { closeJsonViewer, initJsonViewer, jsonViewerOpen, openJsonViewer, type JsonSource } from './jsonviewer';
import { closeMetrics, initMetrics, metricsChanged, metricsOpen, openMetrics } from './metrics';
import { initSettings, openSettings, settingsOpen, updateSettingsStatus } from './settings';
import { firstOwnRef, initSource, linkSources, openSource, setSourceContext, showError } from './source';
import { durationOf, failedOf, groupOf, isSender, isStatic, levelOf, RANK, resOf, ridOf, routeWith, statusOf, typeOf, webappOf, type Group, type Row } from './rows';
import { initTitlebar } from './titlebar';
import { closeTomcat, initTomcat, onWarNotice, openTomcat, syncWarNotices, tomcatOpen } from './tomcat';

// Everything captured is untrusted text. It is only ever placed in the DOM through
// textContent (see `h`), never as HTML.

interface Filters {
  q: string;
  /**
   * Disabled facets, e.g. "source:tomcat", "level:debug", "group:console", "webapp:shop".
   * "webapp:" (no name) stands for Tomcat events whose webapp is not known.
   */
  off: string[];
  hideStatic: boolean;
}

interface Preset extends Filters {
  name: string;
}

const ROW_H = 30;
const SOURCES = [
  ['browser', 'Browser'],
  ['tomcat', 'Tomcat'],
  ['postgres', 'Postgres'],
  ['client', 'API'],
] as const;
const LEVELS: Level[] = ['error', 'warn', 'info', 'debug'];
const GROUPS = [
  ['network', 'Network'],
  ['console', 'Console'],
  ['log', 'Logs'],
  ['query', 'Queries'],
] as const;
const NO_WEBAPP = 'webapp:';
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
  /** Names request paths; holds the path templates of the loaded OpenAPI specs. */
  routes: new RouteMatcher(),
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
  /** Tomcat events per webapp label seen in this session; '' counts the unlabelled ones. */
  webapps: new Map<string, number>(),
  selected: null as Row | null,
  relatedKeys: new Set<string>(),
  follow: true,
  /** Show the latest events at the top. `rows` stays oldest-first; only `view` is reversed. */
  newestFirst: load<boolean>('dh.newestFirst', false),
  filters: { ...DEFAULT_FILTERS, ...load<Partial<Filters>>('dh.filters', {}) } as Filters,
  presets: load<Preset[]>('dh.presets', []),
};

// ── Row model ───────────────────────────────────────────

/** The short name of a network row's path ("user/id" for /user/id/12345), or null. */
const routeOf = (r: Row): Route | null => routeWith(r, state.routes);

function hay(r: Row): string {
  if (r.hay === undefined) {
    const d = r.ev.data;
    const rd = r.res?.data ?? {};
    r.hay = [
      r.ev.summary, r.res?.summary, ridOf(r), d.url, d.message, d.text, d.body, rd.body,
      r.ev.source, r.ev.kind, statusOf(r), rd.errorText, d.webapp, routeOf(r)?.label,
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
    const netId: string | undefined = isSender(ev.source) ? ev.data.netId : undefined;

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
    const app = webappOf(row);
    if (app !== null) state.webapps.set(app, (state.webapps.get(app) ?? 0) + 1);
    if (ev.kind === 'response') row.tEnd = t;
    if (ev.source === 'tomcat' && ev.kind === 'request' && ev.data.durationMs != null) row.tEnd = t + ev.data.durationMs;
    if (netId && (ev.kind === 'request' || ev.kind === 'response')) state.byNet.set(netId, row);
    state.byKey.set(row.key, row);
    if (bulk) state.rows.push(row);
    else insertSorted(state.rows, row);
  }
  if (bulk) state.rows.sort((a, b) => a.t - b.t);
  scheduleRefilter();
  metricsChanged();
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
  state.webapps.clear();
  state.selected = null;
  state.relatedKeys.clear();
  renderDetail();
  metricsChanged();
}

// ── Filtering ───────────────────────────────────────────

function passes(r: Row, off: Set<string>, terms: string[]): boolean {
  const g = groupOf(r);
  if (g !== 'marker') {
    const lvl = levelOf(r);
    if (off.has(`source:${r.ev.source}`) || off.has(`level:${lvl}`) || off.has(`group:${g}`)) return false;
    // Only Tomcat events have a webapp; the webapp filter leaves everything else alone.
    const app = webappOf(r);
    if (app !== null && off.has(`webapp:${app}`)) return false;
    if (state.filters.hideStatic && RANK[lvl] < RANK.warn && isStatic(r)) return false;
  }
  if (terms.length) {
    const text = hay(r);
    for (const term of terms) {
      if (term.startsWith('route:')) {
        // route:user/id matches the short name; route:/user/id/{id} the exact template.
        const want = term.slice(6);
        const route = routeOf(r);
        const have = want.startsWith('/') ? route?.template : route?.label;
        if (have?.toLowerCase() !== want) return false;
      } else if (!text.includes(term)) return false;
    }
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
  if (state.newestFirst) view.reverse();
  // Newest-first, live events land above whatever is being read. Unless following, keep the
  // row at the top of the viewport where it is instead of letting it slide down.
  const following = state.follow && state.mode === 'live';
  const anchorIdx = Math.floor(viewport.scrollTop / ROW_H);
  const anchor = state.newestFirst && state.mode === 'live' && !following ? state.view[anchorIdx] : undefined;
  const anchorOffset = viewport.scrollTop - anchorIdx * ROW_H;
  state.view = view;
  state.counts = counts;
  spacerEl.style.height = `${view.length * ROW_H}px`;
  if (following) scrollToNewest();
  else if (anchor) {
    const i = view.indexOf(anchor);
    if (i !== -1) viewport.scrollTop = i * ROW_H + anchorOffset;
  }
  renderChips();
  renderList();
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
    const text = isSender(r.ev.source) ? r.ev.summary.replace(/^\S+\s/, '').replace(/ [→✕] .*$/, '') : d.path;
    return [
      h('span', { class: 'kind' }, r.ev.source === 'client' ? 'api' : r.ev.source === 'browser' ? (typeOf(r) || 'net').toLowerCase() : 'access'),
      webappTag(r),
      h('span', { class: 'method' }, d.method ?? ''),
      routeText(r, text),
      ridOf(r) &&
        h('span', { class: 'linked', title: `Request ID ${ridOf(r)}` }, linkIcon()),
    ];
  }
  const kind = g === 'console' ? (r.ev.data.type === 'exception' ? 'throw' : 'console') : g;
  return [
    h('span', { class: 'kind' }, kind),
    webappTag(r),
    h('span', { class: 'text' }, r.ev.summary),
    ridOf(r) && h('span', { class: 'linked', title: `Request ID ${ridOf(r)}` }, linkIcon()),
  ];
}

/** A small label naming the webapp a Tomcat event came from. */
function webappTag(r: Row): HTMLElement | null {
  const app = webappOf(r);
  return app ? h('span', { class: 'webapp', title: `Webapp: ${app}` }, app) : null;
}

/**
 * A request's path as its route in bold, then what varies muted: "user/id 12345 ?page=2". The
 * full path stays in the tooltip. Other hosts keep their host in front, muted.
 */
function routeText(r: Row, text: string): HTMLElement {
  const route = routeOf(r);
  if (!route) return h('span', { class: 'text' }, text);
  const host = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(text)?.[0];
  const varying = [...route.params, route.query].filter(Boolean).join(' ');
  return h('span', { class: 'text', title: [text, route.title].filter(Boolean).join('\n') },
    host ? h('span', { class: 'route-rest' }, `${host.replace(/^[a-z]+:\/\//i, '')} `) : null,
    h('span', { class: 'route' }, route.label),
    varying ? h('span', { class: 'route-rest' }, ` ${varying}`) : null);
}

/** The Route line in the detail panel, with a button that shows only that route. */
function routeFact(row: Row): HTMLElement | null {
  const route = routeOf(row);
  if (!route) return null;
  // By template, so /api/orders and /api/orders/{id} (both "api/orders") stay apart.
  const only = h('button', { class: 'btn btn-sm', type: 'button', title: `Show only ${route.template} requests (search route:${route.template})` }, 'Only this route');
  only.onclick = () => setFilters({ q: `route:${route.template}` });
  return h('span', { class: 'route-fact' },
    h('code', {}, route.template),
    route.title ? h('span', { class: 'route-rest' }, route.title) : null,
    only);
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
  const label = source === 'hub' ? 'Marker' : source === 'client' ? 'API' : source[0].toUpperCase() + source.slice(1);
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
    ...(chromeWaiting() ? [chromeHelp()] : []),
  );
}

/** The Chrome collector while it cannot reach Chrome, in the live view of a running hub. */
function chromeWaiting() {
  const c = state.status?.collectors.find((x) => x.name === 'Chrome');
  return state.connected && state.mode === 'live' && c?.state === 'waiting' ? c : null;
}

/** Why Chrome is not connected (the lines after the first of its status) and a way to fix it. */
function chromeHelp(): HTMLElement {
  const hint = chromeWaiting()?.detail.split('\n').slice(1).join(' ') ?? '';
  return h(
    'div',
    { class: 'empty-chrome' },
    hint ? h('p', {}, ...hint.split(/(--[\w-]+)/).map((part, i) => (i % 2 ? h('code', {}, part) : part))) : null,
    chromeButton({ primary: true }),
    chromeLaunchNote(),
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
  renderWebappChips(build, off);
}

/** Above this many choices the webapp chips move into a menu, so the filter bar keeps its room. */
const WEBAPP_INLINE_MAX = 3;
const webappMenu = $('webapp-menu');

/**
 * One chip per webapp seen in this session, plus one for Tomcat events with no known webapp.
 * Webapps hidden by a saved filter keep their chip even before they log anything, so they can
 * be shown again. The group only appears once there is a webapp to choose.
 */
function renderWebappChips(
  build: (host: HTMLElement, family: string[], items: { facet: string; label: string; n?: number }[]) => void,
  off: Set<string>,
): void {
  const names = new Set([...state.webapps.keys()].filter(Boolean));
  for (const f of off) if (f.startsWith('webapp:') && f !== NO_WEBAPP) names.add(f.slice('webapp:'.length));
  const host = $('f-webapp');
  // Also shown while unlabelled events are hidden, or nothing could show them again.
  const show = names.size > 0 || off.has(NO_WEBAPP);
  host.hidden = !show;
  $('f-webapp-divider').hidden = !show;
  if (!show) {
    closeWebappMenu();
    return host.replaceChildren();
  }
  const items = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ facet: `webapp:${name}`, label: name, n: state.webapps.get(name) ?? 0 }));
  if (state.webapps.get('') || off.has(NO_WEBAPP)) items.push({ facet: NO_WEBAPP, label: 'No webapp', n: state.webapps.get('') ?? 0 });
  const family = items.map((it) => it.facet);
  const label = h('span', { class: 'chips-label', title: 'Tomcat events by webapp. Other sources are not affected.' }, 'Webapp');

  if (items.length <= WEBAPP_INLINE_MAX) {
    closeWebappMenu();
    build(host, family, items);
    host.prepend(label);
    return;
  }
  const hidden = items.filter((it) => off.has(it.facet)).length;
  const open = !webappMenu.hidden;
  const toggle = h('button', { class: `chip${hidden ? ' filtered' : ''}`, type: 'button', 'aria-haspopup': 'true', 'aria-expanded': String(open), title: 'Choose which webapps’ Tomcat events to show' },
    h('span', { class: 'label' }, hidden ? `${items.length - hidden} of ${items.length}` : `All ${items.length}`),
    h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'));
  toggle.onclick = (e) => {
    e.stopPropagation();
    if (webappMenu.hidden) openWebappMenu(toggle);
    else closeWebappMenu();
  };
  host.replaceChildren(label, toggle);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Webapp' });
  build(chips, family, items);
  const all = h('button', { class: 'link', type: 'button' }, 'Show all');
  all.onclick = () => setFilters({ off: state.filters.off.filter((f) => !f.startsWith('webapp:')) });
  webappMenu.replaceChildren(chips, h('div', { class: 'menu-foot' }, h('span', {}, 'Shift-click to show only one'), hidden ? all : null));
  if (open) placeWebappMenu(toggle);
}

function placeWebappMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  webappMenu.style.top = `${r.bottom + 6}px`;
  webappMenu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - webappMenu.offsetWidth - 8))}px`;
}

function openWebappMenu(anchor: HTMLElement): void {
  webappMenu.hidden = false;
  anchor.setAttribute('aria-expanded', 'true');
  placeWebappMenu(anchor);
}

function closeWebappMenu(): void {
  if (webappMenu.hidden) return;
  webappMenu.hidden = true;
  $('f-webapp').querySelector('[aria-expanded]')?.setAttribute('aria-expanded', 'false');
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
  if (on && state.mode === 'live') scrollToNewest();
}

function scrollToNewest(): void {
  viewport.scrollTop = state.newestFirst ? 0 : viewport.scrollHeight;
}

function atNewest(): boolean {
  const fromEdge = state.newestFirst
    ? viewport.scrollTop
    : viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  return fromEdge < ROW_H * 2;
}

function setNewestFirst(on: boolean): void {
  if (on === state.newestFirst) return;
  // Mirror the scroll position so the same stretch of events stays on screen.
  const mirrored = Math.max(0, state.view.length * ROW_H - viewport.scrollTop - viewport.clientHeight);
  state.newestFirst = on;
  save('dh.newestFirst', on);
  state.view.reverse();
  renderOrder();
  if (state.follow && state.mode === 'live') scrollToNewest();
  else viewport.scrollTop = mirrored;
  renderList();
}

function renderOrder(): void {
  const btn = $('sort-time');
  const label = state.newestFirst ? 'Newest first' : 'Oldest first';
  btn.classList.toggle('desc', state.newestFirst);
  btn.title = `${label}. Click to show ${state.newestFirst ? 'oldest' : 'newest'} first (O)`;
  btn.setAttribute('aria-label', `Time, ${label.toLowerCase()}`);
  $('btn-follow').classList.toggle('newest-top', state.newestFirst);
}

// ── Detail panel ────────────────────────────────────────

const detail = $('detail');
let relatedHost: HTMLElement | null = null;
/** Builds the selected event's Raw event block if it has not been opened yet (for the find bar). */
let fillRaw: (() => void) | null = null;

// The find bar is built once and stays in the panel across events, keeping its query (like a
// browser's find bar) and its focus while live updates rebuild the content around it.
const finder = createFinder({
  roots: () => (state.selected ? [...detail.children].filter((el): el is HTMLElement => el !== finder.bar && el instanceof HTMLElement) : []),
  prepare: () => fillRaw?.(),
  fallbackFocus: () => viewport,
});
let detailShown: Row | null = null;

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

/**
 * A class name in the facts (logger, exception), marked for Go to source like the stack frames:
 * it becomes a link when the class is in your sources. Text after the name stays plain.
 */
function classFact(text: string | null | undefined, kind: 'logger' | 'exception'): HTMLElement | null {
  if (!text) return null;
  const m = /^((?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*)([\s\S]*)$/.exec(text);
  if (!m) return h('span', {}, text);
  // One find block, so a search can match across the link and the text after it.
  return h('span', { 'data-find-block': '' }, h('span', { class: 'fact-src', 'data-src': m[1], 'data-src-kind': kind }, m[1]), m[2]);
}

function code(text: string, lang: Lang = 'text'): HTMLElement {
  return paint(h('pre', { class: 'code' }), highlight(text, lang));
}

/** The first `max` lines of one or more blocks (a statement and its plan), highlighted. */
function excerpt(parts: [string, Lang][], max = 16): HTMLElement {
  const total = parts.map(([text]) => text).join('\n\n').split('\n').length;
  const tokens: Token[] = [];
  let left = max;
  for (const [text, lang] of parts) {
    if (tokens.length) {
      if (left <= 1) break;
      tokens.push({ text: '\n\n' });
      left--;
    }
    const shown = text.split('\n').slice(0, left);
    left -= shown.length;
    // A related event's card selects that event when clicked, so its classes are not links.
    tokens.push(...highlight(shown.join('\n'), lang).map(({ text, cls }) => ({ text, cls })));
  }
  const hidden = total - (max - left);
  if (hidden > 0) tokens.push({ text: `\n… ${hidden} more lines`, cls: 'dim' });
  return paint(h('pre'), tokens);
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

// ── JSON viewer sources ─────────────────────────────────

/** Opens the full-window JSON viewer, which hides the panel; not over Settings or Tomcat. */
function viewJson(src: JsonSource | null): void {
  if (src && !settingsOpen() && !tomcatOpen()) openJsonViewer(src);
}

/** "JSON viewer" button for a section head: placed before its Copy button. */
function withJsonButton(sec: HTMLElement, src: JsonSource | null, where: Element | null = sec.querySelector('.sec-head')): HTMLElement {
  if (!src || !where) return sec;
  const btn = h('button', { class: 'btn copy jv-open', type: 'button', title: 'Explore this JSON full-window: tree, table, search and paths (V)' }, 'JSON viewer');
  btn.onclick = (e) => {
    // Inside the raw event's <summary>, a click would also fold the section.
    e.preventDefault();
    e.stopPropagation();
    viewJson(src);
  };
  where.insertBefore(btn, where.querySelector(':scope > .copy'));
  return sec;
}

/** Path and query of a URL, for headers: "/api/orders?page=2". */
function shortUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.pathname + u.search).slice(0, 160);
  } catch {
    return url.slice(0, 160);
  }
}

/** The response or request body of a browser request, when it is JSON. */
function bodySource(row: Row, which: 'response' | 'request'): JsonSource | null {
  if (groupOf(row) !== 'network' || !isSender(row.ev.source)) return null;
  const req = row.ev.kind === 'request' ? row.ev.data : {};
  const d: Record<string, any> = which === 'response' ? resOf(row)?.data ?? {} : req;
  if (typeof d.body !== 'string' || d.body.trim() === '') return null;
  if (bodyLang(d.body, which === 'response' ? d.mimeType : undefined) !== 'json') return null;
  const status = which === 'response' ? statusOf(row) : null;
  const name = (shortUrl(row.ev.data.url).split('?')[0].split('/').filter(Boolean).pop() ?? 'body').replace(/[^\w.-]+/g, '_');
  return {
    title: which === 'response' ? 'Response body' : 'Request body',
    meta: [`${row.ev.data.method ?? ''} ${shortUrl(row.ev.data.url)}`.trim(), status != null ? String(status) : '', fmtBytes(d.bodyBytes ?? d.body.length)].filter(Boolean),
    text: d.body,
    fileName: `${name}-${which}.json`,
    truncated: d.bodyTruncated ? { captured: new Blob([d.body]).size, total: d.bodyBytes } : null,
  };
}

/** The text of a console or log message. */
function messageText(row: Row): string | null {
  const d = row.ev.data;
  const g = groupOf(row);
  if (g === 'console') return d.stack && !String(d.text).includes('\n    at ') ? `${d.text}\n${d.stack}` : d.text ?? null;
  if (g === 'log') return d.message ?? null;
  return null;
}

/** A JSON object inside a console or log message ("Saved order {…}"), if there is one. */
function messageSource(row: Row): JsonSource | null {
  const text = messageText(row);
  const found = text ? findJsonIn(text) : null;
  if (!found) return null;
  return {
    title: groupOf(row) === 'console' ? 'Console message' : 'Log message',
    meta: [row.ev.summary.slice(0, 120)],
    text: found.text,
    fileName: `${groupOf(row)}-message.json`,
  };
}

function rawSource(row: Row): JsonSource {
  const res = resOf(row);
  return {
    title: 'Raw event',
    meta: [row.ev.summary.slice(0, 120)],
    text: JSON.stringify(res && res !== row.ev ? [row.ev, res] : row.ev),
    fileName: `event-${row.ev.id}.json`.replace(/[^\w.-]+/g, '_'),
  };
}

/** What V opens: a JSON body, else JSON in the message, else the raw event. */
function jsonForSelected(): JsonSource | null {
  const row = state.selected;
  if (!row) return null;
  return bodySource(row, 'response') ?? bodySource(row, 'request') ?? messageSource(row) ?? rawSource(row);
}

function bodySection(title: string, d: Record<string, any>, mime?: string | null, json: JsonSource | null = null): HTMLElement | null {
  if (typeof d.body !== 'string') {
    return d.bodyUnavailable ? section(title, h('div', { class: 'rel-empty' }, 'Chrome had already discarded this body.')) : null;
  }
  if (d.body === '') return section(title, h('div', { class: 'rel-empty' }, 'Empty body.'));
  const text = prettyBody(d.body, mime);
  const el = withJsonButton(section(title, code(text, bodyLang(text, mime)), { note: fmtBytes(d.bodyBytes), copy: text }), json);
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
      webappTag(r),
      h('span', { class: 'text' }, r.ev.summary),
      statusPill(r),
    ));
  const g = groupOf(r);
  const d = r.ev.data;
  const parts: [string, Lang][] = [];
  if (g === 'log' && d.lines > 1) parts.push([d.message, 'log']);
  if (g === 'query') {
    if (d.statement) parts.push([d.statement, 'sql']);
    if (d.plan) parts.push([d.plan, 'plan']);
  }
  if (parts.length) {
    const pre = excerpt(parts);
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
  fillRaw = null;
  const newEvent = row !== detailShown;
  detailShown = row;
  if (!row) {
    detail.hidden = true;
    finder.refresh(true);
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
  // Before anything is painted: links to the sources depend on the event's webapp.
  setSourceContext(row.ev.source === 'tomcat' ? d.webapp : null);

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

  if (g === 'network' && isSender(row.ev.source)) {
    const status = failedOf(row) ? rd.errorText : statusOf(row) != null ? `${statusOf(row)} ${rd.statusText ?? ''}` : 'Pending';
    add(section('Request', facts([
      ['URL', d.url], ['Route', routeFact(row)], ['Method', d.method], ['Status', status], ['Type', typeOf(row)],
      ['Duration', fmtDuration(durationOf(row))], ['Transferred', fmtBytes(rd.encodedBytes)],
      ['Content type', rd.mimeType], ['Request ID', ridOf(row)], ['Page', d.pageUrl],
      ['Sent by', row.ev.source === 'client' ? `API client${d.label ? ` · ${d.label}` : ''}` : null],
    ])));
    if (row.ev.kind === 'request') add(replayActions(row.ev.data));
  } else if (g === 'network') {
    add(section('Access log', facts([
      ['Webapp', d.webapp], ['Path', d.path], ['Route', routeFact(row)], ['Method', d.method], ['Status', d.status], ['Duration', fmtDuration(d.durationMs)],
      ['Bytes', fmtBytes(d.bytes)], ['Remote', d.remote], ['Request ID', ridOf(row)], ['File', d.file],
    ])));
  } else if (g === 'console') {
    add(section('Console', facts([
      ['Type', d.type], ['Location', d.url ? `${d.url}${d.line ? ':' + d.line : ''}` : null], ['Page', d.pageUrl],
    ])));
  } else if (g === 'log') {
    const entry = section('Log entry', facts([
      ['Webapp', d.webapp], ['Logger', classFact(d.logger, 'logger')], ['Exception', classFact(d.exception, 'exception')],
      ['Root cause', d.rootCause !== d.exception ? classFact(d.rootCause, 'exception') : null],
      ['Thread', d.thread], ['Severity', d.severity], ['Request ID', ridOf(row)], ['File', d.file],
    ]));
    // Only entries that name a class: not Debug Hub's own notes (Start Tomcat, WAR builds).
    if (row.ev.source === 'tomcat' && (d.logger || d.exception || d.stackFrames || MENTIONS_CLASS.test(d.message ?? ''))) entry.append(sourceActions());
    add(entry);
  } else if (g === 'query') {
    add(section('Query', facts([
      ['Duration', fmtDuration(d.durationMs)], ['Backend PID', d.pid], ['Request ID', ridOf(row)], ['File', d.file],
    ])));
  }

  if (g !== 'marker') {
    relatedHost = h('div', { class: 'related' });
    add(section(isSender(row.ev.source) ? 'Server events' : 'Related events', relatedHost));
  }

  if (g === 'network' && isSender(row.ev.source)) {
    add(bodySection('Response body', rd, rd.mimeType, bodySource(row, 'response')));
    add(bodySection('Request body', row.ev.kind === 'request' ? d : {}, undefined, bodySource(row, 'request')));
    add(headersSection('Response headers', rd.headers));
    add(headersSection('Request headers', row.ev.kind === 'request' ? d.headers : undefined));
  } else if (g === 'console') {
    const text = d.stack && !String(d.text).includes('\n    at ') ? `${d.text}\n${d.stack}` : d.text;
    add(withJsonButton(section('Message', code(text ?? '', 'log'), { copy: text ?? '' }), messageSource(row)));
  } else if (g === 'log') {
    add(withJsonButton(section(d.stackFrames ? 'Stack trace' : 'Message', code(d.message ?? '', 'log'), {
      note: d.lines > 1 ? `${d.lines} lines` : undefined,
      copy: d.message ?? '',
    }), messageSource(row)));
  } else if (g === 'query') {
    if (d.statement) add(section('Statement', code(d.statement, 'sql'), { copy: d.statement }));
    if (d.plan) {
      const plan = code(d.plan, 'plan');
      plan.classList.add('nowrap');
      add(section('Plan', plan, { copy: d.plan }));
    }
    if (d.detail) add(section('Detail', code(d.detail, 'log')));
    if (d.hint) add(section('Hint', code(d.hint, 'log')));
    if (!d.statement && !d.plan) add(section('Message', code(d.message ?? '', 'log')));
  }

  const raw = h('details', { class: 'raw' }, h('summary', {}, 'Raw event'));
  withJsonButton(raw, rawSource(row), raw.firstElementChild);
  fillRaw = () => {
    if (raw.childElementCount === 1) raw.append(code(JSON.stringify(res && res !== row.ev ? [row.ev, res] : row.ev, null, 2), 'json'));
  };
  raw.addEventListener('toggle', fillRaw);
  body.append(raw);

  // Everything but the find bar is replaced, so typing in it is not interrupted.
  for (const el of [...detail.children]) if (el !== finder.bar) el.remove();
  detail.prepend(head, title);
  // Re-inserting the bar, even in place, would take focus from it.
  if (finder.bar.parentElement !== detail) detail.append(finder.bar);
  detail.append(body);
  linkSources(body);
  refreshRelated();
  finder.refresh(newEvent);
}

/** A fully qualified class name anywhere in a message, as highlight.ts links them. */
const MENTIONS_CLASS = /(?:^|[^\w.$])(?:[a-z_]\w*\.)+[A-Z][\w$]*/;

/** The Go to source button of a Tomcat log entry. */
function sourceActions(): HTMLElement {
  const btn = h('button', { class: 'btn btn-sm', type: 'button', title: 'Open the first stack frame from your code (or the logger’s class) in your editor (G)' }, 'Go to source');
  btn.onclick = () => void goToSource();
  return h('div', { class: 'd-actions' }, btn);
}

/** G: opens the event's own code at the top of its stack trace, or the logger's class. */
async function goToSource(): Promise<void> {
  const row = state.selected;
  if (!row || groupOf(row) !== 'log' || detail.hidden) return;
  const body = detail.querySelector<HTMLElement>('.d-body');
  const ref = body ? await firstOwnRef(body) : null;
  if (ref) return openSource(ref);
  showError({
    error: 'Nothing in this entry is in your sources.',
    hint: 'Stack frames, the logger and exception classes are looked up in the projects listed under Settings › Source code.',
    settings: true,
  });
}

/** Save to catalog, Edit and send, Replay: a recorded request sent again from the API screen. */
function replayActions(data: Record<string, any>): HTMLElement {
  const note = h('span', { class: 'd-actions-note', role: 'status' });
  const replay = h('button', { class: 'btn btn-sm', type: 'button', title: 'Send this request again now, through the hub, with a fresh request ID' }, 'Replay') as HTMLButtonElement;
  replay.onclick = async () => {
    replay.disabled = true;
    note.textContent = 'Sending…';
    note.classList.remove('error');
    try {
      selectEvent(await replayEvent(data));
    } catch (err) {
      note.textContent = (err as Error).message;
      note.classList.add('error');
      replay.disabled = false;
    }
  };
  const edit = h('button', { class: 'btn btn-sm', type: 'button', title: 'Open it in the API screen to change it before sending' }, 'Edit and send');
  edit.onclick = () => void editEventInApi(data);
  const keep = h('button', { class: 'btn btn-sm', type: 'button', title: 'Save it to the API screen’s catalog of requests' }, 'Save to catalog…');
  keep.onclick = () => void saveEventToCatalog(data);
  return h('div', { class: 'd-actions' }, replay, edit, keep, note);
}

/**
 * Selects an event by id, e.g. one the API screen just sent: switches back to the live session,
 * shows API client events if they were filtered out, and waits briefly for the event to arrive.
 */
export function selectEvent(id: string, tries = 30): void {
  const row = state.byKey.get(id) ?? state.rows.find((r) => r.res?.id === id);
  if (!row) {
    if (state.mode !== 'live' && state.liveSession) void openSession(state.liveSession).then(() => selectEvent(id, tries));
    else if (tries > 0) setTimeout(() => selectEvent(id, tries - 1), 100);
    return;
  }
  if (state.filters.off.includes(`source:${row.ev.source}`)) {
    setFilters({ off: state.filters.off.filter((f) => f !== `source:${row.ev.source}`) });
    refilter();
  }
  select(row, true);
}

/**
 * From the metrics screen: the timeline showing only one route's requests. Level filters and a
 * hidden Network group would hide some of them, so those are cleared.
 */
function showRoute(template: string, asset: boolean): void {
  setFilters({
    q: `route:${template}`,
    off: state.filters.off.filter((f) => f !== 'group:network' && !f.startsWith('level:')),
    hideStatic: asset ? false : state.filters.hideStatic,
  });
  setFollow(false);
}

/** From the metrics screen: selects an event, first lifting any filter that hides it. */
function revealEvent(key: string): void {
  const row = state.byKey.get(key);
  if (!row) return;
  const app = webappOf(row);
  const hiding = new Set([`source:${row.ev.source}`, `level:${levelOf(row)}`, `group:${groupOf(row)}`, ...(app !== null ? [`webapp:${app}`] : [])]);
  const off = state.filters.off.filter((f) => !hiding.has(f));
  const terms = state.filters.q.toLowerCase().split(/\s+/).filter(Boolean);
  const q = passes(row, new Set(off), terms) ? state.filters.q : '';
  setFilters({ off, q, hideStatic: isStatic(row) ? false : state.filters.hideStatic });
  refilter();
  select(row, true);
}

// ── Top bar ─────────────────────────────────────────────

function renderStatus(): void {
  const s = state.status;
  const waitingChrome = chromeWaiting();
  $('collectors').replaceChildren(
    ...(s?.collectors ?? []).map((c) =>
      c === waitingChrome ? chromeStartPill(c.detail) : h('span', { class: `collector ${c.state}`, title: `${c.name}: ${c.detail}` }, h('span', { class: 'collector-name' }, c.name)),
    ),
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

/**
 * While Chrome is not connected its status pill becomes the Start Chrome button: the top bar
 * has no room for another one.
 */
function chromeStartPill(detail: string): HTMLElement {
  const btn = h(
    'button',
    { type: 'button', class: 'collector waiting collector-start', title: `${detail.split('\n')[0]}\nClick to start Chrome with its debugging port.` },
    chromeLaunching() ? 'Starting…' : 'Start Chrome',
  ) as HTMLButtonElement;
  btn.disabled = chromeLaunching();
  btn.onclick = () => void startChromeFromTopbar();
  return btn;
}

/** Top-bar Start Chrome: the result shows as a toast, since the bar has no room for it. */
async function startChromeFromTopbar(): Promise<void> {
  const r = await startChrome();
  const el = h('div', { class: `toast launch-toast${r.ok ? '' : ' failed'}`, role: 'status' }, r.message, r.hint ? h('small', {}, r.hint) : null);
  document.body.append(el);
  const ms = r.ok ? 2500 : 7000;
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
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
    void syncWarNotices();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as ServerMessage;
    if (msg.type === 'status') onStatus(msg.status);
    else if (msg.type === 'war') onWarNotice(msg.war);
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

/**
 * Loads the path templates of the OpenAPI specs set up for the API client, so routes come from
 * the spec where one covers the path. Specs that cannot be loaded are left out; routes then
 * come from the shape of the path alone.
 */
async function loadRouteTemplates(): Promise<void> {
  const templates: RouteTemplate[] = [];
  try {
    const info: { specs: { name: string }[]; baseUrl: string } = await (await fetch('/api/client')).json();
    for (const { name } of info.specs ?? []) {
      try {
        const res = await fetch(`/api/client/specs/${encodeURIComponent(name)}`);
        if (!res.ok) continue;
        const spec: { name: string; servers: { url: string }[]; operations: { method: string; path: string; summary: string; operationId: string | null }[] } = await res.json();
        // Operation paths are relative to the server: /api + /orders/{id}.
        const prefixes = [...new Set(info.baseUrl ? [serverPath(info.baseUrl)] : spec.servers.length ? spec.servers.map((s) => serverPath(s.url)) : [''])];
        for (const op of spec.operations) {
          const title = `${op.summary || op.operationId || `${op.method} ${op.path}`} · ${spec.name}`;
          for (const prefix of prefixes) templates.push({ path: prefix + op.path, method: op.method.toUpperCase(), title });
        }
      } catch {
        /* this spec stays out */
      }
    }
  } catch {
    return;
  }
  if (!templates.length && !state.routes.size) return;
  state.routes = new RouteMatcher(templates);
  for (const r of state.rows) {
    r.route = undefined;
    r.hay = undefined;
  }
  scheduleRefilter();
  metricsChanged();
  if (state.selected) renderDetail();
}

function init(): void {
  initTitlebar();
  applyTheme(load<string | null>('dh.theme', null) ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  $<HTMLInputElement>('q').value = state.filters.q;
  $<HTMLInputElement>('f-static').checked = state.filters.hideStatic;
  renderChips();
  renderOrder();
  syncPresetSelect();
  renderStatus();

  viewport.addEventListener('scroll', () => {
    const atEdge = atNewest();
    if (state.mode === 'live' && atEdge !== state.follow) {
      state.follow = atEdge;
      $('btn-follow').classList.toggle('active', atEdge);
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
  // The webapp menu closes on a click elsewhere, Escape, or when the window changes size.
  document.addEventListener('click', (e) => {
    if (!webappMenu.hidden && !webappMenu.contains(e.target as Node)) closeWebappMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !webappMenu.hidden) {
      e.stopImmediatePropagation();
      closeWebappMenu();
    }
  }, true);
  window.addEventListener('resize', closeWebappMenu);
  $('f-static').addEventListener('change', () => setFilters({ hideStatic: $<HTMLInputElement>('f-static').checked }));
  $('presets').addEventListener('change', () => void onPresetChange());
  $('session').addEventListener('change', () => void openSession($<HTMLSelectElement>('session').value));

  window.addEventListener(CHROME_LAUNCH_EVENT, () => renderStatus());
  $('btn-marker').onclick = () => void addMarker();
  $('btn-follow').onclick = () => setFollow(!state.follow);
  $('sort-time').onclick = () => setNewestFirst(!state.newestFirst);
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

  // One full-window screen at a time: opening Settings (also from the menu or a link) closes Tomcat.
  initSettings({
    onToggle: (open) => {
      if (open) {
        closeTomcat();
        closeJsonViewer();
        closeApi();
        closeMetrics();
      } else void loadRouteTemplates();
      renderList();
    },
  });
  $('btn-settings').onclick = () => openSettings();
  initTomcat({
    onToggle: (open) => {
      if (open) {
        closeApi();
        closeJsonViewer();
        closeMetrics();
      }
      renderList();
    },
  });
  initJsonViewer({
    onToggle: (open) => {
      if (open) closeMetrics();
      renderList();
    },
  });
  initSource();
  $('btn-tomcat').onclick = () => openTomcat();
  initApi({
    onToggle: (open) => {
      if (open) {
        closeJsonViewer();
        closeMetrics();
      } else void loadRouteTemplates();
      renderList();
    },
    showEvent: (id) => selectEvent(id),
  });
  // The viewer opens on top of the API screen, which comes back when it closes.
  setJsonViewerOpener((text, { title }) =>
    openJsonViewer({ title: 'Response body', meta: [title], text, fileName: 'response.json' }),
  );
  $('btn-api').onclick = () => openApi();
  initMetrics({
    onToggle: (open) => {
      if (open) {
        closeTomcat();
        closeApi();
        closeJsonViewer();
      }
      renderList();
    },
    rows: () => state.rows,
    route: routeOf,
    live: () => state.mode === 'live',
    showRoute,
    showEvent: revealEvent,
  });
  $('btn-metrics').onclick = () => openMetrics();

  document.addEventListener('keydown', (e) => {
    // The settings, Tomcat, API, JSON viewer and metrics screens have their own keys.
    if (settingsOpen() || tomcatOpen() || apiOpen() || jsonViewerOpen() || metricsOpen()) return;
    if (finder.handleKey(e)) return;
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
      case 'o': case 'O': setNewestFirst(!state.newestFirst); break;
      case 'e': case 'E': {
        const errorsOnly = ['level:info', 'level:debug'];
        const on = errorsOnly.every((x) => state.filters.off.includes(x));
        const rest = state.filters.off.filter((x) => !x.startsWith('level:'));
        setFilters({ off: on ? rest : [...rest, ...errorsOnly] });
        break;
      }
      case 'r': case 'R': setFilters({ ...DEFAULT_FILTERS }); break;
      case 'v': case 'V': viewJson(jsonForSelected()); break;
      case 'g': case 'G': void goToSource(); break;
      case 's': case 'S': e.preventDefault(); openMetrics(); break;
      case '?': help.showModal(); break;
    }
  });

  connect();
  void loadRouteTemplates();
}

init();
