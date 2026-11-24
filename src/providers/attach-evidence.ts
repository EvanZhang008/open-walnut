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

/**
 * Where an attach of a session this host judges itself (session-row-owner.ts rowOwnedHere, and the
 * host not standing down for an older leader) reads its stream on from, so what its CLI wrote while
 * no runner read it (a restart of the host's service, a line written by the daemon or the host's
 * server directly) is said once, and nothing the leader already heard is said again
 * (2026-11-23: a same-host send's turn ended before the runner attached again, and the future-only
 * attach skipped it for good):
 *
 *   told     the furthest line a durable fact of the session came from (fact-log.ts toldLine): every
 *            line up to it was handled and told, every line past it was not, so the attach reads on
 *            from exactly there, a turn that was running at the restart included. Used when it is a
 *            position in this file (its epoch, when both know one, and within its size).
 *   judged   with no told line (a log from before it, a session that never said a fact here): the
 *            last turn end its runner judged (the record's consumedOffset), when the stream proves a
 *            result was written past it.
 *
 * Null otherwise: the attach subscribes to what comes next, as before. The floor is also the attach's
 * replay watermark: a result past it is new, a line at or below it was handled. `watermark` is the
 * in-memory one after the stale-watermark heal (-1 when there is none, or when it belongs to a dead
 * file), so the judged floor is never a position in another file.
 */
export function judgedReplayFloor(
  ownHostJudged: boolean, watermark: number, evidence: StreamEvidence, told?: { epoch?: string; v: number } | null,
  /** The stream file's size and epoch when the evidence has none (a fold with no verdict): enough for the told line. */
  file?: { fileSize: number; streamEpoch?: string } | null,
): { floor: number; from: 'told' | 'judged' } | null {
  if (!ownHostJudged) return null
  const at = typeof evidence === 'string' ? file ?? null : evidence
  if (told && at && Number.isSafeInteger(told.v) && told.v >= 0 && told.v <= at.fileSize
    && !(told.epoch && at.streamEpoch && told.epoch !== at.streamEpoch)) return { floor: told.v, from: 'told' }
  if (typeof evidence === 'string') return null
  if (!Number.isInteger(watermark) || watermark < 0 || watermark >= evidence.fileSize) return null
  const end = evidence.fold.lastResult?.endOffset
  return typeof end === 'number' && end > watermark ? { floor: watermark, from: 'judged' } : null
}
