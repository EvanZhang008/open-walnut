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
}

/**
 * How a batch reaches a target. This phase has one, local (local-transport.ts: a target
 * directory on this machine). A remote one implements the same four calls.
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
