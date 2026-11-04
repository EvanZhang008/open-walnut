/**
 * The encrypted backup repository's on-store format (version 1).
 *
 * Layout under the destination's root:
 *   walnut-backup.json      plaintext: repo id, key check, chunk sizes, writer machine
 *   packs/<aa>/<packId>     encrypted blobs packed ~16 MB at a time + an encrypted header
 *   index/<id>              encrypted: which blob sits in which pack, at what offset
 *   snapshots/<id>          encrypted: one backup (time, machine, totals, its tree's blob ids)
 *
 * A blob is one chunk of one file (repo/chunker.ts), or one chunk of a
 * snapshot's tree (the list of files). Blobs are deduplicated by their keyed
 * id, so a file that did not change is never uploaded again, and a snapshot
 * costs only what changed. A snapshot is written LAST: its presence means
 * every blob it names was uploaded first.
 *
 * Packs hold either data blobs or tree blobs, never both, so reading every
 * snapshot's file list (prune, restore listing) downloads the small tree packs
 * only.
 */

export const REPO_FORMAT = 'walnut-backup';
export const REPO_VERSION = 1;
export const REPO_CONFIG_KEY = 'walnut-backup.json';
export const PACK_TARGET_BYTES = 16 * 1024 * 1024;

export const packKey = (id: string): string => `packs/${id.slice(0, 2)}/${id}`;
export const indexKey = (id: string): string => `index/${id}`;
export const snapshotKey = (id: string): string => `snapshots/${id}`;
export const packIdFromKey = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

/** walnut-backup.json. Plaintext: it holds nothing about the data. */
export interface RepoConfig {
  format: typeof REPO_FORMAT;
  version: number;
  repoId: string;
  createdAt: string;
  /** HMAC of the repo id under the key's mac subkey: tells a wrong key at once. */
  keyCheck: string;
  chunker: { min: number; avg: number; max: number };
  /**
   * The one machine that writes backups here. Another machine only reads
   * (restore) until the user moves the writer to it (`adopt`), so two machines
   * can never prune each other's packs.
   */
  writer: { hostname: string; since: string };
}

export type PackType = 'data' | 'tree';

/** Where one blob lives: [blobId, offset, sealedLength, rawLength]. */
export type BlobLocation = [string, number, number, number];

export interface PackInfo {
  id: string;
  type: PackType;
  /** Bytes of the whole pack object. */
  size: number;
  blobs: BlobLocation[];
}

/** index/<id>: the packs one backup run (or one prune) wrote. */
export interface IndexFile {
  version: 1;
  packs: PackInfo[];
}

/** One file in a snapshot's tree (JSON lines, sorted by path). */
export interface TreeEntry {
  /** Data-dir-relative path (sqlite snapshots under .sqlite-snapshots/). */
  p: string;
  /** Size in bytes. */
  s: number;
  /** mtime in ms: with the size, the change detector for the next run. */
  m: number;
  /** Blob ids of its chunks, in order (empty for an empty file). */
  b: string[];
}

export interface Snapshot {
  version: 1;
  id: string;
  createdAt: string;
  hostname: string;
  walnutVersion: string;
  fileCount: number;
  totalBytes: number;
  /** Blob ids of the tree (JSON lines of TreeEntry), in order. */
  tree: string[];
}

export type SnapshotSummary = Omit<Snapshot, 'tree'>;
