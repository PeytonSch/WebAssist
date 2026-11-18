import type { RegistryConfig, RegistryPackage, RegistryType } from '../../shared/registry';
import type { HashName, Transport } from './transport';

/**
 * What a kind of registry has to be able to do. Supporting another one (Artifactory's storage
 * API, say) is one file that implements RegistryKind, plus naming it: its name in RegistryType
 * and REGISTRY_TYPES (src/shared/registry.ts), an entry in KINDS (kinds.ts), and its form in
 * REGISTRY_FORMS (src/shared/registry-forms.ts), from which Settings draws its fields and the
 * hub checks them. A field no kind has yet is also added to RegistryPackage. Everything else
 * (checking on a timer, version order and filters, what is new, downloads, checksums, the
 * cache, the deploy) is shared and lives in service.ts.
 */

export interface RegistryContext {
  registry: RegistryConfig;
  transport: Transport;
  signal?: AbortSignal;
}

/** Where one build of a package is downloaded from, and what the registry says about it. */
export interface Artifact {
  url: string;
  /** As the registry names it; cleaned before it is used as a file name. */
  fileName: string;
  /** Identifies this exact build. A SNAPSHOT's, or a fixed URL's, changes when it is rebuilt. */
  build: string;
  modified: string | null;
  bytes: number | null;
  /** Hex digests the registry gave along with the listing. */
  checksums: Partial<Record<HashName, string>>;
}

export interface FoundVersion {
  version: string;
  snapshot: boolean;
  /** Where to download it, when the listing already said. Otherwise `locate` finds out. */
  artifact: Artifact | null;
}

export interface FoundPackage {
  /** Identifies the package within its registry, the same on every check. */
  id: string;
  /** Short name, e.g. the artifact ID: what the webapp name is guessed from. */
  name: string;
  /** What it is in the registry, for display: "com.example:shop". */
  coordinates: string;
  /** In any order, not filtered. */
  versions: FoundVersion[];
}

export interface Listing {
  packages: FoundPackage[];
  /** Something worth telling the user about the listing, e.g. that a search was cut short. */
  hint?: string;
}

export interface RegistryKind {
  type: RegistryType;
  /**
   * Whether versions have an order (2.4.1 is newer than 2.4.0). Where they do not (a fixed URL
   * whose file is replaced in place), any change of build counts as a new one.
   */
  ordered: boolean;
  /** A package entry in a few words, for messages: "com.example:shop". */
  describe(entry: RegistryPackage): string;
  /** What a package entry stands for right now. One entry may find several packages (a search). */
  list(ctx: RegistryContext, entry: RegistryPackage): Promise<Listing>;
  /**
   * Where a version is downloaded from, for versions whose listing did not say. May ask the
   * registry, e.g. for a SNAPSHOT's current build.
   */
  locate(ctx: RegistryContext, entry: RegistryPackage, pkg: FoundPackage, version: FoundVersion): Promise<Artifact>;
  /** The registry's checksum for an artifact, when it is published apart from the listing. */
  checksums?(ctx: RegistryContext, artifact: Artifact): Promise<Partial<Record<HashName, string>>>;
  /** For Test connection on a registry without packages: reaches the registry and says what is there. */
  probe(ctx: RegistryContext): Promise<string>;
}

/** yyyyMMddHHmmss (UTC), as Maven metadata writes times, to ISO. */
export function mavenTime(stamp: string | null | undefined): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})\.?(\d{2})(\d{2})(\d{2})$/.exec((stamp ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** An HTTP date header as ISO, or null. */
export function httpTime(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Joins a base URL and path segments, encoding each segment. */
export function joinUrl(base: string, ...segments: string[]): string {
  const path = segments
    .flatMap((s) => s.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${base.replace(/\/+$/, '')}/${path}`;
}
