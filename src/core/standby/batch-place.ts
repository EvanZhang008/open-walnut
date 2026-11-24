/**
 * A round's placement (batch-round.ts): after the hold and the databases' copies, walk the home
 * again and give each path that existed at the moment its content then, by its kind's rule
 * (change-rules.ts changeRuleOf: one classifier for the code and for the rules' test):
 *
 *   snapshot              copied as pinned (batch-round.ts); one that appeared around the moment
 *                         fails the round
 *   prefix                its bytes up to its mark (append-only.ts); one that did not only grow
 *                         goes to the general rule
 *   content-addressed     any whole copy of its name: the last batch's or one this batch read, at
 *                         its size now, else a read now. Taken whether or not it existed at the
 *                         moment when it is there now (an object or pack that came after the
 *                         moment is one more git ignores, and the pack an object went into is
 *                         never left out); one known or perhaps there at the moment and gone with
 *                         no copy fails the round
 *   quiet-through-moment  a copy read at this moment; else one a stat read after the moment proves;
 *                         else, its last change before the moment, a read now; else the round fails
 */
import { log } from '../../logging/index.js'
import { stagePrefix } from './append-only.js'
import { provenBy, recordRead, type HoldView, type RoundPlan } from './batch-hold.js'
import { RoundFailed, fileEntry, proofEntry, type BatchRun } from './batch-run.js'
import { changeRuleOf } from './change-rules.js'
import { sameStat, type ScanResult } from './scan.js'
import { stageFile } from './stage.js'
import type { BatchFile } from './types.js'

export async function placePaths(run: BatchRun, plan: RoundPlan, view: HoldView, s2: ScanResult, out: Map<string, BatchFile>): Promise<void> {
  const { prev, proofs, stats, opts } = run
  const { s1, appendSet, round, failed } = plan
  const { names, moment, ctx } = view
  const dbPaths = new Set(plan.dbs.map((d) => d.p))
  /** Read `rel` now, by the moment's rule; the copy when the read is taken. */
  const readNow = async (rel: string): Promise<BatchFile | null> => {
    if (!recordRead(run, await stageFile(rel, ctx, run.send), round, failed)) return null
    return proofEntry(rel, proofs.get(rel)!)
  }
  const paths = new Set([...s1.files.keys(), ...s2.files.keys(), ...names.listed])
  for (const rel of [...paths].sort()) {
    if (dbPaths.has(rel)) continue // copied as pinned
    const then = s1.files.get(rel)
    const now = s2.files.get(rel)
    const existed = names.existed(rel)
    const rule = changeRuleOf(rel, { db: !!(then?.db || now?.db), appendOnly: appendSet.has(rel) })
    switch (rule) {
      case 'not-copied':
        continue
      case 'snapshot':
        if (existed === false) continue
        throw new RoundFailed(`database ${rel} appeared around the batch's moment`)
      case 'content-addressed': {
        if (existed === false && !now) continue
        const copies = [prev.get(rel), proofs.has(rel) ? proofEntry(rel, proofs.get(rel)!) : undefined].filter((f): f is BatchFile => !!f && !f.db)
        const got = copies.find((f) => !now || f.size === now.st.s) ?? (now ? await readNow(rel) : null) ?? copies[0]
        if (got) { out.set(rel, got); continue }
        // Came after the moment and went again: no state at the moment had it.
        if (existed === false) continue
        throw new RoundFailed(`${rel}: ${failed.get(rel) ?? 'a git object went before the batch read it'}`)
      }
      case 'prefix':
      case 'quiet-through-moment': {
        if (existed === false) continue
        if (existed === null) throw new RoundFailed(`${rel}: whether it existed at the batch's moment is unknown`)
        const mark = rule === 'prefix' ? view.marks.get(rel) : undefined
        if (mark) {
          const last = prev.get(rel)
          if (last && !last.db && sameStat(last.src, mark.st)) { out.set(rel, last); continue }
          const got = await stagePrefix(opts.home, rel, mark, last, run.send)
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
        const proof = proofs.get(rel)
        const got = (proof && proof.round === round ? proofEntry(rel, proof) : null)
          ?? provenBy(run, rel, view.held.get(rel)) ?? provenBy(run, rel, now?.st)
          // Changed since every copy, last changed before the moment: read it now.
          ?? (now && now.st.c < moment ? await readNow(rel) : null)
        if (got) { out.set(rel, got); continue }
        const why = failed.get(rel)
        throw new RoundFailed(why ? `${rel}: ${why}` : `${rel} changed or went after the batch's moment, and its content at the moment is unknown`)
      }
      default: {
        const unknown: never = rule
        throw new Error(`no placement for rule ${String(unknown)}`)
      }
    }
  }
}
