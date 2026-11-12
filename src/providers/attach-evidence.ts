/**
 * The host reads an attach makes before it takes the session's stream: the
 * cost state (the cost watermark's seed) and the stream file's tail fold (did
 * the current turn end). Both are optional: when either is missing the attach
 * already degrades (an unknown cost baseline, the task phase as the turn's
 * proxy), and neither is needed to write a line into the live CLI.
 *
 * A send or a person waits on an on-demand attach (processNext rehydrating a
 * session this server has not held since its restart, getOrAttachLiveSession),
 * so there the two reads run together and get one budget
 * (ON_DEMAND_ATTACH_EVIDENCE_MS); what has not answered by then counts as not
 * known and the read goes on unheeded. 2026-11-12, the send.delivery alarm:
 * after a Mac reboot the clouddev link was flooded with history refreshes for
 * 172 sessions, and the first sends into two live sessions there waited 37 s
 * and 102 s on these reads (one until the link dropped) before their lines
 * were written.
 *
 * A read that misses the budget is not dropped: `late` hands its answer over
 * when it comes, and the attach applies what is still safe to apply then (a cost
 * baseline no result seeded yet, a dead file's watermark no event consumed past).
 *
 * The startup attach (no budget) waits for them as before, one after the other.
 *
 * attachToExisting makes these two reads only through readAttachEvidence
 * (tests/providers/attach-evidence-ratchet.test.ts). Its authoritative downgrade
 * (reconcileProcessStatus) still asks the daemon for its view, bounded at 3 s, and
 * only when the evidence came back in time and shows the turn ended.
 */

import { DaemonFileReader } from '../core/daemon-file-reader.js'
import type { SessionRecord } from '../core/types.js'
import { log } from '../logging/index.js'

/** How long a send waits, in all, for an on-demand attach's optional host reads. */
export const ON_DEMAND_ATTACH_EVIDENCE_MS = 5_000

/** The stream evidence when the budget ran out first (a string, as the other "no evidence" reasons). */
export const EVIDENCE_TIMEOUT = 'evidence-timeout'

export type StreamEvidence = Awaited<ReturnType<typeof import('../core/session-reconcile.js')['fetchStreamTailFold']>>

export type CostEvidence =
  | { kind: 'read'; value: { totalCostUsd: number } | null }
  | { kind: 'failed'; error: string }
  | { kind: 'timeout' }
  | { kind: 'not-needed' }

export interface AttachEvidence {
  cost: CostEvidence
  /** The fold, or why there is none ('evidence-fetch-threw', EVIDENCE_TIMEOUT, the fetch's own reasons). */
  stream: StreamEvidence
  /** The answers of the reads that missed the budget, when they come (never rejects). */
  late?: { cost?: Promise<CostEvidence>; stream?: Promise<StreamEvidence> }
}

export interface AttachEvidenceDeps {
  readCostState: (host: string, sessionId: string, cwd: string | undefined) => Promise<{ totalCostUsd: number } | null>
  fetchStreamTailFold: (sessionId: string, host: string | null | undefined, opts: { consumedOffset?: number }) => Promise<StreamEvidence>
  now: () => number
}

const REAL_DEPS: AttachEvidenceDeps = {
  readCostState: (host, sid, cwd) => new DaemonFileReader(host).readCostState(sid, cwd),
  fetchStreamTailFold: async (sid, host, opts) => {
    const { fetchStreamTailFold } = await import('../core/session-reconcile.js')
    return fetchStreamTailFold(sid, host, opts)
  },
  now: () => Date.now(),
}

type Timed<T> = { done: true; value: T } | { done: false }

/** `p`'s outcome, or not done when `deadlineAt` passes first. A late rejection is swallowed. */
function until<T>(p: Promise<T>, deadlineAt: number | undefined, now: () => number): Promise<Timed<T>> {
  const settled = p.then((value) => ({ done: true as const, value }))
  if (deadlineAt === undefined) return settled
  const left = deadlineAt - now()
  if (left <= 0) {
    settled.catch(() => {})
    return Promise.resolve({ done: false })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Timed<T>>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), left)
    timer.unref?.()
  })
  settled.catch(() => {})
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

export async function readAttachEvidence(
  record: Pick<SessionRecord, 'claudeSessionId' | 'host' | 'cwd' | 'consumedOffset'>,
  opts: { needCost: boolean; budgetMs?: number },
  deps: AttachEvidenceDeps = REAL_DEPS,
): Promise<AttachEvidence> {
  const sid = record.claudeSessionId
  const host = record.host ?? '__local__'
  const deadlineAt = opts.budgetMs !== undefined ? deps.now() + opts.budgetMs : undefined
  const startedAt = deps.now()

  const late: NonNullable<AttachEvidence['late']> = {}
  const costOf = (p: Promise<{ totalCostUsd: number } | null>): Promise<CostEvidence> => p.then(
    (value) => ({ kind: 'read' as const, value }),
    (error) => {
      log.session.warn('attached cost state unavailable', { sessionId: sid, error: String(error) })
      return { kind: 'failed' as const, error: String(error) }
    })
  const streamOf = (p: Promise<StreamEvidence>): Promise<StreamEvidence> => p.catch((err) => {
    log.session.warn('attachToExisting: stream evidence fetch failed', {
      sessionId: sid, error: err instanceof Error ? err.message : String(err),
    })
    return 'evidence-fetch-threw'
  })
  const costRead = async (): Promise<CostEvidence> => {
    if (!opts.needCost) return { kind: 'not-needed' }
    const read = costOf(Promise.resolve().then(() => deps.readCostState(host, sid, record.cwd)))
    const r = await until(read, deadlineAt, deps.now)
    if (r.done) return r.value
    late.cost = read
    return { kind: 'timeout' }
  }
  const streamRead = async (): Promise<StreamEvidence> => {
    // consumedOffset arms the whale-turn watermark fallback (incident 57b125ab).
    const read = streamOf(Promise.resolve().then(() => deps.fetchStreamTailFold(sid, record.host, { consumedOffset: record.consumedOffset })))
    const r = await until(read, deadlineAt, deps.now)
    if (r.done) return r.value
    late.stream = read
    return EVIDENCE_TIMEOUT
  }

  let cost: CostEvidence
  let stream: StreamEvidence
  if (deadlineAt === undefined) {
    // Startup: one after the other, as before (a restart attaches every session at once).
    cost = await costRead()
    stream = await streamRead()
  } else {
    ;[cost, stream] = await Promise.all([costRead(), streamRead()])
  }
  if (cost.kind === 'timeout' || stream === EVIDENCE_TIMEOUT) {
    log.session.warn('attachToExisting: host evidence not back within the send budget, attaching without it', {
      sessionId: sid, host, budgetMs: opts.budgetMs, waitedMs: deps.now() - startedAt,
      costTimedOut: cost.kind === 'timeout', streamTimedOut: stream === EVIDENCE_TIMEOUT,
    })
  }
  return { cost, stream, ...(late.cost || late.stream ? { late } : {}) }
}
