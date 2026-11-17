import type { Route } from '../shared/route';
import { $, fmtBytes, h, type Child } from './dom';
import {
  bucketSize, CLASS_LABEL, CLASSES, computeMetrics, exceptionClass, normalizeSql, SLOW_MS,
  type Bucket, type EndpointStat, type Group, type Metrics, type MetricsOptions, type QueryGroup, type Range, type Side, type StatusClass,
} from './metricsmodel';
import type { Row } from './rows';
import { closeSettings, settingsOpen } from './settings';

/**
 * The Metrics screen: how often each endpoint is hit, how fast and how often it fails, and what
 * the server, the database and the browser reported meanwhile, for the session on the timeline
 * (live or saved). The numbers come from metricsmodel.ts; this file draws them.
 *
 * Charts are inline SVG built with DOM methods. Every text in them (URLs, messages, SQL) goes
 * in through textContent, never as markup. Colours come from the --viz-* tokens in styles.css.
 */

export interface MetricsHooks {
  onToggle: (open: boolean) => void;
  /** The timeline's rows, oldest first. Read only. */
  rows: () => readonly Row[];
  route: (r: Row) => Route | null;
  /** True while recording, false for a saved session. */
  live: () => boolean;
  /** Back to the timeline, showing only this route's requests. */
  showRoute: (template: string, asset: boolean) => void;
  /** Back to the timeline with this event selected. */
  showEvent: (key: string) => void;
}

interface Prefs {
  range: 'all' | number;
  side: 'auto' | Side;
  includeStatic: boolean;
  webapp: string | null;
}

type SortKey = 'label' | 'count' | 'errors' | 'errorRate' | 'p50' | 'p95' | 'max' | 'avgBytes' | 'last';

/** At most this often while events stream in. */
const RENDER_MS = 1500;
/** A live "last N minutes" window slides even when nothing arrives. */
const TICK_MS = 5000;
const LIST_ROWS = 8;
const ENDPOINT_ROWS = 100;
const RANGES: [Prefs['range'], string][] = [['all', 'Session'], [5, '5 min'], [15, '15 min'], [60, '60 min']];
const NS = 'http://www.w3.org/2000/svg';

const M = {
  open: false,
  prefs: load(),
  /** A window dragged out on the requests chart; replaces the range until cleared. */
  custom: null as readonly [number, number] | null,
  metrics: null as Metrics | null,
  dirty: true,
  lastRender: 0,
  timer: 0,
  tick: 0,
  /** The pointer is over a chart: hold updates so the tooltip does not jump. */
  holding: false,
  sort: { key: 'count' as SortKey, desc: true },
  filter: '',
  allEndpoints: false,
  /** Lists showing all their rows. */
  expanded: new Set<string>(),
  /** Charts shown as their table. */
  tables: new Set<string>(),
};

let hooks: MetricsHooks;
let els: {
  updated: HTMLElement;
  controls: HTMLElement;
  content: HTMLElement;
  tiles: HTMLElement;
  requests: HTMLElement;
  latency: HTMLElement;
  endpoints: HTMLElement;
  endpointCount: HTMLElement;
  breakdown: HTMLElement;
  errors: HTMLElement;
  queries: HTMLElement;
  empty: HTMLElement;
  tip: HTMLElement;
} | null = null;
let resize: ResizeObserver | null = null;
let lastWidth = 0;

const root = () => $('metrics');

function load(): Prefs {
  const fallback: Prefs = { range: 'all', side: 'auto', includeStatic: false, webapp: null };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem('dh.metrics') ?? '{}') };
  } catch {
    return fallback;
  }
}
function savePrefs(): void {
  try {
    localStorage.setItem('dh.metrics', JSON.stringify(M.prefs));
  } catch {
    /* private mode */
  }
}

// ── Formatting ──────────────────────────────────────────

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
/** 1,284 / 12.9K / 1.2M: in full under 10,000. */
function fmtCount(n: number): string {
  if (n < 10_000) return fmtInt(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
/** Axis ticks: 0, 250 ms, 1 s, 1.5 s. */
function fmtMsTick(ms: number): string {
  if (ms === 0) return '0';
  if (ms < 1000) return `${ms} ms`;
  return `${+(ms / 1000).toFixed(2)} s`;
}
function fmtPct(x: number): string {
  if (x === 0) return '0%';
  if (x < 0.001) return '<0.1%';
  return `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;
}
function fmtRate(n: number): string {
  return n >= 100 ? fmtInt(n) : n >= 10 ? n.toFixed(0) : n.toFixed(1);
}
const pad = (n: number) => String(n).padStart(2, '0');
function clockOf(t: number, seconds = true): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
}
function fmtSpan(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const hrs = ms / 3_600_000;
  return `${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)} h`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

/** Round tick values from 0 to at least max, about `count` of them. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(+v.toFixed(6));
  return ticks;
}

// ── SVG helpers ─────────────────────────────────────────

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined> = {}, ...children: (Node | null)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.append(c);
  return el;
}
function svgText(x: number, y: number, text: string, cls: string, anchor: 'start' | 'middle' | 'end' = 'start'): SVGTextElement {
  const t = svgEl('text', { x, y, class: cls, 'text-anchor': anchor });
  t.textContent = text;
  return t;
}
/** A column with a 4px rounded data end and a square foot on the baseline. */
function columnPath(x: number, yTop: number, w: number, yBottom: number, round: boolean): string {
  const r = round ? Math.min(4, w / 2, yBottom - yTop) : 0;
  return `M${x},${yBottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBottom}Z`;
}

// ── Tooltip ─────────────────────────────────────────────

interface TipRow {
  value: string;
  label: string;
  /** A CSS colour for the key; a line key for lines, a square for bars. */
  color?: string;
  key?: 'line' | 'rect' | 'dot';
}

function showTip(x: number, y: number, title: string, rows: TipRow[], note?: string): void {
  if (!els) return;
  const tip = els.tip;
  tip.replaceChildren(
    h('div', { class: 'mx-tip-title' }, title),
    ...rows.map((r) => h('div', { class: 'mx-tip-row' },
      r.color ? h('span', { class: `mx-key mx-key-${r.key ?? 'line'}`, style: `--c:${r.color}` }) : h('span', { class: 'mx-key' }),
      h('b', {}, r.value),
      h('span', {}, r.label))),
    ...(note ? [h('div', { class: 'mx-tip-note' }, note)] : []),
  );
  tip.hidden = false;
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  const left = x + 14 + w > window.innerWidth - 8 ? x - 14 - w : x + 14;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, Math.min(y - hgt / 2, window.innerHeight - hgt - 8))}px`;
}
function hideTip(): void {
  if (els) els.tip.hidden = true;
}

/** Tooltips on hover and keyboard focus for any element with a data-tip index into `tips`. */
function wireTips(host: HTMLElement | SVGElement, tips: (() => [string, TipRow[], string?])[]): void {
  const at = (e: Event) => (e.target as Element).closest?.('[data-tip]') as HTMLElement | null;
  const show = (el: HTMLElement, x: number, y: number) => {
    const [title, rows, note] = tips[Number(el.dataset.tip)]();
    showTip(x, y, title, rows, note);
  };
  host.addEventListener('pointermove', (e) => {
    const el = at(e);
    if (el) show(el, (e as PointerEvent).clientX, (e as PointerEvent).clientY);
    else hideTip();
  });
  host.addEventListener('pointerleave', hideTip);
  host.addEventListener('focusin', (e) => {
    const el = at(e);
    if (!el) return;
    const r = el.getBoundingClientRect();
    show(el, r.right, r.top + r.height / 2);
  });
  host.addEventListener('focusout', hideTip);
}

// ── Data ────────────────────────────────────────────────

function options(): MetricsOptions {
  const range: Range = M.custom ?? M.prefs.range;
  return { range, side: M.prefs.side, includeStatic: M.prefs.includeStatic, webapp: M.prefs.webapp };
}

function recompute(): void {
  const m = computeMetrics(hooks.rows(), options(), hooks.route, hooks.live() ? Date.now() : null);
  // A webapp filter left over from another session would hide everything.
  if (M.prefs.webapp !== null && !m.webapps.includes(M.prefs.webapp) && M.prefs.webapp !== '') {
    M.prefs.webapp = null;
    return recompute();
  }
  M.metrics = m;
}

/** Recomputes and redraws now. */
function update(): void {
  if (!M.open || !els) return;
  clearTimeout(M.timer);
  M.timer = 0;
  M.dirty = false;
  M.lastRender = Date.now();
  recompute();
  render();
}

/** Recomputes soon: at once if the last update was a while ago, else when RENDER_MS has passed. */
function schedule(): void {
  if (!M.open || M.timer) return;
  const wait = Math.max(0, M.lastRender + RENDER_MS - Date.now());
  M.timer = window.setTimeout(() => {
    M.timer = 0;
    if (M.holding || document.hidden) {
      M.dirty = true;
      return;
    }
    update();
  }, wait);
}

// ── Shell and controls ──────────────────────────────────

function seg<T>(label: string, items: [T, string, string?][], current: T | null, onPick: (v: T) => void, disabled: (v: T) => boolean = () => false): HTMLElement {
  return h('div', { class: 'mx-seg', role: 'group', 'aria-label': label },
    ...items.map(([value, text, title]) => {
      const b = h('button', { type: 'button', class: `mx-seg-btn${value === current ? ' on' : ''}`, 'aria-pressed': String(value === current), title }, text) as HTMLButtonElement;
      b.disabled = disabled(value);
      b.onclick = () => onPick(value);
      return b;
    }));
}

function renderControls(): void {
  if (!els || !M.metrics) return;
  const m = M.metrics;
  const ctl: Child[] = [];
  ctl.push(seg('Time range', RANGES, M.custom ? null : M.prefs.range, (v) => {
    M.prefs.range = v as Prefs['range'];
    M.custom = null;
    savePrefs();
    update();
  }));
  if (M.custom) {
    const clear = h('button', { type: 'button', class: 'chip filtered', title: 'Picked on the chart. Click to go back to the whole range.' },
      h('span', {}, `${clockOf(M.custom[0])} – ${clockOf(M.custom[1])}`), h('span', { class: 'caret', 'aria-hidden': 'true' }, '✕'));
    clear.setAttribute('aria-label', 'Clear the picked time window');
    clear.onclick = () => {
      M.custom = null;
      update();
    };
    ctl.push(clear);
  }
  ctl.push(h('span', { class: 'divider' }));
  ctl.push(h('span', { class: 'chips-label' }, 'Requests'));
  ctl.push(seg<Side>('Which requests count', [
    ['server', 'Server', 'Tomcat’s access log: every request the server answered, from any client'],
    ['client', 'Browser + API', 'Requests Chrome and the API screen made, as they saw them (time includes the network)'],
  ], m.side, (v) => {
    M.prefs.side = v;
    savePrefs();
    update();
  }, (v) => (v === 'server' ? !m.hasServer : !m.hasClient) && v !== m.side));
  if (m.side === 'client') {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = M.prefs.includeStatic;
    box.onchange = () => {
      M.prefs.includeStatic = box.checked;
      savePrefs();
      update();
    };
    ctl.push(h('label', { class: 'check', title: 'Count scripts, styles, images and fonts (failed ones always count)' }, box, 'Include assets'));
  }
  if (m.webapps.length) {
    const sel = h('select', { class: 'select-quiet', 'aria-label': 'Webapp' },
      h('option', { value: '*' }, 'All webapps'),
      ...m.webapps.map((w) => h('option', { value: w }, w))) as HTMLSelectElement;
    sel.value = M.prefs.webapp ?? '*';
    sel.onchange = () => {
      M.prefs.webapp = sel.value === '*' ? null : sel.value;
      savePrefs();
      update();
    };
    ctl.push(h('span', { class: 'divider' }), sel);
  }
  els.controls.replaceChildren(...ctl.filter((c): c is Node | string => !!c));

  const live = hooks.live();
  const w = m.window;
  els.updated.textContent = `${live ? 'Live' : 'Saved session'} · ${clockOf(w.from)} – ${clockOf(w.to)} (${fmtSpan(w.to - w.from)})`;
}

function renderShell(): void {
  const back = h('button', { type: 'button', class: 'btn', title: 'Back to the timeline (Esc)' }, '← Timeline');
  back.addEventListener('click', () => closeMetrics());
  const updated = h('span', { class: 'tm-updated', 'aria-live': 'polite' });
  const controls = h('div', { class: 'mx-controls', role: 'toolbar', 'aria-label': 'Metrics filters' });
  const tiles = h('div', { class: 'mx-tiles' });
  const requests = h('section', { class: 'card mx-card' });
  const latency = h('section', { class: 'card mx-card' });
  const endpointCount = h('span', { class: 'muted' });
  const filter = h('input', { type: 'search', class: 'mx-filter', placeholder: 'Filter endpoints', 'aria-label': 'Filter endpoints', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  filter.value = M.filter;
  filter.addEventListener('input', () => {
    M.filter = filter.value;
    renderEndpoints();
  });
  const endpointsBody = h('div', { class: 'mx-card-body' });
  const endpointsCard = h('section', { class: 'card mx-card' },
    h('div', { class: 'mx-card-head' },
      h('div', {}, h('h2', {}, 'Endpoints'), h('p', {}, 'One row per method and route. Click a row to see its requests on the timeline.')),
      endpointCount, filter),
    endpointsBody);
  const breakdown = h('div', { class: 'mx-grid' });
  const errors = h('div', { class: 'mx-grid mx-grid-wide' });
  const queries = h('section', { class: 'card mx-card' });
  const empty = h('div', { class: 'mx-empty', hidden: '' });
  const tip = h('div', { class: 'mx-tip', role: 'tooltip', hidden: '' });
  const content = h('div', { class: 'mx-content' }, empty, tiles, requests, latency, endpointsCard, breakdown, errors, queries);
  root().replaceChildren(
    h('div', { class: 'tm-head' }, back, h('h1', {}, 'Metrics'), updated),
    controls,
    h('div', { class: 'settings-scroll mx-scroll' }, content),
    tip,
  );
  els = { updated, controls, content, tiles, requests, latency, endpoints: endpointsBody, endpointCount, breakdown, errors, queries, empty, tip };
  resize?.disconnect();
  resize = new ResizeObserver(() => {
    const w = content.clientWidth;
    if (Math.abs(w - lastWidth) < 4 || !M.metrics) return;
    lastWidth = w;
    renderCharts();
  });
  resize.observe(content);
}

// ── Rendering ───────────────────────────────────────────

function render(): void {
  if (!els || !M.metrics) return;
  const m = M.metrics;
  renderControls();
  const rows = hooks.rows();
  const nothing = rows.length === 0 || (m.requests === 0 && m.logErrors + m.logWarns + m.consoleErrorCount + m.slowQueries + m.pgErrors.length === 0);
  els.empty.hidden = !nothing;
  for (const el of [els.tiles, els.requests, els.latency, els.endpoints.parentElement!, els.breakdown, els.errors, els.queries]) el.hidden = nothing;
  if (nothing) {
    renderEmpty(rows.length > 0);
    return;
  }
  renderTiles();
  renderCharts();
  renderEndpoints();
  renderBreakdown();
  renderErrors();
  renderQueries();
}

function renderEmpty(filteredOut: boolean): void {
  const narrowed = M.custom !== null || M.prefs.range !== 'all' || M.prefs.webapp !== null;
  const widen = h('button', { type: 'button', class: 'btn' }, 'Show the whole session');
  widen.onclick = () => {
    M.custom = null;
    M.prefs.range = 'all';
    M.prefs.webapp = null;
    savePrefs();
    update();
  };
  els!.empty.replaceChildren(
    h('h3', {}, filteredOut && narrowed ? 'Nothing in this time range' : 'No requests yet'),
    h('div', {}, filteredOut && narrowed
      ? 'Try a longer range, or the whole session.'
      : hooks.live() ? 'Use your app; metrics appear as requests come in.' : 'This session has no requests or errors to measure.'),
    ...(filteredOut && narrowed ? [h('div', { style: 'margin-top:12px' }, widen)] : []),
  );
}

function tile(label: string, value: string, sub: Child, opts: { title?: string; trend?: number[]; tone?: 'bad' } = {}): HTMLElement {
  return h('div', { class: 'mx-tile', title: opts.title },
    h('div', { class: 'mx-tile-label' }, label),
    h('div', { class: 'mx-tile-value' }, value),
    h('div', { class: `mx-tile-sub${opts.tone === 'bad' ? ' bad' : ''}` }, sub),
    opts.trend ? sparkline(opts.trend, 'mx-tile-trend', 120, 22) : null);
}

function renderTiles(): void {
  const m = M.metrics!;
  const errs = m.byClass.s4 + m.byClass.s5 + m.byClass.failed;
  const sideName = m.side === 'server' ? 'in the access log' : 'from the browser and API screen';
  const errorParts = [
    m.byClass.s5 && `${fmtInt(m.byClass.s5)} 5xx`,
    m.byClass.s4 && `${fmtInt(m.byClass.s4)} 4xx`,
    m.byClass.failed && `${fmtInt(m.byClass.failed)} failed`,
  ].filter(Boolean).join(' · ');
  els!.tiles.replaceChildren(
    tile('Requests', fmtCount(m.requests), m.unanswered ? `${fmtInt(m.unanswered)} pending or canceled` : sideName,
      { title: `Requests ${sideName}`, trend: m.buckets.map((b) => b.total) }),
    tile('Requests / min', fmtRate(m.perMin), `over ${fmtSpan(m.window.to - m.window.from)}`),
    tile('Error rate', fmtPct(m.errorRate), errs ? errorParts : 'no 4xx, 5xx or failures', { tone: errs ? 'bad' : undefined, title: '4xx, 5xx and failed requests, out of the requests that got an answer' }),
    tile('p50 latency', fmtMs(m.p50), 'half of requests were faster'),
    tile('p95 latency', fmtMs(m.p95), m.max != null ? `max ${fmtMs(m.max)}` : '—'),
    tile('Slow requests', fmtInt(m.slow), `took ${fmtMs(SLOW_MS)} or more${m.answered ? ` · ${fmtPct(m.slow / m.answered)}` : ''}`, { tone: m.slow ? 'bad' : undefined }),
    tile('Server log errors', fmtInt(m.logErrors), `${plural(m.logWarns, 'warning')} in Tomcat’s logs`, { tone: m.logErrors ? 'bad' : undefined }),
    tile('Exceptions', fmtInt(m.exceptionCount + m.browserExceptions), `${fmtInt(m.exceptionCount)} server · ${fmtInt(m.browserExceptions)} browser`, { tone: m.exceptionCount + m.browserExceptions ? 'bad' : undefined, title: 'Stack traces in Tomcat’s logs, and uncaught exceptions in the browser' }),
    tile('Slow queries', fmtInt(m.slowQueries), m.queries.length ? `max ${fmtMs(Math.max(...m.queries.map((q) => q.maxMs)))}` : 'none logged by Postgres', { title: 'Statements Postgres logged with their duration (log_min_duration_statement)' }),
    tile('Console errors', fmtInt(m.consoleErrorCount), m.consoleErrors.length ? `${plural(m.consoleErrors.length, 'distinct message')}` : 'in the browser', { tone: m.consoleErrorCount ? 'bad' : undefined }),
  );
}

function cardHead(title: string, desc: Child, ...tools: Child[]): HTMLElement {
  return h('div', { class: 'mx-card-head' }, h('div', {}, h('h2', {}, title), desc ? h('p', {}, desc) : null), ...tools);
}

/** The "Table" toggle on a chart card: the chart's numbers as a table, for reading exact values. */
function tableToggle(id: string): HTMLElement {
  const on = M.tables.has(id);
  const b = h('button', { type: 'button', class: `btn btn-sm btn-ghost${on ? ' active' : ''}`, 'aria-pressed': String(on), title: on ? 'Show the chart' : 'Show the numbers as a table' }, on ? 'Chart' : 'Table');
  b.onclick = () => {
    if (on) M.tables.delete(id);
    else M.tables.add(id);
    renderCharts();
  };
  return b;
}

function legend(items: { label: string; color: string; key: 'rect' | 'line' | 'dot' }[]): HTMLElement {
  return h('div', { class: 'mx-legend' }, ...items.map((it) =>
    h('span', { class: 'mx-legend-item' }, h('span', { class: `mx-key mx-key-${it.key}`, style: `--c:${it.color}` }), it.label)));
}

const CLASS_COLOR: Record<StatusClass, string> = {
  failed: 'var(--viz-serious)', s5: 'var(--viz-critical)', s4: 'var(--viz-warning)', s3: 'var(--viz-neutral)', s2: 'var(--viz-good)',
};

function chartWidth(): number {
  // The card's inner width: the content width less the card padding.
  return Math.max(320, (els?.content.clientWidth ?? 800) - 2 - 40);
}

function renderCharts(): void {
  const m = M.metrics;
  if (!els || !m) return;
  lastWidth = els.content.clientWidth;
  const width = chartWidth();
  const present = CLASSES.filter((c) => m.byClass[c] > 0);
  const extra = m.unanswered ? ` Plus ${plural(m.unanswered, 'request')} pending or canceled.` : '';
  els.requests.replaceChildren(
    cardHead('Requests over time', `Per ${fmtSpan(m.bucketMs)}, by outcome. Drag across the chart to zoom into a time window.${extra}`, tableToggle('requests')),
    h('div', { class: 'mx-card-body' },
      M.tables.has('requests') ? bucketTable(m, 'requests') : legend((present.length ? present : ['s2' as StatusClass]).map((c) => ({ label: CLASS_LABEL[c], color: CLASS_COLOR[c], key: 'rect' as const })).reverse()),
      M.tables.has('requests') ? null : requestsChart(m, width)),
  );
  els.latency.replaceChildren(
    cardHead('Latency over time', `Median (p50) and p95 response time per ${fmtSpan(m.bucketMs)}, and the slowest request where it stands out.`, tableToggle('latency')),
    h('div', { class: 'mx-card-body' },
      M.tables.has('latency') ? bucketTable(m, 'latency') : legend([{ label: 'p95', color: 'var(--viz-p95)', key: 'line' }, { label: 'p50', color: 'var(--viz-p50)', key: 'line' }, { label: 'Slowest request, where above p95 (▲ at the top: slower than the scale)', color: 'var(--viz-neutral)', key: 'dot' }]),
      M.tables.has('latency') ? null : latencyChart(m, width)),
  );
}

/** The x axis: time labels at round times, as many as fit. */
function timeAxis(svg: SVGSVGElement, m: Metrics, x: (t: number) => number, left: number, right: number, y: number): void {
  const start = m.buckets[0].t;
  const end = start + m.buckets.length * m.bucketMs;
  const step = Math.max(m.bucketMs, bucketSize(end - start, Math.max(2, Math.floor((right - left) / 80))));
  const seconds = step < 60_000;
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) {
    const px = x(t);
    if (px < left - 1 || px > right + 1) continue;
    svg.append(svgEl('line', { x1: px, x2: px, y1: y, y2: y + 4, class: 'mx-axis' }));
    svg.append(svgText(px, y + 16, clockOf(t, seconds), 'mx-tick', 'middle'));
  }
}

function yAxis(svg: SVGSVGElement, ticks: number[], y: (v: number) => number, left: number, right: number, fmt: (v: number) => string): void {
  for (const v of ticks) {
    const py = y(v);
    svg.append(svgEl('line', { x1: left, x2: right, y1: py, y2: py, class: v === 0 ? 'mx-axis' : 'mx-grid' }));
    svg.append(svgText(left - 8, py + 4, fmt(v), 'mx-tick', 'end'));
  }
}

/** Hover, keyboard and drag-to-zoom over a time chart's buckets. */
function timeInteraction(
  svg: SVGSVGElement,
  geo: { left: number; slot: number; top: number; plotH: number; n: number; last: number },
  onIndex: (i: number | null, clientX: number, clientY: number) => void,
  brush?: (i0: number, i1: number) => void,
): void {
  const overlay = svgEl('rect', { x: geo.left, y: geo.top, width: geo.slot * geo.n, height: geo.plotH, class: 'mx-hit' });
  const band = svgEl('rect', { y: geo.top, height: geo.plotH, class: 'mx-brush', visibility: 'hidden' });
  svg.append(band, overlay);
  let focusIdx = -1;
  let drag: { x0: number; id: number } | null = null;
  const idxAt = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / Number(svg.getAttribute('width'));
    const px = (clientX - box.left) / scale;
    return Math.max(0, Math.min(geo.n - 1, Math.floor((px - geo.left) / geo.slot)));
  };
  overlay.addEventListener('pointermove', (e) => {
    const i = idxAt(e.clientX);
    if (drag && brush) {
      const a = Math.min(drag.x0, i);
      const b = Math.max(drag.x0, i);
      band.setAttribute('x', String(geo.left + a * geo.slot));
      band.setAttribute('width', String((b - a + 1) * geo.slot));
      band.setAttribute('visibility', b > a ? 'visible' : 'hidden');
      hideTip();
      return;
    }
    onIndex(i, e.clientX, e.clientY);
  });
  overlay.addEventListener('pointerleave', () => {
    if (!drag) onIndex(null, 0, 0);
  });
  svg.addEventListener('pointerenter', () => (M.holding = true));
  svg.addEventListener('pointerleave', () => {
    M.holding = false;
    if (M.dirty) schedule();
  });
  if (brush) {
    overlay.style.cursor = 'crosshair';
    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x0: idxAt(e.clientX), id: e.pointerId };
      overlay.setPointerCapture(e.pointerId);
    });
    const finish = (e: PointerEvent) => {
      if (!drag) return;
      const a = Math.min(drag.x0, idxAt(e.clientX));
      const b = Math.max(drag.x0, idxAt(e.clientX));
      drag = null;
      band.setAttribute('visibility', 'hidden');
      if (b > a) brush(a, b);
    };
    overlay.addEventListener('pointerup', finish);
    overlay.addEventListener('pointercancel', () => {
      drag = null;
      band.setAttribute('visibility', 'hidden');
    });
  }
  // Keyboard: focus the chart, then ← → step through the buckets.
  svg.setAttribute('tabindex', '0');
  const showFocused = () => {
    const box = svg.getBoundingClientRect();
    const scale = box.width / Number(svg.getAttribute('width'));
    onIndex(focusIdx, box.left + (geo.left + (focusIdx + 0.5) * geo.slot) * scale, box.top + geo.top * scale + 20);
  };
  svg.addEventListener('focus', () => {
    // Start on the latest interval with requests, not on an empty live edge.
    if (focusIdx < 0) focusIdx = geo.last;
    showFocused();
  });
  svg.addEventListener('blur', () => onIndex(null, 0, 0));
  svg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    focusIdx = Math.max(0, Math.min(geo.n - 1, focusIdx + (e.key === 'ArrowLeft' ? -1 : 1)));
    showFocused();
  });
}

function lastBusy(m: Metrics): number {
  for (let i = m.buckets.length - 1; i > 0; i--) if (m.buckets[i].total) return i;
  return 0;
}

function bucketTitle(m: Metrics, b: Bucket): string {
  const seconds = m.bucketMs < 60_000;
  return `${clockOf(b.t, seconds)} – ${clockOf(b.t + m.bucketMs, seconds)}`;
}

function requestsChart(m: Metrics, width: number): SVGSVGElement {
  const H = 200;
  const top = 10;
  const bottom = 26;
  const left = 48;
  const right = width - 12;
  const plotH = H - top - bottom;
  const n = m.buckets.length;
  const slot = (right - left) / n;
  const ticks = niceTicks(Math.max(1, ...m.buckets.map((b) => b.total)));
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const peak = m.buckets.reduce((a, b) => (b.total > a.total ? b : a), m.buckets[0]);
  const svg = svgEl('svg', {
    width, height: H, viewBox: `0 0 ${width} ${H}`, class: 'mx-chart', role: 'img',
    'aria-label': `Requests over time, per ${fmtSpan(m.bucketMs)}: ${fmtInt(m.requests)} in total, peak ${fmtInt(peak.total)} at ${clockOf(peak.t)}. Use the left and right arrow keys to read each interval.`,
  });
  yAxis(svg, ticks, y, left, right, (v) => fmtCount(v));
  const hover = svgEl('rect', { y: top, height: plotH, width: slot, class: 'mx-hover', visibility: 'hidden' });
  svg.append(hover);
  const barW = Math.min(24, Math.max(1, slot - 2));
  m.buckets.forEach((b, i) => {
    if (!b.total) return;
    const x = left + i * slot + (slot - barW) / 2;
    let acc = 0;
    let first = true;
    CLASSES.forEach((cls, k) => {
      const count = b.counts[k];
      if (!count) return;
      const yb = y(acc) - (first ? 0 : 2);
      acc += count;
      const yt = Math.min(y(acc), yb - 1);
      first = false;
      svg.append(svgEl('path', { d: columnPath(x, yt, barW, yb, acc === b.total), fill: CLASS_COLOR[cls] }));
    });
  });
  timeAxis(svg, m, (t) => left + ((t - m.buckets[0].t) / m.bucketMs) * slot, left, right, top + plotH);
  timeInteraction(svg, { left, slot, top, plotH, n, last: lastBusy(m) }, (i, cx, cy) => {
    if (i === null) {
      hover.setAttribute('visibility', 'hidden');
      hideTip();
      return;
    }
    const b = m.buckets[i];
    hover.setAttribute('x', String(left + i * slot));
    hover.setAttribute('visibility', 'visible');
    const rows: TipRow[] = [...CLASSES].reverse().filter((c) => b.counts[CLASSES.indexOf(c)] > 0)
      .map((c) => ({ value: fmtInt(b.counts[CLASSES.indexOf(c)]), label: CLASS_LABEL[c], color: CLASS_COLOR[c], key: 'rect' as const }));
    showTip(cx, cy, bucketTitle(m, b), [{ value: fmtInt(b.total), label: b.total === 1 ? 'request' : 'requests' }, ...rows]);
  }, (i0, i1) => {
    M.custom = [m.buckets[i0].t, m.buckets[i1].t + m.bucketMs - 1];
    update();
  });
  return svg;
}

function latencyChart(m: Metrics, width: number): SVGSVGElement {
  const H = 180;
  const top = 10;
  const bottom = 26;
  const left = 48;
  const right = width - 44;
  const plotH = H - top - bottom;
  const n = m.buckets.length;
  const slot = (right - left) / n;
  // Scale to the percentile lines, so they stay readable: one 1.25 s report among requests of
  // 1–2 ms would otherwise flatten them onto the axis. Slower requests than the scale holds are
  // pinned to the top edge with their time (and the tooltip has it), unless they are close
  // enough to fit anyway.
  const p95Max = Math.max(0, ...m.buckets.map((b) => b.p95 ?? 0));
  const slowest = Math.max(0, ...m.buckets.map((b) => b.max ?? 0));
  const ticks = niceTicks(Math.max(1, slowest <= Math.max(p95Max * 3, 1) ? slowest : p95Max * 1.25));
  const yMax = ticks[ticks.length - 1];
  const y = (v: number) => top + plotH - (Math.min(v, yMax) / yMax) * plotH;
  const cx = (i: number) => left + (i + 0.5) * slot;
  const svg = svgEl('svg', {
    width, height: H, viewBox: `0 0 ${width} ${H}`, class: 'mx-chart', role: 'img',
    'aria-label': `Latency over time: p50 ${fmtMs(m.p50)}, p95 ${fmtMs(m.p95)} over the range. Use the left and right arrow keys to read each interval.`,
  });
  yAxis(svg, ticks, y, left, right, fmtMsTick);
  const series: { key: 'p95' | 'p50'; color: string }[] = [{ key: 'p50', color: 'var(--viz-p50)' }, { key: 'p95', color: 'var(--viz-p95)' }];
  // The slowest request of an interval, where it stands above the p95 line: the outliers a
  // percentile hides (one slow report among thirty fast calls).
  // Beyond the scale: a ▲ on the top edge. Each run of neighbouring ones gets one label, after
  // its last ▲, with the run's slowest time, where it fits before the next run.
  const runs: { from: number; to: number; max: number }[] = [];
  m.buckets.forEach((b, i) => {
    if (b.max == null || b.p95 == null) return;
    if (b.max > yMax) {
      const x = cx(i);
      svg.append(svgEl('path', { d: `M${x - 5},${top + 7}L${x},${top - 1}L${x + 5},${top + 7}Z`, fill: 'var(--viz-neutral)', class: 'mx-dot' }));
      const run = runs[runs.length - 1];
      if (run && run.to === i - 1) {
        run.to = i;
        run.max = Math.max(run.max, b.max);
      } else runs.push({ from: i, to: i, max: b.max });
    } else if (y(b.p95) - y(b.max) >= 6) {
      svg.append(svgEl('circle', { cx: cx(i), cy: y(b.max), r: 4, fill: 'var(--viz-neutral)', class: 'mx-dot' }));
    }
  });
  runs.forEach((run, k) => {
    const label = fmtMs(run.max);
    const x = cx(run.to) + 9;
    const room = (runs[k + 1] ? cx(runs[k + 1].from) - 8 : right) - x;
    if (room >= label.length * 6.5) svg.append(svgText(x, top + 7, label, 'mx-endlabel'));
  });
  const ends: { key: string; x: number; y: number }[] = [];
  for (const s of series) {
    let d = '';
    let lastI = -1;
    m.buckets.forEach((b, i) => {
      const v = b[s.key];
      if (v == null) return;
      d += `${lastI === i - 1 && d ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
      // A point with no neighbours draws no line: give it a dot.
      const prev = m.buckets[i - 1]?.[s.key];
      const next = m.buckets[i + 1]?.[s.key];
      if (prev == null && next == null) svg.append(svgEl('circle', { cx: cx(i), cy: y(v), r: 4, fill: s.color, class: 'mx-dot' }));
      lastI = i;
    });
    if (d) svg.append(svgEl('path', { d, class: 'mx-line', stroke: s.color }));
    if (lastI >= 0) ends.push({ key: s.key, x: cx(lastI) + 8, y: y(m.buckets[lastI][s.key]!) });
  }
  // Direct labels at the line ends, unless they would collide (the legend still names them).
  if (ends.length === 2 && Math.abs(ends[0].y - ends[1].y) >= 12) {
    for (const e of ends) svg.append(svgText(e.x, e.y + 4, e.key, 'mx-endlabel'));
  } else if (ends.length === 1) svg.append(svgText(ends[0].x, ends[0].y + 4, ends[0].key, 'mx-endlabel'));
  timeAxis(svg, m, (t) => left + ((t - m.buckets[0].t) / m.bucketMs) * slot, left, right, top + plotH);
  const cross = svgEl('line', { y1: top, y2: top + plotH, class: 'mx-cross', visibility: 'hidden' });
  const dots = series.map((s) => svgEl('circle', { r: 4, fill: s.color, class: 'mx-dot', visibility: 'hidden' }));
  svg.append(cross, ...dots);
  timeInteraction(svg, { left, slot, top, plotH, n, last: lastBusy(m) }, (i, px, py) => {
    if (i === null) {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      hideTip();
      return;
    }
    const b = m.buckets[i];
    cross.setAttribute('x1', String(cx(i)));
    cross.setAttribute('x2', String(cx(i)));
    cross.setAttribute('visibility', 'visible');
    series.forEach((s, k) => {
      const v = b[s.key];
      dots[k].setAttribute('visibility', v == null ? 'hidden' : 'visible');
      if (v != null) {
        dots[k].setAttribute('cx', String(cx(i)));
        dots[k].setAttribute('cy', String(y(v)));
      }
    });
    showTip(px, py, bucketTitle(m, b), b.p50 == null ? [] : [
      { value: fmtMs(b.p95), label: 'p95', color: 'var(--viz-p95)' },
      { value: fmtMs(b.p50), label: 'p50', color: 'var(--viz-p50)' },
      { value: fmtMs(b.max), label: 'slowest', color: 'var(--viz-neutral)', key: 'dot' },
    ], b.total ? plural(b.total, 'request') : 'No requests');
  });
  return svg;
}

/** The time charts as a table: one row per interval that had requests. */
function bucketTable(m: Metrics, which: 'requests' | 'latency'): HTMLElement {
  const rows = m.buckets.filter((b) => b.total > 0);
  if (!rows.length) return h('div', { class: 'mx-none' }, 'No requests in this range.');
  const head = which === 'requests' ? ['Time', ...[...CLASSES].reverse().map((c) => CLASS_LABEL[c]), 'Total'] : ['Time', 'Requests', 'p50', 'p95', 'Slowest'];
  return h('div', { class: 'mx-tablewrap mx-tablewrap-short' }, h('table', { class: 'mx-table' },
    h('thead', {}, h('tr', {}, ...head.map((x, i) => h('th', { class: i ? 'num' : undefined, scope: 'col' }, x)))),
    h('tbody', {}, ...rows.map((b) => h('tr', {},
      h('td', {}, bucketTitle(m, b)),
      ...(which === 'requests'
        ? [...[...CLASSES].reverse().map((c) => b.counts[CLASSES.indexOf(c)]), b.total].map((v) => h('td', { class: 'num' }, fmtInt(v)))
        : [h('td', { class: 'num' }, fmtInt(b.total)), h('td', { class: 'num' }, fmtMs(b.p50)), h('td', { class: 'num' }, fmtMs(b.p95)), h('td', { class: 'num' }, fmtMs(b.max))]))))));
}

/** A small trend line in the de-emphasis colour, its latest value marked in the accent. */
function sparkline(values: number[], cls: string, w = 84, hgt = 20): SVGSVGElement {
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number) => (n === 1 ? w / 2 : 2 + (i / (n - 1)) * (w - 4));
  const y = (v: number) => hgt - 2 - (v / max) * (hgt - 4);
  const svg = svgEl('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: cls, 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(''), class: 'mx-spark' }));
  let last = n - 1;
  while (last > 0 && values[last] === 0) last--;
  if (values[last] > 0) svg.append(svgEl('circle', { cx: x(last), cy: y(values[last]), r: 2.5, class: 'mx-spark-end' }));
  return svg;
}

// ── Endpoints ───────────────────────────────────────────

const ENDPOINT_COLS: { key: SortKey | null; label: string; num?: boolean; title?: string }[] = [
  { key: 'label', label: 'Endpoint' },
  { key: 'count', label: 'Requests', num: true },
  { key: 'errors', label: 'Errors', num: true, title: '4xx, 5xx and failed' },
  { key: 'errorRate', label: 'Error rate', num: true },
  { key: 'p50', label: 'p50', num: true },
  { key: 'p95', label: 'p95', num: true },
  { key: 'max', label: 'Max', num: true },
  { key: 'avgBytes', label: 'Avg size', num: true },
  { key: 'last', label: 'Last seen', num: true },
  { key: null, label: 'Trend' },
];

function sortEndpoints(list: EndpointStat[]): EndpointStat[] {
  const { key, desc } = M.sort;
  const dir = desc ? -1 : 1;
  return [...list].sort((a, b) => {
    if (key === 'label') return dir * (a.label.localeCompare(b.label) || a.template.localeCompare(b.template) || a.method.localeCompare(b.method));
    const av = a[key] ?? -1;
    const bv = b[key] ?? -1;
    return dir * (av - bv) || b.count - a.count;
  });
}

function renderEndpoints(): void {
  const m = M.metrics;
  if (!els || !m) return;
  const q = M.filter.trim().toLowerCase();
  const matching = q ? m.endpoints.filter((e) => `${e.method} ${e.label} ${e.template} ${e.title ?? ''}`.toLowerCase().includes(q)) : m.endpoints;
  els.endpointCount.textContent = q ? `${fmtInt(matching.length)} of ${fmtInt(m.endpoints.length)}` : plural(m.endpoints.length, 'endpoint');
  if (!m.endpoints.length) {
    els.endpoints.replaceChildren(h('div', { class: 'mx-none' }, 'No requests in this range.'));
    return;
  }
  if (!matching.length) {
    els.endpoints.replaceChildren(h('div', { class: 'mx-none' }, 'No endpoint matches the filter.'));
    return;
  }
  const sorted = sortEndpoints(matching);
  const shown = M.allEndpoints ? sorted : sorted.slice(0, ENDPOINT_ROWS);
  const maxShare = Math.max(...m.endpoints.map((e) => e.share));
  const head = h('tr', {}, ...ENDPOINT_COLS.map((c) => {
    if (!c.key) return h('th', { scope: 'col', class: 'mx-col-trend' }, c.label);
    const active = M.sort.key === c.key;
    const btn = h('button', { type: 'button', class: 'mx-sort', title: c.title }, c.label, h('span', { class: 'mx-sort-arrow', 'aria-hidden': 'true' }, active ? (M.sort.desc ? '↓' : '↑') : ''));
    btn.onclick = () => {
      M.sort = active ? { key: c.key!, desc: !M.sort.desc } : { key: c.key!, desc: c.key !== 'label' };
      renderEndpoints();
    };
    return h('th', { scope: 'col', class: c.num ? 'num' : undefined, 'aria-sort': active ? (M.sort.desc ? 'descending' : 'ascending') : 'none' }, btn);
  }));
  const body = h('tbody', {}, ...shown.map((e) => endpointRow(e, maxShare)));
  const more = sorted.length > ENDPOINT_ROWS
    ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost mx-more' }, M.allEndpoints ? 'Show fewer' : `Show all ${fmtInt(sorted.length)}`)
    : null;
  if (more) more.onclick = () => {
    M.allEndpoints = !M.allEndpoints;
    renderEndpoints();
  };
  els.endpoints.replaceChildren(h('div', { class: 'mx-tablewrap' }, h('table', { class: 'mx-table mx-endpoints' }, h('thead', {}, head), body)), ...(more ? [more] : []));
}

function endpointRow(e: EndpointStat, maxShare: number): HTMLElement {
  const tr = h('tr', { class: 'mx-click', tabindex: '0', title: [`${e.method} ${e.template}`, e.title, 'Click to show these requests on the timeline'].filter(Boolean).join('\n') },
    h('td', {}, h('div', { class: 'mx-ep' },
      h('span', { class: 'method' }, e.method),
      h('span', { class: 'route' }, e.label),
      e.template !== e.label && e.template !== `/${e.label}` ? h('span', { class: 'route-rest' }, e.template) : null,
      e.isStatic ? h('span', { class: 'mx-tag' }, 'asset') : null)),
    h('td', { class: 'num' },
      h('span', { class: 'mx-share' },
        h('span', { class: 'mx-meter', 'aria-hidden': 'true' }, h('span', { style: `width:${(maxShare ? (e.share / maxShare) * 100 : 0).toFixed(1)}%` })),
        h('span', { title: `${fmtPct(e.share)} of requests` }, fmtInt(e.count)))),
    h('td', { class: `num${e.errors ? ' bad' : ' muted'}`, title: [e.s5 && `${e.s5} 5xx`, e.s4 && `${e.s4} 4xx`, e.failed && `${e.failed} failed`].filter(Boolean).join(', ') || undefined }, e.errors ? fmtInt(e.errors) : '0'),
    h('td', { class: `num${e.errorRate ? ' bad' : ' muted'}` }, fmtPct(e.errorRate)),
    h('td', { class: 'num' }, fmtMs(e.p50)),
    h('td', { class: `num${(e.p95 ?? 0) >= SLOW_MS ? ' slow' : ''}` }, fmtMs(e.p95)),
    h('td', { class: `num${(e.max ?? 0) >= SLOW_MS ? ' slow' : ''}` }, fmtMs(e.max)),
    h('td', { class: 'num muted' }, e.avgBytes == null ? '—' : fmtBytes(Math.round(e.avgBytes))),
    h('td', { class: 'num muted', title: new Date(e.last).toLocaleString() }, clockOf(e.last)),
    h('td', { class: 'mx-col-trend' }, sparkline(e.spark, 'mx-row-spark')));
  const go = () => {
    closeMetrics();
    hooks.showRoute(e.template, e.isStatic);
  };
  tr.addEventListener('click', go);
  tr.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      go();
    }
  });
  return tr;
}

// ── Breakdown: status codes, webapps, server vs browser ─

function meterList(id: string, items: { name: Child; value: number; text: string; color: string; tip: () => [string, TipRow[], string?]; sub?: string }[]): HTMLElement {
  const max = Math.max(1, ...items.map((i) => i.value));
  const tips = items.map((i) => i.tip);
  const list = h('div', { class: 'mx-meters', id },
    ...items.map((it, k) => h('div', { class: 'mx-meter-row', 'data-tip': String(k), tabindex: '0' },
      h('span', { class: 'mx-meter-name' }, it.name),
      h('span', { class: 'mx-meter-bar' }, h('span', { style: `width:${Math.max(0.5, (it.value / max) * 100).toFixed(1)}%;--c:${it.color}` })),
      h('span', { class: 'mx-meter-value' }, it.text),
      it.sub !== undefined ? h('span', { class: 'mx-meter-sub' }, it.sub) : null)));
  wireTips(list, tips);
  return list;
}

function renderBreakdown(): void {
  const m = M.metrics!;
  const cards: HTMLElement[] = [];
  const answered = Math.max(1, m.answered);
  cards.push(h('section', { class: 'card mx-card' },
    cardHead('Status codes', m.side === 'server' ? 'As Tomcat answered them.' : 'As the browser and API screen received them.'),
    h('div', { class: 'mx-card-body' }, m.statuses.length
      ? meterList('mx-statuses', m.statuses.slice(0, 12).map((s) => ({
        name: h('span', { class: `pill ${s.cls === 'failed' ? 'fail' : s.cls}` }, s.code === 'failed' ? 'ERR' : s.code),
        value: s.count,
        text: fmtInt(s.count),
        sub: fmtPct(s.count / answered),
        color: CLASS_COLOR[s.cls],
        tip: () => [s.code === 'failed' ? 'Failed (no response)' : `HTTP ${s.code}`, [{ value: fmtInt(s.count), label: s.count === 1 ? 'request' : 'requests', color: CLASS_COLOR[s.cls], key: 'rect' }, { value: fmtPct(s.count / answered), label: 'of answered requests' }]],
      })))
      : h('div', { class: 'mx-none' }, 'No answered requests in this range.'))));

  if (m.side === 'server' && m.webappStats.length > 1) {
    cards.push(h('section', { class: 'card mx-card' },
      cardHead('Webapps', 'Requests per webapp, from the access log.'),
      h('div', { class: 'mx-card-body' }, meterList('mx-webapps', m.webappStats.map((w) => ({
        name: h('span', { class: 'webapp' }, w.name),
        value: w.count,
        text: fmtInt(w.count),
        sub: w.errors ? `${fmtInt(w.errors)} errors` : `p95 ${fmtMs(w.p95)}`,
        color: 'var(--viz-1)',
        tip: () => [w.name, [
          { value: fmtInt(w.count), label: 'requests', color: 'var(--viz-1)', key: 'rect' },
          { value: fmtInt(w.errors), label: 'errors (4xx, 5xx)' },
          { value: fmtMs(w.p95), label: 'p95 latency' },
        ]],
      }))))));
  }

  const split = m.split;
  if (split) {
    const share = Math.min(1, split.serverShare);
    const tips: (() => [string, TipRow[], string?])[] = [
      () => ['Server', [{ value: fmtPct(share), label: 'of the browser’s time', color: 'var(--viz-1)', key: 'rect' }, { value: fmtMs(split.serverP50), label: 'median server time' }]],
      () => ['Network, proxy and browser', [{ value: fmtPct(1 - share), label: 'of the browser’s time', color: 'var(--viz-neutral)', key: 'rect' }, { value: fmtMs(split.overheadP50), label: 'median overhead' }]],
    ];
    const bar = h('div', { class: 'mx-split', role: 'img', 'aria-label': `Server ${fmtPct(share)}, network and the rest ${fmtPct(1 - share)} of the browser’s time` },
      h('span', { 'data-tip': '0', tabindex: '0', style: `flex:${share};--c:var(--viz-1)` }),
      h('span', { 'data-tip': '1', tabindex: '0', style: `flex:${1 - share};--c:var(--viz-neutral)` }));
    wireTips(bar, tips);
    const fig = (label: string, value: string) => h('div', { class: 'mx-fig' }, h('div', { class: 'mx-fig-value' }, value), h('div', { class: 'mx-fig-label' }, label));
    cards.push(h('section', { class: 'card mx-card' },
      cardHead('Server vs browser time', `${plural(split.n, 'request')} seen by both the browser (or API screen) and the access log, matched by request ID.`),
      h('div', { class: 'mx-card-body' },
        legend([{ label: `Server ${fmtPct(share)}`, color: 'var(--viz-1)', key: 'rect' }, { label: `Network, proxy and browser ${fmtPct(1 - share)}`, color: 'var(--viz-neutral)', key: 'rect' }]),
        bar,
        h('div', { class: 'mx-figs' },
          fig('Browser, median', fmtMs(split.clientP50)),
          fig('Server, median', fmtMs(split.serverP50)),
          fig('Overhead, median', fmtMs(split.overheadP50)),
          fig('Overhead, p95', fmtMs(split.overheadP95))))));
  }
  els!.breakdown.replaceChildren(...cards);
}

// ── Errors and queries ──────────────────────────────────

/** A list of grouped occurrences; each row jumps to the latest one on the timeline. */
function groupList(id: string, groups: Group[], cells: (g: Group) => { main: Child[]; counts: Child[] }, none: string): HTMLElement {
  if (!groups.length) return h('div', { class: 'mx-none' }, none);
  const all = M.expanded.has(id);
  const shown = all ? groups : groups.slice(0, LIST_ROWS);
  const list = h('ul', { class: 'mx-list' }, ...shown.map((g) => {
    const c = cells(g);
    const b = h('button', { type: 'button', class: 'mx-list-row', title: `${g.text}\nLatest at ${new Date(g.last).toLocaleString()}. Click to show it on the timeline.` },
      h('span', { class: 'mx-list-main' }, ...c.main),
      h('span', { class: 'mx-list-counts' }, ...c.counts),
      h('span', { class: 'mx-list-last' }, clockOf(g.last)));
    b.onclick = () => {
      closeMetrics();
      hooks.showEvent(g.lastKey);
    };
    return h('li', {}, b);
  }));
  const more = groups.length > LIST_ROWS ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost mx-more' }, all ? 'Show fewer' : `Show all ${fmtInt(groups.length)}`) : null;
  if (more) more.onclick = () => {
    if (all) M.expanded.delete(id);
    else M.expanded.add(id);
    renderErrors();
    renderQueries();
  };
  return h('div', {}, list, more);
}

const shortClass = (name: string) => name.split('.').pop() || name;
/** com.example.OrderService.load → OrderService.load: a logger that names a method keeps its class. */
function shortLogger(name: string): string {
  const parts = name.split('.');
  const last = parts.pop() ?? name;
  return /^[a-z]/.test(last) && parts.length ? `${parts.pop()}.${last}` : last;
}
const countCell = (n: number, cls = '') => h('span', { class: `mx-count ${cls}` }, fmtInt(n));

function renderErrors(): void {
  const m = M.metrics!;
  const card = (title: string, desc: string, body: HTMLElement) => h('section', { class: 'card mx-card' }, cardHead(title, desc), h('div', { class: 'mx-card-body mx-list-body' }, body));
  els!.errors.replaceChildren(
    card('Exceptions', 'Stack traces in Tomcat’s logs, by exception, message and root cause.', groupList('exceptions', m.exceptions, (g) => {
      const cls = exceptionClass(g.text);
      const cause = g.detail ? exceptionClass(g.detail) : '';
      return {
        main: [
          h('span', { class: 'mx-strong', title: cls }, shortClass(cls)),
          h('span', { class: 'mx-dim' }, g.text.slice(cls.length).replace(/^:\s*/, '')),
          cause && cause !== cls ? h('span', { class: 'mx-dim mx-cause', title: g.detail ?? cause }, `caused by ${shortClass(cause)}`) : null,
        ],
        counts: [countCell(g.count, 'bad')],
      };
    }, 'No exceptions logged in this range.')),
    card('Log errors and warnings', 'Tomcat log entries at WARN or above, by logger.', groupList('loggers', m.loggers, (g) => ({
      main: [h('span', { class: 'mx-strong', title: g.key || 'No logger in the line' }, g.key ? shortLogger(g.key) : '(no logger)'), h('span', { class: 'mx-dim' }, g.key && g.text.startsWith(g.key) ? g.text.slice(g.key.length).trim() : g.text)],
      counts: [g.errors ? h('span', { class: 'mx-count bad', title: 'Errors' }, `${fmtInt(g.errors)} err`) : null, g.warns ? h('span', { class: 'mx-count warn', title: 'Warnings' }, `${fmtInt(g.warns)} warn`) : null],
    }), 'No errors or warnings logged in this range.')),
    card('Postgres errors', 'Errors in the Postgres log, by message.', groupList('pg', m.pgErrors, (g) => ({
      main: [h('span', { class: 'mx-mono' }, g.text), g.detail ? h('span', { class: 'mx-dim mx-mono', title: g.detail }, normalizeSql(g.detail)) : null],
      counts: [countCell(g.count, 'bad')],
    }), 'No Postgres errors in this range.')),
    card('Console errors', 'Errors and uncaught exceptions in the browser console, by message.', groupList('console', m.consoleErrors, (g) => ({
      main: [h('span', {}, g.text)],
      counts: [countCell(g.count, 'bad')],
    }), 'No console errors in this range.')),
  );
}

function renderQueries(): void {
  const m = M.metrics!;
  const body = h('div', { class: 'mx-card-body' });
  if (!m.queries.length) {
    body.append(h('div', { class: 'mx-none' }, 'No slow queries logged in this range. Postgres logs a statement with its duration when it takes longer than log_min_duration_statement.'));
  } else {
    const all = M.expanded.has('queries');
    const shown = all ? m.queries : m.queries.slice(0, LIST_ROWS);
    const maxTotal = Math.max(...m.queries.map((q) => q.totalMs));
    const rows = shown.map((q: QueryGroup) => {
      const tr = h('tr', { class: 'mx-click', tabindex: '0', title: `${q.statement}\nClick to show the latest one on the timeline.` },
        h('td', { class: 'mx-sql' }, h('code', {}, q.statement)),
        h('td', { class: 'num' }, fmtInt(q.count)),
        h('td', { class: 'num' }, h('span', { class: 'mx-share' },
          h('span', { class: 'mx-meter', 'aria-hidden': 'true' }, h('span', { style: `width:${((q.totalMs / maxTotal) * 100).toFixed(1)}%` })),
          h('span', {}, fmtMs(q.totalMs)))),
        h('td', { class: `num${q.avgMs >= SLOW_MS ? ' slow' : ''}` }, fmtMs(q.avgMs)),
        h('td', { class: `num${q.maxMs >= SLOW_MS ? ' slow' : ''}` }, fmtMs(q.maxMs)),
        h('td', { class: 'num muted', title: new Date(q.last).toLocaleString() }, clockOf(q.last)));
      const go = () => {
        closeMetrics();
        hooks.showEvent(q.lastKey);
      };
      tr.addEventListener('click', go);
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          go();
        }
      });
      return tr;
    });
    body.append(h('div', { class: 'mx-tablewrap' }, h('table', { class: 'mx-table' },
      h('thead', {}, h('tr', {}, ...['Statement', 'Count', 'Total', 'Avg', 'Max', 'Last seen'].map((x, i) => h('th', { scope: 'col', class: i ? 'num' : undefined }, x)))),
      h('tbody', {}, ...rows))));
    if (m.queries.length > LIST_ROWS) {
      const more = h('button', { type: 'button', class: 'btn btn-sm btn-ghost mx-more' }, all ? 'Show fewer' : `Show all ${fmtInt(m.queries.length)}`);
      more.onclick = () => {
        if (all) M.expanded.delete('queries');
        else M.expanded.add('queries');
        renderQueries();
      };
      body.append(more);
    }
  }
  els!.queries.replaceChildren(cardHead('Slow queries', 'Statements Postgres logged with a duration, with literals as ?, by total time.'), body);
}

// ── Public ──────────────────────────────────────────────

export function metricsOpen(): boolean {
  return M.open;
}

/** The timeline's rows changed: new events, another session, or new route names. */
export function metricsChanged(): void {
  M.dirty = true;
  if (M.open) schedule();
}

export function openMetrics(): void {
  if (!closeSettings()) return;
  if (location.hash !== '#metrics') history.replaceState(null, '', '#metrics');
  if (M.open) return;
  M.open = true;
  root().hidden = false;
  document.body.classList.add('metrics-open');
  hooks.onToggle(true);
  renderShell();
  update();
  M.tick = window.setInterval(() => {
    if (hooks.live() && !M.custom && M.prefs.range !== 'all') metricsChanged();
    else if (M.dirty && !M.holding) schedule();
  }, TICK_MS);
}

export function closeMetrics(): void {
  if (!M.open) return;
  M.open = false;
  clearTimeout(M.timer);
  clearInterval(M.tick);
  M.timer = 0;
  M.holding = false;
  resize?.disconnect();
  resize = null;
  els = null;
  M.metrics = null;
  root().hidden = true;
  root().replaceChildren();
  document.body.classList.remove('metrics-open');
  if (location.hash === '#metrics') history.replaceState(null, '', location.pathname + location.search);
  hooks.onToggle(false);
}

export function toggleMetrics(): void {
  if (M.open) closeMetrics();
  else openMetrics();
}

/** Call after initSettings, initTomcat and initApi: they handle a hash change first. */
export function initMetrics(opts: MetricsHooks): void {
  hooks = opts;
  const sync = () => {
    if (location.hash === '#metrics') {
      if (settingsOpen()) history.replaceState(null, '', '#settings');
      else openMetrics();
    } else if (M.open) closeMetrics();
  };
  window.addEventListener('hashchange', sync);
  sync();

  document.addEventListener('keydown', (e) => {
    if (!M.open || document.querySelector('dialog[open]')) return;
    const t = e.target as HTMLElement;
    const typing = t.matches('input, select, textarea');
    // The timeline's own keys (Escape closes its detail panel, S opens this screen) must not
    // also run once this closes.
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      if (typing) t.blur();
      else if (M.custom) {
        M.custom = null;
        update();
      } else closeMetrics();
    } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.stopImmediatePropagation();
      closeMetrics();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && M.dirty) schedule();
  });
}
