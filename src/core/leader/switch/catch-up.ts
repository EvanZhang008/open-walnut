/**
 * The standby caught up before the handover (docs/reference/leader-switch.md, "The standby caught up first"):
 * the last step of the preflight, while the leader still serves. The final batch (final-stop.ts) runs inside the
 * commit window with the leader stopped, and carries what changed since the standby's last batch. A standby that
 * is behind (a large write the copy link has not carried yet, a writer faster than the link) would make it run
 * past the window: the switch rolls back after minutes without a leader. So before anything stops, the leader
 * takes its own standby batches back to back (the standby runner's, core/standby/runner.ts) until one takes at
 * most a quarter of the commit window, which is what the final batch will then carry about. One that does not
 * come within the catch-up's time, or batches that grow over the budget (the writes outpace the link), refuse
 * the switch here: nothing was handed over, the leader never stopped.
 *
 * Why a quarter: the commit window (commit_window_s, 300 s) runs from the handover to the new leader's commit
 * start. After the final batch come its verify pass and mark, the promotion and the trial start (about 20 s on a
 * 20 GB home), and before it the stop's teardown and the writers' settle (up to 30 s). A batch of at most 75 s
 * leaves the rest of the window for those and for a final batch up to three times the steady one.
 */
import type { BatchOutcome } from '../../standby/index.js'
import { withDeadline } from '../../../lib/with-deadline.js'

/** The share of the commit window a caught-up batch may take at most. */
export const CATCH_UP_SHARE = 4

export function catchUpBudgetMs(commitWindowMs: number): number {
  return Math.floor(commitWindowMs / CATCH_UP_SHARE)
}

/** Void rounds in a row (each the runner's batch with its own retries) after which the catch-up gives up. */
export const CATCH_UP_VOIDS = 3
/** Between a void round and the next: a host out of reach answers at once, and each round walks the home. */
const VOID_PAUSE_MS = 1_000

export interface CatchUpBatch {
  ok: boolean
  /** The batch's own time (its stats), or how long it was waited for when it says none. */
  ms: number
  sentBytes: number
  /** Nothing changed since the last batch (its time is still a whole walk of the home: the final batch ends on one). */
  unchanged?: boolean
  reason?: string
}

export type CatchUpOutcome =
  | { ok: true; batches: CatchUpBatch[]; ms: number; budgetMs: number }
  | { ok: false; why: string; batches: CatchUpBatch[]; ms: number; budgetMs: number }

const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const said = (b: CatchUpBatch) => b.ok ? `${s(b.ms)}, ${mb(b.sentBytes)} sent` : `void after ${s(b.ms)} (${b.reason ?? 'no reason'})`

/**
 * Standby batches through `runOnce` (the runner's: it joins a batch under way, else starts one) until one is
 * caught up, within `maxMs` (default: one commit window). Never throws.
 */
export async function catchUpStandby(o: {
  runOnce: () => Promise<BatchOutcome | null>
  commitWindowMs: number
  maxMs?: number
  now?: () => number
  /** Between a void round and the next (default VOID_PAUSE_MS; tests shorten it). */
  voidPauseMs?: number
}): Promise<CatchUpOutcome> {
  const now = o.now ?? Date.now
  const budgetMs = catchUpBudgetMs(o.commitWindowMs)
  const maxMs = o.maxMs ?? o.commitWindowMs
  const start = now()
  const batches: CatchUpBatch[] = []
  const refuse = (why: string): CatchUpOutcome => ({ ok: false, why, batches, ms: now() - start, budgetMs })
  for (;;) {
    const left = start + maxMs - now()
    if (left <= 0) return refuse(`no standby batch took at most ${s(budgetMs)} (a quarter of the commit window) within ${s(maxMs)}; the last: ${batches.length ? said(batches.at(-1)!) : 'none'}`)
    const t0 = now()
    const out = await withDeadline<BatchOutcome | null | 'late'>(
      o.runOnce().catch((err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err), stats: {} as never })),
      left, () => 'late',
    )
    // The batch under way goes on in the background (the runner's own): the leader keeps serving either way.
    if (out === 'late') return refuse(`a standby batch still ran after ${s(maxMs)} of catching up (the final batch must fit in a quarter of the commit window, ${s(budgetMs)}); the last that ended: ${batches.length ? said(batches.at(-1)!) : 'none'}`)
    if (out === null) return refuse('this leader takes no standby batches now (standby.dir, the experiment): nothing keeps the copy there current')
    const st = (out.stats ?? {}) as Partial<{ totalMs: number; sentBytes: number }>
    const b: CatchUpBatch = {
      ok: out.ok,
      ms: Number.isFinite(st.totalMs) ? st.totalMs! : now() - t0,
      sentBytes: Number.isFinite(st.sentBytes) ? st.sentBytes! : 0,
      ...(out.ok && out.commit.unchanged ? { unchanged: true } : {}),
      ...(!out.ok ? { reason: out.reason } : {}),
    }
    batches.push(b)
    // The time counts even for a batch that found nothing: the final batch ends on such a pass, often after a changed one.
    if (b.ok && b.ms <= budgetMs) return { ok: true, batches, ms: now() - start, budgetMs }
    if (!b.ok) {
      let voids = 0
      while (voids < batches.length && !batches[batches.length - 1 - voids]!.ok) voids++
      if (voids >= CATCH_UP_VOIDS) return refuse(`${voids} standby batches in a row were void; the last: ${said(b)}`)
      await new Promise((r) => setTimeout(r, o.voidPauseMs ?? VOID_PAUSE_MS))
      continue
    }
    // Two batches over the budget in a row, the later not shorter: what is written meanwhile is more than the link carries.
    const prev = batches.at(-2)
    if (b.ok && prev?.ok && prev.ms > budgetMs && b.ms >= prev.ms) {
      // Nothing to send in either: the walk of the home alone is over the budget.
      if (b.unchanged && prev.unchanged) return refuse(`a walk of the home alone takes ${s(b.ms)} (then ${s(prev.ms)} before it), over the budget of ${s(budgetMs)}: the final batch ends on such a walk`)
      return refuse(`the standby falls further behind: batches over the budget of ${s(budgetMs)} took ${said(prev)}, then ${said(b)} (the writes outpace the copy link)`)
    }
  }
}

/**
 * The standby target refuses every op but an apply while one runs there (core/standby/apply-status.ts): the
 * leader's own periodic batch, applying on the other machine. Not a failure of the copy: its op waits for it.
 */
export function standbyBusy(reason: string): boolean {
  return /the target is busy: an apply/.test(reason)
}

/**
 * `op` (a verify pass over the copy link), tried again while the target says it applies a batch, until `untilMs`
 * (wall clock); any other error, or busy past it, is thrown as it came.
 */
export async function whenStandbyIdle<T>(op: () => Promise<T>, o: { untilMs: number; everyMs?: number; now?: () => number }): Promise<T> {
  const now = o.now ?? Date.now
  for (;;) {
    try {
      return await op()
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      if (!standbyBusy(why) || now() + (o.everyMs ?? 1_000) > o.untilMs) throw err
      await new Promise((r) => setTimeout(r, o.everyMs ?? 1_000))
    }
  }
}

/**
 * The last look, right before the switch stop (routes/leader-switch.ts /switch/final-stop): the same rule as the
 * catch-up, within one budget. The catch-up ran before the handover; between it and the stop the leader may still
 * write (a large recording, an import, a session's files) while the new leader's job gets ready (up to 30 s).
 * A batch of what came since that does not stand within the budget means the final batch would not fit either:
 * the stop is refused while the doors were never closed and nothing stopped, and the source job takes the
 * handover back (the old leader leads again at once). Without it, a final batch past the window rolls back only
 * at the commit deadline: minutes with no leader (the 2026-11-24 rehearsal: 6 min 9 s).
 */
export function lastLook(o: { runOnce: () => Promise<BatchOutcome | null>; commitWindowMs: number; now?: () => number; voidPauseMs?: number }): Promise<CatchUpOutcome> {
  return catchUpStandby({ ...o, maxMs: catchUpBudgetMs(o.commitWindowMs) })
}
