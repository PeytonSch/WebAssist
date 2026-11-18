import type { RegistryPackage, RegistryType } from './registry';

// What each kind of registry asks for in Settings. The settings screen builds its form from
// this and the hub checks what is saved against it (src/server/registry/config.ts), so a new
// kind of registry needs an entry here and no changes to either.

export interface EntryField {
  key: keyof RegistryPackage;
  label: string;
  placeholder: string;
  required?: boolean;
  /** Takes most of the row: an address needs the room. */
  wide?: boolean;
  /** Shown under "More options": rarely needed. */
  more?: boolean;
  help?: string;
}

export interface RegistryForm {
  /** In the type list. */
  label: string;
  /** What it is for, under the type list. */
  about: string;
  url: { placeholder: string; required: boolean; help: string };
  /** What one entry of `packages` is called for this kind. */
  entry: { noun: string; plural: string; add: string; empty: string };
  fields: EntryField[];
}

const VERSION_FIELDS: EntryField[] = [
  { key: 'classifier', label: 'Classifier', placeholder: 'none', more: true, help: 'The part after the version in the file name, e.g. prod in shop-2.4.1-prod.war.' },
  { key: 'extension', label: 'Extension', placeholder: 'war', more: true },
  { key: 'versions', label: 'Versions', placeholder: '', more: true, help: 'Releases only leaves out -SNAPSHOT versions; Snapshots only keeps just those.' },
  { key: 'versionPattern', label: 'Version pattern', placeholder: '2.* or /^2\\.\\d+\\.\\d+$/', more: true, help: 'Only versions that match: * and ? as wildcards, or a /regular expression/.' },
];

const DEPLOY_AS: EntryField = { key: 'deployAs', label: 'Deploy as', placeholder: 'guessed from the name', more: true, help: 'The webapp name, e.g. ROOT. Empty: the name without its version, as for a local WAR.' };

export const REGISTRY_FORMS: Record<RegistryType, RegistryForm> = {
  maven: {
    label: 'Maven repository',
    about: 'Reads maven-metadata.xml, as Maven does. Works with Nexus 2 and 3, Artifactory, GitLab and GitHub package registries and plain web folders.',
    url: {
      placeholder: 'https://nexus.example.com/repository/maven-public',
      required: true,
      help: 'The repository’s root: the folder that has com/, org/ and so on in it. A group repository that combines releases and snapshots works too.',
    },
    entry: { noun: 'Package', plural: 'Packages', add: 'Add package', empty: 'No packages yet: add the WARs to look for.' },
    fields: [
      { key: 'groupId', label: 'Group ID', placeholder: 'com.example', required: true },
      { key: 'artifactId', label: 'Artifact ID', placeholder: 'shop', required: true },
      ...VERSION_FIELDS,
      DEPLOY_AS,
    ],
  },
  nexus3: {
    label: 'Nexus 3 search',
    about: 'Asks Nexus Repository 3 for the WARs in a repository, so they need not be listed one by one. Also for raw repositories.',
    url: {
      placeholder: 'https://nexus.example.com',
      required: true,
      help: 'The Nexus server itself, with its context path if it has one, not a repository.',
    },
    entry: { noun: 'Search', plural: 'Searches', add: 'Add search', empty: 'No searches yet: add a repository to look in.' },
    fields: [
      { key: 'repository', label: 'Repository', placeholder: 'maven-releases', required: true },
      { key: 'group', label: 'Group', placeholder: 'any', help: 'Maven: the group ID. Raw: the folder, e.g. /builds/shop.' },
      { key: 'name', label: 'Name', placeholder: 'every WAR', help: 'Maven: the artifact ID. Empty finds every WAR in the repository.' },
      ...VERSION_FIELDS,
      { key: 'params', label: 'Extra search parameters', placeholder: 'maven.extension=war', more: true, help: 'Added to the search as written, e.g. maven.extension=war so Nexus leaves out poms and jars, which makes checks of a large Maven repository much faster.' },
      DEPLOY_AS,
    ],
  },
  url: {
    label: 'Direct URL',
    about: 'Fixed addresses of WARs, e.g. a CI server’s last successful build. A new build is noticed when the file’s ETag, date or size changes.',
    url: {
      placeholder: 'https://ci.example.com (optional)',
      required: false,
      help: 'Optional. Addresses below that do not start with http are relative to it.',
    },
    entry: { noun: 'WAR', plural: 'WARs', add: 'Add URL', empty: 'No URLs yet.' },
    fields: [
      { key: 'name', label: 'Name', placeholder: 'shop', required: true },
      { key: 'url', label: 'URL', placeholder: 'https://ci.example.com/job/shop/lastSuccessfulBuild/artifact/target/shop.war', required: true, wide: true },
      DEPLOY_AS,
    ],
  },
};

/** A package entry with every field its kind of registry has, empty. */
export function blankPackage(type: RegistryType): RegistryPackage {
  const entry: Record<string, string> = {};
  for (const f of REGISTRY_FORMS[type].fields) entry[f.key] = f.key === 'versions' ? 'all' : '';
  return entry as unknown as RegistryPackage;
}
