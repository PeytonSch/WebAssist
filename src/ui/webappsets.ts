import type { ApplySetResult, TomcatState, WebappSet, WebappSetInfo } from '../shared/tomcat';
import { confirmDialog } from './confirm';
import { h, type Child } from './dom';
import { act, api, busyNote, busyWith, button, foldCard, isManagerApp, missing, refreshTomcat, settingsLink, tomcatState } from './tomcat';

/**
 * Webapp sets on the Tomcat page: named lists of the webapps to have deployed for a task.
 * Applying one moves the webapps that are not in it to the disabled folder and brings those in it
 * back, so switching tasks is one click. The hub keeps the sets (webapp-sets.json next to the
 * settings) and works out, with every state it sends, what applying each would move.
 */

const busyKey = (name: string) => `set:${name}`;

/** Webapps a set never disables: the Manager this page uses, and Debug Hub itself. */
function keptNames(s: TomcatState): Set<string> {
  return new Set(s.webapps.filter((a) => isManagerApp(s, a) || a.self).map((a) => a.name));
}

function chips(names: string[], cls = ''): HTMLElement {
  return h('span', { class: `set-chips ${cls}` }, ...names.map((n) => h('span', { class: 'set-chip' }, n)));
}

function planText(set: WebappSetInfo): string {
  const p = set.plan;
  if (set.current) return p.missing.length ? `Deployed now, but ${p.missing.length} not found` : 'Deployed now';
  return [
    p.disable.length ? `disables ${p.disable.length}` : '',
    p.enable.length ? `enables ${p.enable.length}` : '',
    p.missing.length ? `${p.missing.length} not found` : '',
  ]
    .filter(Boolean)
    .join(' · ')
    .replace(/^./, (c) => c.toUpperCase());
}

function setRow(s: TomcatState, set: WebappSetInfo): HTMLElement {
  const key = busyKey(set.name);
  const busy = !!s.sets.applying || busyWith('set:');
  const noFolders = !s.settings.webappsDir || !s.settings.disabledDir;
  const apply = button(set.current ? 'Applied' : 'Apply…', () => void applySet(set), {
    primary: !set.current,
    disabled: busy || set.current || noFolders,
    title: noFolders ? 'Set the webapps folder and a folder for disabled webapps in Settings › Tomcat' : set.current ? 'This set is what is deployed now' : planText(set),
  });
  const edit = button('Edit…', () => void openSetEditor(set), { disabled: busy });
  const del = button('Delete…', () => void deleteSet(set), { danger: true, disabled: busy });
  const missingNote = set.plan.missing.length ? h('span', { class: 'set-missing', title: 'In the set, but neither deployed nor disabled: deploy them to have them' }, `Not found: ${set.plan.missing.join(', ')}`) : null;
  return h(
    'div',
    { class: `tm-row tm-set${set.current ? ' current' : ''}` },
    h(
      'div',
      { class: 'tm-name' },
      h('b', {}, set.name),
      set.current ? h('span', { class: 'tm-tag set-current', title: 'What is deployed now is this set' }, 'Current') : null,
    ),
    h('div', { class: 'set-apps', title: set.webapps.join(', ') }, set.webapps.length ? chips(set.webapps) : h('span', { class: 'muted' }, 'No webapps: applying disables them all'), missingNote),
    busyNote(key) ?? h('span', { class: `muted set-plan${set.current ? ' ok' : ''}` }, planText(set)),
    h('div', { class: 'tm-actions' }, apply, edit, del),
  );
}

/** The Webapp sets card, above the webapps. */
export function setsCard(s: TomcatState): HTMLElement {
  const sets = s.sets;
  const body: Child[] = [];
  if (sets.error) body.push(h('div', { class: 'tm-note warn' }, sets.error));
  if (!s.settings.disabledDir) {
    body.push(h('div', { class: 'tm-note' }, 'Applying a set moves webapps to the folder for disabled webapps: choose one in ', settingsLink(), '.'));
  }
  if (!sets.list.length) {
    body.push(missing('No sets yet. Save the webapps you need for a task as a set, and switch between tasks by applying another set: what is not in it is disabled, what is in it is enabled.'));
  }
  body.push(...sets.list.map((set) => setRow(s, set)));
  const add = button('New set…', () => void openSetEditor(null), { disabled: !!sets.error && !sets.list.length && /settings folder/.test(sets.error), title: 'Save the webapps deployed now (or others) as a set' });
  return foldCard('sets', 'Webapp sets', sets.list.length || null, 'The webapps for a task, deployed in one go.', add, ...body);
}

// ── Applying ────────────────────────────────────────────

function planBlock(title: string, names: string[], help: string, cls = ''): HTMLElement | null {
  if (!names.length) return null;
  return h('div', { class: `set-plan-block ${cls}` }, h('div', { class: 'set-plan-title' }, `${title} (${names.length})`, h('span', { class: 'muted' }, ` ${help}`)), chips(names));
}

async function applySet(set: WebappSetInfo): Promise<void> {
  const p = set.plan;
  const running = new Set((tomcatState()?.webapps ?? []).filter((a) => a.state === 'running').map((a) => a.name));
  const stopping = p.disable.filter((n) => running.has(n)).length;
  const text = h(
    'div',
    { class: 'set-plan-list' },
    planBlock('Disable', p.disable, 'moved to the disabled folder', 'out'),
    planBlock('Enable', p.enable, 'moved back into webapps', 'in'),
    planBlock('Not found', p.missing, 'neither deployed nor disabled: deploy them to have them', 'missing'),
    planBlock('Kept', p.kept, 'never disabled by a set (the Tomcat Manager, Debug Hub)', 'kept'),
  );
  const ok = await confirmDialog({
    title: `Apply ${set.name}?`,
    text,
    ok: 'Apply set',
    note: [stopping ? `${stopping} of them ${stopping === 1 ? 'is' : 'are'} running and will be stopped first.` : '', 'Tomcat undeploys and deploys them within a few seconds.'].filter(Boolean).join(' '),
  });
  if (!ok) return;
  await act(
    busyKey(set.name),
    async () => {
      // Show the webapps moving while it works.
      const timer = window.setInterval(() => void refreshTomcat(), 1000);
      try {
        const r = await api<ApplySetResult>('/api/tomcat/sets/apply', { name: set.name });
        if (r.failed.length) throw new Error(`${r.message} ${r.failed.map((f) => `${f.name}: ${f.error}`).join(' ')}`);
        return r.message;
      } finally {
        clearInterval(timer);
      }
    },
    'Applying…',
  );
}

async function deleteSet(set: WebappSet): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete this set?',
    subject: h('div', {}, h('b', {}, set.name), h('div', { class: 'muted' }, set.webapps.join(', ') || 'No webapps')),
    text: 'Only the set is deleted. Its webapps stay where they are.',
    ok: 'Delete set',
    danger: true,
  });
  if (!ok) return;
  await act(busyKey(set.name), async () => {
    await api('/api/tomcat/sets/delete', { name: set.name });
    return `Deleted the set ${set.name}.`;
  }, 'Deleting…');
}

// ── Editing ─────────────────────────────────────────────

type Where = 'deployed' | 'disabled' | 'missing';
const WHERE_LABEL: Record<Where, string> = { deployed: 'deployed', disabled: 'disabled', missing: 'not found' };

/** Creates a set (from what is deployed now) or changes one: its name and which webapps are in it. */
async function openSetEditor(set: WebappSet | null): Promise<void> {
  document.querySelector('dialog.set-dialog')?.remove();
  await refreshTomcat();
  const s = tomcatState();
  if (!s) return;
  const kept = keptNames(s);
  const where = new Map<string, Where>();
  for (const a of s.disabled) where.set(a.name, 'disabled');
  // Webapps Tomcat runs from elsewhere cannot be moved, so they are not offered.
  for (const a of s.webapps) if (!a.external) where.set(a.name, 'deployed');
  for (const n of set?.webapps ?? []) if (!where.has(n)) where.set(n, 'missing');
  const names = [...where.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  const picked = new Set(set ? set.webapps : names.filter((n) => where.get(n) === 'deployed'));

  const nameInput = h('input', { type: 'text', class: 'input', id: 'set-name', placeholder: 'e.g. Checkout bug', autocomplete: 'off', maxlength: '80' }) as HTMLInputElement;
  nameInput.value = set?.name ?? '';
  const nameError = h('div', { class: 'field-error', role: 'alert' });
  const filter = h('input', { type: 'search', class: 'input set-filter', placeholder: 'Filter', 'aria-label': 'Filter webapps', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const count = h('span', { class: 'muted set-count' });
  const list = h('div', { class: 'set-list', role: 'group', 'aria-label': 'Webapps in the set' });
  const error = h('div', { class: 'field-error', role: 'alert' });

  const boxes = new Map<string, HTMLInputElement>();
  const rows = names.map((n) => {
    const box = h('input', { type: 'checkbox', value: n }) as HTMLInputElement;
    box.checked = picked.has(n);
    box.addEventListener('change', () => {
      if (box.checked) picked.add(n);
      else picked.delete(n);
      update();
    });
    boxes.set(n, box);
    const w = where.get(n)!;
    const row = h(
      'label',
      { class: `set-item ${w}` },
      box,
      h('span', { class: 'set-item-name' }, n),
      kept.has(n) ? h('span', { class: 'tm-tag', title: 'Never disabled by a set' }, 'always kept') : null,
      h('span', { class: `set-where ${w}` }, WHERE_LABEL[w]),
    );
    row.dataset.name = n.toLowerCase();
    return row;
  });
  if (rows.length) list.append(...rows);
  else list.append(h('div', { class: 'muted set-empty' }, 'No webapps in the webapps or disabled folder.'));

  const pick = (which: (n: string) => boolean) => () => {
    for (const [n, box] of boxes) {
      box.checked = which(n);
      if (box.checked) picked.add(n);
      else picked.delete(n);
    }
    update();
  };
  const linkBtn = (text: string, title: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'link', title }, text);
    b.addEventListener('click', fn);
    return b;
  };
  const quick = h(
    'span',
    { class: 'set-quick' },
    linkBtn('Deployed now', 'Tick exactly the webapps deployed now', pick((n) => where.get(n) === 'deployed')),
    linkBtn('None', 'Untick all', pick(() => false)),
  );

  const update = () => {
    const shown = rows.filter((r) => !r.hidden).length;
    const n = picked.size;
    count.textContent = `${n} selected${shown < rows.length ? ` · ${shown} of ${rows.length} shown` : ''}`;
    error.textContent = '';
  };
  filter.addEventListener('input', () => {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) r.hidden = !terms.every((t) => r.dataset.name!.includes(t));
    update();
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filter.value) {
      e.preventDefault();
      filter.value = '';
      filter.dispatchEvent(new Event('input'));
    }
  });
  nameInput.addEventListener('input', () => (nameError.textContent = ''));
  update();

  const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, set ? 'Save' : 'Save set') as HTMLButtonElement;
  const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
  const form = h(
    'form',
    { method: 'dialog' },
    h('h2', {}, set ? `Edit ${set.name}` : 'New webapp set'),
    h('p', { class: 'muted set-intro' }, set ? 'Change its name or which webapps are in it.' : 'The webapps deployed now are ticked. Applying the set later disables what is not ticked and enables what is.'),
    h('label', { class: 'tm-deploy-label', for: 'set-name' }, 'Name'),
    nameInput,
    nameError,
    h('div', { class: 'set-list-head' }, h('span', { class: 'tm-deploy-label' }, 'Webapps'), quick, h('span', { class: 'spacer' }), filter),
    list,
    h('div', { class: 'set-foot' }, count),
    error,
    h('div', { class: 'dialog-actions' }, cancel, ok),
  );
  const dialog = h('dialog', { class: 'dialog set-dialog' }, form) as HTMLDialogElement;
  document.body.append(dialog);
  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameError.textContent = 'Give the set a name.';
      return nameInput.focus();
    }
    ok.disabled = true;
    try {
      await api('/api/tomcat/sets/save', { name, webapps: [...picked], previous: set?.name });
      dialog.close();
      await refreshTomcat();
    } catch (err) {
      const msg = (err as Error).message;
      if (/already a set|name/i.test(msg)) {
        nameError.textContent = msg;
        nameInput.focus();
      } else error.textContent = msg;
    } finally {
      ok.disabled = false;
    }
  });
  dialog.showModal();
  nameInput.focus();
  nameInput.select();
}
