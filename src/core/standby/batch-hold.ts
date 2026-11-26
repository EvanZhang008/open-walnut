/**
 * A round's hold (batch-round.ts): hold Walnut's gated writes (src/utils/write-gate.ts) and let
 * the ones under way end; mark the append-only files (append-only.ts); read the moment on the
 * filesystem's clock; note and pin every database (sqlite-pin.ts); read the stat of each hot
 * file and read the ones that changed before the moment since their copy; list again every dir
 * that changed since the walk (moment-names.ts) and read its files that changed since their
 * copy; let writes go. Returns what the rest of the round places paths with.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { holdWrites, type HoldResult } from '../../utils/write-gate.js'
import { markAppendOnly, type AppendMark } from './append-only.js'
import { RoundFailed, VoidBatch, databaseStat, fsClock, proofEntry, type BatchRun } from './batch-run.js'
import { changeRuleOf, isObjectStoreDir } from './change-rules.js'
import type { ChunkSink } from './chunks.js'
import { limiter, placeOf, sameStat, toSourceStat, type ScanEntry, type ScanResult } from './scan.js'
import { namesAtMoment, type MomentNames } from './moment-names.js'
import type { Pin, PinWorker } from './sqlite-pin.js'
import { stageFile, type StageContext, type StageOutcome } from './stage.js'
import type { BatchFile, SourceStat } from './types.js'

/** What a round knows from its walk, before its hold. */
export interface RoundPlan {
  s1: ScanResult
  dbs: ScanEntry[]
  /** Append-only files of the walk: marked in the hold. */
  appendOnly: string[]
  appendSet: Set<string>
  /** Files the hold reads the stat of (hot: changed lately, or a read of them was not taken), the newest first. */
  hot: string[]
  round: number
  /** Reads of this round that were not taken, for the reason a failed round gives. */
  failed: Map<string, string>
}

/** What the hold saw, at and right after the moment. */
export interface HoldView {
  /** The moment, on the filesystem's own clock (fsClock). */
  moment: number
  pin: Pin
  /** When the pins were taken (performance clock). */
  pinnedFrom: number
  names: MomentNames
  marks: Map<string, AppendMark>
  dbStats: Map<string, SourceStat>
  /** Databases whose stat did not move across the pins: their pinned state is the stat's. */
  steady: Set<string>
  /** Stats read in the hold, after the moment: the hot files and the changed dirs' files. */
  held: Map<string, SourceStat>
  /** The read rule at this moment (stage.ts). */
  ctx: StageContext
}

/** Keep a read the batch takes; note one it does not (its path is hot from now on). An unreadable file voids the batch. */
export function recordRead(run: BatchRun, out: StageOutcome, round: number | null, failed?: Map<string, string>): boolean {
  if (out.ok) {
    run.proofs.set(out.rel, { st: out.st, x: out.x, h: out.h, size: out.size, chunks: out.chunks, round })
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

/** The copy of `rel` that `st`, a stat read after the moment, proves was the file at the moment. */
export function provenBy(run: BatchRun, rel: string, st: SourceStat | undefined): BatchFile | null {
  if (!st) return null
  const proof = run.proofs.get(rel)
  if (proof && sameStat(st, proof.st)) return proofEntry(rel, proof)
  const last = run.prev.get(rel)
  if (last && !last.db && sameStat(st, last.src)) return last
  return null
}

export async function holdRound(run: BatchRun, plan: RoundPlan, pinner: PinWorker, scanClock: number): Promise<HoldView> {
  const { opts, stats, prev } = run
  const { s1, dbs, appendOnly, appendSet, hot, round, failed } = plan
  const home = opts.home
  const dbStatAll = () => Promise.all(dbs.map(async (d) => [d.p, await databaseStat(path.join(home, d.p))] as const))
  /** What the hold read, kept in memory until the writes go again. */
  const heldChunks = new Map<string, Buffer>()
  const keep: ChunkSink = (id, data) => { heldChunks.set(id, Buffer.from(data)) }
  /** A plain file whose stat, read after the moment, proves no copy the batch holds: it changed since. */
  const changedSince = (rel: string, st: SourceStat) =>
    changeRuleOf(rel, { db: !!s1.files.get(rel)?.db, appendOnly: appendSet.has(rel) }) === 'quiet-through-moment' && !provenBy(run, rel, st)

  let hold: HoldResult<HoldView>
  try {
    hold = await holdWrites(async (): Promise<HoldView> => {
      const holdStart = performance.now()
      const timeLeft = () => performance.now() - holdStart < (opts.holdReadMs ?? 200)
      // Gated writes that ended just now should land in an earlier tick than the moment.
      await new Promise((r) => setTimeout(r, opts.settleMs ?? 15))
      // Just before the moment: what each append-only file holds then is the batch's (one
      // unchanged since the last batch is only stat'ed).
      const marks = new Map<string, AppendMark>()
      const markSlot = limiter(64)
      await Promise.all(appendOnly.map((rel) => markSlot(async () => {
        const last = prev.get(rel)
        const mark = await markAppendOnly(path.join(home, rel), last && !last.db ? last.src : undefined)
        if (mark) marks.set(rel, mark)
      })))
      const moment = await fsClock(run.stagingDir, home)
      const dbStats = new Map<string, SourceStat>()
      try {
        for (const [p, st] of await dbStatAll()) dbStats.set(p, st)
      } catch (err) {
        throw new RoundFailed(`a database cannot be read (${String(err)})`)
      }
      // A database replaced since the walk (a new inode) is not the file the worker opened.
      for (const d of dbs) if (dbStats.get(d.p)!.i !== d.st.i) throw new RoundFailed(`database ${d.p} was replaced around the batch's moment`)
      let pin: Pin
      try {
        pin = await pinner.pin()
      } catch (err) {
        throw new RoundFailed(`databases cannot be pinned: ${err instanceof Error ? err.message : String(err)}`)
      }
      const pinnedFrom = performance.now()
      const steady = new Set<string>()
      for (const [p, st] of await dbStatAll().catch(() => [] as Array<readonly [string, SourceStat]>)) {
        if (sameStat(st, dbStats.get(p))) steady.add(p)
      }
      const ctx: StageContext = { home, momentMs: moment, afterCopy: opts.hooks?.afterCopy }
      let room = opts.holdCopyBytes ?? 8 * 1024 * 1024
      /** Read these in the hold, smallest first, as far as the budget goes: a read now is one no write after the moment can undo. */
      const readInHold = async (files: Array<{ rel: string; size: number }>) => {
        for (const { rel, size } of files.sort((a, b) => a.size - b.size)) {
          if (size > room || !timeLeft()) return
          room -= size
          recordRead(run, await stageFile(rel, ctx, keep), round, failed)
        }
      }
      // The hot files first, right after the moment: the sooner a stat after it, the less likely
      // a writer outside the gate moved the file in between. One that changed before the moment
      // since its copy is read at once.
      const held = new Map<string, SourceStat>()
      const statSlot = limiter(64)
      await Promise.all(hot.map((rel) => statSlot(async () => {
        const st = await fs.lstat(path.join(home, rel)).catch(() => null)
        if (st?.isFile()) held.set(rel, toSourceStat(st))
      })))
      stats.heldStatFiles = hot.length
      await readInHold([...held].filter(([rel, st]) => st.c < moment && changedSince(rel, st)).map(([rel, st]) => ({ rel, size: st.s })))
      const names = await namesAtMoment(home, s1, moment, scanClock, placeOf(run.opts))
      // A dir that also changed after the moment: a name made and removed around it is in
      // neither listing, so its names then cannot be told. Git's object store is the exception
      // (change-rules.ts isObjectStoreDir): its names are placed one by one (batch-place.ts).
      const unsettled = names.unsettled.filter((d) => !isObjectStoreDir(d))
      if (unsettled.length) throw new RoundFailed(`${unsettled.slice(0, 3).map((d) => d || '.').join(', ')}: names changed at the batch's moment`)
      for (const [rel, st] of names.heldStats) if (!held.has(rel)) held.set(rel, st)
      // Then the changed dirs' files: each one that changed since its copy and existed at the moment.
      await readInHold([...names.heldStats]
        .filter(([rel, st]) => run.proofs.get(rel)?.round !== round && names.existed(rel) === true && changedSince(rel, st))
        .map(([rel, st]) => ({ rel, size: st.s })))
      return { moment, pin, pinnedFrom, names, marks, dbStats, steady, held, ctx }
    }, { drainMs: opts.drainMs ?? 300 })
  } finally {
    // What the hold read is the batch's copy whether or not this round goes on (the next round
    // takes it while its stat holds): its chunks go to the target either way.
    for (const [id, data] of heldChunks) await run.send(id, data)
    heldChunks.clear()
  }
  stats.holdMs = hold.holdMs
  stats.drainMs = hold.drainMs
  if (!hold.drained || !hold.result) throw new RoundFailed('writes under way did not end within the hold')
  stats.pinAttempts = hold.result.pin.attempts
  stats.namesMs = hold.result.names.ms
  return hold.result
}
