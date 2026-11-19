import type { DownloadInfo, DownloadResult, PackageInfo, PackageNotice, RegistryInfo, RegistryMessage, RegistryState } from '../shared/registry';
import { REGISTRY_FORMS } from '../shared/registry-forms';
import { fmtBytes, h, type Child } from './dom';
import { openSettings } from './settings';
import { ago, api, button, card, filterCard, missing, nameProblem, openDeploy, renderNotices, searchable, searchBox, tomcatOpen } from './tomcat';

/**
 * Packages from the registries in Settings, on the Tomcat page: each package with its versions
 * (newest first; an older one rolls back), what is deployed from it, and Download & deploy,
 * which fetches the version into the hub's cache and then opens the same deploy dialog a local
 * WAR gets. Also the new-version notices, which show on every screen next to the new-WAR ones.
 * Everything shown comes from GET /api/registry; the hub says over the WebSocket when to load it
 * again and how downloads are getting on.
 */

const POLL_MS = 15_000;
const HIDE_KEY = 'dh.packages.hideUnmatched';

function loadHide(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === 'true';
  } catch {
    return false;
  }
}
const MAX_NOTICES = 3;

const P = {
  state: null as RegistryState | null,
  stateJson: '',
  loadError: null as string | null,
  /** The version chosen in each package's list, by package key. Not there: the latest. */
  picked: new Map<string, string>(),
  /** Leave out packages none of whose versions pass the version settings, and the notes about them. */
  hideUnmatched: loadHide(),
  /** The package whose Deploy as is being edited, and what is typed so far. */
  editing: null as { key: string; value: string; error: string | null } | null,
  /** Requests in flight: package keys, and "check". */
  busy: new Set<string>(),
  /** Downloads the user canceled, so their failure is not reported as one. */
  canceled: new Set<string>(),
  downloads: new Map<string, DownloadInfo>(),
  /** New versions not yet deployed or dismissed, by package key. */
  notices: new Map<string, PackageNotice>(),
  /** The card on the page now, replaced in place when only the packages changed. */
  card: null as HTMLElement | null,
  timer: 0,
  reload: 0,
};

// ── Data ────────────────────────────────────────────────

const allPackages = (): PackageInfo[] => (P.state?.registries ?? []).flatMap((r) => r.packages);
/** Already in the hub's cache: deploying needs no download. */
const isCached = (key: string, version: string): boolean => !!allPackages().find((p) => p.key === key)?.versions.find((v) => v.version === version)?.cached;

function adopt(state: RegistryState): void {
  P.loadError = null;
  const json = JSON.stringify(state);
  const same = json === P.stateJson;
  P.state = state;
  P.stateJson = json;
  for (const key of [...P.downloads.keys()]) if (!allPackages().some((p) => p.key === key && p.download)) P.downloads.delete(key);
  for (const p of allPackages()) if (p.download) P.downloads.set(p.key, p.download);
  syncNotices();
  if (!same) redrawCard();
}

async function refresh(): Promise<void> {
  try {
    adopt(await api<RegistryState>('/api/registry'));
  } catch (err) {
    P.loadError = (err as Error).message;
    redrawCard();
  }
}

/** Loads the packages again shortly: several changes in a row cause one load. */
function refreshSoon(): void {
  clearTimeout(P.reload);
  P.reload = window.setTimeout(() => void refresh(), 150);
}

/** While the Tomcat page is open, look now and then even if the socket said nothing. */
function keepFresh(): void {
  if (P.timer) return;
  P.timer = window.setInterval(() => {
    if (!tomcatOpen()) {
      clearInterval(P.timer);
      P.timer = 0;
    } else if (!document.hidden) void refresh();
  }, POLL_MS);
}

/** Notices follow the hub: a version deployed or dismissed in another window goes away here too. */
function syncNotices(): void {
  const fresh = new Map(allPackages().filter((p) => p.fresh && p.latest).map((p) => [p.key, p]));
  let changed = false;
  for (const key of [...P.notices.keys()]) {
    if (!fresh.has(key)) {
      P.notices.delete(key);
      changed = true;
    }
  }
  for (const [key, p] of fresh) {
    const had = P.notices.get(key);
    if (had?.version === p.latest && had.target === p.target) continue;
    P.notices.set(key, { key, registry: p.registry, name: p.name, coordinates: p.coordinates, version: p.latest!, target: p.target });
    changed = true;
  }
  if (changed) renderNotices();
}

function say(kind: 'error' | 'info', text: string): void {
  const el = h('div', { class: `toast pkg-toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 9000 : 4000);
  setTimeout(() => el.remove(), kind === 'error' ? 9400 : 4400);
}

// ── Actions ─────────────────────────────────────────────

/** Fetches a version into the hub's cache, then opens the deploy dialog on the file. */
async function downloadAndDeploy(key: string, version: string | undefined): Promise<void> {
  if (P.busy.has(key)) return;
  P.busy.add(key);
  P.canceled.delete(key);
  redrawAll();
  try {
    const { war } = await api<DownloadResult>('/api/registry/download', { key, version });
    P.busy.delete(key);
    P.downloads.delete(key);
    redrawAll();
    await openDeploy(war);
  } catch (err) {
    if (!P.canceled.has(key)) say('error', (err as Error).message);
  } finally {
    P.busy.delete(key);
    P.downloads.delete(key);
    redrawAll();
    refreshSoon();
  }
}

async function saveTarget(key: string, value: string): Promise<void> {
  const name = value.trim();
  const problem = name ? nameProblem(name) : null;
  if (problem) {
    P.editing = { key, value, error: problem };
    return redrawCard();
  }
  P.busy.add(`${key}:as`);
  redrawCard();
  try {
    const state = await api<RegistryState>('/api/registry/target', { key, deployAs: name });
    P.editing = null;
    adopt(state);
  } catch (err) {
    P.editing = { key, value, error: (err as Error).message };
  } finally {
    P.busy.delete(`${key}:as`);
    redrawCard();
  }
}

function cancelDownload(key: string): void {
  P.canceled.add(key);
  void api('/api/registry/cancel', { key }).catch(() => undefined);
}

function dismiss(key: string): void {
  if (P.notices.delete(key)) renderNotices();
  void api('/api/registry/dismiss', { key }).catch(() => undefined).then(refreshSoon);
}

async function checkNow(): Promise<void> {
  if (P.busy.has('check')) return;
  P.busy.add('check');
  redrawCard();
  try {
    adopt(await api<RegistryState>('/api/registry/check', {}));
  } catch (err) {
    say('error', (err as Error).message);
  } finally {
    P.busy.delete('check');
    redrawCard();
  }
}

// ── Card ────────────────────────────────────────────────

function registriesLink(text: string): HTMLElement {
  const a = h('a', { href: '#settings/registries', class: 'link' }, text);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openSettings('registries');
  });
  return a;
}

function progressText(d: DownloadInfo): string {
  if (d.phase === 'verifying') return 'Checking the download…';
  if (d.phase === 'starting' || !d.received) return 'Starting the download…';
  return d.total ? `Downloading ${fmtBytes(d.received)} of ${fmtBytes(d.total)} (${Math.floor((d.received / d.total) * 100)}%)` : `Downloading ${fmtBytes(d.received)}`;
}

/** A download's progress: a line of text over a bar. Updated in place as it moves on. */
function progress(key: string): HTMLElement {
  const d = P.downloads.get(key);
  const bar = h('div', { class: 'pkg-bar' }, h('i', {}));
  const el = h('div', { class: 'pkg-progress', 'data-pkg-progress': key, role: 'status' }, h('span', {}, d ? progressText(d) : 'Starting the download…'), bar);
  paintProgress(el, d);
  return el;
}

function paintProgress(el: HTMLElement, d: DownloadInfo | undefined): void {
  const text = el.querySelector('span');
  const fill = el.querySelector<HTMLElement>('i');
  if (text && d) text.textContent = progressText(d);
  if (!fill) return;
  const known = !!d?.total && d.phase !== 'starting';
  el.classList.toggle('unknown', !known);
  fill.style.width = known ? `${Math.min(100, (d!.received / d!.total!) * 100).toFixed(1)}%` : '';
}

const TARGET_FROM: Record<PackageInfo['targetFrom'], string> = {
  package: 'set for this package',
  settings: 'from Settings › Package registries',
  guess: 'guessed from the name',
};

/** "→ shop", which opens the editor for the name it deploys as. */
function targetButton(p: PackageInfo): HTMLElement {
  const b = h(
    'button',
    { type: 'button', class: `pkg-target${p.targetFrom === 'package' ? ' own' : ''}`, 'data-f': `${p.key}:as`, title: `Deploys as ${p.target}.war (${TARGET_FROM[p.targetFrom]}). Click to change.` },
    h('span', { class: 'pkg-target-arrow' }, '→'),
    h('span', { class: 'pkg-target-name' }, p.target),
    h('span', { class: 'pkg-target-edit', 'aria-hidden': 'true' }, '✎'),
  );
  b.setAttribute('aria-label', `Deploys as ${p.target}. Change`);
  b.addEventListener('click', () => {
    P.editing = { key: p.key, value: p.target, error: null };
    redrawCard();
    const input = P.card?.querySelector<HTMLInputElement>('.pkg-as-input');
    input?.focus();
    input?.select();
  });
  return b;
}

/** Editing the webapp name a package deploys as, in place of its status. */
function targetEditor(p: PackageInfo): HTMLElement {
  const e = P.editing!;
  const saving = P.busy.has(`${p.key}:as`);
  const input = h('input', {
    type: 'text',
    class: `input mono pkg-as-input${e.error ? ' invalid' : ''}`,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': `Deploy ${p.name} as`,
    placeholder: 'guessed from the name',
    'data-f': `${p.key}:as-input`,
  }) as HTMLInputElement;
  input.value = e.value;
  input.disabled = saving;
  const close = () => {
    P.editing = null;
    redrawCard();
    [...(P.card?.querySelectorAll<HTMLElement>('[data-f]') ?? [])].find((el) => el.dataset.f === `${p.key}:as`)?.focus();
  };
  input.addEventListener('input', () => {
    e.value = input.value;
    const was = e.error;
    e.error = null;
    if (was) {
      input.classList.remove('invalid');
      input.closest('.pkg-as')?.querySelector('.pkg-as-error')?.replaceWith(hint);
    }
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void saveTarget(p.key, input.value);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      close();
    }
  });
  const save = button(saving ? 'Saving…' : 'Save', () => void saveTarget(p.key, input.value), { primary: true, disabled: saving });
  save.dataset.f = `${p.key}:as-save`;
  const cancel = button('Cancel', close, { disabled: saving });
  cancel.classList.add('btn-ghost');
  const reset =
    p.targetFrom === 'package'
      ? h('button', { type: 'button', class: 'link pkg-as-reset', title: 'Forget this name: deploy as Settings say, or as guessed from the name' }, 'Use default')
      : null;
  reset?.addEventListener('click', () => void saveTarget(p.key, ''));
  const hint = h('div', { class: 'muted pkg-as-hint' }, 'Remembered for this package. ', reset);
  return h(
    'div',
    { class: 'pkg-as' },
    h('div', { class: 'pkg-as-row' }, h('span', { class: 'muted' }, 'Deploy as'), input, save, cancel),
    e.error ? h('div', { class: 'field-error pkg-as-error', role: 'alert' }, e.error) : hint,
  );
}

function packageRow(p: PackageInfo, canDeploy: boolean): HTMLElement {
  const downloading = P.busy.has(p.key) || P.downloads.has(p.key);
  const picked = p.versions.find((v) => v.version === P.picked.get(p.key)) ?? p.versions[0];
  const select = h(
    'select',
    { class: 'input pkg-version', 'aria-label': `Version of ${p.name}`, 'data-f': `${p.key}:version`, title: p.versionCount > p.versions.length ? `The newest ${p.versions.length} of ${p.versionCount} versions` : undefined },
    ...p.versions.map((v) => {
      const notes = [v.version === p.latest ? 'latest' : '', v.version === p.deployed?.version ? 'deployed' : '', v.cached ? 'downloaded' : ''].filter(Boolean);
      return h('option', { value: v.version }, notes.length ? `${v.version} (${notes.join(', ')})` : v.version);
    }),
  ) as HTMLSelectElement;
  if (picked) select.value = picked.version;
  select.disabled = downloading || p.versions.length < 2;
  select.addEventListener('change', () => {
    if (select.value === p.latest) P.picked.delete(p.key);
    else P.picked.set(p.key, select.value);
    redrawCard();
  });

  const editing = !downloading && P.editing?.key === p.key;
  let status: Child;
  if (downloading) status = progress(p.key);
  else if (editing) status = targetEditor(p);
  else {
    const about = picked ? [picked.modified ? `published ${ago(picked.modified)}` : '', fmtBytes(picked.bytes)].filter(Boolean).join(' · ') : '';
    status = h(
      'div',
      { class: 'pkg-status muted' },
      targetButton(p),
      p.deployed || about
        ? h(
            'span',
            {},
            p.deployed
              ? h('span', { title: `Deployed from here ${new Date(p.deployed.at).toLocaleString()}` }, `${p.deployed.version} deployed${p.deployed.as === p.target ? '' : ` as ${p.deployed.as}`}`)
              : null,
            p.deployed && about ? ' · ' : null,
            about || null,
          )
        : null,
    );
  }

  const actions: HTMLElement[] = [];
  if (downloading) {
    const b = button('Cancel', () => cancelDownload(p.key), { disabled: !P.downloads.has(p.key), title: 'Stop the download' });
    b.dataset.f = `${p.key}:cancel`;
    actions.push(b);
  } else if (picked) {
    if (p.fresh) {
      const b = button('Dismiss', () => dismiss(p.key), { title: 'Not now: stop announcing this version' });
      b.classList.add('btn-ghost');
      b.dataset.f = `${p.key}:dismiss`;
      actions.push(b);
    }
    const older = !!p.deployed && picked.version !== p.latest && picked.version !== p.deployed.version;
    const b = button(picked.cached ? 'Deploy…' : 'Download & deploy…', () => void downloadAndDeploy(p.key, picked.version), {
      primary: p.fresh && picked.version === p.latest,
      disabled: !canDeploy,
      title: !canDeploy
        ? 'Set the webapps folder in Settings › Tomcat'
        : picked.cached
          ? 'Already downloaded: opens the deploy dialog'
          : `Downloads ${picked.version} from ${p.registry}, then opens the deploy dialog${older ? ' (an older version: a rollback)' : ''}`,
    });
    b.dataset.f = `${p.key}:deploy`;
    actions.push(b);
  }

  const row = h(
    'div',
    { class: `tm-row tm-pkg${p.fresh ? ' fresh' : ''}${editing ? ' editing' : ''}` },
    h(
      'div',
      { class: 'tm-name', title: p.coordinates },
      h('b', {}, p.name),
      p.fresh ? h('span', { class: 'tm-tag new', title: `${p.latest} was not there at the last look` }, 'New') : null,
      picked?.snapshot ? h('span', { class: 'tm-tag', title: 'A snapshot: rebuilt under the same version' }, 'snapshot') : null,
    ),
    h('span', { class: 'muted pkg-coords', title: p.coordinates }, p.coordinates),
    p.versions.length ? select : h('span', { class: 'muted' }, 'No versions'),
    status,
    // The editor takes the actions' room too.
    editing ? null : h('div', { class: 'tm-actions' }, ...actions),
  );
  return searchable(row, p.name, p.coordinates, p.target, p.registry, p.fresh && 'new', picked?.snapshot && 'snapshot');
}

/** Found, but none of its versions pass the version settings (Versions, Version pattern). */
const unmatched = (p: PackageInfo) => !p.versions.length;

function registryBlock(r: RegistryInfo, canDeploy: boolean): HTMLElement {
  const when = r.checking ? 'Checking…' : r.checkedAt ? `checked ${ago(r.checkedAt)}` : r.error ? '' : 'not checked yet';
  const next = r.nextCheckAt ? `Next check ${new Date(r.nextCheckAt).toLocaleTimeString()}` : 'Checked only with Check now';
  const body: Child[] = [
    h(
      'div',
      { class: 'pkg-reg-head' },
      h('b', {}, r.name),
      h('span', { class: 'tm-tag' }, REGISTRY_FORMS[r.type].label),
      r.url ? h('span', { class: 'tm-dir muted' }, r.url) : null,
      h('span', { class: `pkg-when muted${r.checking ? ' checking' : ''}`, title: r.error ? undefined : next }, when),
    ),
  ];
  if (r.error) body.push(h('div', { class: 'tm-note warn' }, r.error, ' ', registriesLink('Fix in Settings')));
  for (const p of r.problems) {
    if (P.hideUnmatched && p.filtered) continue;
    const note = h('div', { class: `tm-note${p.quiet ? '' : ' warn'}` }, h('b', {}, `${p.entry}: `), p.message, p.hint ? ` ${p.hint}` : '');
    note.dataset.qNote = `${p.entry} ${p.message}`.toLowerCase();
    body.push(note);
  }
  const shown = P.hideUnmatched ? r.packages.filter((p) => !unmatched(p)) : r.packages;
  body.push(...shown.map((p) => packageRow(p, canDeploy)));
  if (r.packages.length && !shown.length) {
    const n = r.packages.length;
    body.push(missing(`${n === 1 ? 'Its package is' : `All ${n} packages are`} hidden: none of ${n === 1 ? 'its' : 'their'} versions pass the version settings.`));
  }
  if (!r.packages.length && !r.problems.length && !r.error && r.checkedAt) {
    body.push(missing('Nothing to look for in this registry yet. Add packages in ', registriesLink('Settings › Package registries'), '.'));
  }
  return h('div', { class: 'pkg-reg', 'data-q-group': '' }, ...body);
}

function build(canDeploy: boolean): HTMLElement {
  const s = P.state;
  const body: Child[] = [];
  if (P.loadError && !s) body.push(h('div', { class: 'tm-note warn' }, `Could not load the packages: ${P.loadError}`));
  else if (!s) body.push(missing('Loading…'));
  else if (!s.registries.length) {
    body.push(
      missing(
        'For WARs that are not built on this machine: add a package registry (Nexus, Artifactory, any Maven repository, or a fixed URL) in ',
        registriesLink('Settings › Package registries'),
        '. New versions are announced here and wherever you are in Debug Hub.',
      ),
    );
  } else body.push(...s.registries.map((r) => registryBlock(r, canDeploy)));

  const checking = P.busy.has('check');
  const check = button(checking ? 'Checking…' : 'Check now', () => void checkNow(), { disabled: checking || !s?.registries.some((r) => !r.error), title: 'Look for new versions in every registry now' });
  check.dataset.f = 'check';
  const all = allPackages();
  const hidden = all.filter(unmatched).length;
  const tools = s?.registries.length
    ? h('span', { class: 'tm-tools' }, searchBox('packages', 'packages', all.length), hidden ? hideToggle(hidden) : null, check)
    : null;
  const el = card('packages', 'Packages', 'From the package registries in Settings.', tools, ...body);
  el.dataset.canDeploy = String(canDeploy);
  return el;
}

/** "Hide 3 with no matching version": packages the version settings leave nothing of. */
function hideToggle(count: number): HTMLElement {
  const box = h('input', { type: 'checkbox', 'data-f': 'hide-unmatched' }) as HTMLInputElement;
  box.checked = P.hideUnmatched;
  box.addEventListener('change', () => {
    P.hideUnmatched = box.checked;
    try {
      localStorage.setItem(HIDE_KEY, String(box.checked));
    } catch {
      /* remembered for this page only */
    }
    redrawCard();
  });
  return h(
    'label',
    { class: 'check pkg-hide', title: 'Leave out packages none of whose versions pass the version settings (Versions and Version pattern in Settings › Package registries), and the notes about them' },
    box,
    ` Hide ${count} with no matching version`,
  );
}

/** The Packages card, for the Tomcat page. `canDeploy`: the webapps folder is set. */
export function packagesCard(canDeploy: boolean): HTMLElement {
  if (!P.state && !P.loadError) void refresh();
  keepFresh();
  P.card = build(canDeploy);
  return P.card;
}

/** Draws the card again where it is, keeping the keyboard focus on the same control. */
function redrawCard(): void {
  const old = P.card;
  if (!old?.isConnected) return;
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-f]');
  const f = focused && old.contains(focused) ? focused.dataset.f : null;
  const next = build(old.dataset.canDeploy === 'true');
  old.replaceWith(next);
  P.card = next;
  filterCard('packages');
  const again = f ? [...next.querySelectorAll<HTMLElement>('[data-f]')].find((el) => el.dataset.f === f) : null;
  again?.focus({ preventScroll: true });
  if (again instanceof HTMLInputElement && (again.type === 'text' || again.type === 'search')) again.setSelectionRange(again.value.length, again.value.length);
}

function redrawAll(): void {
  redrawCard();
  renderNotices();
}

// ── Notices ─────────────────────────────────────────────

/** How many new-version notices there are, for the badge on the Tomcat button. */
export function packageNoticeCount(): number {
  return P.notices.size;
}

/** The new-version notices, for the stack the new-WAR notices are in: at most `room` of them, and a count of the rest. */
export function packageNotices(room = MAX_NOTICES): HTMLElement[] {
  const all = [...P.notices.values()];
  const cards = all.slice(0, room).map((n) => {
    const downloading = P.busy.has(n.key) || P.downloads.has(n.key);
    const actions = downloading
      ? [button('Cancel', () => cancelDownload(n.key), { disabled: !P.downloads.has(n.key) })]
      : [button('Dismiss', () => dismiss(n.key)), button(isCached(n.key, n.version) ? 'Deploy…' : 'Download & deploy…', () => void downloadAndDeploy(n.key, n.version), { primary: true })];
    return h(
      'div',
      { class: 'war-notice', role: 'status' },
      h('div', { class: 'war-notice-title' }, 'New package version'),
      h('div', { class: 'war-notice-name', title: n.coordinates }, `${n.name} ${n.version}`),
      downloading ? progress(n.key) : h('div', { class: 'muted' }, `${n.registry} · deploys as ${n.target}`),
      h('div', { class: 'war-notice-actions' }, ...actions),
    );
  });
  if (all.length > room) {
    const rest = all.length - room;
    cards.push(h('div', { class: 'war-notice more' }, h('span', { class: 'muted' }, `${rest} more new version${rest === 1 ? '' : 's'} on the Tomcat page`)));
  }
  return cards;
}

function systemNotify(n: PackageNotice): void {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.hasFocus()) return;
  try {
    const note = new Notification('New package version', { body: `${n.name} ${n.version}\n${n.registry}`, tag: `pkg:${n.key}` });
    note.onclick = () => {
      window.focus();
      note.close();
      void downloadAndDeploy(n.key, n.version);
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

// ── Public ──────────────────────────────────────────────

/** A message about the registries, pushed over the WebSocket. */
export function onRegistryMessage(msg: RegistryMessage): void {
  if (msg.change === 'state') return refreshSoon();
  if (msg.change === 'new') {
    P.notices.set(msg.notice.key, msg.notice);
    renderNotices();
    systemNotify(msg.notice);
    return refreshSoon();
  }
  // The first word of a download turns its Cancel on, so that one draws everything.
  const started = !!msg.download && !P.downloads.has(msg.key);
  if (msg.download) P.downloads.set(msg.key, msg.download);
  else P.downloads.delete(msg.key);
  // Progress moves often: after that, update the lines that show it rather than drawing everything again.
  const lines = [...document.querySelectorAll<HTMLElement>('[data-pkg-progress]')].filter((el) => el.dataset.pkgProgress === msg.key);
  if (msg.download && lines.length && !started) for (const el of lines) paintProgress(el, msg.download);
  else redrawAll();
}

/** Picks up versions announced while this page was closed or disconnected. */
export async function syncPackages(): Promise<void> {
  try {
    adopt(await api<RegistryState>('/api/registry'));
  } catch {
    /* offline; the socket reconnects and calls this again */
  }
}
