import { NOTIFY_MODES, REGISTRY_DEFAULTS, REGISTRY_TYPES, type NotifyMode, type RegistryAuth, type RegistryConfig, type RegistryPackage, type RegistryType, type TestResult } from '../shared/registry';
import { blankPackage, REGISTRY_FORMS, type EntryField } from '../shared/registry-forms';
import { h, type Child } from './dom';
import { api } from './tomcat';

/**
 * Settings › Package registries: the registries Debug Hub checks for WARs, each with its
 * address, login and the packages to look for, and a Test connection that says what it finds.
 * The fields a package has come from REGISTRY_FORMS, by the kind of registry. Like the rest of
 * the settings screen it edits the draft; errors come back keyed registries.<i>… and land beside
 * the input they belong to.
 */

/** What the settings screen lends this section (src/ui/settings.ts). */
export interface SettingsKit {
  get: (path: string) => any;
  change: (path: string, value: unknown) => void;
  clearError: (path: string) => void;
  /** Where the screen shows an error for a setting, by its path. */
  slots: Map<string, HTMLElement>;
  field: (path: string | null, label: string, control: HTMLElement, help?: Child, opts?: { wide?: boolean }) => HTMLElement;
}

const PATH = 'registries';

const NOTIFY_OPTIONS: Record<NotifyMode, string> = {
  all: 'Every new version',
  releases: 'New releases only, not snapshots',
  deployed: 'Only for packages deployed in Tomcat',
  off: 'Off: only marked New on the Tomcat page',
};

const blankRegistry = (): RegistryConfig => ({
  name: '',
  type: 'maven',
  url: '',
  auth: { type: 'none' },
  headers: [],
  insecureTls: false,
  caFile: '',
  timeoutMs: REGISTRY_DEFAULTS.timeoutMs,
  checkMinutes: REGISTRY_DEFAULTS.checkMinutes,
  notify: REGISTRY_DEFAULTS.notify,
  packages: [],
});

/** A package's fields carried over to another kind of registry, where they mean the same. */
function convert(p: RegistryPackage, to: RegistryType): RegistryPackage {
  const next = blankPackage(to) as unknown as Record<string, string>;
  const old = p as unknown as Record<string, string>;
  for (const key of Object.keys(next)) if (old[key]) next[key] = old[key];
  if (to === 'nexus3') {
    next.group ||= old.groupId ?? '';
    next.name ||= old.artifactId ?? '';
  } else if (to === 'maven') {
    next.groupId ||= old.group ?? '';
    next.artifactId ||= old.name ?? '';
  } else next.name ||= old.artifactId ?? '';
  return next as unknown as RegistryPackage;
}

export function registryFields(kit: SettingsKit): HTMLElement[] {
  const rowsEl = h('div', { class: 'list-rows' });
  const add = h('button', { type: 'button', class: 'btn btn-ghost list-add' }, '+ Add registry');
  const values = (): RegistryConfig[] => structuredClone(kit.get(PATH) ?? []);
  /** Which registries have "More options" open, so a redraw does not close them. */
  const open = new Set<number>();

  /** Changes one registry in the draft. Typing does not redraw; what changes the form's shape does. */
  const patch = (i: number, fn: (r: RegistryConfig) => void, errorPath?: string) => {
    const arr = values();
    if (!arr[i]) return;
    fn(arr[i]);
    kit.change(PATH, arr);
    if (errorPath) kit.clearError(errorPath);
    kit.clearError(`${PATH}.${i}`);
  };

  /** A text input bound to one value of a registry, with its own error slot. */
  const input = (
    i: number,
    path: string,
    value: string,
    set: (r: RegistryConfig, v: string) => void,
    opts: { label: string; placeholder?: string; mono?: boolean; secret?: boolean; number?: boolean },
  ): HTMLElement => {
    const at = `${PATH}.${i}.${path}`;
    const el = h('input', {
      type: opts.number ? 'number' : 'text',
      class: `input${opts.mono ? ' mono' : ''}${opts.number ? ' num' : ''}`,
      placeholder: opts.placeholder,
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': opts.label,
    }) as HTMLInputElement;
    el.value = value;
    // A reference to an environment variable is not a secret, and is easier to get right when it can be read.
    const mask = () => (el.type = opts.secret && el.value && !/\$\{env:/.test(el.value) ? 'password' : opts.number ? 'number' : 'text');
    mask();
    el.addEventListener('input', () => {
      mask();
      patch(i, (r) => set(r, el.value), at);
    });
    const err = h('div', { class: 'field-error', role: 'alert' });
    kit.slots.set(at, err);
    return h('div', { class: 'list-row' }, el, err);
  };

  const row = (label: string, control: Child, help?: Child): HTMLElement =>
    h('div', { class: 'reg-line' }, h('span', { class: 'reg-label' }, label), h('div', { class: 'reg-control' }, control, help ? h('div', { class: 'field-help' }, help) : null));

  /** Opens a "More options" when an error lands inside it, so it is not hidden. */
  const revealErrors = (details: HTMLDetailsElement) => {
    new MutationObserver(() => {
      if ([...details.querySelectorAll('.field-error')].some((e) => e.textContent)) details.open = true;
    }).observe(details, { subtree: true, childList: true, characterData: true });
  };

  /** One field of a package entry. `where` tells screen readers which entry: "package 2 of registry 1". */
  const entryField = (i: number, j: number, f: EntryField, entry: RegistryPackage, where: string): HTMLElement => {
    const value = String((entry as unknown as Record<string, unknown>)[f.key] ?? '');
    const set = (r: RegistryConfig, v: string) => {
      (r.packages[j] as unknown as Record<string, string>)[f.key] = v;
    };
    let control: HTMLElement;
    if (f.key === 'versions') {
      const sel = h(
        'select',
        { class: 'input', 'aria-label': `${f.label} of ${where}` },
        h('option', { value: 'all' }, 'Releases and snapshots'),
        h('option', { value: 'releases' }, 'Releases only'),
        h('option', { value: 'snapshots' }, 'Snapshots only'),
      ) as HTMLSelectElement;
      sel.value = value || 'all';
      sel.addEventListener('change', () => patch(i, (r) => set(r, sel.value), `${PATH}.${i}.packages.${j}.versions`));
      control = h('div', { class: 'list-row' }, sel);
    } else {
      control = input(i, `packages.${j}.${f.key}`, value, set, { label: `${f.label} of ${where}`, placeholder: f.placeholder, mono: true });
    }
    // In the row of main fields there is no room for the help: it is the tooltip there.
    return h('label', { class: `reg-entry-field${f.wide ? ' wide' : ''}`, title: f.help }, h('span', {}, f.label), control, f.more && f.help ? h('span', { class: 'field-help' }, f.help) : null);
  };

  const entries = (i: number, reg: RegistryConfig): HTMLElement => {
    const form = REGISTRY_FORMS[reg.type];
    const main = form.fields.filter((f) => !f.more);
    const more = form.fields.filter((f) => f.more);
    const list = reg.packages.map((entry, j) => {
      const where = `${form.entry.noun.toLowerCase()} ${j + 1} of registry ${i + 1}`;
      const remove = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', title: 'Remove', 'aria-label': `Remove ${where}` }, '×');
      remove.addEventListener('click', () => {
        patch(i, (r) => void r.packages.splice(j, 1));
        render();
      });
      const details = h('details', { class: 'reg-more' }, h('summary', {}, 'More options'), h('div', { class: 'reg-entry-grid' }, ...more.map((f) => entryField(i, j, f, entry, where)))) as HTMLDetailsElement;
      // Open when something in it is set, so a setting in force is never out of sight.
      details.open = more.some((f) => {
        const v = String((entry as unknown as Record<string, unknown>)[f.key] ?? '');
        return v !== '' && !(f.key === 'versions' && v === 'all') && !(f.key === 'extension' && v === REGISTRY_DEFAULTS.extension);
      });
      revealErrors(details);
      return h('div', { class: 'reg-entry' }, h('div', { class: 'reg-entry-main' }, ...main.map((f) => entryField(i, j, f, entry, where)), remove), more.length ? details : null);
    });
    const addEntry = h('button', { type: 'button', class: 'btn btn-ghost list-add' }, `+ ${form.entry.add}`);
    addEntry.addEventListener('click', () => {
      patch(i, (r) => void r.packages.push(blankPackage(r.type)));
      render();
      rowsEl.querySelectorAll<HTMLElement>('.reg-card')[i]?.querySelector<HTMLInputElement>('.reg-entry:last-of-type input')?.focus();
    });
    return h('div', { class: 'list' }, h('div', { class: 'list-rows' }, ...(list.length ? list : [h('div', { class: 'list-empty' }, form.entry.empty)])), addEntry);
  };

  const headers = (i: number, reg: RegistryConfig): HTMLElement => {
    const list = reg.headers.map((hd, j) => {
      const remove = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', title: 'Remove', 'aria-label': `Remove header ${j + 1}` }, '×');
      remove.addEventListener('click', () => {
        patch(i, (r) => void r.headers.splice(j, 1));
        render();
      });
      return h(
        'div',
        { class: 'pair-inputs' },
        h('div', { style: 'flex: 0 0 200px' }, input(i, `headers.${j}.name`, hd.name, (r, v) => (r.headers[j].name = v), { label: `Name of header ${j + 1}`, placeholder: 'X-JFrog-Art-Api', mono: true })),
        h('div', { style: 'flex: 1; min-width: 0' }, input(i, `headers.${j}.value`, hd.value, (r, v) => (r.headers[j].value = v), { label: `Value of header ${j + 1}`, placeholder: '${env:ARTIFACTORY_KEY}', mono: true, secret: true })),
        remove,
      );
    });
    const addHeader = h('button', { type: 'button', class: 'btn btn-ghost list-add' }, '+ Add header');
    addHeader.addEventListener('click', () => {
      patch(i, (r) => void r.headers.push({ name: '', value: '' }));
      open.add(i);
      render();
    });
    return h('div', { class: 'list' }, h('div', { class: 'list-rows' }, ...list), addHeader);
  };

  const login = (i: number, reg: RegistryConfig): HTMLElement => {
    const sel = h(
      'select',
      { class: 'input', 'aria-label': `Login for registry ${i + 1}` },
      h('option', { value: 'none' }, 'None (anonymous)'),
      h('option', { value: 'basic' }, 'User name and password'),
      h('option', { value: 'bearer' }, 'Token (Bearer)'),
    ) as HTMLSelectElement;
    sel.value = reg.auth.type;
    sel.addEventListener('change', () => {
      patch(i, (r) => (r.auth = { ...r.auth, type: sel.value as RegistryAuth['type'] }));
      render();
    });
    const parts: Child[] = [sel];
    if (reg.auth.type === 'basic') {
      parts.push(
        h(
          'div',
          { class: 'reg-pair' },
          input(i, 'auth.username', reg.auth.username ?? '', (r, v) => (r.auth.username = v), { label: `User name for registry ${i + 1}`, placeholder: 'User name', mono: true }),
          input(i, 'auth.password', reg.auth.password ?? '', (r, v) => (r.auth.password = v), { label: `Password for registry ${i + 1}`, placeholder: 'Password, or ${env:NEXUS_PASSWORD}', mono: true, secret: true }),
        ),
      );
    } else if (reg.auth.type === 'bearer') {
      parts.push(input(i, 'auth.token', reg.auth.token ?? '', (r, v) => (r.auth.token = v), { label: `Token for registry ${i + 1}`, placeholder: 'Token, or ${env:REGISTRY_TOKEN}', mono: true, secret: true }));
    }
    return h('div', { class: 'reg-login' }, ...parts);
  };

  const tester = (i: number): HTMLElement => {
    const btn = h('button', { type: 'button', class: 'btn' }, 'Test connection') as HTMLButtonElement;
    const out = h('div', { class: 'list-note reg-test', 'aria-live': 'polite' });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Testing…';
      out.replaceChildren(h('span', { class: 'pm muted' }, 'Asking the registry…'));
      try {
        const result = await api<TestResult>('/api/registry/test', { registry: values()[i] });
        out.replaceChildren(
          ...result.lines.map((l) => h('span', { class: `pm ${l.ok ? 'ok' : 'warn'}` }, l.entry ? h('b', {}, `${l.entry}: `) : null, l.message, l.hint ? ` ${l.hint}` : '')),
        );
      } catch (err) {
        out.replaceChildren(h('span', { class: 'pm warn' }, `Could not test: ${(err as Error).message}`));
      } finally {
        btn.disabled = false;
        btn.textContent = 'Test connection';
      }
    });
    return h('div', {}, h('div', { class: 'input-row' }, btn, h('span', { class: 'muted reg-test-note' }, 'Tries what is entered here, saved or not.')), out);
  };

  const cardFor = (reg: RegistryConfig, i: number): HTMLElement => {
    const form = REGISTRY_FORMS[reg.type];
    const type = h('select', { class: 'input', 'aria-label': `Kind of registry ${i + 1}` }, ...REGISTRY_TYPES.map((t) => h('option', { value: t }, REGISTRY_FORMS[t].label))) as HTMLSelectElement;
    type.value = reg.type;
    type.addEventListener('change', () => {
      const to = type.value as RegistryType;
      patch(i, (r) => {
        r.packages = r.packages.map((p) => convert(p, to));
        r.type = to;
      });
      render();
    });
    const remove = h('button', { type: 'button', class: 'btn btn-icon btn-ghost', title: 'Remove this registry', 'aria-label': `Remove registry ${i + 1}` }, '×');
    remove.addEventListener('click', () => {
      const arr = values();
      arr.splice(i, 1);
      open.clear();
      kit.change(PATH, arr);
      render();
    });

    const notify = h(
      'select',
      { class: 'input', 'aria-label': `Notifications for registry ${i + 1}` },
      ...NOTIFY_MODES.map((m) => h('option', { value: m }, NOTIFY_OPTIONS[m])),
    ) as HTMLSelectElement;
    notify.value = reg.notify ?? REGISTRY_DEFAULTS.notify;
    notify.addEventListener('change', () => patch(i, (r) => (r.notify = notify.value as NotifyMode)));
    const insecure = h('input', { type: 'checkbox' }) as HTMLInputElement;
    insecure.checked = reg.insecureTls === true;
    insecure.addEventListener('change', () => patch(i, (r) => (r.insecureTls = insecure.checked)));
    const numeric = (path: 'timeoutMs' | 'checkMinutes', scale: number, unit: string, what: string, label = `${what} for registry ${i + 1}`) =>
      h(
        'div',
        { class: 'input-unit' },
        input(i, path, String(+(Number(reg[path] ?? 0) / scale).toFixed(2)), (r, v) => ((r as any)[path] = v.trim() === '' ? '' : Math.round(Number(v) * scale)), { label, number: true }),
        h('span', {}, unit),
      );
    const more = h(
      'details',
      { class: 'reg-more' },
      h('summary', {}, 'More options'),
      h(
        'div',
        { class: 'reg-lines' },
        row('Extra headers', headers(i, reg), h('span', {}, 'Sent with every request to this registry, e.g. ', h('code', {}, 'X-JFrog-Art-Api'), ' or ', h('code', {}, 'PRIVATE-TOKEN'), ' where a registry wants its own header instead of a login.')),
        row('Check every', numeric('checkMinutes', 1, 'minutes', 'Check every'), '0: only when you press Check now on the Tomcat page.'),
        row('Timeout', numeric('timeoutMs', 1000, 'seconds', 'Timeout'), 'How long to wait for the registry to answer, and for a download to move on.'),
        row(
          'Certificate file',
          input(i, 'caFile', reg.caFile ?? '', (r, v) => (r.caFile = v), { label: `Certificate file for registry ${i + 1}`, placeholder: 'C:/certs/company-root-ca.pem', mono: true }),
          'For a registry whose https certificate is signed by your company’s own certificate authority: that authority’s certificate as a PEM file.',
        ),
        row('', h('label', { class: 'check' }, insecure, ' Allow untrusted certificates'), 'Accepts any https certificate from this registry. Prefer the certificate file; leave off for anything outside your network.'),
      ),
    ) as HTMLDetailsElement;
    more.open = open.has(i) || reg.headers.length > 0 || !!reg.caFile || reg.insecureTls === true || reg.timeoutMs !== REGISTRY_DEFAULTS.timeoutMs || reg.checkMinutes !== REGISTRY_DEFAULTS.checkMinutes;
    more.addEventListener('toggle', () => (more.open ? open.add(i) : open.delete(i)));
    revealErrors(more);

    const rowErr = h('div', { class: 'field-error', role: 'alert' });
    kit.slots.set(`${PATH}.${i}`, rowErr);
    return h(
      'div',
      { class: 'sc-row reg-card' },
      h(
        'div',
        { class: 'reg-head' },
        h('span', { class: 'sc-num' }, `${i + 1}`),
        input(i, 'name', reg.name, (r, v) => (r.name = v), { label: `Name of registry ${i + 1}`, placeholder: 'Name, e.g. Nexus' }),
        h('div', { class: 'list-row' }, type),
        remove,
      ),
      h('p', { class: 'reg-about' }, form.about),
      h(
        'div',
        { class: 'reg-lines' },
        row('URL', input(i, 'url', reg.url, (r, v) => (r.url = v), { label: `URL of registry ${i + 1}`, placeholder: form.url.placeholder, mono: true }), form.url.help),
        row(
          'Login',
          login(i, reg),
          reg.auth.type === 'none'
            ? null
            : h('span', {}, 'Stored in the settings file as plain text. To keep it out of the file, write ', h('code', {}, '${env:NAME}'), ': Debug Hub then reads the environment variable NAME when it starts.'),
        ),
        row(form.entry.plural, entries(i, reg)),
        row(
          'Notify',
          h('div', { class: 'list-row' }, notify),
          'Which new versions show a notice on every screen and a desktop notification. Any package can be set otherwise with its bell on the Tomcat page; the timeline notes every new version either way.',
        ),
      ),
      more,
      h('div', { class: 'reg-lines' }, row('Test', tester(i))),
      rowErr,
    );
  };

  function render(focusLast = false): void {
    for (const key of [...kit.slots.keys()]) if (key.startsWith(`${PATH}.`)) kit.slots.delete(key);
    const vals = values();
    rowsEl.replaceChildren(
      ...(vals.length
        ? vals.map((r, i) => cardFor({ ...blankRegistry(), ...r, auth: r.auth?.type ? r.auth : { type: 'none' }, headers: r.headers ?? [], packages: r.packages ?? [] }, i))
        : [h('div', { class: 'list-empty' }, 'No registries: WARs come from the build folders under Tomcat server only.')]),
    );
    if (focusLast) rowsEl.querySelector<HTMLInputElement>('.reg-card:last-child input')?.focus();
  }
  add.addEventListener('click', () => {
    kit.change(PATH, [...values(), blankRegistry()]);
    render(true);
  });
  render();

  return [
    kit.field(
      PATH,
      'Registries',
      h('div', { class: 'list' }, rowsEl, add),
      h(
        'span',
        {},
        'Each registry is checked on its own timer. A version that was not there before is announced like a freshly built WAR, and the Tomcat page’s Packages list downloads and deploys any version. Downloads are kept in ',
        h('code', {}, 'registry-cache'),
        ' next to the settings file.',
      ),
      { wide: true },
    ),
  ];
}
