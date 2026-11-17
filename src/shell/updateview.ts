// The update window's page (bundled into update.html by scripts/build.mjs). Everything it shows
// comes from git (commit messages, paths, diffs), so it is only ever set as text, never as HTML.
import {
  commitTag, fmt, groupByDir, hue, initials, parseDiff, reflow, statBlocks, TAG_LABEL,
  type CommitTag, type DiffAnswer, type DiffLine, type UpdateAction, type UpdateView,
} from './updatemodel';
import type { FileStat, UpdateCommit } from './gitupdate';

interface Bridge {
  view(): Promise<UpdateView>;
  diff(path: string, sha: string | null): Promise<DiffAnswer>;
  choose(id: string | null): void;
  fit(height: number): void;
}
const bridge = (window as unknown as { updateWindow: Bridge }).updateWindow;

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const main = document.getElementById('main')!;
const footer = document.getElementById('footer')!;
let cancelId: string | null = null;
let chosen = false;

function choose(id: string | null, button?: HTMLButtonElement): void {
  if (chosen) return;
  chosen = true;
  if (button) {
    button.classList.add('busy');
    if (id === 'update') button.textContent = 'Updating…';
  }
  bridge.choose(id);
}

document.getElementById('close')!.addEventListener('click', () => choose(cancelId));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    choose(cancelId);
  }
});

// ── Pieces ──────────────────────────────────────────────

function blocks(f: { added: number | null; deleted: number | null }): HTMLElement {
  return h('span', { class: 'blocks', 'aria-hidden': 'true' }, ...statBlocks(f.added, f.deleted).map((k) => h('i', { class: k })));
}

function nums(added: number | null, deleted: number | null): HTMLElement {
  if (added === null && deleted === null) return h('span', { class: 'nums' }, h('span', {}, 'binary'));
  return h('span', { class: 'nums' }, h('span', { class: 'plus' }, `+${fmt(added ?? 0)}`), h('span', { class: 'minus' }, `−${fmt(deleted ?? 0)}`));
}

function tag(t: CommitTag): HTMLElement {
  return h('span', { class: `tag ${t}` }, TAG_LABEL[t]);
}

function avatar(name: string): HTMLElement {
  const el = h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(name));
  el.style.background = `hsl(${hue(name)} 55% 50%)`;
  return el;
}

function actionButtons(actions: UpdateAction[]): HTMLElement[] {
  return actions.map((a) => {
    const b = h('button', { class: a.primary ? 'btn btn-primary' : 'btn', type: 'button' }, a.label);
    if (a.primary) b.append(h('span', { class: 'kbd' }, '↵'));
    b.addEventListener('click', () => choose(a.id, b));
    return b;
  });
}

// ── Diffs ───────────────────────────────────────────────

const MAX_LINES = 1500;

function splitChanged(line: DiffLine): Child[] {
  if (!line.changed) return [line.text];
  const [a, b] = line.changed;
  return [line.text.slice(0, a), h('mark', {}, line.text.slice(a, b)), line.text.slice(b)];
}

function diffTable(answer: DiffAnswer, onShowAll?: () => void, all = false): HTMLElement {
  if (answer.error) return h('div', { class: 'diff-msg' }, `Could not read this diff: ${answer.error}`);
  const d = parseDiff(answer.text);
  if (d.binary) return h('div', { class: 'diff-msg' }, 'Binary file: no text diff to show.');
  if (!d.hunks.length) return h('div', { class: 'diff-msg' }, d.status === 'new' ? 'New empty file.' : 'No text changes (only the file mode changed).');
  const table = h('table', { class: 'diff' });
  const body = h('tbody');
  table.append(body);
  let shown = 0;
  let total = 0;
  for (const hk of d.hunks) total += hk.lines.length + 1;
  outer: for (const hk of d.hunks) {
    const head = /^(@@[^@]*@@)/.exec(hk.header)?.[1] ?? hk.header;
    body.append(h('tr', { class: 'hunk' }, h('td', { colspan: '4' }, h('span', {}, head), hk.context ? h('span', { class: 'ctx' }, hk.context) : null)));
    shown++;
    for (const line of hk.lines) {
      if (!all && shown >= MAX_LINES) break outer;
      shown++;
      body.append(h('tr', { class: line.kind },
        h('td', { class: 'ln' }, line.old !== undefined ? String(line.old) : ''),
        h('td', { class: 'ln' }, line.new !== undefined ? String(line.new) : ''),
        h('td', { class: 'sign' }, line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''),
        h('td', { class: 'code' }, ...splitChanged(line)),
      ));
    }
  }
  const wrap = h('div', {}, table);
  if (!all && total > MAX_LINES && onShowAll) {
    wrap.append(h('div', { class: 'diff-msg' }, `Showing the first ${fmt(MAX_LINES)} of ${fmt(total)} lines.`, h('br'),
      h('button', { class: 'btn', type: 'button', onclick: onShowAll }, 'Show all')));
  } else if (answer.truncated) {
    wrap.append(h('div', { class: 'diff-msg' }, 'This diff is very large, so only its start is shown.'));
  }
  return wrap;
}

const diffCache = new Map<string, Promise<DiffAnswer>>();
function loadDiff(path: string, sha: string | null): Promise<DiffAnswer> {
  const key = `${sha ?? '*'}\n${path}`;
  let p = diffCache.get(key);
  if (!p) diffCache.set(key, (p = bridge.diff(path, sha).catch((err) => ({ text: '', truncated: false, error: String(err?.message ?? err) }))));
  return p;
}

/** Fills `into` with the diff once it arrives (a loading bar until then). */
function showDiff(into: HTMLElement, path: string, sha: string | null): void {
  into.replaceChildren(h('div', { class: 'diff-msg' }, h('span', { class: 'loading' })));
  void loadDiff(path, sha).then((answer) => {
    const render = (all: boolean) => into.replaceChildren(diffTable(answer, () => render(true), all));
    render(false);
  });
}

// ── Available ───────────────────────────────────────────

function pathLabel(path: string): HTMLElement {
  const cut = path.lastIndexOf('/');
  return h('span', { class: 'path', title: path }, h('bdi', {}, cut >= 0 ? h('span', { class: 'dir' }, path.slice(0, cut + 1)) : null, path.slice(cut + 1)));
}

function commitCard(c: UpdateCommit, i: number): HTMLElement {
  const t = commitTag(c.subject);
  const added = c.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = c.files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  const card = h('article', { class: 'commit' });
  card.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
  const head = h('button', { class: 'commit-head', type: 'button', 'aria-expanded': 'false' },
    tag(t),
    h('div', { class: 'commit-main' },
      h('div', { class: 'subject' }, c.subject),
      h('div', { class: 'meta' },
        h('span', { class: 'who' }, avatar(c.author), c.author),
        h('span', { title: c.date ? new Date(c.date).toLocaleString() : '' }, c.when),
        h('span', { class: 'sha' }, c.sha),
        h('span', {}, `${c.files.length} file${c.files.length === 1 ? '' : 's'}`),
      ),
    ),
    c.files.length ? h('div', { class: 'delta' }, nums(added, deleted), blocks({ added, deleted })) : null,
    h('span', { class: 'chev', 'aria-hidden': 'true' }, '▶'),
  );
  const body = h('div', { class: 'commit-body' });
  let built = false;
  head.addEventListener('click', () => {
    const open = card.classList.toggle('open');
    head.setAttribute('aria-expanded', String(open));
    if (open && !built) {
      built = true;
      if (c.body) {
        const msg = h('div', { class: 'message' });
        for (const b of reflow(c.body)) {
          if (b.kind === 'p') msg.append(h('p', {}, b.text));
          else if (b.kind === 'pre') msg.append(h('pre', {}, b.text));
          else msg.append(h('ul', {}, ...b.items.map((t) => h('li', {}, t))));
        }
        body.append(msg);
      }
      const list = h('ul', { class: 'filelist' });
      for (const f of c.files) {
        const holder = h('div', { class: 'inline-diff' });
        holder.hidden = true;
        const btn = h('button', { type: 'button', 'aria-expanded': 'false', title: 'Show the diff' }, pathLabel(f.path), nums(f.added, f.deleted), blocks(f));
        btn.addEventListener('click', () => {
          const show = holder.hidden;
          holder.hidden = !show;
          btn.setAttribute('aria-expanded', String(show));
          if (show && !holder.firstChild) showDiff(holder, f.path, c.sha);
        });
        list.append(h('li', {}, btn, holder));
      }
      body.append(list);
    }
  });
  card.append(head, body);
  return card;
}

function simpleCommitCard(c: { sha: string; subject: string; author: string; when: string }, i: number): HTMLElement {
  return commitCard({ ...c, body: '', date: '', files: [] }, i);
}

function filesPane(files: FileStat[]): HTMLElement {
  const pane = h('div', { class: 'pane', id: 'pane-files', role: 'tabpanel' });
  const list = h('div', { class: 'files', role: 'listbox', 'aria-label': 'Files changed' });
  const vpath = h('div', { class: 'vpath' });
  const vbadge = h('span', {});
  const vnums = h('span', {});
  const vbody = h('div', { class: 'viewer-body' });
  const viewer = h('div', { class: 'viewer' }, h('div', { class: 'viewer-head' }, vpath, vbadge, vnums), vbody);
  const buttons: HTMLButtonElement[] = [];
  let current = -1;
  const select = (i: number) => {
    if (i < 0 || i >= buttons.length || i === current) return;
    buttons[current]?.setAttribute('aria-selected', 'false');
    current = i;
    const b = buttons[i];
    b.setAttribute('aria-selected', 'true');
    b.scrollIntoView({ block: 'nearest' });
    const f = files.find((x) => x.path === b.dataset.path)!;
    vpath.textContent = f.path;
    vpath.title = f.path;
    vnums.replaceChildren(nums(f.added, f.deleted));
    vbadge.className = '';
    vbadge.textContent = '';
    showDiff(vbody, f.path, null);
    void loadDiff(f.path, null).then((a) => {
      if (current !== i) return;
      const status = parseDiff(a.text).status;
      if (status) {
        vbadge.className = `badge ${status}`;
        vbadge.textContent = status === 'new' ? 'NEW' : 'DELETED';
      }
    });
  };
  for (const g of groupByDir(files)) {
    if (g.dir) list.append(h('div', { class: 'group-name', title: g.dir }, `${g.dir}/`));
    for (const f of g.files) {
      const i = buttons.length;
      const b = h('button', { class: 'file', type: 'button', role: 'option', 'aria-selected': 'false', 'data-path': f.path, title: f.path },
        h('span', { class: 'fname' }, f.name), nums(f.added, f.deleted));
      b.addEventListener('click', () => select(i));
      buttons.push(b);
      list.append(b);
    }
  }
  list.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      select(current + (e.key === 'ArrowDown' ? 1 : -1));
      buttons[current]?.focus();
    }
  });
  pane.append(list, viewer);
  (pane as HTMLElement & { activate?: () => void }).activate = () => select(current < 0 ? 0 : current);
  return pane;
}

function renderAvailable(v: Extract<UpdateView, { mode: 'available' }>): void {
  const d = v.details;
  const commits = d ? d.commits : v.commits;
  const n = `${fmt(v.behind)} new commit${v.behind === 1 ? '' : 's'}`;
  const tags = new Map<CommitTag, number>();
  for (const c of commits) tags.set(commitTag(c.subject), (tags.get(commitTag(c.subject)) ?? 0) + 1);

  const stats = h('div', { class: 'stats' },
    h('span', { class: 'chip sha', title: `${v.head} → ${v.target}` }, v.head.slice(0, 7), h('span', { class: 'arrow' }, '→'), h('b', {}, v.target.slice(0, 7))),
    d ? h('span', { class: 'chip' }, `${fmt(d.files.length)} file${d.files.length === 1 ? '' : 's'}`) : null,
    d ? h('span', { class: 'chip' }, h('span', { class: 'plus' }, `+${fmt(d.added)}`), h('span', { class: 'minus' }, `−${fmt(d.deleted)}`)) : null,
  );
  const hero = h('section', { class: 'hero' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
    h('div', { class: 'hero-text' },
      h('div', { class: 'eyebrow' }, v.blocked ? 'Update available' : 'Update ready'),
      h('h1', {}, v.blocked ? 'There is a newer Debug Hub' : 'A new version of Debug Hub is here'),
      h('p', {}, `${n} on ${v.source}.`),
      stats,
    ),
  );

  const banners = h('div', { class: 'banners' });
  if (v.blocked) {
    banners.append(h('div', { class: 'banner warn' }, h('span', { class: 'ic' }, '!'),
      h('div', {}, h('b', {}, 'It cannot be updated automatically. '), v.blocked, ' Update by hand with ', h('code', {}, 'git pull'), ', then ', h('code', {}, 'npm run app'), '.')));
  }
  if (d?.dependencies && !v.blocked) {
    banners.append(h('div', { class: 'banner info' }, h('span', { class: 'ic' }, 'i'),
      h('div', {}, h('b', {}, 'Dependencies changed. '), 'The update runs ', h('code', {}, 'npm install'), ', so it takes a little longer.')));
  }
  if (v.fetchNote) banners.append(h('div', { class: 'banner warn' }, h('span', { class: 'ic' }, '!'), h('div', {}, v.fetchNote)));

  // Tabs
  const summary = h('span', { class: 'summary' });
  for (const t of ['new', 'fix', 'improved', 'docs', 'tests'] as CommitTag[]) {
    const c = tags.get(t);
    if (c) summary.append(h('span', { class: `tag ${t}`, title: `${c} ${TAG_LABEL[t].toLowerCase()}` }, `${c} ${TAG_LABEL[t]}`));
  }
  const commitsPane = h('div', { class: 'pane on', id: 'pane-commits', role: 'tabpanel' });
  const list = h('div', { class: 'commits' });
  commits.forEach((c, i) => list.append('files' in c ? commitCard(c as UpdateCommit, i) : simpleCommitCard(c, i)));
  if (v.behind > commits.length) list.append(h('div', { class: 'empty' }, `…and ${fmt(v.behind - commits.length)} older commit${v.behind - commits.length === 1 ? '' : 's'}.`));
  if (!commits.length) list.append(h('div', { class: 'empty' }, 'No commit details available.'));
  commitsPane.append(list);
  const panes: HTMLElement[] = [commitsPane];
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const tabButtons: HTMLButtonElement[] = [];
  const addTab = (label: string, count: number, pane: HTMLElement) => {
    const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(!tabButtons.length) }, label, h('span', { class: 'count' }, fmt(count)));
    b.addEventListener('click', () => {
      tabButtons.forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      panes.forEach((p) => p.classList.toggle('on', p === pane));
      (pane as HTMLElement & { activate?: () => void }).activate?.();
    });
    tabButtons.push(b);
    tabs.append(b);
  };
  addTab('What’s new', v.behind, commitsPane);
  if (d && d.files.length) {
    const fp = filesPane(d.files);
    panes.push(fp);
    addTab('Files changed', d.files.length, fp);
  }
  tabs.append(summary);
  main.replaceChildren(hero, banners, tabs, ...panes);

  footer.replaceChildren(
    h('div', { class: 'note' }, v.blocked
      ? 'Debug Hub keeps running as it is.'
      : h('span', {}, 'Debug Hub quits, fast-forwards to ', h('code', {}, v.source), d?.dependencies ? ', runs npm install' : '', ' and starts again with ', h('code', {}, 'npm run app'), '.')),
    ...actionButtons(v.actions),
  );
  (footer.querySelector('.btn-primary') as HTMLButtonElement | null)?.focus();
}

// ── Messages ────────────────────────────────────────────

function renderMessage(v: Extract<UpdateView, { mode: 'message' }>): void {
  document.body.classList.add('message');
  const icon = v.tone === 'ok' ? '✓' : '!';
  main.replaceChildren(h('section', { class: 'msg' },
    h('div', { class: `icon ${v.tone}`, 'aria-hidden': 'true' }, icon),
    h('div', {},
      h('h1', {}, v.title),
      h('p', {}, v.detail),
      v.head ? h('span', { class: 'chip sha' }, h('b', {}, v.head.slice(0, 7))) : null,
    ),
  ));
  footer.replaceChildren(h('div', { class: 'note' }), ...actionButtons(v.actions));
  (footer.querySelector('.btn-primary') as HTMLButtonElement | null)?.focus();
  // Grow the window to fit the text.
  requestAnimationFrame(() => bridge.fit(document.querySelector('.titlebar')!.getBoundingClientRect().height + main.firstElementChild!.getBoundingClientRect().height + footer.getBoundingClientRect().height));
}

void bridge.view().then((v) => {
  cancelId = v.cancel;
  if (v.mode === 'available') renderAvailable(v);
  else renderMessage(v);
});
