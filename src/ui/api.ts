import {
  HTTP_METHODS,
  enumOf,
  exampleFromSchema,
  paramValue,
  resolveDraft,
  typeHint,
  type ApiOperation,
  type ApiParam,
  type ApiSpec,
  type Catalog,
  type OperationLink,
  type ParamIn,
  type ParamRow,
  type RequestDraft,
  type SavedRequest,
  type SendResult,
  type SpecStatus,
  type Variable,
} from '../shared/apiclient';
import { replayFromEvent, type Replay } from '../shared/replay';
import { confirmDialog } from './confirm';
import { $, fmtBytes, h, type Child } from './dom';
import { bodyLang, highlight, paint } from './highlight';
import { closeSettings, openSettings, settingsOpen } from './settings';
import { closeTomcat } from './tomcat';

/**
 * The API screen (#api): pick an operation from an OpenAPI spec, or start a request from
 * scratch, fill in its parameters, headers and body, and send it. The hub sends it (no CORS, any
 * local service) and records it on the timeline, with a request ID so the server-side events it
 * causes link to it. Requests can be saved, with {{variables}}, to a catalog the hub keeps in
 * api-requests.json next to the settings file.
 *
 * Everything shown from a spec or a response is untrusted text and only reaches the DOM through
 * `h` (textContent), never as HTML. Spec descriptions are Markdown and are shown as plain text.
 */

interface ClientInfo {
  specs: SpecStatus[];
  baseUrl: string;
  defaultHeaders: { name: string; value: string }[];
  addRequestId: boolean;
  requestIdHeader: string;
  timeoutMs: number;
  insecureTls: boolean;
}

interface CatalogFile extends Catalog {
  file: string;
  error: string | null;
}

interface HistoryEntry {
  at: string;
  name: string;
  method: string;
  /** The URL as sent. */
  url: string;
  status: number | null;
  ms: number;
  error: string | null;
  /** The draft as typed: method, URL, params, the request's own headers and body. */
  draft: RequestDraft;
  op: OperationLink | null;
}

/** The saved request open in the builder, and how it looked when opened or last saved. */
interface Opened {
  id: string;
  name: string;
  folder: string;
  description: string;
  snapshot: string;
}

/** Opens a text in the full-window JSON viewer; set by whoever provides one. */
export type JsonViewerOpener = (text: string, opts: { title: string }) => void;

const HISTORY_MAX = 50;
const CONTENT_TYPES = ['application/json', 'application/x-www-form-urlencoded', 'text/plain', 'application/xml'];
const COMMON_HEADERS = ['Accept', 'Authorization', 'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'Referer', 'X-Requested-With'];

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
    /* private mode or full */
  }
}

const emptyDraft = (url = ''): RequestDraft => ({ method: 'GET', url, params: [], headers: [], body: '', contentType: '', disabledDefaults: [] });

const A = {
  open: false,
  info: null as ClientInfo | null,
  catalog: null as CatalogFile | null,
  loadError: null as string | null,
  specName: load<string>('dh.api.spec', ''),
  specs: new Map<string, ApiSpec>(),
  specErrors: new Map<string, string>(),
  specLoading: new Set<string>(),
  /** The server chosen per spec, when a spec names several. */
  servers: load<Record<string, string>>('dh.api.servers', {}),
  side: load<'ops' | 'saved' | 'history'>('dh.api.side', 'ops'),
  filter: '',
  collapsed: new Set<string>(load<string[]>('dh.api.collapsed', [])),
  draft: emptyDraft(),
  op: null as OperationLink | null,
  opened: null as Opened | null,
  /** Warnings about the request in the builder, e.g. headers that were redacted when recorded. */
  notes: [] as string[],
  reqTab: 'params' as 'params' | 'headers' | 'body',
  resTab: 'body' as 'body' | 'headers' | 'request',
  inflight: null as AbortController | null,
  result: null as SendResult | null,
  /** Why the last send did not happen or did not get through to the hub. */
  sendError: null as string | null,
  follow: load<boolean>('dh.api.follow', false),
  history: load<HistoryEntry[]>('dh.api.history', []),
};

let hooks = {
  onToggle: (_open: boolean) => undefined as void,
  showEvent: (_id: string) => undefined as void,
};
let jsonViewer: JsonViewerOpener | null = null;
const root = () => $('api');

// ── Helpers ─────────────────────────────────────────────

async function call<R = any>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<R> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? 'GET' : 'POST'),
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init?.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = Array.isArray(data.errors) && data.errors.length ? ` ${data.errors.map((e: any) => e.message).join(' ')}` : '';
    throw new Error(`${data.error ?? `HTTP ${res.status}`}${detail}`);
  }
  return data as R;
}

function button(label: Child, onClick: () => void, opts: { primary?: boolean; ghost?: boolean; title?: string; cls?: string; disabled?: boolean } = {}): HTMLButtonElement {
  const cls = `btn${opts.primary ? ' btn-primary' : ''}${opts.ghost ? ' btn-ghost' : ''}${opts.cls ? ' ' + opts.cls : ''}`;
  const b = h('button', { type: 'button', class: cls, title: opts.title }, label) as HTMLButtonElement;
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

function toast(text: string, error = false): void {
  const el = h('div', { class: `toast${error ? ' launch-toast failed' : ''}`, role: 'status' }, text);
  document.body.append(el);
  const ms = error ? 6000 : 1800;
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

const methodBadge = (m: string) => h('span', { class: `mbadge m-${m.toLowerCase()}` }, m);

function statusPill(status: number | null, error?: string | null): HTMLElement {
  if (status == null) return h('span', { class: 'pill fail', title: error ?? '' }, 'ERR');
  return h('span', { class: `pill s${Math.floor(status / 100)}` }, String(status));
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * A spec description as plain text: paragraphs split on blank lines, `code` in monospace.
 * Nothing in it is ever treated as HTML.
 */
function markdownText(text: string): HTMLElement {
  const box = h('div', { class: 'api-md' });
  for (const para of text.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    const p = h('p');
    para.split(/(`[^`\n]+`)/).forEach((part, i) => p.append(i % 2 ? h('code', {}, part.slice(1, -1)) : part));
    box.append(p);
  }
  return box;
}

/** The JSON a body holds, pretty-printed, or null when it is not JSON. */
function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** "Unexpected token } in JSON at position 12" made into a line and column. */
function jsonProblem(text: string): string | null {
  if (!text.trim()) return null;
  try {
    JSON.parse(text);
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    const pos = /position (\d+)/.exec(msg);
    if (!pos) return msg;
    const before = text.slice(0, Number(pos[1]));
    const line = before.split('\n').length;
    const col = before.length - before.lastIndexOf('\n');
    return `${msg.replace(/ in JSON at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)$/, '')} at line ${line}, column ${col}`;
  }
}

// ── Data ────────────────────────────────────────────────

async function loadInfo(): Promise<void> {
  try {
    A.info = await call<ClientInfo>('/api/client');
    A.loadError = null;
  } catch (err) {
    A.loadError = (err as Error).message;
  }
}

async function loadCatalog(): Promise<void> {
  try {
    A.catalog = await call<CatalogFile>('/api/client/catalog');
  } catch (err) {
    A.loadError = (err as Error).message;
  }
}

async function ensureLoaded(): Promise<void> {
  await Promise.all([A.info ? null : loadInfo(), A.catalog ? null : loadCatalog()]);
}

/** Loads a spec from the hub (which caches it); `reload` fetches it again. */
async function ensureSpec(name: string, reload = false): Promise<ApiSpec | null> {
  if (!name) return null;
  if (A.specs.has(name) && !reload) return A.specs.get(name)!;
  if (A.specLoading.has(name)) return null;
  A.specLoading.add(name);
  if (A.open) renderHead();
  try {
    const spec = await call<ApiSpec>(`/api/client/specs/${encodeURIComponent(name)}${reload ? '?reload=1' : ''}`);
    A.specs.set(name, spec);
    A.specErrors.delete(name);
  } catch (err) {
    A.specs.delete(name);
    A.specErrors.set(name, (err as Error).message);
  } finally {
    A.specLoading.delete(name);
  }
  await loadInfo();
  if (A.open) {
    renderHead();
    renderSide();
    renderBuilder();
  }
  return A.specs.get(name) ?? null;
}

function specFor(name: string | undefined | null): ApiSpec | null {
  return name ? A.specs.get(name) ?? null : null;
}

/** The operation the builder's request was made from, when its spec is loaded. */
function currentOp(): { spec: ApiSpec; op: ApiOperation } | null {
  const link = A.op;
  const spec = specFor(link?.spec);
  if (!link || !spec) return null;
  const op = spec.operations.find((o) => (link.operationId ? o.operationId === link.operationId : o.method === link.method && o.path === link.path))
    ?? spec.operations.find((o) => o.method === link.method && o.path === link.path);
  return op ? { spec, op } : null;
}

function serverOf(spec: ApiSpec | null): string {
  if (!spec?.servers.length) return '';
  const chosen = A.servers[spec.name];
  return spec.servers.some((s) => s.url === chosen) ? chosen : spec.servers[0].url;
}

/** What {{baseUrl}} stands for: Settings' base URL, else the request's spec's server, else the chosen spec's. */
function baseUrl(): string {
  return A.info?.baseUrl || serverOf(specFor(A.op?.spec)) || serverOf(specFor(A.specName));
}

function variables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const v of A.catalog?.variables ?? []) vars[v.name] = v.value;
  const base = baseUrl();
  if (base) vars.baseUrl = base;
  return vars;
}

const linkOf = (spec: ApiSpec, op: ApiOperation): OperationLink => ({ spec: spec.name, operationId: op.operationId, method: op.method, path: op.path });
const opMemoryKey = (link: OperationLink) => `dh.api.last.${link.spec}::${link.operationId ?? `${link.method} ${link.path}`}`;
const snapshot = () => JSON.stringify({ d: A.draft, o: A.op });
const dirty = () => !!A.opened && snapshot() !== A.opened.snapshot;

/** A new request for an operation, with the spec's examples filled in. */
function draftFromOp(spec: ApiSpec, op: ApiOperation): RequestDraft {
  const params: ParamRow[] = op.params.map((p) => ({
    in: p.in,
    name: p.name,
    value: paramValue(p, spec.schemas),
    // Optional parameters start switched off; typing a value switches them on.
    enabled: p.required,
  }));
  const content = preferredContent(op);
  let body = '';
  if (content) {
    const example = content.example !== undefined ? content.example : exampleFromSchema(content.schema, spec.schemas, { for: 'request' });
    if (example !== undefined && example !== null && !/xml/.test(content.type)) body = JSON.stringify(example, null, 2);
  }
  return { method: op.method, url: `{{baseUrl}}${op.path}`, params, headers: [], body, contentType: content?.type ?? '', disabledDefaults: [] };
}

function preferredContent(op: ApiOperation) {
  const list = op.body?.contents ?? [];
  return list.find((c) => /json/.test(c.type)) ?? list[0] ?? null;
}

// ── Actions ─────────────────────────────────────────────

/** Remembers the values last used for an operation, for the next time it is picked. */
function rememberOp(): void {
  if (A.op && !A.opened) save(opMemoryKey(A.op), A.draft);
}

function selectOp(spec: ApiSpec, op: ApiOperation): void {
  rememberOp();
  A.op = linkOf(spec, op);
  A.opened = null;
  A.notes = [];
  A.draft = load<RequestDraft | null>(opMemoryKey(A.op), null) ?? draftFromOp(spec, op);
  A.result = null;
  A.sendError = null;
  A.reqTab = op.params.length || !op.body ? 'params' : 'body';
  renderSide();
  renderBuilder();
  renderResponse();
}

function newRequest(): void {
  rememberOp();
  A.op = null;
  A.opened = null;
  A.notes = [];
  A.draft = emptyDraft(baseUrl() ? '{{baseUrl}}/' : 'http://localhost:8080/');
  A.result = null;
  A.sendError = null;
  A.reqTab = 'params';
  renderSide();
  renderBuilder();
  renderResponse();
  root().querySelector<HTMLInputElement>('.api-url')?.focus();
}

function draftOf(r: RequestDraft): RequestDraft {
  return structuredClone({ method: r.method, url: r.url, params: r.params, headers: r.headers, body: r.body, contentType: r.contentType, disabledDefaults: r.disabledDefaults });
}

/** Asks before unsaved changes to the open request are dropped. */
function confirmDiscard(): Promise<boolean> {
  return confirmDialog({
    title: 'Discard unsaved changes?',
    text: h('span', {}, 'Your changes to ', h('b', {}, A.opened?.name ?? 'this request'), ' have not been saved.'),
    ok: 'Discard changes',
    cancel: 'Keep editing',
    danger: true,
  });
}

async function openSaved(r: SavedRequest): Promise<void> {
  if (dirty() && !(await confirmDiscard())) return;
  rememberOp();
  A.op = r.operation;
  A.draft = draftOf(r);
  A.opened = { id: r.id, name: r.name, folder: r.folder, description: r.description, snapshot: '' };
  A.opened.snapshot = snapshot();
  A.notes = [];
  A.result = null;
  A.sendError = null;
  if (r.operation && !A.specs.has(r.operation.spec)) void ensureSpec(r.operation.spec);
  renderSide();
  renderBuilder();
  renderResponse();
}

function restoreHistory(e: HistoryEntry): void {
  rememberOp();
  A.op = e.op;
  A.opened = null;
  A.notes = [];
  A.draft = structuredClone(e.draft);
  A.result = null;
  A.sendError = null;
  renderBuilder();
  renderResponse();
}

/** Puts a request into the builder from outside: a replayed timeline event. */
function loadDraft(draft: RequestDraft, notes: string[]): void {
  rememberOp();
  A.op = null;
  A.opened = null;
  A.notes = notes;
  A.draft = draft;
  A.result = null;
  A.sendError = null;
  A.reqTab = draft.body ? 'body' : 'headers';
}

async function send(): Promise<void> {
  if (A.inflight) return;
  const { input, problems } = resolveDraft(A.draft, variables());
  if (problems.length) {
    A.sendError = problems.join(' ');
    A.result = null;
    renderResponse();
    return;
  }
  input.followRedirects = A.follow;
  const op = currentOp()?.op;
  input.label = A.opened?.name ?? (op ? op.summary || op.operationId || '' : '');
  const ctrl = new AbortController();
  A.inflight = ctrl;
  A.sendError = null;
  renderSendButton();
  renderResponse();
  try {
    const result = await call<SendResult>('/api/client/send', { body: input, signal: ctrl.signal });
    A.result = result;
    A.resTab = 'body';
    rememberOp();
    A.history = [
      { at: new Date().toISOString(), name: input.label ?? '', method: result.method, url: result.url, status: result.status, ms: result.durationMs, error: result.error, draft: structuredClone(A.draft), op: A.op },
      ...A.history,
    ].slice(0, HISTORY_MAX);
    save('dh.api.history', A.history);
  } catch (err) {
    A.result = null;
    A.sendError = ctrl.signal.aborted ? 'Canceled. The request was stopped and is marked canceled on the timeline.' : `Could not send: ${(err as Error).message}`;
  } finally {
    A.inflight = null;
  }
  if (!A.open) return;
  renderSendButton();
  renderResponse();
  if (A.side === 'history') renderSide();
}

function cancel(): void {
  A.inflight?.abort();
}

// ── Saving ──────────────────────────────────────────────

function requestBody(meta: { name: string; folder: string; description: string }, draft = A.draft, op = A.op) {
  return { ...draftOf(draft), ...meta, operation: op };
}

function folders(): string[] {
  return [...new Set((A.catalog?.requests ?? []).map((r) => r.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

interface FieldDef {
  key: string;
  label: string;
  value: string;
  kind?: 'text' | 'folder' | 'textarea';
  placeholder?: string;
}

/**
 * A small form in a dialog. `submit` returns an error to show, or null when done; the dialog
 * stays open on an error, so nothing typed is lost.
 */
function formDialog(title: string, fields: FieldDef[], okLabel: string, submit: (values: Record<string, string>) => Promise<string | null>, notes: Child[] = []): void {
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement>();
  const listId = `api-folders-${Date.now()}`;
  const rows = fields.map((f) => {
    const input = (f.kind === 'textarea'
      ? h('textarea', { class: 'input api-ta', rows: '3', placeholder: f.placeholder })
      : h('input', { type: 'text', class: 'input', placeholder: f.placeholder, autocomplete: 'off', spellcheck: 'false', ...(f.kind === 'folder' && { list: listId }) })) as HTMLInputElement;
    input.value = f.value;
    inputs.set(f.key, input);
    return h('label', { class: 'api-dlg-field' }, h('span', {}, f.label), input);
  });
  const err = h('div', { class: 'field-error', role: 'alert' });
  const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, okLabel) as HTMLButtonElement;
  const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const form = h('form', { method: 'dialog' },
    h('h2', {}, title),
    ...notes.filter(Boolean).map((n) => h('div', { class: 'tm-note warn' }, n)),
    ...rows,
    h('datalist', { id: listId }, ...folders().map((f) => h('option', { value: f }))),
    err,
    h('div', { class: 'dialog-actions' }, cancelBtn, ok));
  const dialog = h('dialog', { class: 'dialog api-dialog' }, form) as HTMLDialogElement;
  cancelBtn.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    ok.disabled = true;
    const values = Object.fromEntries([...inputs].map(([k, el]) => [k, el.value]));
    try {
      const problem = await submit(values);
      if (problem) err.textContent = problem;
      else dialog.close();
    } catch (ex) {
      err.textContent = (ex as Error).message;
    } finally {
      ok.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  const first = inputs.values().next().value;
  first?.focus();
  if (first instanceof HTMLInputElement) first.select();
}

function infoDialog(title: string, ...body: Child[]): void {
  const close = h('button', { type: 'button', class: 'btn btn-primary' }, 'Close');
  const dialog = h('dialog', { class: 'dialog api-dialog' }, h('h2', {}, title), ...body, h('div', { class: 'dialog-actions' }, close)) as HTMLDialogElement;
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

const PLAIN_TEXT_NOTE = 'Saved requests, their headers (tokens included) and variables are stored as plain text in api-requests.json next to the settings file.';

function suggestedName(): string {
  const op = currentOp()?.op;
  if (op) return op.summary || op.operationId || `${op.method} ${op.path}`;
  return `${A.draft.method} ${A.draft.url.replace(/^\{\{baseUrl\}\}/, '').replace(/^https?:\/\/[^/]+/, '') || '/'}`.slice(0, 200);
}

function saveAs(): void {
  formDialog(
    'Save request',
    [
      { key: 'name', label: 'Name', value: A.opened ? `${A.opened.name} (copy)` : suggestedName() },
      { key: 'folder', label: 'Folder', value: A.opened?.folder ?? currentOp()?.op.tags[0] ?? '', kind: 'folder', placeholder: 'None' },
      { key: 'description', label: 'Description', value: A.opened?.description ?? '', kind: 'textarea', placeholder: 'Optional' },
    ],
    'Save',
    async (v) => {
      const out = await call<{ request: SavedRequest; notice?: string }>('/api/client/catalog/requests', { body: requestBody({ name: v.name, folder: v.folder, description: v.description }) });
      afterSave(out);
      return null;
    },
    [h('span', { class: 'muted' }, PLAIN_TEXT_NOTE)],
  );
}

async function saveCurrent(): Promise<void> {
  if (!A.opened) return saveAs();
  try {
    const o = A.opened;
    afterSave(await call(`/api/client/catalog/requests/${encodeURIComponent(o.id)}`, { method: 'PUT', body: requestBody(o) }));
  } catch (err) {
    toast(`Could not save: ${(err as Error).message}`, true);
  }
}

function afterSave(out: { request: SavedRequest; notice?: string }): void {
  const r = out.request;
  A.opened = { id: r.id, name: r.name, folder: r.folder, description: r.description, snapshot: '' };
  A.opened.snapshot = snapshot();
  A.notes = [];
  toast(out.notice ?? `Saved “${r.name}”`, !!out.notice);
  void loadCatalog().then(() => {
    if (!A.open) return;
    renderSide();
    renderBuilder();
  });
}

function editDetails(r: SavedRequest): void {
  formDialog(
    'Rename or move',
    [
      { key: 'name', label: 'Name', value: r.name },
      { key: 'folder', label: 'Folder', value: r.folder, kind: 'folder', placeholder: 'None' },
      { key: 'description', label: 'Description', value: r.description, kind: 'textarea', placeholder: 'Optional' },
    ],
    'Save',
    async (v) => {
      const out = await call<{ request: SavedRequest }>(`/api/client/catalog/requests/${encodeURIComponent(r.id)}`, { method: 'PUT', body: { ...r, name: v.name, folder: v.folder, description: v.description } });
      if (A.opened?.id === r.id) Object.assign(A.opened, { name: out.request.name, folder: out.request.folder, description: out.request.description });
      await loadCatalog();
      renderSide();
      renderBuilder();
      return null;
    },
  );
}

async function duplicate(r: SavedRequest): Promise<void> {
  try {
    await call('/api/client/catalog/requests', { body: { ...r, name: `${r.name} (copy)` } });
    await loadCatalog();
    renderSide();
  } catch (err) {
    toast(`Could not duplicate: ${(err as Error).message}`, true);
  }
}

async function remove(r: SavedRequest): Promise<void> {
  const go = await confirmDialog({
    title: 'Delete this saved request?',
    text: r.folder ? h('span', {}, 'It is removed from the folder ', h('b', {}, r.folder), '.') : 'It is removed from your saved requests.',
    subject: h('div', { class: 'api-confirm-req' },
      h('div', { class: 'api-item-line' }, methodBadge(r.method), h('b', { class: 'api-name' }, r.name)),
      h('div', { class: 'api-item-sub mono' }, r.url)),
    note: 'This cannot be undone.',
    ok: 'Delete request',
    danger: true,
  });
  if (!go) return;
  try {
    await call(`/api/client/catalog/requests/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
    if (A.opened?.id === r.id) A.opened = null;
    await loadCatalog();
    renderSide();
    renderBuilder();
  } catch (err) {
    toast(`Could not delete: ${(err as Error).message}`, true);
  }
}

function variablesDialog(): void {
  const rows: Variable[] = structuredClone(A.catalog?.variables ?? []);
  const list = h('div', { class: 'api-vars' });
  const err = h('div', { class: 'field-error', role: 'alert' });
  const render = () => {
    list.replaceChildren(
      ...rows.map((v, i) => {
        const name = h('input', { type: 'text', class: 'input mono', placeholder: 'token', 'aria-label': `Variable ${i + 1} name`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
        const value = h('input', { type: 'text', class: 'input mono', placeholder: 'value', 'aria-label': `Variable ${i + 1} value`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
        name.value = v.name;
        value.value = v.value;
        name.addEventListener('input', () => (v.name = name.value));
        value.addEventListener('input', () => (v.value = value.value));
        const del = button('×', () => {
          rows.splice(i, 1);
          render();
        }, { ghost: true, cls: 'btn-icon', title: 'Remove' });
        return h('div', { class: 'api-var-row' }, name, value, del);
      }),
      ...(rows.length ? [] : [h('div', { class: 'list-empty' }, 'No variables yet.')]),
    );
  };
  render();
  const add = button('+ Add variable', () => {
    rows.push({ name: '', value: '' });
    render();
    list.querySelector<HTMLInputElement>('.api-var-row:last-child input')?.focus();
  }, { ghost: true, cls: 'list-add' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save') as HTMLButtonElement;
  const close = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const base = baseUrl();
  const dialog = h('dialog', { class: 'dialog api-dialog api-vars-dialog' },
    h('h2', {}, 'Variables'),
    h('p', { class: 'muted' }, 'Write ', h('code', {}, '{{name}}'), ' in a URL, parameter, header or body. ', h('code', {}, '{{baseUrl}}'), ` is built in: ${base ? base : 'the base URL from Settings or the spec'}. ${PLAIN_TEXT_NOTE}`),
    list, add, err,
    h('div', { class: 'dialog-actions' }, close, saveBtn)) as HTMLDialogElement;
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await call('/api/client/catalog/variables', { method: 'PUT', body: rows });
      await loadCatalog();
      dialog.close();
      if (A.open) renderBuilder();
    } catch (e) {
      err.textContent = (e as Error).message;
    } finally {
      saveBtn.disabled = false;
    }
  });
  document.body.append(dialog);
  dialog.showModal();
}

async function exportCatalog(): Promise<void> {
  try {
    const cat = await call<CatalogFile>('/api/client/catalog');
    const blob = new Blob([JSON.stringify({ version: 1, variables: cat.variables, requests: cat.requests }, null, 2) + '\n'], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'api-requests.json' }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) {
    toast(`Could not export: ${(err as Error).message}`, true);
  }
}

function importCatalog(): void {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: '' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const s = await call<{ added: string[]; updated: string[]; unchanged: number; skipped: { name: string; reason: string }[]; variables: { added: string[]; updated: string[] }; notice?: string }>('/api/client/catalog/import', { body: data });
      await loadCatalog();
      renderSide();
      const line = (label: string, names: string[]) => (names.length ? h('li', {}, h('b', {}, `${label} (${names.length}): `), names.join(', ')) : null);
      infoDialog(
        `Imported ${file.name}`,
        h('ul', { class: 'api-summary' },
          line('Added', s.added),
          line('Updated', s.updated),
          s.unchanged ? h('li', {}, h('b', {}, 'Unchanged: '), String(s.unchanged)) : null,
          line('Variables added', s.variables.added),
          line('Variables updated', s.variables.updated),
          ...s.skipped.map((x) => h('li', { class: 'warn' }, h('b', {}, `Skipped ${x.name}: `), x.reason)),
          !s.added.length && !s.updated.length && !s.variables.added.length && !s.variables.updated.length ? h('li', {}, 'Nothing new.') : null),
        s.notice ? h('div', { class: 'tm-note warn' }, s.notice) : null,
      );
    } catch (err) {
      toast(`Could not import: ${(err as Error).message}`, true);
    }
  });
  document.body.append(input);
  input.click();
}

// ── Shell ───────────────────────────────────────────────

function renderShell(): void {
  const back = button('← Timeline', () => closeApi(), { title: 'Back to the timeline (Esc)' });
  root().replaceChildren(
    h('div', { class: 'tm-head api-head' }, back, h('h1', {}, 'API'), h('div', { class: 'api-head-specs' })),
    h('div', { class: 'api-body' },
      h('aside', { class: 'api-side', 'aria-label': 'Requests' }),
      h('div', { class: 'api-main' }, h('section', { class: 'api-req card', 'aria-label': 'Request' }), h('section', { class: 'api-res card', 'aria-label': 'Response' }))),
  );
  renderHead();
  renderSide();
  renderBuilder();
  renderResponse();
}

function renderHead(): void {
  const host = root().querySelector('.api-head-specs');
  if (!host || !A.open) return;
  const specs = A.info?.specs ?? [];
  const sel = h('select', { class: 'api-spec-select', 'aria-label': 'Spec', title: 'OpenAPI spec' },
    h('option', { value: '' }, specs.length ? 'No spec' : 'No specs in Settings'),
    ...specs.map((s) => h('option', { value: s.name }, s.title && s.title !== s.name ? `${s.name} · ${s.title}` : s.name))) as HTMLSelectElement;
  sel.value = specs.some((s) => s.name === A.specName) ? A.specName : '';
  sel.addEventListener('change', () => {
    A.specName = sel.value;
    save('dh.api.spec', A.specName);
    A.side = 'ops';
    save('dh.api.side', A.side);
    renderHead();
    renderSide();
    if (A.specName) void ensureSpec(A.specName);
  });
  const parts: Child[] = [sel];
  const spec = specFor(A.specName);
  if (A.info?.baseUrl) {
    parts.push(h('span', { class: 'api-base', title: 'Base URL from Settings › API client: used instead of the spec’s servers' }, 'Base ', h('code', {}, A.info.baseUrl)));
  } else if (spec && spec.servers.length > 1) {
    const srv = h('select', { class: 'api-server-select', 'aria-label': 'Server', title: 'The server {{baseUrl}} stands for' },
      ...spec.servers.map((s) => h('option', { value: s.url }, s.description ? `${s.url} · ${s.description}` : s.url))) as HTMLSelectElement;
    srv.value = serverOf(spec);
    srv.addEventListener('change', () => {
      A.servers[spec.name] = srv.value;
      save('dh.api.servers', A.servers);
      renderBuilder();
    });
    parts.push(srv);
  } else if (spec?.servers.length) parts.push(h('span', { class: 'api-base', title: 'The server named in the spec' }, 'Base ', h('code', {}, spec.servers[0].url)));
  if (A.specName) {
    parts.push(button('Reload', () => void ensureSpec(A.specName, true), { title: 'Fetch the spec again', disabled: A.specLoading.has(A.specName) }));
  }
  let status: HTMLElement | null = null;
  if (A.loadError) status = h('span', { class: 'tm-updated error' }, `Could not reach the hub: ${A.loadError}`);
  else if (A.specLoading.has(A.specName)) status = h('span', { class: 'tm-updated' }, 'Loading spec…');
  else if (A.specErrors.has(A.specName)) status = h('span', { class: 'tm-updated error', title: A.specErrors.get(A.specName)! }, 'Could not load the spec');
  else if (spec) {
    status = h('span', { class: 'tm-updated', title: spec.warnings.join('\n') || undefined },
      `${spec.title}${spec.version ? ` ${spec.version}` : ''} · ${spec.operations.length} operations${spec.warnings.length ? ` · ${spec.warnings.length} warning${spec.warnings.length === 1 ? '' : 's'}` : ''}`);
  }
  host.replaceChildren(...parts.filter((p): p is Node | string => !!p), status ?? '', h('div', { class: 'spacer' }),
    button('Variables', () => variablesDialog(), { title: 'Values for {{name}} placeholders' }),
    button('API settings', () => openSettings('api')));
}

// ── Sidebar ─────────────────────────────────────────────

function renderSide(): void {
  const side = root().querySelector('.api-side');
  if (!side || !A.open) return;
  const tab = (id: typeof A.side, label: string, n?: number) => {
    const b = button(h('span', {}, label, n ? h('span', { class: 'n' }, ` ${n}`) : null), () => {
      A.side = id;
      save('dh.api.side', id);
      renderSide();
    }, { cls: `api-tab${A.side === id ? ' active' : ''}` });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(A.side === id));
    return b;
  };
  const filter = h('input', { type: 'search', class: 'input api-filter', placeholder: A.side === 'ops' ? 'Filter operations' : A.side === 'saved' ? 'Filter saved requests' : 'Filter history', 'aria-label': 'Filter', spellcheck: 'false' }) as HTMLInputElement;
  filter.value = A.filter;
  const list = h('div', { class: 'api-list' });
  filter.addEventListener('input', () => {
    A.filter = filter.value;
    list.replaceChildren(...sideItems());
  });
  list.replaceChildren(...sideItems());
  const foot: Child[] = [];
  if (A.side === 'saved') {
    foot.push(button('Export', () => void exportCatalog(), { ghost: true, title: 'Download the saved requests and variables as a JSON file' }));
    foot.push(button('Import…', () => importCatalog(), { ghost: true, title: 'Merge an exported file: same ids are replaced, new ones added' }));
  } else if (A.side === 'history' && A.history.length) {
    foot.push(button('Clear history', () => {
      A.history = [];
      save('dh.api.history', A.history);
      renderSide();
    }, { ghost: true }));
  }
  side.replaceChildren(
    h('div', { class: 'api-tabs', role: 'tablist' }, tab('ops', 'Operations', specFor(A.specName)?.operations.length), tab('saved', 'Saved', A.catalog?.requests.length), tab('history', 'History')),
    h('div', { class: 'api-side-tools' }, filter, button('+ New', () => newRequest(), { title: 'A request without a spec' })),
    list,
    foot.length ? h('div', { class: 'api-side-foot' }, ...foot) : '',
  );
}

function matches(text: string): boolean {
  const terms = A.filter.toLowerCase().split(/\s+/).filter(Boolean);
  const t = text.toLowerCase();
  return terms.every((x) => t.includes(x));
}

function empty(...text: Child[]): HTMLElement {
  return h('div', { class: 'api-empty' }, ...text);
}

function sideItems(): HTMLElement[] {
  if (A.side === 'saved') return savedItems();
  if (A.side === 'history') return historyItems();
  return opItems();
}

function group(key: string, label: string, count: number, items: HTMLElement[]): HTMLElement[] {
  const collapsed = A.collapsed.has(key) && !A.filter;
  const head = button(h('span', {}, h('span', { class: 'caret', 'aria-hidden': 'true' }, collapsed ? '▸' : '▾'), ' ', label, h('span', { class: 'n' }, ` ${count}`)), () => {
    if (A.collapsed.has(key)) A.collapsed.delete(key);
    else A.collapsed.add(key);
    save('dh.api.collapsed', [...A.collapsed]);
    renderSide();
  }, { cls: 'api-group' });
  head.setAttribute('aria-expanded', String(!collapsed));
  return [head, ...(collapsed ? [] : items)];
}

function opItems(): HTMLElement[] {
  const specs = A.info?.specs ?? [];
  if (!specs.length) {
    const link = h('a', { href: '#settings/api', class: 'link' }, 'Settings › API client');
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openSettings('api');
    });
    return [empty('No specs yet. Add your OpenAPI or Swagger URL (e.g. ', h('code', {}, 'http://localhost:8080/v3/api-docs'), ') under ', link, '.'), empty('Or start a ', h('b', {}, 'New'), ' request without one.')];
  }
  if (!A.specName) return [empty('Pick a spec above, or start a New request.')];
  if (A.specLoading.has(A.specName)) return [empty('Loading…')];
  const error = A.specErrors.get(A.specName);
  if (error) return [h('div', { class: 'tm-note warn' }, error), button('Try again', () => void ensureSpec(A.specName, true))];
  const spec = specFor(A.specName);
  if (!spec) {
    void ensureSpec(A.specName);
    return [empty('Loading…')];
  }
  const byTag = new Map<string, ApiOperation[]>();
  for (const op of spec.operations) {
    if (!matches(`${op.method} ${op.path} ${op.summary} ${op.operationId ?? ''} ${op.tags.join(' ')}`)) continue;
    const tag = op.tags[0] ?? 'Other';
    byTag.set(tag, [...(byTag.get(tag) ?? []), op]);
  }
  if (!byTag.size) return [empty(spec.operations.length ? 'No operations match.' : 'This spec has no operations.')];
  const out: HTMLElement[] = [];
  for (const [tag, ops] of byTag) {
    out.push(...group(`op:${spec.name}:${tag}`, tag, ops.length, ops.map((op) => {
      const active = A.op?.spec === spec.name && A.op.method === op.method && A.op.path === op.path;
      const b = button(
        h('span', { class: 'api-item-main' },
          h('span', { class: 'api-item-line' }, methodBadge(op.method), h('span', { class: `api-path${op.deprecated ? ' deprecated' : ''}` }, op.path)),
          op.summary || op.deprecated ? h('span', { class: 'api-item-sub' }, op.deprecated ? h('span', { class: 'tm-tag' }, 'deprecated') : null, op.summary ? ` ${op.summary}` : null) : null),
        () => selectOp(spec, op),
        { cls: `api-item${active ? ' active' : ''}`, title: op.description ? op.description.slice(0, 300) : undefined },
      );
      return b;
    })));
  }
  return out;
}

function savedItems(): HTMLElement[] {
  if (!A.catalog) return [empty('Loading…')];
  const notes: HTMLElement[] = [];
  if (A.catalog.error) notes.push(h('div', { class: 'tm-note warn' }, `${A.catalog.error} The next save moves it aside and starts a new file.`));
  const reqs = A.catalog.requests.filter((r) => matches(`${r.name} ${r.method} ${r.url} ${r.folder} ${r.description}`));
  if (!A.catalog.requests.length) {
    return [...notes, empty('No saved requests yet. Build one and press Save, or use Save to catalog on a request in the timeline.'), h('div', { class: 'api-empty muted' }, PLAIN_TEXT_NOTE)];
  }
  if (!reqs.length) return [...notes, empty('Nothing matches.')];
  const byFolder = new Map<string, SavedRequest[]>();
  for (const r of [...reqs].sort((a, b) => a.name.localeCompare(b.name))) byFolder.set(r.folder, [...(byFolder.get(r.folder) ?? []), r]);
  const keys = [...byFolder.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const out: HTMLElement[] = [...notes];
  for (const folder of keys) {
    const items = byFolder.get(folder)!.map((r) => {
      const active = A.opened?.id === r.id;
      const main = button(
        h('span', { class: 'api-item-main' },
          h('span', { class: 'api-item-line' }, methodBadge(r.method), h('span', { class: 'api-name' }, r.name), active && dirty() ? h('span', { class: 'api-dirty', title: 'Unsaved changes' }, '●') : null),
          h('span', { class: 'api-item-sub mono' }, r.url)),
        () => void openSaved(r),
        { cls: `api-item${active ? ' active' : ''}`, title: r.description || undefined },
      );
      const tools = h('span', { class: 'api-item-tools' },
        button('▶', async () => {
          await openSaved(r);
          if (A.opened?.id === r.id) void send();
        }, { ghost: true, cls: 'btn-icon', title: `Send “${r.name}” now` }),
        button('✎', () => editDetails(r), { ghost: true, cls: 'btn-icon', title: 'Rename or move' }),
        button('⧉', () => void duplicate(r), { ghost: true, cls: 'btn-icon', title: 'Duplicate' }),
        button('×', () => void remove(r), { ghost: true, cls: 'btn-icon', title: 'Delete' }));
      return h('div', { class: 'api-saved' }, main, tools);
    });
    if (folder === '' && keys.length === 1) out.push(...items);
    else out.push(...group(`folder:${folder}`, folder || 'No folder', items.length, items));
  }
  return out;
}

function historyItems(): HTMLElement[] {
  const list = A.history.filter((e) => matches(`${e.method} ${e.url} ${e.name} ${e.status ?? ''}`));
  if (!A.history.length) return [empty('Requests you send appear here. Only the method, URL, parameters, the request’s own headers and body are kept, in this browser.')];
  if (!list.length) return [empty('Nothing matches.')];
  return list.map((e) =>
    button(
      h('span', { class: 'api-item-main' },
        h('span', { class: 'api-item-line' }, methodBadge(e.method), h('span', { class: 'api-path' }, e.url.replace(/^https?:\/\/[^/]+/, '') || '/'), statusPill(e.status, e.error)),
        h('span', { class: 'api-item-sub' }, `${e.name ? e.name + ' · ' : ''}${ago(e.at)} · ${fmtMs(e.ms)}`)),
      () => restoreHistory(e),
      { cls: 'api-item', title: e.error ?? e.url },
    ),
  );
}

// ── Builder ─────────────────────────────────────────────

function renderSendButton(): void {
  const host = root().querySelector('.api-send');
  if (!host) return;
  host.replaceChildren(
    A.inflight
      ? button('Cancel', () => cancel(), { title: 'Stop waiting and close the connection' })
      : button('Send', () => void send(), { primary: true, title: 'Send (Ctrl+Enter)' }),
  );
}

function renderBuilder(): void {
  const host = root().querySelector('.api-req');
  if (!host || !A.open) return;
  const found = currentOp();
  const op = found?.op ?? null;

  const title = A.opened ? A.opened.name : op ? op.summary || op.operationId || `${op.method} ${op.path}` : A.op ? `${A.op.method} ${A.op.path}` : 'New request';
  const head = h('div', { class: 'api-req-head' },
    h('h2', {}, title),
    A.opened?.folder ? h('span', { class: 'tm-tag' }, A.opened.folder) : null,
    op?.deprecated ? h('span', { class: 'tm-tag' }, 'deprecated') : null,
    h('span', { class: 'api-state' }),
    h('div', { class: 'spacer' }),
    button(A.opened ? 'Save' : 'Save…', () => void saveCurrent(), { title: A.opened ? 'Save changes (Ctrl+S)' : 'Save to the catalog (Ctrl+S)' }),
    A.opened ? button('Save as…', () => saveAs(), { title: 'Save a copy under another name' }) : null);

  const notes = A.notes.map((n, i) => {
    const close = button('×', () => {
      A.notes.splice(i, 1);
      renderBuilder();
    }, { ghost: true, cls: 'btn-icon', title: 'Dismiss' });
    return h('div', { class: 'tm-note warn api-note' }, h('span', {}, n), close);
  });

  const method = h('select', { class: 'input api-method', 'aria-label': 'Method' }, ...HTTP_METHODS.map((m) => h('option', { value: m }, m))) as HTMLSelectElement;
  if (!(HTTP_METHODS as readonly string[]).includes(A.draft.method)) method.append(h('option', { value: A.draft.method }, A.draft.method));
  method.value = A.draft.method;
  method.dataset.m = A.draft.method.toLowerCase();
  method.addEventListener('change', () => {
    A.draft.method = method.value;
    method.dataset.m = method.value.toLowerCase();
    refresh();
  });
  const url = h('input', { type: 'text', class: 'input mono api-url', placeholder: '{{baseUrl}}/api/orders or http://localhost:8080/api/orders', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'URL' }) as HTMLInputElement;
  url.value = A.draft.url;
  url.addEventListener('input', () => {
    A.draft.url = url.value;
    syncPathParams();
    refresh();
  });
  url.addEventListener('change', () => renderTab());

  const follow = h('input', { type: 'checkbox' }) as HTMLInputElement;
  follow.checked = A.follow;
  follow.addEventListener('change', () => {
    A.follow = follow.checked;
    save('dh.api.follow', A.follow);
  });

  host.replaceChildren(
    head,
    ...notes,
    op ? docs(found!.spec, op) : '',
    h('div', { class: 'api-line' }, method, url, h('span', { class: 'api-send' })),
    h('div', { class: 'api-preview' }),
    h('div', { class: 'api-req-tabs', role: 'tablist' }),
    h('div', { class: 'api-tab-body' }),
    h('div', { class: 'api-opts' },
      h('label', { class: 'check', title: 'Off: a 3xx response is shown as it is. On: up to 5 redirects are followed, each recorded on the timeline.' }, follow, ' Follow redirects'),
      A.info?.addRequestId ? h('span', { class: 'muted' }, `A fresh ${A.info.requestIdHeader} is added, so the server’s logs and queries link to the request on the timeline.`) : null),
  );
  renderSendButton();
  renderTab();
  refresh();
}

/** Operation docs: summary, description, responses and security, collapsed by default. */
function docs(spec: ApiSpec, op: ApiOperation): HTMLElement {
  const d = h('details', { class: 'api-docs' }, h('summary', {}, h('span', {}, 'Documentation'), h('span', { class: 'muted mono' }, ` ${op.method} ${op.path}${op.operationId ? ` · ${op.operationId}` : ''}`)));
  const body: Child[] = [];
  if (op.summary) body.push(h('p', { class: 'api-summary-line' }, op.summary));
  if (op.description) body.push(markdownText(op.description));
  if (op.body?.description) body.push(h('div', { class: 'api-doc-sub' }, h('b', {}, 'Body: '), op.body.description));
  if (op.responses.length) {
    body.push(h('div', { class: 'api-doc-sub' }, h('b', {}, 'Responses')));
    body.push(h('dl', { class: 'facts api-responses' }, ...op.responses.flatMap((r) => [
      h('dt', {}, /^\d{3}$/.test(r.status) ? statusPill(Number(r.status)) : h('span', { class: 'pill' }, r.status)),
      h('dd', { class: 'plain' }, r.description || '', r.contents.length ? h('span', { class: 'muted' }, ` · ${r.contents.map((c) => c.type).join(', ')}`) : null),
    ])));
  }
  if (op.security.length) {
    const schemes = op.security.map((name) => {
      const s = spec.securitySchemes.find((x) => x.name === name);
      return s ? `${name} (${[s.type, s.scheme, s.in && `${s.in} ${s.paramName ?? ''}`.trim()].filter(Boolean).join(', ')})` : name;
    });
    body.push(h('div', { class: 'api-doc-sub' }, h('b', {}, 'Security: '), schemes.join(' or '), h('span', { class: 'muted' }, '. Put a token under Default headers in Settings, or in a header here.')));
  }
  if (!body.length) body.push(h('p', { class: 'muted' }, 'The spec has no description for this operation.'));
  d.append(h('div', { class: 'api-docs-body' }, ...body));
  return d;
}

/** Keeps a path parameter row for each {name} in the URL, so typing a URL works without a spec. */
function syncPathParams(): void {
  const names = [...A.draft.url.matchAll(/(?<!\{)\{([^{}/?#]+)\}(?!\})/g)].map((m) => m[1]);
  const before = A.draft.params.length;
  for (const name of names) {
    if (!A.draft.params.some((p) => p.in === 'path' && p.name === name)) A.draft.params.push({ in: 'path', name, value: '', enabled: true });
  }
  // Path rows nothing refers to any more go, unless the spec defines them.
  const spec = currentOp()?.op;
  A.draft.params = A.draft.params.filter((p) => p.in !== 'path' || names.includes(p.name) || spec?.params.some((s) => s.in === 'path' && s.name === p.name));
  if (A.draft.params.length !== before && A.reqTab === 'params') renderTab();
}

function renderTab(): void {
  const tabs = root().querySelector('.api-req-tabs');
  const body = root().querySelector('.api-tab-body');
  if (!tabs || !body) return;
  const n = (k: typeof A.reqTab) => {
    if (k === 'params') return A.draft.params.filter((p) => p.enabled).length;
    if (k === 'headers') return A.draft.headers.filter((x) => x.enabled && x.name).length + (A.info?.defaultHeaders.filter((d) => !A.draft.disabledDefaults.some((x) => x.toLowerCase() === d.name.toLowerCase())).length ?? 0);
    return A.draft.body ? 1 : 0;
  };
  const tab = (k: typeof A.reqTab, label: string) => {
    const count = n(k);
    const b = button(h('span', {}, label, k !== 'body' && count ? h('span', { class: 'n' }, ` ${count}`) : k === 'body' && count ? h('span', { class: 'dot-on', 'aria-label': 'has a body' }) : null), () => {
      A.reqTab = k;
      renderTab();
    }, { cls: `api-tab${A.reqTab === k ? ' active' : ''}` });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(A.reqTab === k));
    return b;
  };
  tabs.replaceChildren(tab('params', 'Params'), tab('headers', 'Headers'), tab('body', 'Body'));
  body.replaceChildren(A.reqTab === 'params' ? paramsTable() : A.reqTab === 'headers' ? headersTable() : bodyEditor());
}

function specParam(row: ParamRow): ApiParam | undefined {
  return currentOp()?.op.params.find((p) => p.in === row.in && p.name === row.name);
}

function paramsTable(): HTMLElement {
  const found = currentOp();
  const schemas = found?.spec.schemas ?? {};
  const rows = A.draft.params.map((row, i) => {
    const sp = specParam(row);
    const on = h('input', { type: 'checkbox', 'aria-label': `Send ${row.name || 'parameter'}` }) as HTMLInputElement;
    on.checked = row.enabled;
    on.disabled = row.in === 'path';
    on.addEventListener('change', () => {
      row.enabled = on.checked;
      refresh();
    });
    let name: HTMLElement;
    let where: HTMLElement;
    if (sp) {
      name = h('span', { class: 'api-pname mono', title: sp.description || undefined }, row.name, sp.required ? h('span', { class: 'req', title: 'Required' }, '*') : null);
      where = h('span', { class: `api-in in-${row.in}` }, row.in);
    } else {
      const input = h('input', { type: 'text', class: 'input mono', placeholder: 'name', 'aria-label': `Parameter ${i + 1} name`, spellcheck: 'false' }) as HTMLInputElement;
      input.value = row.name;
      input.addEventListener('input', () => {
        row.name = input.value;
        refresh();
      });
      name = input;
      const sel = h('select', { class: 'input api-in-select', 'aria-label': `Parameter ${i + 1} location` }, ...(['query', 'path', 'header', 'cookie'] as ParamIn[]).map((x) => h('option', { value: x }, x))) as HTMLSelectElement;
      sel.value = row.in;
      sel.addEventListener('change', () => {
        row.in = sel.value as ParamIn;
        refresh();
      });
      where = sel;
    }
    const options = sp ? enumOf(sp.schema, schemas) : null;
    let value: HTMLInputElement | HTMLSelectElement;
    if (options) {
      value = h('select', { class: 'input mono', 'aria-label': `${row.name} value` }, h('option', { value: '' }, '—'), ...options.map((o) => h('option', { value: o }, o))) as HTMLSelectElement;
      if (row.value && !options.includes(row.value)) value.append(h('option', { value: row.value }, row.value));
    } else {
      value = h('input', { type: 'text', class: 'input mono', placeholder: sp ? typeHint(sp.schema, schemas) || 'value' : 'value', 'aria-label': `${row.name || 'parameter'} value`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    }
    value.value = row.value;
    value.addEventListener(options ? 'change' : 'input', () => {
      row.value = value.value;
      // Giving an optional parameter a value means it should be sent.
      if (value.value && !row.enabled) {
        row.enabled = true;
        on.checked = true;
      }
      refresh();
    });
    const del = sp
      ? h('span')
      : button('×', () => {
          A.draft.params.splice(i, 1);
          renderTab();
          refresh();
        }, { ghost: true, cls: 'btn-icon', title: 'Remove' });
    const hint = sp ? [typeHint(sp.schema, schemas), sp.deprecated ? 'deprecated' : '', sp.description].filter(Boolean).join(' · ') : '';
    return h('div', { class: `kv-row${row.enabled ? '' : ' off'}` }, on, where, name, value, del, hint ? h('div', { class: 'kv-hint' }, hint) : null);
  });
  const add = button('+ Add parameter', () => {
    A.draft.params.push({ in: 'query', name: '', value: '', enabled: true });
    renderTab();
    root().querySelector<HTMLInputElement>('.api-tab-body .kv-row:last-of-type input[type=text]')?.focus();
  }, { ghost: true, cls: 'list-add' });
  return h('div', { class: 'kv' },
    ...(rows.length ? rows : [h('div', { class: 'list-empty' }, found ? 'This operation has no parameters.' : 'No parameters. Write {name} in the URL for a path parameter.')]),
    add);
}

function headersTable(): HTMLElement {
  const defaults = A.info?.defaultHeaders ?? [];
  const own = A.draft.headers;
  const overridden = (name: string) => own.some((x) => x.enabled && x.name.trim().toLowerCase() === name.toLowerCase());
  const defaultRows = defaults.map((d) => {
    const off = A.draft.disabledDefaults.some((x) => x.toLowerCase() === d.name.toLowerCase());
    const on = h('input', { type: 'checkbox', 'aria-label': `Send default ${d.name}` }) as HTMLInputElement;
    on.checked = !off;
    on.addEventListener('change', () => {
      A.draft.disabledDefaults = on.checked ? A.draft.disabledDefaults.filter((x) => x.toLowerCase() !== d.name.toLowerCase()) : [...A.draft.disabledDefaults, d.name];
      renderTab();
      refresh();
    });
    const over = button('Override', () => {
      own.push({ name: d.name, value: d.value, enabled: true });
      renderTab();
      refresh();
    }, { ghost: true, title: 'Send a different value with this request' });
    const value = h('input', { type: 'text', class: 'input mono', readonly: '', 'aria-label': `${d.name} default value` }) as HTMLInputElement;
    value.value = d.value;
    return h('div', { class: `kv-row default${off || overridden(d.name) ? ' off' : ''}` }, on, h('span', { class: 'api-in' }, 'default'), h('span', { class: 'api-pname mono' }, d.name), value, over,
      overridden(d.name) ? h('div', { class: 'kv-hint' }, 'Replaced by this request’s own header below.') : null);
  });
  const ownRows = own.map((row, i) => {
    const on = h('input', { type: 'checkbox', 'aria-label': `Send ${row.name || 'header'}` }) as HTMLInputElement;
    on.checked = row.enabled;
    on.addEventListener('change', () => {
      row.enabled = on.checked;
      refresh();
    });
    const name = h('input', { type: 'text', class: 'input mono', placeholder: 'Header', list: 'api-header-names', 'aria-label': `Header ${i + 1} name`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    name.value = row.name;
    name.addEventListener('input', () => {
      row.name = name.value;
      refresh();
    });
    const value = h('input', { type: 'text', class: 'input mono', placeholder: 'value or {{variable}}', 'aria-label': `Header ${i + 1} value`, spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
    value.value = row.value;
    value.addEventListener('input', () => {
      row.value = value.value;
      refresh();
    });
    const del = button('×', () => {
      own.splice(i, 1);
      renderTab();
      refresh();
    }, { ghost: true, cls: 'btn-icon', title: 'Remove' });
    return h('div', { class: `kv-row${row.enabled ? '' : ' off'}` }, on, h('span', { class: 'api-in' }, 'header'), name, value, del);
  });
  const add = button('+ Add header', () => {
    own.push({ name: '', value: '', enabled: true });
    renderTab();
    root().querySelector<HTMLInputElement>('.api-tab-body .kv-row:last-of-type input[type=text]')?.focus();
  }, { ghost: true, cls: 'list-add' });
  const settingsLink = h('a', { href: '#settings/api', class: 'link' }, 'Settings › API client');
  settingsLink.addEventListener('click', (e) => {
    e.preventDefault();
    openSettings('api');
  });
  return h('div', { class: 'kv' },
    defaults.length ? h('div', { class: 'kv-label' }, 'Default headers from ', settingsLink) : null,
    ...defaultRows,
    defaults.length ? h('div', { class: 'kv-label' }, 'This request') : null,
    ...(ownRows.length ? ownRows : [h('div', { class: 'list-empty' }, defaults.length ? 'No headers of its own.' : 'No headers. Headers sent with every request go under Default headers in Settings › API client.')]),
    add,
    A.draft.contentType && A.draft.body ? h('div', { class: 'kv-hint' }, `Content-Type: ${A.draft.contentType} is added from the Body tab unless set here.`) : null,
    h('datalist', { id: 'api-header-names' }, ...COMMON_HEADERS.map((x) => h('option', { value: x }))));
}

function bodyEditor(): HTMLElement {
  const found = currentOp();
  const contents = found?.op.body?.contents ?? [];
  const types = [...new Set([...contents.map((c) => c.type), ...CONTENT_TYPES, ...(A.draft.contentType ? [A.draft.contentType] : [])])];
  const type = h('select', { class: 'input api-ctype', 'aria-label': 'Content type' }, h('option', { value: '' }, 'No content type'), ...types.map((t) => h('option', { value: t }, t))) as HTMLSelectElement;
  type.value = A.draft.contentType;
  const ta = h('textarea', { class: 'input mono api-body-text', spellcheck: 'false', 'aria-label': 'Body', placeholder: A.draft.method === 'GET' ? 'GET requests usually have no body' : '{ "name": "value" }  ·  {{variables}} are filled in when sent' }) as HTMLTextAreaElement;
  ta.value = A.draft.body;
  const status = h('span', { class: 'api-json-status' });
  const check = () => {
    const isJson = /json/i.test(A.draft.contentType) || (/form-urlencoded/i.test(A.draft.contentType) && /^\s*\{/.test(A.draft.body));
    // {{variables}} inside strings are fine; unquoted ones ({{count}}) are checked as a number.
    const problem = isJson ? jsonProblem(A.draft.body.replace(/\{\{[^}]*\}\}/g, '0')) : null;
    status.className = `api-json-status${problem ? ' bad' : A.draft.body.trim() && isJson ? ' ok' : ''}`;
    status.textContent = problem ? `Not valid JSON: ${problem}` : A.draft.body.trim() && isJson ? 'Valid JSON' : '';
  };
  type.addEventListener('change', () => {
    A.draft.contentType = type.value;
    check();
    refresh();
  });
  ta.addEventListener('input', () => {
    A.draft.body = ta.value;
    check();
    refresh();
  });
  ta.addEventListener('keydown', (e) => {
    // Tab indents in the body instead of leaving it.
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  });
  const content = contents.find((c) => c.type === A.draft.contentType) ?? contents[0];
  const gen = content && found
    ? button('Generate example', () => {
        const ex = content.example !== undefined ? content.example : exampleFromSchema(content.schema, found.spec.schemas, { for: 'request' });
        const text = JSON.stringify(ex ?? {}, null, 2);
        const replace = () => {
          A.draft.body = text;
          if (!A.draft.contentType) A.draft.contentType = content.type;
          renderTab();
          refresh();
        };
        if (!A.draft.body.trim() || A.draft.body === text) return replace();
        void confirmDialog({ title: 'Replace the body?', text: 'The body you have now is replaced with an example built from the spec.', ok: 'Replace body' }).then((go) => go && replace());
      }, { title: `An example ${content.type} body built from the spec’s schema` })
    : null;
  const fmt = button('Format', () => {
    const pretty = prettyJson(A.draft.body);
    if (!pretty) return;
    A.draft.body = pretty;
    ta.value = pretty;
    check();
    refresh();
  }, { title: 'Pretty-print the JSON body' });
  check();
  return h('div', { class: 'api-body-edit' },
    h('div', { class: 'api-body-tools' }, type, gen, fmt, status),
    ta,
    /form-urlencoded/i.test(A.draft.contentType) ? h('div', { class: 'kv-hint' }, 'Write a=1&b=2, or a JSON object, which is form-encoded when sent.') : null,
    found?.op.body?.required && !A.draft.body.trim() ? h('div', { class: 'kv-hint warn' }, 'The spec says this operation needs a body.') : null);
}

/** Updates what depends on the draft without rebuilding the inputs being typed in. */
function refresh(): void {
  const preview = root().querySelector('.api-preview');
  if (preview) {
    const { input, problems } = resolveDraft(A.draft, variables());
    preview.classList.toggle('bad', problems.length > 0);
    preview.replaceChildren(problems.length ? h('span', {}, problems[0]) : h('span', { class: 'mono', title: 'The URL as it will be sent' }, input.url));
  }
  const state = root().querySelector('.api-state');
  if (state) {
    const d = dirty();
    state.textContent = A.opened ? (d ? '● Unsaved changes' : 'Saved') : '';
    state.className = `api-state${d ? ' dirty' : ''}`;
  }
  // Counts in the tab labels.
  const tabs = root().querySelectorAll<HTMLElement>('.api-req-tabs .api-tab .n');
  if (tabs.length) {
    const p = A.draft.params.filter((x) => x.enabled).length;
    const hd = A.draft.headers.filter((x) => x.enabled && x.name).length + (A.info?.defaultHeaders.filter((d) => !A.draft.disabledDefaults.some((x) => x.toLowerCase() === d.name.toLowerCase())).length ?? 0);
    root().querySelectorAll<HTMLElement>('.api-req-tabs .api-tab').forEach((b, i) => {
      const n = b.querySelector('.n');
      if (n && i < 2) n.textContent = ` ${i === 0 ? p : hd}`;
    });
  }
  // The unsaved-changes dot on the open request in the Saved list.
  const active = root().querySelector('.api-saved .api-item.active');
  if (active && !!active.querySelector('.api-dirty') !== dirty()) renderSide();
}

// ── Response ────────────────────────────────────────────

function renderResponse(): void {
  const host = root().querySelector('.api-res');
  if (!host || !A.open) return;
  if (A.inflight) {
    host.replaceChildren(h('div', { class: 'api-res-wait' }, h('span', { class: 'api-spinner', 'aria-hidden': 'true' }), 'Waiting for the response…', button('Cancel', () => cancel())));
    return;
  }
  if (A.sendError) {
    host.replaceChildren(h('div', { class: 'banner error', role: 'alert' }, h('span', {}, A.sendError)));
    return;
  }
  const r = A.result;
  if (!r) {
    host.replaceChildren(h('div', { class: 'api-res-empty' }, 'The response appears here. ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ' sends.'));
    return;
  }
  const ctype = r.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? null;
  const pretty = r.binary ? null : prettyJson(r.body);
  const shown = pretty ?? r.body;
  const timeline = button('Show in timeline', () => {
    closeApi();
    hooks.showEvent(r.requestEventId);
  }, { title: 'Open this request on the timeline, with the server events it caused' });
  const viewer = jsonViewer && pretty
    ? button('Open in JSON viewer', () => jsonViewer?.(r.body, { title: `${r.method} ${r.url} → ${r.status ?? ''}` }), { title: 'Browse the JSON body in the full-window viewer' })
    : null;
  const copy = !r.binary && r.body
    ? button('Copy', async () => {
        try {
          await navigator.clipboard.writeText(shown);
          toast('Copied the body');
        } catch {
          toast('Copy failed', true);
        }
      }, { title: 'Copy the body' })
    : null;
  const headEl = h('div', { class: 'api-res-head' },
    statusPill(r.status, r.error),
    h('span', { class: 'api-res-status' }, r.status != null ? r.statusText : r.canceled ? 'Canceled' : 'No response'),
    h('span', { class: 'api-res-meta', title: r.ttfbMs != null ? `First byte after ${fmtMs(r.ttfbMs)}` : undefined }, fmtMs(r.durationMs)),
    r.status != null ? h('span', { class: 'api-res-meta' }, fmtBytes(r.bodyBytes)) : null,
    r.redirects.length ? h('span', { class: 'api-res-meta' }, `${r.redirects.length} redirect${r.redirects.length === 1 ? '' : 's'} followed`) : null,
    h('div', { class: 'spacer' }), viewer, copy, timeline);

  const tabs = h('div', { class: 'api-req-tabs', role: 'tablist' });
  const body = h('div', { class: 'api-tab-body' });
  const tab = (k: typeof A.resTab, label: string, n?: number) => {
    const b = button(h('span', {}, label, n ? h('span', { class: 'n' }, ` ${n}`) : null), () => {
      A.resTab = k;
      renderResponse();
    }, { cls: `api-tab${A.resTab === k ? ' active' : ''}` });
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(A.resTab === k));
    return b;
  };
  tabs.append(tab('body', 'Body'), tab('headers', 'Headers', r.headers.length), tab('request', 'Request'));
  const facts = (pairs: [string, string][]) => h('dl', { class: 'facts' }, ...pairs.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  if (A.resTab === 'headers') {
    body.append(r.headers.length ? facts(r.headers) : h('div', { class: 'list-empty' }, 'No headers.'));
  } else if (A.resTab === 'request') {
    body.append(
      facts([
        ['URL', r.url],
        ['Method', r.method],
        ...(r.requestId ? [['Request ID', r.requestId] as [string, string]] : []),
        ...(r.remoteAddress ? [['Remote', r.remoteAddress] as [string, string]] : []),
        ...(r.httpVersion ? [['HTTP', r.httpVersion] as [string, string]] : []),
        ...r.redirects.map((x, i) => [`Redirect ${i + 1}`, `${x.status} from ${x.url}`] as [string, string]),
      ]),
      h('div', { class: 'kv-label' }, 'Headers sent'),
      facts(r.sentHeaders),
    );
  } else if (r.error && r.status == null) {
    body.append(h('div', { class: 'banner error', role: 'alert' }, h('span', {}, r.error)));
  } else if (r.binary) {
    body.append(h('div', { class: 'list-empty' }, `Binary body (${ctype ?? 'unknown type'}, ${fmtBytes(r.bodyBytes)}), not shown.`));
  } else if (!r.body) {
    body.append(h('div', { class: 'list-empty' }, 'Empty body.'));
  } else {
    body.append(paint(h('pre', { class: 'code api-res-body' }), highlight(shown, bodyLang(shown, ctype))));
    if (r.truncated) body.append(h('div', { class: 'notice' }, `Only the first ${fmtBytes(r.body.length)} are shown.`));
  }
  host.replaceChildren(headEl, tabs, body);
}

// ── Recorded requests from the timeline ─────────────────

async function replayOf(data: Record<string, any>): Promise<Replay> {
  await ensureLoaded();
  // The chosen spec's server can stand in for {{baseUrl}}: load it if needed, but do not keep
  // the user waiting on a spec that does not answer.
  const name = A.specName && A.info?.specs.some((s) => s.name === A.specName) ? A.specName : A.info?.specs[0]?.name;
  if (name && !A.specs.has(name) && !A.info?.baseUrl) {
    await Promise.race([ensureSpec(name), new Promise((r) => setTimeout(r, 3000))]);
    if (!A.specName && A.specs.has(name)) A.specName = name;
  }
  // Specs already loaded offer their servers for {{baseUrl}}; Settings' base URL comes first.
  const bases = [A.info?.baseUrl ?? '', baseUrl(), ...[...A.specs.values()].flatMap((s) => s.servers.map((x) => x.url))].filter(Boolean);
  return replayFromEvent(data, {
    requestIdHeader: A.info?.requestIdHeader ?? 'X-Request-Id',
    baseUrls: [...new Set(bases)],
    defaultHeaders: (A.info?.defaultHeaders ?? []).map((d) => d.name),
    variables: (A.catalog?.variables ?? []).map((v) => v.name),
  });
}

/** Save to catalog… on a timeline request: asks for a name and folder, saying what needs filling in. */
export async function saveEventToCatalog(data: Record<string, any>): Promise<void> {
  const r = await replayOf(data);
  formDialog(
    'Save to catalog',
    [
      { key: 'name', label: 'Name', value: r.name },
      { key: 'folder', label: 'Folder', value: '', kind: 'folder', placeholder: 'None' },
      { key: 'description', label: 'Description', value: '', kind: 'textarea', placeholder: 'Optional' },
    ],
    'Save',
    async (v) => {
      const out = await call<{ request: SavedRequest; notice?: string }>('/api/client/catalog/requests', { body: requestBody({ name: v.name, folder: v.folder, description: v.description }, r.draft, null) });
      await loadCatalog();
      if (A.open) renderSide();
      toast(out.notice ?? `Saved “${out.request.name}” to the catalog`, !!out.notice);
      return null;
    },
    [...r.warnings, h('span', { class: 'muted' }, PLAIN_TEXT_NOTE)],
  );
}

/** Edit and send: opens the API screen with the recorded request in the builder. */
export async function editEventInApi(data: Record<string, any>): Promise<void> {
  const r = await replayOf(data);
  loadDraft(r.draft, r.warnings);
  openApi();
}

/**
 * Replay: sends the recorded request again straight away and shows the new one on the timeline.
 * Returns the new request's event id, or throws with what stopped it.
 */
export async function replayEvent(data: Record<string, any>): Promise<string> {
  const r = await replayOf(data);
  if (r.blocking.length) throw new Error(r.blocking.join(' '));
  if (r.needs.length) throw new Error(`${r.warnings[0]} Or use Edit and send to fill them in.`);
  const { input, problems } = resolveDraft(r.draft, variables());
  if (problems.length) throw new Error(problems.join(' '));
  input.label = 'Replay';
  const result = await call<SendResult>('/api/client/send', { body: input });
  if (result.error && !result.canceled) toast(`Replay failed: ${result.error}`, true);
  return result.requestEventId;
}

// ── Public ──────────────────────────────────────────────

/** Connects the "Open in JSON viewer" button; without an opener the button is not shown. */
export function setJsonViewerOpener(fn: JsonViewerOpener | null): void {
  jsonViewer = fn;
  if (A.open) renderResponse();
}

export function apiOpen(): boolean {
  return A.open;
}

export function openApi(): void {
  if (!closeSettings()) return;
  closeTomcat();
  if (location.hash !== '#api') history.replaceState(null, '', '#api');
  if (A.open) {
    renderBuilder();
    renderResponse();
    return;
  }
  A.open = true;
  root().hidden = false;
  document.body.classList.add('api-open');
  hooks.onToggle(true);
  renderShell();
  // Settings may have changed since the last visit: the specs list, base URL and default headers.
  void Promise.all([loadInfo(), loadCatalog()]).then(() => {
    if (!A.open) return;
    // The hub forgets a spec whose URL changed in Settings; forget it here too.
    for (const s of A.info?.specs ?? []) {
      if (s.state === 'not-loaded') {
        A.specs.delete(s.name);
        A.specErrors.delete(s.name);
      }
    }
    if (A.specName && !A.info?.specs.some((s) => s.name === A.specName)) A.specName = '';
    if (!A.specName && A.info?.specs.length === 1) A.specName = A.info.specs[0].name;
    renderShell();
    if (A.specName) void ensureSpec(A.specName);
  });
}

export function closeApi(): void {
  if (!A.open) return;
  rememberOp();
  A.open = false;
  document.querySelectorAll<HTMLDialogElement>('dialog.api-dialog').forEach((d) => d.close());
  root().hidden = true;
  root().replaceChildren();
  document.body.classList.remove('api-open');
  if (location.hash === '#api') history.replaceState(null, '', location.pathname + location.search);
  hooks.onToggle(false);
}

/** Call after initSettings and initTomcat: they handle a hash change first. */
export function initApi(opts: { onToggle: (open: boolean) => void; showEvent: (id: string) => void }): void {
  hooks = opts;
  const sync = () => {
    if (location.hash === '#api') {
      if (settingsOpen()) history.replaceState(null, '', '#settings');
      else openApi();
    } else if (A.open) closeApi();
  };
  window.addEventListener('hashchange', sync);
  sync();

  document.addEventListener('keydown', (e) => {
    // The JSON viewer, opened from a response, covers this screen and has its own keys.
    if (!A.open || document.querySelector('dialog[open]') || document.body.classList.contains('json-open')) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveCurrent();
    } else if (e.key === 'Escape') {
      const t = e.target as HTMLElement;
      if (t.matches('input, select, textarea')) t.blur();
      else closeApi();
    }
  });
}
