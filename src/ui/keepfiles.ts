// The "Local config files" part of the deploy dialog (tomcat.ts): for each file the deploy could
// keep from the copy it replaces, how it compares with the new build's (new settings, dropped
// ones, other values) and what to do with it: keep the deployed one, use the build's, or merge
// the two in the merge view (mergeview.ts).

import type { KeyChange } from '../shared/configkeys';
import { DEPLOY_BODY_LIMIT, type KeepCompare, type KeepComparePreview, type MergedInput, type MergeFile } from '../shared/keepmerge';
import type { KeptFile, WarInfo } from '../shared/tomcat';
import { h, type Child } from './dom';
import { openMergeView, type MergeResult } from './mergeview';

/** The Tomcat page's fetch helper: GET without a body, POST with one; throws with the hub's message. */
type Api = <R = any>(path: string, body?: unknown) => Promise<R>;

type Choice = 'deployed' | 'build' | 'merged';

interface FileState {
  choice: Choice;
  /** The result applied in the merge view, with the versions it was merged from. */
  merged?: { result: MergeResult; deployedHash: string; buildHash: string };
  /** The merge view is being opened. */
  opening?: boolean;
  error?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** "a, b and c", cut short: "a, b, c and 4 more". */
function nameList(names: string[], and = 'and', max = 3): string {
  if (names.length > max + 1) return `${names.slice(0, max).join(', ')} ${and} ${names.length - max} more`;
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}` : (names[0] ?? '');
}

/** Files worth a look first: those the build has new settings for, then other differences, then the rest. */
function rank(c: KeepCompare | undefined): number {
  if (!c) return 2;
  if (c.status === 'identical') return 4;
  if (c.status === 'only-deployed') return 3;
  return c.keys?.addedCount ? 0 : 1;
}

/** "mail (2)" for a section, the path for a single setting. */
const keyNames = (keys: KeyChange[]) => keys.map((k) => (k.count > 1 ? `${k.path} (${k.count})` : k.path));

export class KeepFiles {
  /** Goes into the deploy dialog once; its content is redrawn in place. */
  readonly el = h('div', { class: 'tm-keep kf' });
  /** The webapp name the files were looked up for. */
  name: string | null = null;
  private preview: KeepComparePreview | null = null;
  private files = new Map<string, FileState>();

  constructor(private o: { api: Api; war: WarInfo; changed: () => void }) {
    this.el.hidden = true;
  }

  /** What a deploy as `name` could keep. Choices made for another name are forgotten. */
  set(name: string, preview: KeepComparePreview | null): void {
    if (name !== this.name) this.files.clear();
    this.name = name;
    this.preview = preview;
    const paths = new Set(preview?.files.map((f) => f.path));
    for (const p of [...this.files.keys()]) if (!paths.has(p)) this.files.delete(p);
    for (const f of preview?.files ?? []) {
      const st = this.files.get(f.path);
      const c = preview!.compare[f.path];
      if (!st) this.files.set(f.path, { choice: c && !c.keepable ? 'build' : 'deployed' });
      // The versions a merge was made from are gone: it would be refused at deploy time.
      else if (st.merged && (!c || !c.mergeable)) this.files.set(f.path, { choice: 'deployed' });
    }
    this.draw();
  }

  /** Whether there is anything to choose, so the dialog can stop and show it before deploying. */
  get hasChoices(): boolean {
    return !!this.preview?.files.length && !this.preview.problem;
  }

  show(visible: boolean): void {
    this.el.hidden = !visible || !this.preview || (!this.preview.files.length && !this.preview.source);
  }

  /** What goes into the deploy request. */
  choices(): { keep: string[]; merged: MergedInput[] } {
    const keep: string[] = [];
    const merged: MergedInput[] = [];
    if (!this.preview || this.preview.problem) return { keep, merged };
    for (const f of this.preview.files) {
      const st = this.files.get(f.path);
      if (st?.choice === 'deployed') keep.push(f.path);
      else if (st?.choice === 'merged' && st.merged) merged.push({ path: f.path, text: st.merged.result.text, deployedHash: st.merged.deployedHash, buildHash: st.merged.buildHash });
    }
    return { keep, merged };
  }

  /** Why the deploy request would be refused for its size, or null. */
  tooLarge(): string | null {
    const size = this.choices().merged.reduce((n, m) => n + m.text.length, 0);
    return size * 1.1 > DEPLOY_BODY_LIMIT ? 'The merged files are too large to send together. Keep or replace some of them instead.' : null;
  }

  private setAll(choice: 'deployed' | 'build'): void {
    for (const f of this.preview?.files ?? []) {
      const c = this.preview!.compare[f.path];
      const st = this.files.get(f.path)!;
      if (c?.status === 'identical' || (choice === 'deployed' && c && !c.keepable)) continue;
      st.choice = choice;
    }
    this.draw();
    this.o.changed();
  }

  private async merge(file: KeptFile): Promise<void> {
    const st = this.files.get(file.path)!;
    if (st.opening || !this.name) return;
    st.opening = true;
    st.error = undefined;
    this.draw();
    const name = this.name;
    try {
      const q = `name=${encodeURIComponent(name)}&file=${encodeURIComponent(this.o.war.file)}&path=${encodeURIComponent(file.path)}`;
      const both = await this.o.api<MergeFile>(`/api/tomcat/keep/file?${q}`);
      if (this.name !== name || !this.el.isConnected) return;
      // A merge made from other content cannot be continued: start from the deployed copy again.
      const prior = st.merged && st.merged.deployedHash === both.deployed.hash && st.merged.buildHash === both.build.hash ? st.merged.result.text : undefined;
      openMergeView({
        file: both,
        warName: this.o.war.name,
        initial: prior,
        onApply: (result) => {
          if (result.outcome === 'merged') {
            st.merged = { result, deployedHash: both.deployed.hash, buildHash: both.build.hash };
            st.choice = 'merged';
          } else {
            // Exactly one of the two versions: no merge to write.
            st.merged = undefined;
            st.choice = result.outcome;
          }
          this.draw();
          this.o.changed();
          this.el.querySelector<HTMLElement>(`[data-k="${CSS.escape(`merge:${file.path}`)}"]`)?.focus();
        },
      });
    } catch (err) {
      st.error = (err as Error).message;
    } finally {
      st.opening = false;
      this.draw();
    }
  }

  // ── Drawing ───────────────────────────────────────────

  /** What the build brings for one file, in a sentence or two. */
  private describe(c: KeepCompare | undefined, st: FileState): { lead: Child; rest: string[]; fresh: number } {
    if (!c) return { lead: null, rest: [], fresh: 0 };
    if (c.status === 'identical') return { lead: h('span', { class: 'muted' }, 'The same as the new build’s.'), rest: [], fresh: 0 };
    if (c.status === 'only-deployed') return { lead: h('span', {}, 'Only in the deployed copy.'), rest: [st.choice === 'deployed' ? 'Kept: added to the new build.' : 'Left out: the new webapp starts without it.'], fresh: 0 };
    const rest: string[] = [];
    let lead: Child = null;
    let fresh = 0;
    if (c.keys) {
      const k = c.keys;
      fresh = k.addedCount;
      if (k.addedCount) {
        const names = keyNames(k.added);
        const el = h(
          'span',
          { class: 'kf-new', title: k.added.map((a) => `${a.path}${a.value !== undefined ? ` = ${a.value}` : ` (${a.count} settings)`}`).join('\n') },
          h('strong', {}, `${plural(k.addedCount, 'new setting')} in this build`),
          ': ',
          h('span', { class: 'kf-names' }, nameList(names)),
        );
        lead = el;
      } else lead = h('span', {}, 'No new settings in this build.');
      if (k.removedCount) rest.push(`${k.removedCount} no longer in the build: ${nameList(keyNames(k.removed))}`);
      if (k.changedCount) rest.push(`${plural(k.changedCount, 'value')} ${k.changedCount === 1 ? 'differs' : 'differ'}: ${nameList(k.changed.map((v) => v.path))}`);
    } else if (c.formatOnly) lead = h('span', {}, 'The same text; only line endings or encoding differ.');
    else if (c.lines) lead = h('span', {}, `Differs from the build’s: ${c.lines.added ? `+${c.lines.added}` : ''}${c.lines.added && c.lines.removed ? ' ' : ''}${c.lines.removed ? `−${c.lines.removed}` : ''} ${c.lines.added + c.lines.removed === 1 ? 'line' : 'lines'} in the build.`);
    else lead = h('span', {}, 'Differs from the new build’s.');
    if (c.reason) rest.push(c.reason);
    return { lead, rest, fresh };
  }

  private row(file: KeptFile): HTMLElement {
    const st = this.files.get(file.path)!;
    const c = this.preview!.compare[file.path];
    const locked = !!this.preview!.problem;
    const { lead, rest, fresh } = this.describe(c, st);

    const seg = h('div', { class: 'kf-seg', role: 'group', 'aria-label': `What to do with ${file.path}` });
    const option = (choice: Choice, label: string, title: string, disabled = false) => {
      const b = h('button', { type: 'button', class: `kf-opt${st.choice === choice ? ' on' : ''}`, title, 'aria-pressed': String(st.choice === choice), 'data-k': `${choice}:${file.path}` }, label) as HTMLButtonElement;
      b.disabled = disabled || locked;
      b.addEventListener('click', () => {
        st.choice = choice;
        this.draw();
        this.o.changed();
      });
      seg.append(b);
    };
    const info: Child[] = [];
    if (c?.status !== 'identical') {
      if (c?.status === 'only-deployed') {
        option('deployed', 'Keep', 'Add the deployed file to the new build', !c.keepable);
        option('build', 'Leave out', 'Deploy the build as it is, without this file');
      } else {
        option('deployed', 'Keep deployed', 'The deployed file replaces the build’s, as it is', c ? !c.keepable : false);
        option('build', 'Use new build', 'The build’s file is deployed; the local one is dropped');
        if (st.merged) option('merged', 'Merged', 'Your merge of the two is written into the build');
      }
    }
    let mergeBtn: HTMLButtonElement | null = null;
    if (c?.mergeable && c.status === 'differs') {
      const label = st.opening ? 'Opening…' : st.merged ? 'Edit merge…' : 'Merge…';
      mergeBtn = h('button', { type: 'button', class: `btn btn-sm kf-merge${fresh && !st.merged && st.choice === 'deployed' ? ' kf-merge-hot' : ''}`, 'data-k': `merge:${file.path}`, title: 'See both versions side by side and choose, line by line' }, label) as HTMLButtonElement;
      mergeBtn.disabled = !!st.opening || locked;
      mergeBtn.addEventListener('click', () => void this.merge(file));
    }
    if (st.choice === 'merged' && st.merged) {
      const r = st.merged.result;
      const bits = [`Merged: ${r.added ? `+${r.added}` : ''}${r.added && r.removed ? ' ' : ''}${r.removed ? `−${r.removed}` : ''}${r.added + r.removed ? ` ${r.added + r.removed === 1 ? 'line' : 'lines'} against the deployed copy` : ''}`];
      if (r.missing !== null && fresh) bits.push(r.missing ? `${plural(r.missing, 'new setting')} not taken` : fresh === 1 ? 'the new setting taken' : `all ${fresh} new settings taken`);
      info.push(h('div', { class: 'kf-state' }, bits.join(' · ')));
      if (r.problem) info.push(h('div', { class: 'kf-state warn' }, `Not valid as its format: ${r.problem}`));
    } else {
      if (lead) info.push(h('div', { class: 'kf-lead' }, lead));
      if (st.choice === 'build' && c?.keys?.changedCount) info.push(h('div', { class: 'kf-state warn' }, `Your ${plural(c.keys.changedCount, 'local value')} will be replaced by the build’s.`));
    }
    for (const r of rest) info.push(h('div', { class: 'kf-rest muted' }, r));
    if (st.error) info.push(h('div', { class: 'field-error', role: 'alert' }, st.error));

    return h(
      'li',
      { class: `kf-file${fresh && st.choice === 'deployed' ? ' kf-has-new' : ''}${c?.status === 'identical' ? ' kf-same' : ''}` },
      h(
        'div',
        { class: 'kf-top' },
        h('code', { class: 'kf-path', title: file.path }, file.path),
        fresh ? h('span', { class: 'kf-badge', title: 'Settings the new build has that the deployed file does not' }, `${fresh} new`) : null,
        mergeBtn || seg.childElementCount ? h('div', { class: 'kf-controls' }, mergeBtn, seg.childElementCount ? seg : null) : null,
      ),
      ...info,
    );
  }

  private draw(): void {
    const p = this.preview;
    const active = document.activeElement instanceof HTMLElement && this.el.contains(document.activeElement) ? document.activeElement.dataset.k : undefined;
    if (!p) return void this.el.replaceChildren();
    const from = p.source?.where === 'disabled' ? 'disabled copy' : 'deployed copy';
    if (!p.files.length) {
      return void this.el.replaceChildren(h('p', { class: 'muted' }, `No ${nameList(p.patterns, 'or', 4)} in the ${from} to keep.`));
    }
    const choosable = p.files.filter((f) => p.compare[f.path]?.status !== 'identical').length;
    const all = (label: string, choice: 'deployed' | 'build') => {
      const b = h('button', { type: 'button', class: 'link', 'data-k': `all:${choice}` }, label) as HTMLButtonElement;
      b.addEventListener('click', () => this.setAll(choice));
      return b;
    };
    const fresh = p.files.reduce((n, f) => n + (p.compare[f.path]?.keys?.addedCount ?? 0), 0);
    const parts: Child[] = [
      h(
        'div',
        { class: 'kf-head' },
        h('strong', {}, 'Local config files'),
        h('span', { class: 'muted' }, `from the ${from}`),
        h('span', { class: 'spacer' }),
        !p.problem && choosable > 1 ? all('Keep all', 'deployed') : null,
        !p.problem && choosable > 1 ? all('Use new build for all', 'build') : null,
      ),
      p.problem ? h('p', { class: 'warn' }, p.problem) : null,
      !p.problem && fresh ? h('p', { class: 'kf-hint' }, `The new build has ${plural(fresh, 'setting')} your deployed files do not. Merge a file to add them and keep your values.`) : null,
      h('ul', { class: `kf-list${p.problem ? ' off' : ''}` }, ...[...p.files].sort((x, y) => rank(p.compare[x.path]) - rank(p.compare[y.path])).map((f) => this.row(f))),
      p.truncated ? h('p', { class: 'muted' }, 'The search stopped early; there may be more.') : null,
      !p.problem ? h('p', { class: 'muted kf-foot' }, 'Kept and merged files are written into the WAR before Tomcat sees it, so the webapp starts with them.') : null,
    ];
    this.el.replaceChildren(...parts.filter((x): x is Node => !!x));
    if (active) this.el.querySelector<HTMLElement>(`[data-k="${CSS.escape(active)}"]`)?.focus();
  }
}
