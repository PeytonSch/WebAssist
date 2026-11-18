// What the deploy dialog and the merge view exchange with the hub about kept files: how each
// compares with the new build's file of the same path, both texts for merging, and the merged
// result that goes into the WAR.

import type { FileKind, KeyChange, ValueChange } from './configkeys';
import type { TextFormat } from './textformat';
import type { KeepPreview } from './tomcat';

/** A file bigger than this is kept or replaced as a whole; the merge view does not open it. */
export const MERGE_MAX_BYTES = 1024 * 1024;
export const MERGE_MAX_LINES = 20_000;
/** The deploy request carries merged files, so it may be much bigger than other requests. */
export const DEPLOY_BODY_LIMIT = 16 * 1024 * 1024;
/** Settings listed per file in the comparison; the counts are of all of them. */
export const MAX_LISTED_KEYS = 40;

/**
 * identical: byte for byte the same as the build's file.
 * only-deployed: the build has no file at this path; keeping the deployed one adds it.
 * differs: both have it and they are not the same.
 */
export type CompareStatus = 'identical' | 'only-deployed' | 'differs';

/** How a kept-file candidate compares with the same path in the new WAR. */
export interface KeepCompare {
  status: CompareStatus;
  kind: FileKind;
  /** Whether the deployed copy can be kept at all (it cannot when it is over the size limit). */
  keepable: boolean;
  /** Whether the merge view can open it. Keeping or replacing it works either way. */
  mergeable: boolean;
  /** Why not, when not mergeable or not keepable. */
  reason: string | null;
  /** The texts are the same; only line endings, byte order mark or encoding differ. */
  formatOnly: boolean;
  /** Lines the build adds and removes, compared with the deployed copy. Null when not compared. */
  lines: { added: number; removed: number } | null;
  /**
   * By setting, when both versions could be read as their format: what the build adds (new
   * settings the deployed copy lacks), what it no longer has, and what has another value.
   * The lists are cut at MAX_LISTED_KEYS; the counts are complete.
   */
  keys: {
    added: KeyChange[];
    addedCount: number;
    removed: KeyChange[];
    removedCount: number;
    changed: ValueChange[];
    changedCount: number;
  } | null;
}

/** GET /api/tomcat/keep/compare: the keep preview with each file compared to the new build. */
export interface KeepComparePreview extends KeepPreview {
  /** By file path. Missing when the comparison could not be made (see `problem`). */
  compare: Record<string, KeepCompare>;
}

export interface MergeSide {
  /** Line endings as "\n", without a byte order mark. */
  text: string;
  format: TextFormat;
  /** Of the file's bytes; sent back with the merged result so a file that changed meanwhile is noticed. */
  hash: string;
  bytes: number;
}

/** GET /api/tomcat/keep/file: both versions of one kept file, for the merge view. */
export interface MergeFile {
  path: string;
  kind: FileKind;
  deployed: MergeSide;
  build: MergeSide;
}

/** A merged file in POST /api/tomcat/deploy. */
export interface MergedInput {
  path: string;
  /** The merged text. It is stored with the deployed copy's line endings, byte order mark and encoding. */
  text: string;
  /** Hashes from GET /api/tomcat/keep/file. When given, a version that changed since is refused (409). */
  deployedHash?: string;
  buildHash?: string;
}
