import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WebappSet, WebappSetPlan } from '../../shared/tomcat';
import type { FieldError } from '../config';
import { checkName } from './webapps';

/**
 * Webapp sets: named lists of the webapps to have deployed for a task, in webapp-sets.json next
 * to the settings file. Applying one moves what is not in it to the disabled folder and brings
 * what is in it back (TomcatService.applySet); this file only keeps the lists and works out
 * what applying one would move. Every change re-reads the file, so edits by hand are kept, and
 * writes through a temporary file.
 */

export const SETS_FILE = 'webapp-sets.json';
const MAX_SETS = 200;
const MAX_WEBAPPS = 500;

export class SetError extends Error {
  constructor(
    message: string,
    public status = 400,
    public errors: FieldError[] = [],
  ) {
    super(message);
  }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/** A set as sent by the page (or found in the file), checked and tidied: names trimmed, sorted, once each. */
export function validateSet(input: unknown): { set: Omit<WebappSet, 'updated'>; errors: FieldError[] } {
  const errors: FieldError[] = [];
  const v = isObj(input) ? input : {};
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  if (!name) errors.push({ path: 'name', message: 'Give the set a name' });
  else if (name.length > 80) errors.push({ path: 'name', message: 'Name is too long' });
  else if (/[\u0000-\u001f]/.test(name)) errors.push({ path: 'name', message: 'Name cannot contain control characters' });
  const list: unknown[] = Array.isArray(v.webapps) ? v.webapps : [];
  if (v.webapps !== undefined && !Array.isArray(v.webapps)) errors.push({ path: 'webapps', message: 'Must be a list of webapp names' });
  const webapps = new Set<string>();
  list.forEach((w, i) => {
    const n = typeof w === 'string' ? w.trim() : '';
    const problem = n ? checkName(n) : 'Enter a name';
    if (problem) errors.push({ path: `webapps.${i}`, message: problem });
    else webapps.add(n);
  });
  if (webapps.size > MAX_WEBAPPS) errors.push({ path: 'webapps', message: `At most ${MAX_WEBAPPS} webapps` });
  return { set: { name, webapps: [...webapps].sort(byName) }, errors };
}

/**
 * What applying a set would move. `keep` are webapps a set never disables (the Manager Debug Hub
 * uses, Debug Hub itself); a name both deployed and disabled counts as deployed.
 */
export function planSet(set: Pick<WebappSet, 'webapps'>, deployed: string[], disabled: string[], keep: (name: string) => boolean): WebappSetPlan {
  const want = new Set(set.webapps);
  const there = new Set(deployed);
  const away = new Set(disabled);
  const plan: WebappSetPlan = { disable: [], enable: [], missing: [], kept: [] };
  for (const name of deployed) {
    if (want.has(name)) continue;
    (keep(name) ? plan.kept : plan.disable).push(name);
  }
  for (const name of set.webapps) {
    if (there.has(name)) continue;
    (away.has(name) ? plan.enable : plan.missing).push(name);
  }
  for (const list of Object.values(plan)) list.sort(byName);
  return plan;
}

interface SetsFile {
  version: 1;
  sets: WebappSet[];
}

export class WebappSetStore {
  /** Why the file could not be read; saving moves it aside and starts afresh. */
  problem: string | null = null;

  constructor(readonly file: string) {}

  /** The sets in the file, in name order. A file that cannot be read gives none, and says why. */
  list(): WebappSet[] {
    this.problem = null;
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!isObj(raw) || !Array.isArray(raw.sets)) throw new Error('it has no list of sets');
      const out: WebappSet[] = [];
      const seen = new Set<string>();
      for (const item of raw.sets.slice(0, MAX_SETS)) {
        const { set, errors } = validateSet(item);
        // A set edited by hand with one bad name keeps the good ones.
        if (!set.name || seen.has(set.name.toLowerCase()) || errors.some((e) => e.path === 'name')) continue;
        seen.add(set.name.toLowerCase());
        out.push({ ...set, updated: isObj(item) && typeof item.updated === 'string' ? item.updated : new Date(0).toISOString() });
      }
      return out.sort((a, b) => byName(a.name, b.name));
    } catch (err) {
      this.problem = `Could not read ${this.file}: ${(err as Error).message}`;
      return [];
    }
  }

  /** Saves a set, new or changed. `previous`: the name it had, when it is renamed. */
  save(input: unknown, previous?: string): WebappSet {
    const { set, errors } = validateSet(input);
    if (errors.length) throw new SetError(errors[0].message, 400, errors);
    const sets = this.list();
    if (this.problem) this.moveAside();
    // A new set never replaces another; a changed one replaces only itself.
    const was = previous?.trim().toLowerCase() ?? null;
    const clash = sets.find((s) => s.name.toLowerCase() === set.name.toLowerCase() && s.name.toLowerCase() !== was);
    if (clash) throw new SetError(`There is already a set called ${clash.name}.`, 409, [{ path: 'name', message: `There is already a set called ${clash.name}` }]);
    const rest = sets.filter((s) => s.name.toLowerCase() !== was);
    if (rest.length >= MAX_SETS) throw new SetError(`At most ${MAX_SETS} sets.`);
    const saved: WebappSet = { ...set, updated: new Date().toISOString() };
    this.write([...rest, saved]);
    return saved;
  }

  delete(name: string): void {
    const sets = this.list();
    const rest = sets.filter((s) => s.name.toLowerCase() !== name.trim().toLowerCase());
    if (rest.length === sets.length) throw new SetError(`There is no set called ${name}.`, 404);
    this.write(rest);
  }

  get(name: string): WebappSet {
    const set = this.list().find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
    if (!set) throw new SetError(`There is no set called ${name}.`, 404);
    return set;
  }

  private write(sets: WebappSet[]): void {
    const data: SetsFile = { version: 1, sets: sets.sort((a, b) => byName(a.name, b.name)) };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    renameSync(tmp, this.file);
    this.problem = null;
  }

  /** Keeps an unreadable file as .broken-<time> rather than overwriting what may be fixable by hand. */
  private moveAside(): void {
    try {
      renameSync(this.file, `${this.file}.broken-${Date.now()}`);
    } catch {
      /* overwritten instead */
    }
  }
}
