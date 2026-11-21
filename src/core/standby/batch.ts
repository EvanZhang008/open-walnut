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
import { DB_NAME, scanHome, sameStat, toSourceStat, type ScanEntry } from './scan.js'
import { namesAtMoment, type MomentNames } from './moment-names.js'
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
  /** Time the hold spent on the dirs' names at the moment. */
  namesMs: number
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
async function fsClock(stagingDir: string, home: string): Promise<number> {
  await fs.mkdir(stagingDir, { recursive: true })
  const probe = path.join(stagingDir, 'clock-probe')
  await fs.writeFile(probe, String(Date.now()))
  const [st, h] = await Promise.all([fs.lstat(probe), fs.stat(home)])
  if (st.dev !== h.dev) throw new VoidBatch(`the staging dir ${stagingDir} is not on the home's filesystem`)
  return st.ctimeMs
}

export async function takeBatch(opts: BatchOptions): Promise<BatchOutcome> {
  const started = performance.now()
  const stats: BatchStats = { scanMs: 0, rescanMs: 0, holdMs: 0, drainMs: 0, totalMs: 0, files: 0, databases: 0, stagedFiles: 0, stagedBytes: 0, sentChunks: 0, sentBytes: 0, pinAttempts: 0, namesMs: 0 }
  const settleMs = opts.settleMs ?? 15
  const stagingDir = path.join(opts.stagingDir, `batch-${process.pid}-${Date.now()}`)
  let worker: PinWorker | null = null
  try {
    const { state, files: prevFiles } = await opts.transport.current()
    const prev = new Map(prevFiles.map((f) => [f.p, f]))

    // 1. scan. The clock before it: a dir whose ctime is at or past this may have gained a
    // name in the same tick the scan listed it (a tick is coarse), so the hold lists it again.
    const scanClock = await fsClock(stagingDir, opts.home)
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
    /** The moment, on the filesystem's own clock (fsClock). */
    let fsMoment = 0
    let names: MomentNames | null = null
    const hold = await holdWrites(async () => {
      // Gated writes that ended just now should land in an earlier tick than the moment.
      await new Promise((r) => setTimeout(r, settleMs))
      fsMoment = await fsClock(stagingDir, opts.home)
      try {
        for (const [p, st] of await dbStatAll()) dbStats.set(p, st)
      } catch (err) {
        throw new VoidBatch(`a database cannot be read (${String(err)})`)
      }
      // A database replaced since the scan (a new inode) is not the file the worker opened.
      for (const d of dbs) if (dbStats.get(d.p)!.i !== d.st.i) throw new VoidBatch(`database ${d.p} was replaced around the batch's moment`)
      try {
        pin = await pinner.pin()
      } catch (err) {
        throw new VoidBatch(`databases cannot be pinned: ${err instanceof Error ? err.message : String(err)}`)
      }
      for (const [p, st] of await dbStatAll().catch(() => [] as Array<readonly [string, SourceStat]>)) {
        if (sameStat(st, dbStats.get(p))) steady.add(p)
      }
      names = await namesAtMoment(opts.home, s1, fsMoment, scanClock)
      // A dir that also changed after the moment: a name made and removed around the moment is
      // in neither listing, so the names at the moment cannot be told.
      if (names.unsettled.length) throw new VoidBatch(`${names.unsettled.slice(0, 3).map((d) => d || '.').join(', ')}: names changed at the batch's moment`)
      ctx = { home: opts.home, momentMs: fsMoment, afterCopy: opts.hooks?.afterCopy }
      // Read the changed files in the hold, smallest first, as far as the budget goes: each one
      // read now is one no write after the moment can void. The rest are read after it.
      let room = opts.holdCopyBytes ?? 8 * 1024 * 1024
      for (const e of [...changed].sort((a, b) => a.st.s - b.st.s)) {
        if (e.st.s > room) break
        room -= e.st.s
        await stage(e.p, keep)
      }
      // Files made since the scan that existed at the moment: read them while writes are held.
      const made = names.listed.filter((rel) => !s1.files.has(rel) && !staged.has(rel) && !DB_NAME.test(rel) && names!.existed(rel) === true)
      for (const rel of made) {
        const size = await fs.lstat(path.join(opts.home, rel)).then((st) => st.size).catch(() => 0)
        if (size > room) break
        room -= size
        await stage(rel, keep)
      }
    }, { drainMs: opts.drainMs ?? 300 })
    stats.holdMs = hold.holdMs
    stats.drainMs = hold.drainMs
    if (!hold.drained) throw new VoidBatch('writes under way did not end within the hold')
    const pinned: Pin | null = pin
    if (!pinned) throw new VoidBatch('databases were not pinned')
    stats.pinAttempts = (pinned as Pin).attempts
    await opts.hooks?.afterHold?.()
    const atMoment: MomentNames = names as unknown as MomentNames
    stats.namesMs = atMoment.ms
    for (const [id, data] of heldChunks) await send(id, data)
    heldChunks.clear()

    // 3. stage the changed files the hold did not read (the databases are pinned: they wait)
    for (const e of changed) if (!staged.has(e.p)) await stage(e.p, send)

    // 4. re-scan, and place every path of either scan or of the moment's dirs
    const s2 = await scanHome(opts.home)
    stats.rescanMs = s2.ms
    if (s2.unreadable.length) throw new VoidBatch(`cannot read ${s2.unreadable.slice(0, 5).join(', ')}`)
    const out = new Map<string, BatchFile>()
    const dbPaths = new Set(dbs.map((d) => d.p))
    const paths = new Set([...s1.files.keys(), ...s2.files.keys(), ...staged.keys(), ...atMoment.listed])
    for (const rel of [...paths].sort()) {
      const existed = atMoment.existed(rel)
      if (existed === false) continue
      if (existed === null) throw new VoidBatch(`${rel}: whether it existed at the batch's moment is unknown`)
      const then = s1.files.get(rel)
      const now = s2.files.get(rel)
      if (dbPaths.has(rel)) continue // pinned: copied below
      if (then?.db || now?.db) throw new VoidBatch(`database ${rel} appeared around the batch's moment`)
      const st = staged.get(rel)
      if (st) { out.set(rel, fileEntry(rel, st.size, st.h, st.chunks, st.x, st.st, false)); continue }
      const last = prev.get(rel)
      // Unchanged from the last batch through both scans: its content at the moment is the last batch's.
      if (then && now && last && sameStat(then.st, now.st)) { out.set(rel, last); continue }
      // Unchanged from the last batch to the scan, and from the scan to the hold (its stat read
      // there): the last batch's too, however it changed after the moment.
      const held = atMoment.heldStats.get(rel)
      if (then && last && held && sameStat(then.st, last.src) && sameStat(held, then.st)) { out.set(rel, last); continue }
      // Changed or made since the first scan, last changed before the moment: read it now.
      if (now && now.st.c < fsMoment) {
        await stage(rel, send)
        const got = staged.get(rel)!
        out.set(rel, fileEntry(rel, got.size, got.h, got.chunks, got.x, got.st, false))
        continue
      }
      throw new VoidBatch(`${rel} changed or went after the batch's moment, and its content at the moment is unknown`)
    }
    for (const rel of s2.files.keys()) {
      if (s2.files.get(rel)!.db && !dbPaths.has(rel) && atMoment.existed(rel) !== false) throw new VoidBatch(`database ${rel} appeared around the batch's moment`)
    }

    // 5. copy each changed database as pinned (pinned since the moment, so any time is fine)
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

    // 6. commit (every chunk was sent as it was read)
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
