// Package registries (Nexus and the like) as a source of WARs: the settings, and what the
// Tomcat page's Packages card and the new-version notices exchange with the hub.

import type { WarInfo } from './tomcat';

// ── Settings ────────────────────────────────────────────

/**
 * maven:  a Maven repository layout, read through maven-metadata.xml. Works with Nexus 2 and 3,
 *         Artifactory, GitLab and GitHub Maven endpoints and plain static repositories.
 * nexus3: Nexus Repository 3's search API, which finds WARs in a repository without naming each
 *         one, and also covers raw (non-Maven) repositories.
 * url:    fixed URLs to WARs, e.g. a CI server's "last successful build" artifact.
 */
export type RegistryType = 'maven' | 'nexus3' | 'url';

export const REGISTRY_TYPES: RegistryType[] = ['maven', 'nexus3', 'url'];

export interface RegistryAuth {
  type: 'none' | 'basic' | 'bearer';
  /** basic. */
  username?: string;
  /** basic. May be ${env:NAME}. */
  password?: string;
  /** bearer. May be ${env:NAME}. */
  token?: string;
}

export type VersionKinds = 'all' | 'releases' | 'snapshots';

/** One thing to look for in a registry. Which fields apply depends on the registry's type. */
export interface RegistryPackage {
  /** maven. */
  groupId?: string;
  artifactId?: string;
  /** nexus3: the repository to search. */
  repository?: string;
  /** nexus3: the component's group (Maven: the group ID). Empty: any. */
  group?: string;
  /** nexus3: the component's name (Maven: the artifact ID), empty for every WAR found. url: what to call it. */
  name?: string;
  /** nexus3: more search parameters, as a query string, e.g. maven.extension=war. */
  params?: string;
  /** url: the WAR's address; relative to the registry's URL when not absolute. */
  url?: string;
  /** maven, nexus3. */
  classifier?: string;
  /** maven, nexus3. Default war. */
  extension?: string;
  /** maven, nexus3. */
  versions?: VersionKinds;
  /** maven, nexus3: only versions matching this, with * and ?, or a /regular expression/. */
  versionPattern?: string;
  /** The webapp name to deploy as. Empty: guessed from the name, as for a local WAR. */
  deployAs: string;
}

export interface RegistryConfig {
  /** Shown in the UI, and what its remembered state is kept under. Unique. */
  name: string;
  type: RegistryType;
  /** maven: the repository's root. nexus3: the server, e.g. https://nexus.example.com. url: optional base. */
  url: string;
  auth: RegistryAuth;
  /** Sent with every request to the registry's own host. Values may be ${env:NAME}. */
  headers: { name: string; value: string }[];
  /** Accept certificates that cannot be verified. */
  insecureTls: boolean;
  /** A PEM file with the certificate authority that signed the registry's certificate. */
  caFile: string;
  timeoutMs: number;
  /** How often to look for new versions. 0: only with Check now. */
  checkMinutes: number;
  packages: RegistryPackage[];
}

export const REGISTRY_DEFAULTS = {
  timeoutMs: 30_000,
  checkMinutes: 15,
  extension: 'war',
} as const;

/** Text of the form ${env:NAME} stands for that environment variable of the hub. */
export const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ── State ───────────────────────────────────────────────

export interface PackageVersionInfo {
  version: string;
  snapshot: boolean;
  /** When the registry says it was published. */
  modified: string | null;
  bytes: number | null;
  /** Already downloaded: deploying needs no download. */
  cached: boolean;
}

export type DownloadPhase = 'starting' | 'downloading' | 'verifying';

export interface DownloadInfo {
  key: string;
  version: string;
  phase: DownloadPhase;
  received: number;
  /** Null when the registry does not say. */
  total: number | null;
}

export interface PackageInfo {
  /** Identifies the package across restarts: registry, coordinates. */
  key: string;
  registry: string;
  /** Short name, e.g. the artifact ID. */
  name: string;
  /** What it is in the registry, e.g. "com.example:shop" or the URL. */
  coordinates: string;
  /** Newest first, as the settings filter them. At most MAX_LISTED_VERSIONS. */
  versions: PackageVersionInfo[];
  versionCount: number;
  latest: string | null;
  /** The latest version appeared since it was last deployed or dismissed. */
  fresh: boolean;
  /** The webapp name it would be deployed as. */
  target: string;
  /** What Debug Hub last deployed from this package, if it is still in webapps. */
  deployed: { version: string; as: string; at: string } | null;
  download: DownloadInfo | null;
}

export interface RegistryInfo {
  name: string;
  type: RegistryType;
  /** Without any login written into it. */
  url: string;
  checking: boolean;
  checkedAt: string | null;
  /** When the next automatic check is due; null when automatic checks are off. */
  nextCheckAt: string | null;
  /** Why the whole registry cannot be used: a setting, an environment variable that is not set. */
  error: string | null;
  /** What went wrong for single package entries; the others still work. */
  problems: { entry: string; message: string; hint?: string; /** Worth knowing, but nothing is broken. */ quiet?: boolean }[];
  packages: PackageInfo[];
}

/** GET /api/registry. */
export interface RegistryState {
  registries: RegistryInfo[];
}

/** A new version, for the notice. */
export interface PackageNotice {
  key: string;
  registry: string;
  name: string;
  coordinates: string;
  version: string;
  target: string;
}

/** Pushed over the WebSocket. */
export type RegistryMessage =
  /** Something changed: load GET /api/registry again. */
  | { type: 'registry'; change: 'state' }
  /** A new version was found. */
  | { type: 'registry'; change: 'new'; notice: PackageNotice }
  /** A download moved on; null: it ended. */
  | { type: 'registry'; change: 'download'; key: string; download: DownloadInfo | null };

/** POST /api/registry/download, once the file is there. */
export interface DownloadResult {
  /** The downloaded file, ready for the deploy dialog. */
  war: WarInfo;
  /** What was checked, e.g. "SHA-256 verified". */
  note: string;
}

/** One line of what Test connection found. */
export interface TestLine {
  ok: boolean;
  /** The package entry, or empty for the registry itself. */
  entry: string;
  message: string;
  hint?: string;
}

/** POST /api/registry/test. */
export interface TestResult {
  ok: boolean;
  lines: TestLine[];
}

export const MAX_LISTED_VERSIONS = 60;
