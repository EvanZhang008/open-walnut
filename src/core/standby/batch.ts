/**
 * Take one batch of the leader's home and send it to a standby target: everything the
 * manifest classes `leader-data`, as it was at one moment, or nothing at all.
 *
 *   1. scan       walk the home (scan.ts), diff against the target's current batch
 *   2. hold       hold Walnut's gated writes (src/utils/write-gate.ts) and let the ones under way
 *                 end; note the stat of every database; pin every database at one moment
 *                 (sqlite-pin.ts), the moment read on the filesystem's clock (fsClock); read the
 *                 changed plain files into memory if they are small; let writes go
 *   3. stage      copy each changed database as pinned, and read the changed files not yet read
 *   4. re-scan    walk again: a file that moved since step 1 is taken now if its last change
 *                 came before the moment, and voids the batch if it changed after the moment
 *                 without a copy of it from before (its content at the moment is unknown)
 *   5. send       the chunks the target lacks, then commit; the target checks every hash
 *
 * Every copy follows stage.ts's rule. Any file that cannot be read, any database that cannot
 * be pinned or copied, any change the steps cannot place before or after the moment, and the
 * batch is void: nothing is committed and the target's position does not move.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { holdWrites } from '../../utils/write-gate.js'
import type { ChunkSink, FileDigest } from './chunks.js'
import { scanHome, sameStat, toSourceStat, type ScanEntry } from './scan.js'
import { openPinWorker, type Pin, type PinWorker } from './sqlite-pin.js'
import { stageFile, type StageContext, type StageOutcome } from './stage.js'
import { STANDBY_FORMAT, STANDBY_VERSION, chunkIds, type BatchFile, type BatchManifest, type CommitResult, type SourceStat, type StandbyTransport } from './types.js'

export interface BatchOptions {
  home: string
  transport: StandbyTransport
  /** A dir of this machine on the home's filesystem, for the clock probe (emptied after each batch). */
  stagingDir: string
  /**
   * How long the hold waits after the writes under way ended, so their ctimes fall in an
   * earlier tick of the filesystem's clock than the moment's (default 15 ms; a tick is 1 to 10 ms).
   * Only makes a void batch rarer: the moment itself is read from the filesystem (fsClock).
   */
  settleMs?: number
  /** Longest wait for the writes under way when the hold starts. */
  drainMs?: number
  /** Changed plain files are copied inside the hold while they total at most this (default 8 MB). */
  holdCopyBytes?: number
  /** Test hooks. */
  hooks?: {
    afterScan?: () => Promise<void> | void
    afterHold?: () => Promise<void> | void
    afterCopy?: (rel: string) => Promise<void> | void
  }
}

export interface BatchStats {
  scanMs: number
  rescanMs: number
  holdMs: number
  drainMs: number
  totalMs: number
  files: number
  databases: number
  stagedFiles: number
  stagedBytes: number
  sentChunks: number
  sentBytes: number
  pinAttempts: number
}

export type BatchOutcome =
  | { ok: true; manifest: BatchManifest; commit: CommitResult; stats: BatchStats }
  | { ok: false; reason: string; stats: BatchStats }

export class VoidBatch extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'VoidBatch'
  }
}

/** A database's change detector: its own stat, moved on by its -wal's. */
async function databaseStat(abs: string): Promise<SourceStat> {
  const db = await fs.lstat(abs)
  const wal = await fs.lstat(`${abs}-wal`).catch(() => null)
  return {
    s: db.size + (wal ? wal.size : 0),
    m: Math.max(db.mtimeMs, wal?.mtimeMs ?? 0),
    c: Math.max(db.ctimeMs, wal?.ctimeMs ?? 0),
    i: db.ino,
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
async function fsClock(stagingDir: string, home: string): Promise<number> {
  await fs.mkdir(stagingDir, { recursive: true })
  const probe = path.join(stagingDir, 'clock-probe')
  await fs.writeFile(probe, String(Date.now()))
  const [st, h] = await Promise.all([fs.lstat(probe), fs.stat(home)])
  if (st.dev !== h.dev) throw new VoidBatch(`the staging dir ${stagingDir} is not on the home's filesystem`)
  return st.ctimeMs
}

/** The nearest existing dir above `rel`: its ctime says when an entry under it last went. */
async function parentCtime(home: string, rel: string): Promise<number> {
  let dir = path.dirname(rel)
  for (;;) {
    const st = await fs.lstat(dir === '.' ? home : path.join(home, dir)).catch(() => null)
    if (st) return st.ctimeMs
    if (dir === '.') return Number.POSITIVE_INFINITY
    dir = path.dirname(dir)
  }
}

export async function takeBatch(opts: BatchOptions): Promise<BatchOutcome> {
  const started = performance.now()
  const stats: BatchStats = { scanMs: 0, rescanMs: 0, holdMs: 0, drainMs: 0, totalMs: 0, files: 0, databases: 0, stagedFiles: 0, stagedBytes: 0, sentChunks: 0, sentBytes: 0, pinAttempts: 0 }
  const settleMs = opts.settleMs ?? 15
  const stagingDir = path.join(opts.stagingDir, `batch-${process.pid}-${Date.now()}`)
  let worker: PinWorker | null = null
  try {
    const { state, files: prevFiles } = await opts.transport.current()
    const prev = new Map(prevFiles.map((f) => [f.p, f]))

    // 1. scan
    const s1 = await scanHome(opts.home)
    stats.scanMs = s1.ms
    if (s1.unreadable.length) throw new VoidBatch(`cannot read ${s1.unreadable.slice(0, 5).join(', ')}`)
    await opts.hooks?.afterScan?.()
    const dbs = [...s1.files.values()].filter((e) => e.db).sort((a, b) => a.p.localeCompare(b.p))
    const plain = [...s1.files.values()].filter((e) => !e.db)
    const changed = plain.filter((e) => !sameStat(e.st, prev.get(e.p)?.src) || prev.get(e.p)?.db)
    stats.databases = dbs.length

    // 2. hold
    const staged = new Map<string, Extract<StageOutcome, { ok: true }>>()
    const dbStats = new Map<string, SourceStat>()
    /** Databases whose stat did not move across the pins: their pinned state is the stat's. */
    const steady = new Set<string>()
    let ctx!: StageContext
    /** Chunks the target holds or was sent in this batch. */
    const known = new Set<string>()
    const send = async (id: string, data: Buffer): Promise<void> => {
      if (known.has(id)) return
      known.add(id)
      if (!(await opts.transport.missing([id])).size) return
      await opts.transport.putChunk(id, data)
      stats.sentChunks++
      stats.sentBytes += data.length
    }
    /** What the hold read, kept in memory until the writes go again (the staging area). */
    const heldChunks = new Map<string, Buffer>()
    const keep = (id: string, data: Buffer) => { heldChunks.set(id, Buffer.from(data)) }
    const stage = async (rel: string, sink: ChunkSink): Promise<void> => {
      const out = await stageFile(rel, ctx, sink)
      if (!out.ok) throw new VoidBatch(`${rel}: ${out.why}${out.detail ? ` (${out.detail})` : ''}`)
      staged.set(rel, out)
      stats.stagedFiles++
      stats.stagedBytes += out.size
    }
    try {
      worker = await openPinWorker(dbs.map((d) => path.join(opts.home, d.p)))
    } catch (err) {
      throw new VoidBatch(`databases cannot be opened: ${err instanceof Error ? err.message : String(err)}`)
    }
    const pinner: PinWorker = worker
    const dbStatAll = () => Promise.all(dbs.map(async (d) => [d.p, await databaseStat(path.join(opts.home, d.p))] as const))
    let pin: Pin | null = null
    /** The moment and the end of the pins, on the filesystem's own clock (fsClock). */
    let fsMoment = 0
    let fsAfter = 0
    const hold = await holdWrites(async () => {
      // Gated writes that ended just now should land in an earlier tick than the moment.
      await new Promise((r) => setTimeout(r, settleMs))
      fsMoment = await fsClock(stagingDir, opts.home)
      try {
        for (const [p, st] of await dbStatAll()) dbStats.set(p, st)
      } catch (err) {
        throw new VoidBatch(`a database cannot be read (${String(err)})`)
      }
      try {
        pin = await pinner.pin()
      } catch (err) {
        throw new VoidBatch(`databases cannot be pinned: ${err instanceof Error ? err.message : String(err)}`)
      }
      for (const [p, st] of await dbStatAll().catch(() => [] as Array<readonly [string, SourceStat]>)) {
        if (sameStat(st, dbStats.get(p))) steady.add(p)
      }
      fsAfter = await fsClock(stagingDir, opts.home)
      ctx = { home: opts.home, momentMs: fsMoment, afterCopy: opts.hooks?.afterCopy }
      const budget = opts.holdCopyBytes ?? 8 * 1024 * 1024
      if (changed.reduce((n, e) => n + e.st.s, 0) <= budget) for (const e of changed) await stage(e.p, keep)
    }, { drainMs: opts.drainMs ?? 300 })
    stats.holdMs = hold.holdMs
    stats.drainMs = hold.drainMs
    if (!hold.drained) throw new VoidBatch('writes under way did not end within the hold')
    const pinned: Pin | null = pin
    if (!pinned) throw new VoidBatch('databases were not pinned')
    stats.pinAttempts = (pinned as Pin).attempts
    await opts.hooks?.afterHold?.()
    for (const [id, data] of heldChunks) await send(id, data)
    heldChunks.clear()

    // 3. stage: the changed databases as pinned, then the files the hold did not copy
    const out = new Map<string, BatchFile>()
    for (let i = 0; i < dbs.length; i++) {
      const d = dbs[i]
      const src = dbStats.get(d.p)!
      const last = prev.get(d.p)
      // Unchanged since the last batch's stat, and no commit between this stat and the pins.
      if (last?.db && sameStat(last.src, src) && steady.has(d.p)) { out.set(d.p, last); continue }
      let dig: FileDigest
      try {
        dig = await pinner.copy(i)
        const missing = await opts.transport.missing(dig.chunks.filter((id) => !known.has(id)))
        const want = dig.chunks.map((id, at) => (missing.has(id) ? at : -1)).filter((at) => at >= 0)
        for (let k = 0; k < want.length; k += 32) {
          const part = want.slice(k, k + 32)
          const data = await pinner.chunks(part)
          for (let j = 0; j < part.length; j++) await send(dig.chunks[part[j]], data[j])
        }
        await pinner.drop()
      } catch (err) {
        throw new VoidBatch(`database ${d.p} cannot be copied: ${err instanceof Error ? err.message : String(err)}`)
      }
      stats.stagedFiles++
      stats.stagedBytes += dig.size
      out.set(d.p, fileEntry(d.p, dig.size, dig.h, dig.chunks, false, src, true))
    }
    await pinner.close()
    for (const e of changed) if (!staged.has(e.p)) await stage(e.p, send)

    // 4. re-scan: place every move since step 1 before or after the moment
    const s2 = await scanHome(opts.home)
    stats.rescanMs = s2.ms
    if (s2.unreadable.length) throw new VoidBatch(`cannot read ${s2.unreadable.slice(0, 5).join(', ')}`)
    const before = fsMoment
    const bornAfter = async (rel: string): Promise<boolean> => {
      const born = await fs.lstat(path.join(opts.home, rel)).then((st) => st.birthtimeMs).catch(() => 0)
      return born > fsAfter
    }
    for (const [rel, now] of s2.files) {
      const then = s1.files.get(rel)
      if (now.db && !then) {
        // A database made since step 1 was not pinned: fine only when it was made after the moment.
        if (await bornAfter(rel)) continue
        throw new VoidBatch(`database ${rel} appeared around the batch's moment`)
      }
      if (now.db || out.has(rel) || then?.db) continue
      if (staged.has(rel)) continue // copied with its content at the moment; a later change is the next batch's
      if (then && sameStat(then.st, now.st)) continue
      // New since step 1 and born after the moment: the next batch's.
      if (!then && await bornAfter(rel)) continue
      if (now.st.c < before) { await stage(rel, send); continue }
      throw new VoidBatch(`${rel} changed after the batch's moment, and its content at the moment is unknown`)
    }
    for (const [rel, then] of s1.files) {
      if (then.db || s2.files.has(rel) || staged.has(rel)) continue
      // Gone since step 1: gone before the moment, it is out of the batch; else unknown.
      if (await parentCtime(opts.home, rel) >= before) throw new VoidBatch(`${rel} was removed around the batch's moment`)
    }

    // The batch: every file of the moment.
    for (const [rel, e] of s1.files) {
      if (e.db || out.has(rel)) continue
      const st = staged.get(rel)
      if (st) { out.set(rel, fileEntry(rel, st.size, st.h, st.chunks, st.x, st.st, false)); continue }
      if (!s2.files.has(rel)) continue
      const last = prev.get(rel)
      if (!last) throw new VoidBatch(`${rel} has neither a copy nor a previous batch`)
      out.set(rel, last)
    }
    for (const [rel, st] of staged) if (!out.has(rel)) out.set(rel, fileEntry(rel, st.size, st.h, st.chunks, st.x, st.st, false))

    // 5. commit (every chunk was sent as it was read)
    const manifest: BatchManifest = {
      format: STANDBY_FORMAT,
      version: STANDBY_VERSION,
      batch: (state.current?.batch ?? 0) + 1,
      takenAt: new Date((pinned as Pin).pinnedAt).toISOString(),
      files: [...out.values()].sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)),
    }
    stats.files = manifest.files.length
    const commit = await opts.transport.commit(manifest)
    stats.totalMs = performance.now() - started
    return { ok: true, manifest, commit, stats }
  } catch (err) {
    stats.totalMs = performance.now() - started
    if (err instanceof VoidBatch) return { ok: false, reason: err.message, stats }
    return { ok: false, reason: err instanceof Error ? err.message : String(err), stats }
  } finally {
    await (worker as PinWorker | null)?.close().catch(() => {})
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

function fileEntry(p: string, size: number, h: string, chunks: string[], x: boolean, src: SourceStat, db: boolean): BatchFile {
  const f: BatchFile = { p, size, h, src }
  const plain = size === 0 ? [] : [h]
  if (chunks.length !== plain.length || chunks[0] !== plain[0]) f.b = chunks
  if (x) f.x = 1
  if (db) f.db = 1
  return f
}

export type { ScanEntry }
export { toSourceStat, chunkIds }
