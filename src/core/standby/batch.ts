/**
 * Take one batch of the leader's home and send it to a standby target: everything the
 * manifest classes `leader-data`, as it was at one moment, or nothing at all.
 *
 * A home of real size takes minutes to read while the leader keeps writing (its git
 * auto-commit every 30 s, sessions, tasks, notes), so the batch reads first and fixes its
 * moment after, when little is left to read:
 *
 *   1. pass        walk the home (scan.ts) and read every changed file the batch holds no copy
 *                  of (the catch-up read: a first batch reads the whole home here, with no hold).
 *                  A read that took long is followed by another pass, which reads only what
 *                  changed meanwhile, until a pass is quick
 *   2. round       hold the writes, fix the moment, place every path at it from the copies
 *                  (batch-round.ts, each kind by its rule in change-rules.ts)
 *   3. commit      the chunks went as they were read; the target checks every hash
 *
 * A round that cannot place a path at its moment (it changed after the moment with no copy of
 * it from before) fails, and the batch goes back to 1 with what it read kept: only what changed
 * again is read again. The batch is void (nothing is committed and the target's position does
 * not move) after `maxRounds` failed rounds, or at once over a file that cannot be read, a
 * database that cannot be opened or copied, or the target refusing.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { RoundFailed, VoidBatch, fsClock, newStats, type BatchOptions, type BatchOutcome, type BatchRun } from './batch-run.js'
import { hasCopy, recordRead, runRound } from './batch-round.js'
import { changeRuleOf } from './change-rules.js'
import { limiter, placeOf, scanHome, type ScanResult } from './scan.js'
import { STAGING_NAME, removeDeadOwners } from './scratch.js'
import { stageFile, type StageOutcome } from './stage.js'
import { STANDBY_FORMAT, STANDBY_VERSION, compareBatchPaths, type BatchManifest } from './types.js'

export { VoidBatch, RoundFailed, databaseStat, type BatchOptions, type BatchOutcome, type BatchStats } from './batch-run.js'

/**
 * Read every plain file of the walk the batch holds no copy of (append-only files are taken
 * in the round, up to their mark). Each read counts by stage.ts's rule against the filesystem's
 * clock read just before; a read not taken leaves its file hot for the round. Returns its time.
 */
async function catchUp(run: BatchRun, s1: ScanResult): Promise<number> {
  const need = [...s1.files.values()].filter((e) => {
    const rule = changeRuleOf(e.p, { db: e.db, appendOnly: placeOf(run.opts).appendOnly(e.p) })
    return (rule === 'quiet-through-moment' || rule === 'content-addressed') && !hasCopy(run, e)
  })
  if (!need.length) return 0
  const start = performance.now()
  // The filesystem's clock, read again every half second of a long read (a file written since
  // the last reading is late for it, and read in the next pass).
  const ctx = { home: run.opts.home, momentMs: await fsClock(run.stagingDir, run.opts.home), afterCopy: run.opts.hooks?.afterCopy }
  let readAt = performance.now()
  const slot = limiter(4)
  // Every read ends before any is judged, so none runs on after the batch returns.
  const outs: StageOutcome[] = await Promise.all(need.map((e) => slot(async () => {
    if (performance.now() - readAt > 500) { readAt = performance.now(); ctx.momentMs = await fsClock(run.stagingDir, run.opts.home) }
    return stageFile(e.p, { ...ctx }, run.send)
  })))
  for (const out of outs) recordRead(run, out, null)
  const ms = performance.now() - start
  run.stats.catchUpMs += ms
  return ms
}

export async function takeBatch(opts: BatchOptions): Promise<BatchOutcome> {
  const started = performance.now()
  const stats = newStats()
  const stagingDir = path.join(opts.stagingDir, `batch-${process.pid}-${Date.now()}`)
  const maxRounds = opts.maxRounds ?? 10
  const maxCatchUps = opts.maxCatchUps ?? 8
  try {
    // What a batch of a process that is gone left here (a leader killed mid-batch).
    await removeDeadOwners(opts.stagingDir, STAGING_NAME)
    const { state, files: prevFiles } = await opts.transport.current()
    const known = new Set<string>()
    const run: BatchRun = {
      opts,
      stats,
      stagingDir,
      prev: new Map(prevFiles.map((f) => [f.p, f])),
      proofs: new Map(),
      readFailures: new Map(),
      hotSince: (await fsClock(stagingDir, opts.home)) - (opts.hotWindowMs ?? 60_000),
      known,
      send: async (id, data) => {
        if (known.has(id)) return
        known.add(id)
        if (!(await opts.transport.missing([id])).size) return
        await opts.transport.putChunk(id, data)
        stats.sentChunks++
        stats.sentBytes += data.length
      },
    }
    let catchUps = 0
    while (stats.rounds < maxRounds) {
      // The clock before the walk: a dir whose ctime is at or past this may have gained a name
      // in the same tick the walk listed it (a tick is coarse), so the hold lists it again.
      const scanClock = await fsClock(stagingDir, opts.home)
      const s1 = await scanHome(opts.home, placeOf(opts))
      stats.passes++
      stats.scanMs = s1.ms
      if (s1.unreadable.length) throw new VoidBatch(`cannot read ${s1.unreadable.slice(0, 5).join(', ')}`)
      await opts.hooks?.afterScan?.()
      const readMs = await catchUp(run, s1)
      await opts.hooks?.afterCatchUp?.()
      // The home moved on while a long read ran: walk it again first, so the round's hold has
      // only what changed since to read.
      if (readMs > (opts.longReadMs ?? 1000) && catchUps < maxCatchUps) { catchUps++; continue }
      stats.rounds++
      let placed
      try {
        placed = await runRound(run, s1, scanClock, stats.rounds)
      } catch (err) {
        if (!(err instanceof RoundFailed)) throw err
        stats.roundFailures.push(err.message)
        continue
      }
      const manifest: BatchManifest = {
        format: STANDBY_FORMAT,
        version: STANDBY_VERSION,
        batch: (state.current?.batch ?? 0) + 1,
        takenAt: new Date(placed.pinnedAt).toISOString(),
        files: [...placed.files.values()].sort(compareBatchPaths),
        ...(placed.dirs.length ? { dirs: placed.dirs } : {}),
      }
      stats.files = manifest.files.length
      const commit = await opts.transport.commit(manifest)
      stats.totalMs = performance.now() - started
      if (stats.rounds > 1) log.session.info('standby: a batch took more than one round', { rounds: stats.rounds, passes: stats.passes, failures: stats.roundFailures.slice(-3) })
      return { ok: true, manifest, commit, stats }
    }
    throw new VoidBatch(stats.roundFailures.at(-1) ?? 'no round was taken')
  } catch (err) {
    stats.totalMs = performance.now() - started
    if (err instanceof VoidBatch) return { ok: false, reason: err.message, stats }
    return { ok: false, reason: err instanceof Error ? err.message : String(err), stats }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

export type { ScanEntry } from './scan.js'
export { toSourceStat } from './scan.js'
export { chunkIds } from './types.js'
