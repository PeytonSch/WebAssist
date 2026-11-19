import { ENV_REF, REGISTRY_DEFAULTS, REGISTRY_TYPES, type RegistryAuth, type RegistryConfig, type RegistryPackage, type RegistryType, type VersionKinds } from '../../shared/registry';
import { REGISTRY_FORMS } from '../../shared/registry-forms';
import type { FieldError } from '../config';
import { checkName } from '../tomcat/webapps';
import { versionMatcher } from './version';

/**
 * Checks the `registries` setting and returns it complete: defaults filled in, text trimmed,
 * blank rows dropped, and each package holding just the fields its kind of registry has. Errors
 * are keyed like the rest of the settings ("registries.0.packages.1.artifactId"), so the
 * settings screen can show each beside its input.
 */

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COORDINATE = /^[A-Za-z0-9_.-]+$/;

function regexProblem(pattern: string): string | null {
  try {
    versionMatcher(pattern);
    return null;
  } catch (err) {
    return (err as Error).message.replace(/^Invalid regular expression: /, '');
  }
}

/** What is wrong with one field of a package entry, or null. */
function fieldProblem(key: keyof RegistryPackage, value: string, label: string): string | null {
  switch (key) {
    case 'artifactId':
      // A pattern searches the group: * and ?, or a /regular expression/.
      if (/[*?]/.test(value) && /^[A-Za-z0-9_.*?-]+$/.test(value)) return null;
      if (/^\/.+\/[a-z]*$/.test(value)) return regexProblem(value);
      return COORDINATE.test(value) ? null : `${label} can only have letters, digits and . _ -, or * and ? to match several`;
    case 'groupId':
    case 'repository':
    case 'classifier':
      return COORDINATE.test(value) ? null : `${label} can only have letters, digits and . _ -`;
    case 'extension':
      return /^[A-Za-z0-9]+$/.test(value) ? null : 'An extension without the dot, e.g. war';
    case 'versionPattern':
      return regexProblem(value);
    case 'deployAs':
      return checkName(value);
    case 'params':
      return /[\s#]/.test(value) ? 'Search parameters as in a URL: name=value&name=value' : null;
    case 'url':
      if (/^[a-z][a-z0-9+.-]*:/i.test(value.replace(ENV_REF, '')) && !/^https?:\/\//i.test(value)) return 'Must be an http:// or https:// address';
      return /\s/.test(value) ? 'An address cannot contain spaces' : null;
  }
  return null;
}

export function validateRegistries(input: unknown, errors: FieldError[], path = 'registries'): RegistryConfig[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push({ path, message: 'Must be a list' });
    return [];
  }
  const fail = (at: string, message: string) => void errors.push({ path: at, message });
  const text = (at: string, v: unknown, label: string): string => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') {
      fail(at, `${label} must be text`);
      return '';
    }
    return v.trim();
  };
  const int = (at: string, v: unknown, fallback: number, min: number, max: number, label: string): number => {
    const n = v === undefined || v === null || v === '' ? fallback : typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      fail(at, `${label} must be a whole number from ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}`);
      return fallback;
    }
    return n;
  };

  const out: RegistryConfig[] = [];
  const names = new Set<string>();
  input.forEach((item, i) => {
    const at = `${path}.${i}`;
    if (!isObj(item)) return fail(at, 'Must be a registry');
    const type: RegistryType = REGISTRY_TYPES.includes(item.type) ? item.type : 'maven';
    if (item.type !== undefined && !REGISTRY_TYPES.includes(item.type)) fail(`${at}.type`, 'Choose a kind of registry from the list');
    const form = REGISTRY_FORMS[type];
    const name = text(`${at}.name`, item.name, 'Name');
    const url = text(`${at}.url`, item.url, 'URL').replace(/\/+$/, '');
    const packagesIn: unknown[] = Array.isArray(item.packages) ? item.packages : [];
    if (item.packages !== undefined && !Array.isArray(item.packages)) fail(`${at}.packages`, 'Must be a list');

    const packages: RegistryPackage[] = [];
    packagesIn.forEach((p, j) => {
      const pat = `${at}.packages.${j}`;
      if (!isObj(p)) return fail(pat, `Must be a ${form.entry.noun.toLowerCase()}`);
      const entry: Record<string, string> = {};
      let any = false;
      for (const f of form.fields) {
        if (f.key === 'versions') {
          const v: VersionKinds = p.versions === undefined || p.versions === '' ? 'all' : p.versions;
          if (!['all', 'releases', 'snapshots'].includes(v)) fail(`${pat}.versions`, 'Must be all, releases or snapshots');
          entry.versions = ['all', 'releases', 'snapshots'].includes(v) ? v : 'all';
          continue;
        }
        const value = text(`${pat}.${f.key}`, p[f.key], f.label);
        entry[f.key] = value;
        if (value) any = true;
      }
      // A row left empty is dropped rather than complained about.
      if (!any) return;
      for (const f of form.fields) {
        if (f.key === 'versions') continue;
        const value = entry[f.key];
        if (!value) {
          if (f.required) fail(`${pat}.${f.key}`, `${f.label} is required`);
          continue;
        }
        const problem = fieldProblem(f.key, value, f.label);
        if (problem) fail(`${pat}.${f.key}`, problem);
      }
      if ('extension' in entry && !entry.extension) entry.extension = REGISTRY_DEFAULTS.extension;
      if (type === 'url' && entry.url && !/^https?:\/\//i.test(entry.url) && !/^\$\{env:/.test(entry.url) && !url) {
        fail(`${pat}.url`, 'Must start with http:// or https://, or give the registry a URL for it to be relative to');
      }
      packages.push(entry as unknown as RegistryPackage);
    });

    const authIn = isObj(item.auth) ? item.auth : {};
    const headersIn: unknown[] = Array.isArray(item.headers) ? item.headers : [];
    const blank = !name && !url && !packages.length && !headersIn.length && !authIn.username && !authIn.password && !authIn.token;
    if (blank) return;

    if (!name) fail(`${at}.name`, 'Give the registry a name');
    else if (name.length > 80) fail(`${at}.name`, 'Name is too long');
    else if (names.has(name.toLowerCase())) fail(`${at}.name`, `Another registry is already called ${name}`);
    names.add(name.toLowerCase());

    if (!url) {
      if (form.url.required) fail(`${at}.url`, 'URL is required');
    } else if (!/^https?:\/\/[^/\s]+/i.test(url) && !/^\$\{env:/.test(url)) fail(`${at}.url`, 'Must start with http:// or https://');
    else if (/\s/.test(url)) fail(`${at}.url`, 'An address cannot contain spaces');

    const authType: RegistryAuth['type'] = ['none', 'basic', 'bearer'].includes(authIn.type) ? authIn.type : 'none';
    if (authIn.type !== undefined && !['none', 'basic', 'bearer'].includes(authIn.type)) fail(`${at}.auth.type`, 'Must be none, basic or bearer');
    let auth: RegistryAuth = { type: 'none' };
    if (authType === 'basic') {
      const username = text(`${at}.auth.username`, authIn.username, 'User name');
      // Not trimmed: a password may end in a space.
      const password = typeof authIn.password === 'string' ? authIn.password : '';
      if (!username) fail(`${at}.auth.username`, 'User name is required');
      auth = { type: 'basic', username, password };
    } else if (authType === 'bearer') {
      const token = text(`${at}.auth.token`, authIn.token, 'Token');
      if (!token) fail(`${at}.auth.token`, 'Token is required');
      else if (/[\r\n]/.test(token)) fail(`${at}.auth.token`, 'A token cannot contain line breaks');
      auth = { type: 'bearer', token };
    }

    const headers: RegistryConfig['headers'] = [];
    if (item.headers !== undefined && !Array.isArray(item.headers)) fail(`${at}.headers`, 'Must be a list');
    headersIn.forEach((hd, j) => {
      const hat = `${at}.headers.${j}`;
      if (!isObj(hd)) return fail(hat, 'Must be a header');
      const hname = text(`${hat}.name`, hd.name, 'Header');
      const value = typeof hd.value === 'string' ? hd.value : hd.value == null ? '' : String(hd.value);
      if (!hname && !value.trim()) return;
      if (!HEADER_NAME.test(hname)) fail(`${hat}.name`, hname ? 'Not a valid HTTP header name' : 'Header name is required');
      if (/[\r\n]/.test(value)) fail(`${hat}.value`, 'A header value cannot contain line breaks');
      headers.push({ name: hname, value });
    });

    if (item.insecureTls !== undefined && typeof item.insecureTls !== 'boolean') fail(`${at}.insecureTls`, 'Must be on or off');
    out.push({
      name,
      type,
      url,
      auth,
      headers,
      insecureTls: item.insecureTls === true,
      caFile: text(`${at}.caFile`, item.caFile, 'Certificate file'),
      timeoutMs: int(`${at}.timeoutMs`, item.timeoutMs, REGISTRY_DEFAULTS.timeoutMs, 1000, 600_000, 'Timeout'),
      // 0 turns automatic checks off; otherwise no more often than once a minute.
      checkMinutes: int(`${at}.checkMinutes`, item.checkMinutes, REGISTRY_DEFAULTS.checkMinutes, 0, 7 * 24 * 60, 'Check every'),
      packages,
    });
  });
  return out;
}

/** Makes the registries' file paths absolute, like every other path in the settings. */
export function resolveRegistryPaths(registries: unknown, abs: (p: string) => string): RegistryConfig[] {
  if (!Array.isArray(registries)) return [];
  return registries.map((r) => (isObj(r) && typeof r.caFile === 'string' && r.caFile ? { ...r, caFile: abs(r.caFile) } : r)) as RegistryConfig[];
}
