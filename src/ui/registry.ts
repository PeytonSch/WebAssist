import type { DownloadInfo, DownloadResult, PackageInfo, PackageNotice, RegistryInfo, RegistryMessage, RegistryState } from '../shared/registry';
import { REGISTRY_FORMS } from '../shared/registry-forms';
import { fmtBytes, h, type Child } from './dom';
import { openSettings } from './settings';
import { ago, api, button, card, missing, openDeploy, renderNotices, tomcatOpen } from './tomcat';

/**
 * Packages from the registries in Settings, on the Tomcat page: each package with its versions
 * (newest first; an older one rolls back), what is deployed from it, and Download & deploy,
 * which fetches the version into the hub's cache and then opens the same deploy dialog a local
 * WAR gets. Also the new-version notices, which show on every screen next to the new-WAR ones.
 * Everything shown comes from GET /api/registry; the hub says over the WebSocket when to load it
 * again and how downloads are getting on.
 */

const POLL_MS = 15_000;
const MAX_NOTICES = 3;

const P = {
  state: null as RegistryState | null,
  stateJson: '',
  loadError: null as string | null,
  /** The version chosen in each package's list, by package key. Not there: the latest. */
  picked: new Map<string, string>(),
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

  let status: Child;
  if (downloading) status = progress(p.key);
  else {
    const about = picked ? [picked.modified ? `published ${ago(picked.modified)}` : '', fmtBytes(picked.bytes)].filter(Boolean).join(' · ') : '';
    status = h(
      'div',
      { class: 'pkg-status muted' },
      p.deployed
        ? h('span', { title: `Deployed from here ${new Date(p.deployed.at).toLocaleString()}` }, `${p.deployed.version} deployed as ${p.deployed.as}`)
        : h('span', { title: `Deploys as ${p.target}.war` }, `→ ${p.target}`),
      about ? h('span', {}, about) : null,
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

  return h(
    'div',
    { class: `tm-row tm-pkg${p.fresh ? ' fresh' : ''}` },
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
    h('div', { class: 'tm-actions' }, ...actions),
  );
}

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
    body.push(h('div', { class: `tm-note${p.quiet ? '' : ' warn'}` }, h('b', {}, `${p.entry}: `), p.message, p.hint ? ` ${p.hint}` : ''));
  }
  body.push(...r.packages.map((p) => packageRow(p, canDeploy)));
  if (!r.packages.length && !r.problems.length && !r.error && r.checkedAt) {
    body.push(missing('Nothing to look for in this registry yet. Add packages in ', registriesLink('Settings › Package registries'), '.'));
  }
  return h('div', { class: 'pkg-reg' }, ...body);
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
  const el = card('packages', 'Packages', 'From the package registries in Settings.', s?.registries.length ? check : null, ...body);
  el.dataset.canDeploy = String(canDeploy);
  return el;
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
  if (f) [...next.querySelectorAll<HTMLElement>('[data-f]')].find((el) => el.dataset.f === f)?.focus({ preventScroll: true });
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
