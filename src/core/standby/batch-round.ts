/**
 * One round of a batch (batch.ts): one moment, and every path of the home placed at it from the
 * copies the batch holds, or a failed round (RoundFailed) that the batch follows with a new walk
 * of the home and a new moment. Nothing a round reads is lost when it fails: the copies stay
 * with the batch, so the next round reads only what changed again.
 *
 *   1. hold   batch-hold.ts: the moment, the pins, the hot files' and changed dirs' stats, and
 *             the reads of the small files that changed since their copy
 *   2. copy   each changed database as pinned, first: each one's pin ends once it is copied
 *   3. place  batch-place.ts: walk again and give each path its content at the moment, by its
 *             kind's rule (change-rules.ts)
 *   4. check  git's pack dir did not change while the round placed paths, and every object a
 *             ref of the batch names is in it (git-tips.ts)
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { holdRound, recordRead, type HoldView, type RoundPlan } from './batch-hold.js'
import { momentDirs } from './batch-dirs.js'
import { placePaths } from './batch-place.js'
import { RoundFailed, VoidBatch, fileEntry, type BatchRun } from './batch-run.js'
import { changeRuleOf, isContentAddressed } from './change-rules.js'
import type { FileDigest } from './chunks.js'
import { missingRefTips } from './git-tips.js'
import { placeOf, sameStat, scanHome, type ScanEntry, type ScanResult } from './scan.js'
import { openPinWorker, type PinWorker } from './sqlite-pin.js'
import { stageFile } from './stage.js'
import type { BatchFile } from './types.js'

export { recordRead }

/** Git's pack dir: a pack that came or went while a round placed paths fails it (an object moved into a pack the walk did not list). */
const PACK_DIR = '.git/objects/pack'
/** New git objects read while the databases stay pinned, at most (batch-round.ts runRound). */
const FRESH_EARLY_BYTES = 16 * 1024 * 1024

export interface RoundResult {
  files: Map<string, BatchFile>
  /** The batch's dirs (batch-dirs.ts). */
  dirs: string[]
  /** When the databases were pinned (wall clock): the batch's `takenAt`. */
  pinnedAt: number
}

/** Whether the batch holds a copy of `e` as the walk saw it (the last batch's, or one it read). */
export function hasCopy(run: BatchRun, e: ScanEntry): boolean {
  const last = run.prev.get(e.p)
  const proof = run.proofs.get(e.p)
  if (isContentAddressed(e.p)) return (!!last && !last.db && last.size === e.st.s) || (!!proof && proof.size === e.st.s)
  return (!!last && !last.db && sameStat(e.st, last.src)) || (!!proof && sameStat(e.st, proof.st))
}

function planRound(run: BatchRun, s1: ScanResult, round: number): RoundPlan {
  const dbs = [...s1.files.values()].filter((e) => e.db).sort((a, b) => a.p.localeCompare(b.p))
  const plain = [...s1.files.values()].filter((e) => !e.db)
  const appendOnly = plain.filter((e) => placeOf(run.opts).appendOnly(e.p)).map((e) => e.p)
  const appendSet = new Set(appendOnly)
  // Hot: changed lately, or a read of it was not taken. Each is likely to change again, so the
  // hold reads its stat, which then proves (or not) the copy the batch holds.
  const hot = plain
    .filter((e) => changeRuleOf(e.p, { db: false, appendOnly: appendSet.has(e.p) }) === 'quiet-through-moment' && (e.st.c >= run.hotSince || run.readFailures.has(e.p)))
    .sort((a, b) => b.st.c - a.st.c)
    .slice(0, run.opts.holdStatFiles ?? 4096)
    .map((e) => e.p)
  return { s1, dbs, appendOnly, appendSet, hot, round, failed: new Map() }
}

/** Copy each changed database as pinned; each pin ends once its database is copied. */
async function copyDatabases(run: BatchRun, plan: RoundPlan, view: HoldView, pinner: PinWorker, out: Map<string, BatchFile>): Promise<void> {
  const { stats, prev, opts } = run
  for (let i = 0; i < plan.dbs.length; i++) {
    const d = plan.dbs[i]
    const src = view.dbStats.get(d.p)!
    const last = prev.get(d.p)
    // Unchanged since the last batch's stat, and no commit between this stat and the pins.
    if (last?.db && sameStat(last.src, src) && view.steady.has(d.p)) { out.set(d.p, last); continue }
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
}

export async function runRound(run: BatchRun, s1: ScanResult, scanClock: number, round: number): Promise<RoundResult> {
  const { opts, stats } = run
  const home = opts.home
  const plan = planRound(run, s1, round)
  stats.databases = plan.dbs.length
  let worker: PinWorker | null = null
  try {
    try {
      worker = await openPinWorker(plan.dbs.map((d) => path.join(home, d.p)))
    } catch (err) {
      throw new VoidBatch(`databases cannot be opened: ${err instanceof Error ? err.message : String(err)}`)
    }
    const view = await holdRound(run, plan, worker, scanClock)
    await opts.hooks?.afterHold?.()
    // The git objects new since the walk, read before a repack can remove them (a git object's
    // copy holds at any time): the small ones first, up to 16 MiB, the rest once the databases
    // are copied, so their pins do not wait on a large one.
    const fresh = await Promise.all(view.names.listed
      .filter((rel) => isContentAddressed(rel) && !run.proofs.has(rel) && !run.prev.has(rel) && view.names.existed(rel) !== false)
      .map(async (rel) => ({ rel, size: (await fs.lstat(path.join(home, rel)).catch(() => null))?.size ?? 0 })))
    let early = FRESH_EARLY_BYTES
    const later: string[] = []
    for (const { rel, size } of fresh.sort((a, b) => a.size - b.size)) {
      if (size > early) { later.push(rel); continue }
      early -= size
      recordRead(run, await stageFile(rel, view.ctx, run.send), round, plan.failed)
    }
    const out = new Map<string, BatchFile>()
    await copyDatabases(run, plan, view, worker, out)
    await worker.close()
    stats.pinMs = performance.now() - view.pinnedFrom
    for (const rel of later) recordRead(run, await stageFile(rel, view.ctx, run.send), round, plan.failed)
    const s2 = await scanHome(home, placeOf(run.opts))
    stats.rescanMs = s2.ms
    if (s2.unreadable.length) throw new VoidBatch(`cannot read ${s2.unreadable.slice(0, 5).join(', ')}`)
    await placePaths(run, plan, view, s2, out)
    const packs = s2.dirs.get(PACK_DIR)
    if (packs) {
      const st = await fs.lstat(path.join(home, PACK_DIR)).catch(() => null)
      if (!st || st.ino !== packs.i || st.ctimeMs !== packs.c) throw new RoundFailed(`${PACK_DIR}: a pack came or went while the batch read the object store`)
    }
    const missing = await missingRefTips(home, out)
    if (missing.length) throw new RoundFailed(`git's ${missing.slice(0, 3).join(', ')}, which the batch does not hold`)
    return { files: out, dirs: momentDirs(view.names, s1, s2, out.keys(), placeOf(run.opts)), pinnedAt: view.pin.pinnedAt }
  } finally {
    await (worker as PinWorker | null)?.close().catch(() => {})
  }
}
