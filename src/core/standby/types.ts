/**
 * The standby copy's shapes (docs/reference/standby-copy.md). Pure types and constants.
 */

export const STANDBY_FORMAT = 'walnut-standby'
export const STANDBY_VERSION = 1

/** A file's stat on the leader when it was read: the change detector for the next batch. */
export interface SourceStat {
  /** size in bytes */
  s: number
  /** mtime, ms (fractional where the filesystem has it) */
  m: number
  /** ctime, ms: no program can set it, so a rewrite that keeps size and mtime still moves it */
  c: number
  /** inode */
  i: number
  /** A database's only: the head of its -wal (checkpoint sequence and salts), which a WAL restart changes even when the size does not */
  w?: string
}

/** One file of a batch. */
export interface BatchFile {
  /** Relative to the home, '/'-separated. */
  p: string
  size: number
  /** sha256 of the whole content, hex. */
  h: string
  /** Chunk ids (sha256 hex) in order; absent means one chunk, `h` itself (or none when empty). */
  b?: string[]
  /** 1: executable. */
  x?: 1
  /** 1: a SQLite database, taken as a consistent snapshot (its -wal/-shm are never copied). */
  db?: 1
  /** The leader's stat when it was read (for a database: of the database and its -wal). */
  src: SourceStat
}

/** The order of a manifest's files (by path, as bytes would sort them in UTF-16): the leader and a receiver sort alike. */
export const compareBatchPaths = (a: BatchFile, b: BatchFile): number => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)

export function chunkIds(f: BatchFile): string[] {
  return f.b ?? (f.size === 0 ? [] : [f.h])
}

/** A complete batch: everything the leader holds as `leader-data`, at one moment. */
export interface BatchManifest {
  format: typeof STANDBY_FORMAT
  version: number
  /** Counts up from 1 on each target. */
  batch: number
  /** The moment the batch is of (ISO). */
  takenAt: string
  files: BatchFile[]
}

/** What the target holds now. */
export interface StandbyState {
  format: typeof STANDBY_FORMAT
  version: number
  /** null until the first batch is complete. */
  current: {
    batch: number
    takenAt: string
    /** The batch whose manifest lists the files (an unchanged batch points at the last one that changed). */
    manifest: number
    fileCount: number
    bytes: number
    /** When the target made it current. */
    committedAt: string
  } | null
  /** When the last verify pass ran, and what it found. */
  lastVerify?: { at: string; drift: number; deep: boolean }
}

export interface CommitResult {
  batch: number
  /** Files written into the copy (new or changed), deleted from it. */
  written: number
  deleted: number
  /** True when the batch changed nothing: only the position moved. */
  unchanged: boolean
  /** Of the written files, how many were made from the last batch's copy with only their changed chunks written. */
  patched?: number
  /** Patches that did not match their hash and were built whole instead (a sign of trouble). */
  patchFailed?: number
  /** Bytes written into new files (a patched file counts its changed chunks only; a clone that the filesystem cannot share copies the rest in the kernel). */
  bytesWritten?: number
}

/**
 * How a batch reaches a target: a directory on this machine (StandbyTarget, index.ts
 * localTransport) or one on another host, reached through that host's daemon
 * (remote-transport.ts). Both implement the same four calls.
 */
export interface StandbyTransport {
  /** The target's current batch and its files (null before the first). */
  current(): Promise<{ state: StandbyState; files: BatchFile[] }>
  /** Which of these chunk ids the target does not hold yet. */
  missing(ids: string[]): Promise<Set<string>>
  /** Send one chunk; the target checks its hash before keeping it. */
  putChunk(id: string, data: Buffer): Promise<void>
  /**
   * Make a batch current: the target checks every chunk and every file by hash, then
   * switches in one step. A failure leaves its previous batch current and whole.
   */
  commit(manifest: BatchManifest): Promise<CommitResult>
}

/**
 * A batch as a remote transport sends it (remote-transport.ts, receive.ts): the files that
 * differ from the target's current batch `base` (all of them when `base` is null) and the
 * paths gone since. The receiver rebuilds the whole manifest from its own current batch and
 * takes it only when the rebuilt manifest's sha256 (of its JSON) is `hash`.
 */
export interface BatchUpload {
  format: 'walnut-standby-upload'
  version: 1
  /** The batch the delta is against: the target's current one when the leader read it. */
  base: number | null
  head: Omit<BatchManifest, 'files'>
  puts: BatchFile[]
  dels: string[]
  /** sha256 of JSON.stringify(manifest), the manifest the leader made. */
  hash: string
}
