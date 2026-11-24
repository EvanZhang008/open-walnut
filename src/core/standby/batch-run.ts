/**
 * What the passes and rounds of one batch share (batch.ts, batch-round.ts): its options and
 * stats, the copies it read so far, and the chunks the target holds or was sent.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BatchFile, BatchManifest, CommitResult, SourceStat, StandbyTransport } from './types.js'

export interface BatchOptions {
  home: string
  transport: StandbyTransport
  /** A dir of this machine on the home's filesystem, for the clock probe (emptied after each batch). */
  stagingDir: string
  /**
   * How long the hold waits after the writes under way ended, so their ctimes fall in an
   * earlier tick of the filesystem's clock than the moment's (default 15 ms; a tick is 1 to 10 ms).
   * Only makes a failed round rarer: the moment itself is read from the filesystem (fsClock).
   */
  settleMs?: number
  /** Longest wait for the writes under way when the hold starts. */
  drainMs?: number
  /** Changed plain files are read inside the hold while they total at most this (default 8 MB). */
  holdCopyBytes?: number
  /** Stop reading files in the hold once it has lasted this long (ms); the rest are read after it. */
  holdReadMs?: number
  /** Rounds (a hold and a moment each) before the batch is void (default 10). */
  maxRounds?: number
  /** Extra passes after a catch-up read that took long, before a round is tried anyway (default 8). */
  maxCatchUps?: number
  /** A catch-up read that took longer than this (ms) is followed by another pass, not a round (default 1000). */
  longReadMs?: number
  /** Files changed this long before the batch started, or since, are hot: the hold reads their stat (default 60 s). */
  hotWindowMs?: number
  /** At most this many hot files have their stat read in the hold, the newest first (default 4096). */
  holdStatFiles?: number
  /** Test hooks. */
  hooks?: {
    afterScan?: () => Promise<void> | void
    afterHold?: () => Promise<void> | void
    afterCopy?: (rel: string) => Promise<void> | void
  }
}

export interface BatchStats {
  /** The last pass's walk of the home. */
  scanMs: number
  /** The last round's walk after its moment. */
  rescanMs: number
  holdMs: number
  drainMs: number
  /** From the databases' pins to their end: the leader's WAL cannot be checkpointed past them meanwhile. */
  pinMs: number
  totalMs: number
  files: number
  databases: number
  /** Files read, over every pass and round (a file read twice counts twice). */
  stagedFiles: number
  stagedBytes: number
  sentChunks: number
  sentBytes: number
  pinAttempts: number
  /** Time the hold spent on the dirs' names at the moment. */
  namesMs: number
  /** Append-only files that had not only grown, so the general rule placed them. */
  appendFallbacks: number
  /** Walks of the home before the batch's moment (each round's, and each catch-up read's). */
  passes: number
  /** Rounds: holds, each with a moment of its own. */
  rounds: number
  /** Why each round that did not commit failed, in order. */
  roundFailures: string[]
  /** Time spent reading files before a hold (the catch-up reads). */
  catchUpMs: number
  /** Hot files whose stat the last hold read. */
  heldStatFiles: number
}

export type BatchOutcome =
  | { ok: true; manifest: BatchManifest; commit: CommitResult; stats: BatchStats }
  | { ok: false; reason: string; stats: BatchStats }

/** The batch cannot be taken now (an unreadable file, a database that cannot be opened, the target): nothing is committed. */
export class VoidBatch extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'VoidBatch'
  }
}

/** A round could not place a path at its moment: the batch walks the home again and tries a new moment. */
export class RoundFailed extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'RoundFailed'
  }
}

/** A whole copy of one plain file the batch read, and the stat that proves when it holds. */
export interface Proof {
  st: SourceStat
  x: boolean
  h: string
  size: number
  chunks: string[]
  /**
   * The clock reading its ctime was checked against (stage.ts): when it is the round's moment,
   * the copy is the file at the moment; else it is, while a stat read after the moment equals `st`.
   */
  checkedAt: number
}

export interface BatchRun {
  opts: BatchOptions
  stats: BatchStats
  /** This batch's own staging dir (the clock probe). */
  stagingDir: string
  /** The target's current batch, by path. */
  prev: Map<string, BatchFile>
  /** Copies read by this batch, by path: kept across rounds, so no round reads a file that did not change again. */
  proofs: Map<string, Proof>
  /** Why the last read of a path was not taken (late, changed, gone): it is hot. */
  readFailures: Map<string, string>
  /** Files whose ctime is at or past this (the filesystem's clock) are hot. */
  hotSince: number
  /** Send a chunk the target lacks. */
  send(id: string, data: Buffer): Promise<void>
  /** Chunks the target holds or was sent in this batch. */
  known: Set<string>
}

export function newStats(): BatchStats {
  return { scanMs: 0, rescanMs: 0, holdMs: 0, drainMs: 0, pinMs: 0, totalMs: 0, files: 0, databases: 0, stagedFiles: 0, stagedBytes: 0, sentChunks: 0, sentBytes: 0, pinAttempts: 0, namesMs: 0, appendFallbacks: 0, passes: 0, rounds: 0, roundFailures: [], catchUpMs: 0, heldStatFiles: 0 }
}

/** A database's change detector: its own stat, moved on by its -wal's (size, times and head). */
export async function databaseStat(abs: string): Promise<SourceStat> {
  const db = await fs.lstat(abs)
  const wal = await fs.lstat(`${abs}-wal`).catch(() => null)
  let w: string | undefined
  if (wal) {
    const fh = await fs.open(`${abs}-wal`, 'r').catch(() => null)
    if (fh) {
      try {
        const head = Buffer.alloc(32)
        const { bytesRead } = await fh.read(head, 0, 32, 0)
        w = head.subarray(0, bytesRead).toString('hex')
      } finally {
        await fh.close()
      }
    }
  }
  return {
    s: db.size + (wal ? wal.size : 0),
    m: Math.max(db.mtimeMs, wal?.mtimeMs ?? 0),
    c: Math.max(db.ctimeMs, wal?.ctimeMs ?? 0),
    i: db.ino,
    ...(w === undefined ? {} : { w }),
  }
}

/**
 * Now, as the filesystem's clock reads it: the ctime of a probe written into the staging dir.
 * A file's ctime comes from a coarse kernel clock that lags the wall clock by up to a tick
 * (10 ms measured on Linux), so comparing it with Date.now() could place a write after the
 * moment before it. Every write after the probe has a ctime at or past the probe's, and one in
 * the same tick ties: so "ctime < probe" proves "written before the probe". The staging dir
 * must be on the home's filesystem (it is by default: the home's tmp/).
 */
export async function fsClock(stagingDir: string, home: string): Promise<number> {
  await fs.mkdir(stagingDir, { recursive: true })
  const probe = path.join(stagingDir, 'clock-probe')
  await fs.writeFile(probe, String(Date.now()))
  const [st, h] = await Promise.all([fs.lstat(probe), fs.stat(home)])
  if (st.dev !== h.dev) throw new VoidBatch(`the staging dir ${stagingDir} is not on the home's filesystem`)
  return st.ctimeMs
}

export function fileEntry(p: string, size: number, h: string, chunks: string[], x: boolean, src: SourceStat, db: boolean): BatchFile {
  const f: BatchFile = { p, size, h, src }
  const plain = size === 0 ? [] : [h]
  if (chunks.length !== plain.length || chunks[0] !== plain[0]) f.b = chunks
  if (x) f.x = 1
  if (db) f.db = 1
  return f
}

export function proofEntry(p: string, proof: Proof): BatchFile {
  return fileEntry(p, proof.size, proof.h, proof.chunks, proof.x, proof.st, false)
}
