/**
 * One round of a batch (batch.ts): one moment, and every path of the home placed at it from the
 * copies the batch holds, or a failed round (RoundFailed) that the batch follows with a new walk
 * of the home and a new moment. Nothing a round reads is lost when it fails: the copies stay
 * with the batch, so the next round reads only what changed again.
 *
 *   1. hold   hold Walnut's gated writes (src/utils/write-gate.ts) and let the ones under way
 *             end; mark the append-only files (append-only.ts); read the moment on the
 *             filesystem's clock; note and pin every database (sqlite-pin.ts); list again every
 *             dir that changed since the walk (moment-names.ts); read the stat of each hot file
 *             (changed lately, or a read of it was not taken); read the small files whose stat
 *             now proves no copy the batch holds; let writes go
 *   2. copy   each changed database as pinned, first: each one's pin ends once it is copied
 *   3. place  walk again, and give each path that existed at the moment its content then, by its
 *             kind's rule (change-rules.ts): a database as pinned; an append-only file's bytes up
 *             to its mark; a git object any whole copy of its name; any other file a copy whose
 *             stat a stat read after the moment still equals, or a read now when its last change
 *             came before the moment. A path none of these places fails the round.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { holdWrites } from '../../utils/write-gate.js'
import { isAppendOnlyHomePath } from '../home-manifest/index.js'
import { markAppendOnly, stagePrefix, type AppendMark } from './append-only.js'
import { RoundFailed, VoidBatch, databaseStat, fileEntry, fsClock, proofEntry, type BatchRun } from './batch-run.js'
import { isContentAddressed, isObjectStoreDir } from './change-rules.js'
import type { ChunkSink, FileDigest } from './chunks.js'
import { DB_NAME, limiter, sameStat, scanHome, toSourceStat, type ScanEntry, type ScanResult } from './scan.js'
import { namesAtMoment, type MomentNames } from './moment-names.js'
import { openPinWorker, type Pin, type PinWorker } from './sqlite-pin.js'
import { stageFile, type StageContext, type StageOutcome } from './stage.js'
import type { BatchFile, SourceStat } from './types.js'

export interface RoundResult {
  files: Map<string, BatchFile>
  /** When the databases were pinned (wall clock): the batch's `takenAt`. */
  pinnedAt: number
}

/** Keep a read the batch takes; note one it does not (its path is hot from now on). An unreadable file voids the batch. */
export function recordRead(run: BatchRun, out: StageOutcome, checkedAt: number, failed?: Map<string, string>): boolean {
  if (out.ok) {
    run.proofs.set(out.rel, { st: out.st, x: out.x, h: out.h, size: out.size, chunks: out.chunks, checkedAt })
    run.readFailures.delete(out.rel)
    run.stats.stagedFiles++
    run.stats.stagedBytes += out.size
    return true
  }
  const why = `${out.why}${out.detail ? ` (${out.detail})` : ''}`
  if (out.why === 'unreadable') throw new VoidBatch(`${out.rel}: ${why}`)
  run.readFailures.set(out.rel, why)
  failed?.set(out.rel, why)
  return false
}

/** Whether the batch holds a copy of `e` as the walk saw it (the last batch's, or one it read). */
export function hasCopy(run: BatchRun, e: ScanEntry): boolean {
  const last = run.prev.get(e.p)
  const proof = run.proofs.get(e.p)
  if (isContentAddressed(e.p)) return (!!last && !last.db && last.size === e.st.s) || (!!proof && proof.size === e.st.s)
  return (!!last && !last.db && sameStat(e.st, last.src)) || (!!proof && sameStat(e.st, proof.st))
}

export async function runRound(run: BatchRun, s1: ScanResult, scanClock: number): Promise<RoundResult> {
  const { opts, stats, prev, proofs } = run
  const home = opts.home
  const settleMs = opts.settleMs ?? 15
  const dbs = [...s1.files.values()].filter((e) => e.db).sort((a, b) => a.p.localeCompare(b.p))
  const plain = [...s1.files.values()].filter((e) => !e.db)
  // Append-only files are taken up to their size when marked in the hold (append-only.ts).
  const appendOnly = plain.filter((e) => isAppendOnlyHomePath(e.p)).map((e) => e.p)
  const appendSet = new Set(appendOnly)
  const marks = new Map<string, AppendMark>()
  stats.databases = dbs.length
  // Hot: changed lately, or a read of it was not taken. Each is likely to change again, so the
  // hold reads its stat, which then proves (or not) the copy the batch holds.
  const hot = plain
    .filter((e) => !appendSet.has(e.p) && !isContentAddressed(e.p) && (e.st.c >= run.hotSince || run.readFailures.has(e.p)))
    .sort((a, b) => b.st.c - a.st.c)
    .slice(0, opts.holdStatFiles ?? 4096)
    .map((e) => e.p)
  /** Reads of this round that were not taken, for the reason a failed round gives. */
  const failed = new Map<string, string>()

  /** The copy of `rel` that `st`, a stat read after the moment, proves was the file at the moment. */
  const provenBy = (rel: string, st: SourceStat | undefined): BatchFile | null => {
    if (!st) return null
    const proof = proofs.get(rel)
    if (proof && sameStat(st, proof.st)) return proofEntry(rel, proof)
    const last = prev.get(rel)
    if (last && !last.db && sameStat(st, last.src)) return last
    return null
  }

  let worker: PinWorker | null = null
  try {
    try {
      worker = await openPinWorker(dbs.map((d) => path.join(home, d.p)))
    } catch (err) {
      throw new VoidBatch(`databases cannot be opened: ${err instanceof Error ? err.message : String(err)}`)
    }
    const pinner: PinWorker = worker
    const dbStatAll = () => Promise.all(dbs.map(async (d) => [d.p, await databaseStat(path.join(home, d.p))] as const))
    const dbStats = new Map<string, SourceStat>()
    /** Databases whose stat did not move across the pins: their pinned state is the stat's. */
    const steady = new Set<string>()
    let pin: Pin | null = null
    let pinnedFrom = 0
    /** The moment, on the filesystem's own clock (fsClock). */
    let moment = 0
    let names: MomentNames | null = null
    /** Stats read in the hold, after the moment: the changed dirs' files and the hot files. */
    const held = new Map<string, SourceStat>()
    /** What the hold read, kept in memory until the writes go again. */
    const heldChunks = new Map<string, Buffer>()
    const keep: ChunkSink = (id, data) => { heldChunks.set(id, Buffer.from(data)) }
    let ctx!: StageContext

    // 1. hold
    let hold: Awaited<ReturnType<typeof holdWrites>>
    try {
      hold = await holdWrites(async () => {
        const holdStart = performance.now()
        const timeLeft = () => performance.now() - holdStart < (opts.holdReadMs ?? 200)
        // Gated writes that ended just now should land in an earlier tick than the moment.
        await new Promise((r) => setTimeout(r, settleMs))
        // Just before the moment: what each append-only file holds then is the batch's (one
        // unchanged since the last batch is only stat'ed).
        const markSlot = limiter(64)
        await Promise.all(appendOnly.map((rel) => markSlot(async () => {
          const last = prev.get(rel)
          const mark = await markAppendOnly(path.join(home, rel), last && !last.db ? last.src : undefined)
          if (mark) marks.set(rel, mark)
        })))
        moment = await fsClock(run.stagingDir, home)
        try {
          for (const [p, st] of await dbStatAll()) dbStats.set(p, st)
        } catch (err) {
          throw new RoundFailed(`a database cannot be read (${String(err)})`)
        }
        // A database replaced since the walk (a new inode) is not the file the worker opened.
        for (const d of dbs) if (dbStats.get(d.p)!.i !== d.st.i) throw new RoundFailed(`database ${d.p} was replaced around the batch's moment`)
        try {
          pin = await pinner.pin()
          pinnedFrom = performance.now()
        } catch (err) {
          throw new RoundFailed(`databases cannot be pinned: ${err instanceof Error ? err.message : String(err)}`)
        }
        for (const [p, st] of await dbStatAll().catch(() => [] as Array<readonly [string, SourceStat]>)) {
          if (sameStat(st, dbStats.get(p))) steady.add(p)
        }
        ctx = { home, momentMs: moment, afterCopy: opts.hooks?.afterCopy }
        let room = opts.holdCopyBytes ?? 8 * 1024 * 1024
        /** Read these in the hold, smallest first, as far as the budget goes: a read now is one no write after the moment can undo. */
        const readInHold = async (files: Array<{ rel: string; size: number }>) => {
          for (const { rel, size } of files.sort((a, b) => a.size - b.size)) {
            if (size > room || !timeLeft()) return
            room -= size
            recordRead(run, await stageFile(rel, ctx, keep), moment, failed)
          }
        }
        /** A plain file whose stat, read after the moment, proves no copy the batch holds: it changed since. */
        const changedSince = (rel: string, st: SourceStat) => !appendSet.has(rel) && !isContentAddressed(rel) && !DB_NAME.test(rel) && !s1.files.get(rel)?.db && !provenBy(rel, st)
        // The hot files first, right after the moment: the sooner a stat after it, the less likely
        // a writer outside the gate moved the file in between. One that changed before the moment
        // since its copy is read at once.
        const statSlot = limiter(64)
        await Promise.all(hot.map((rel) => statSlot(async () => {
          const st = await fs.lstat(path.join(home, rel)).catch(() => null)
          if (st?.isFile()) held.set(rel, toSourceStat(st))
        })))
        stats.heldStatFiles = hot.length
        await readInHold([...held].filter(([rel, st]) => st.c < moment && changedSince(rel, st)).map(([rel, st]) => ({ rel, size: st.s })))
        const atMoment = await namesAtMoment(home, s1, moment, scanClock)
        names = atMoment
        // A dir that also changed after the moment: a name made and removed around it is in
        // neither listing, so its names then cannot be told. Git's object store is the exception
        // (change-rules.ts isObjectStoreDir): its names are placed one by one below.
        const unsettled = atMoment.unsettled.filter((d) => !isObjectStoreDir(d))
        if (unsettled.length) throw new RoundFailed(`${unsettled.slice(0, 3).map((d) => d || '.').join(', ')}: names changed at the batch's moment`)
        for (const [rel, st] of atMoment.heldStats) if (!held.has(rel)) held.set(rel, st)
        // Then the changed dirs' files: each one that changed since its copy and existed at the
        // moment, and each git object new since the walk (read before a repack can remove it).
        await readInHold([...atMoment.heldStats]
          .filter(([rel]) => proofs.get(rel)?.checkedAt !== moment)
          .filter(([rel, st]) => (isContentAddressed(rel) ? !proofs.has(rel) && !prev.has(rel) && atMoment.existed(rel) !== false : atMoment.existed(rel) === true && changedSince(rel, st)))
          .map(([rel, st]) => ({ rel, size: st.s })))
      }, { drainMs: opts.drainMs ?? 300 })
    } finally {
      // What the hold read is the batch's copy whether or not this round goes on (the next
      // round takes it while its stat holds): its chunks go to the target either way.
      for (const [id, data] of heldChunks) await run.send(id, data)
      heldChunks.clear()
    }
    stats.holdMs = hold.holdMs
    stats.drainMs = hold.drainMs
    if (!hold.drained) throw new RoundFailed('writes under way did not end within the hold')
    const pinned: Pin | null = pin
    if (!pinned) throw new RoundFailed('databases were not pinned')
    stats.pinAttempts = (pinned as Pin).attempts
    await opts.hooks?.afterHold?.()
    const atMoment: MomentNames = names as unknown as MomentNames
    stats.namesMs = atMoment.ms

    // 2. copy each changed database as pinned, first: each one's pin ends once it is copied (the
    // chunks wait in the transport, never on the link), so the leader's WAL is checkpointed again
    // while the files are read and sent
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
        const missing = await opts.transport.missing(dig.chunks.filter((id) => !run.known.has(id)))
        const want = dig.chunks.map((id, at) => (missing.has(id) ? at : -1)).filter((at) => at >= 0)
        for (let k = 0; k < want.length; k += 32) {
          const part = want.slice(k, k + 32)
          const data = await pinner.chunks(part)
          for (let j = 0; j < part.length; j++) await run.send(dig.chunks[part[j]], data[j])
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
    stats.pinMs = performance.now() - pinnedFrom
    // The git objects new since the walk that the hold had no room for: read now, before a
    // repack can remove them (a git object's copy holds at any time).
    for (const rel of atMoment.listed) {
      if (isContentAddressed(rel) && !proofs.has(rel) && !prev.has(rel) && atMoment.existed(rel) !== false) recordRead(run, await stageFile(rel, ctx, run.send), moment, failed)
    }

    // 3. walk again, and place every path of either walk or of the moment's dirs
    const s2 = await scanHome(home)
    stats.rescanMs = s2.ms
    if (s2.unreadable.length) throw new VoidBatch(`cannot read ${s2.unreadable.slice(0, 5).join(', ')}`)
    const dbPaths = new Set(dbs.map((d) => d.p))
    /** Read `rel` now, by the moment's rule; the copy when the read is taken. */
    const readNow = async (rel: string): Promise<BatchFile | null> => {
      if (!recordRead(run, await stageFile(rel, ctx, run.send), moment, failed)) return null
      return proofEntry(rel, proofs.get(rel)!)
    }
    const paths = new Set([...s1.files.keys(), ...s2.files.keys(), ...atMoment.listed])
    for (const rel of [...paths].sort()) {
      if (dbPaths.has(rel)) continue // copied above, as pinned
      const existed = atMoment.existed(rel)
      if (existed === false) continue
      const then = s1.files.get(rel)
      const now = s2.files.get(rel)
      if (then?.db || now?.db) throw new RoundFailed(`database ${rel} appeared around the batch's moment`)
      if (isContentAddressed(rel)) {
        // Any whole copy of a git object's name is its content (change-rules.ts): the last
        // batch's or one read in this batch, at the size it has now; else a read now. Taken when
        // its name may have existed at the moment (a dir of the object store that changed again).
        const copies = [prev.get(rel), proofs.has(rel) ? proofEntry(rel, proofs.get(rel)!) : undefined].filter((f): f is BatchFile => !!f && !f.db)
        const got = copies.find((f) => !now || f.size === now.st.s) ?? (now ? await readNow(rel) : null) ?? copies[0]
        if (!got) throw new RoundFailed(`${rel}: ${failed.get(rel) ?? 'a git object went before the batch read it'}`)
        out.set(rel, got)
        continue
      }
      if (existed === null) throw new RoundFailed(`${rel}: whether it existed at the batch's moment is unknown`)
      const mark = marks.get(rel)
      if (mark) {
        const last = prev.get(rel)
        if (last && !last.db && sameStat(last.src, mark.st)) { out.set(rel, last); continue }
        const got = await stagePrefix(home, rel, mark, last, run.send)
        if (got.ok) {
          stats.stagedFiles++
          stats.stagedBytes += got.size
          out.set(rel, fileEntry(rel, got.size, got.h, got.chunks, got.x, got.st, false))
          continue
        }
        // It did not only grow: the general rule below decides (taken when it was quiet since
        // before the moment, else the round fails), so one rewrite cannot fail every round after.
        stats.appendFallbacks++
        log.session.info('standby: an append-only file did not only grow; the general rule places it', { path: rel, why: got.why, detail: got.detail })
      }
      // A copy read and checked at this moment; or one a stat read after the moment proves.
      const proof = proofs.get(rel)
      const atThis = proof && proof.checkedAt === moment ? proofEntry(rel, proof) : null
      const got = atThis ?? provenBy(rel, held.get(rel)) ?? provenBy(rel, now?.st)
        // Changed since every copy, last changed before the moment: read it now.
        ?? (now && now.st.c < moment ? await readNow(rel) : null)
      if (got) { out.set(rel, got); continue }
      const why = failed.get(rel)
      throw new RoundFailed(why ? `${rel}: ${why}` : `${rel} changed or went after the batch's moment, and its content at the moment is unknown`)
    }
    for (const rel of s2.files.keys()) {
      if (s2.files.get(rel)!.db && !dbPaths.has(rel) && atMoment.existed(rel) !== false) throw new RoundFailed(`database ${rel} appeared around the batch's moment`)
    }
    return { files: out, pinnedAt: (pinned as Pin).pinnedAt }
  } finally {
    await (worker as PinWorker | null)?.close().catch(() => {})
  }
}
