/**
 * The rows a host that runs and judges a session keeps parked in its own queue, in the leader's
 * panel (docs/plan/one-service-every-host.md, phase 2). A line the leader handed to the host lives in
 * the host's queue from then on; when it parks there (a gone folder, a refusal), the leader's queue
 * no longer has it, so the panel showed nothing, its Retry made a second copy on the leader, and its
 * Discard found nothing to remove (2026-11-24: twelve rows parked on a host for hours, invisible and
 * undeletable from the console).
 *
 *   list     the leader's queue reads (the console's session:get-queue, GET /api/v1/sessions/:id/queue)
 *            add the host's parked rows (lifecycle readParkedRows), marked `onHost`, within a short
 *            deadline: a host that does not answer in time leaves the list as the leader has it
 *   retry    a Retry or Send now of a row the leader does not have goes to the host
 *            (sendQueuedRowNow), which puts its own row back in line: never a copy on the leader
 *   discard  a Discard of a row the leader does not have goes to the host (discardQueuedRow)
 *
 * A host before these members answers no_such_member: the list stays the leader's, and a retry or
 * discard reads as the row being gone, as before. Nothing here for a session this server runs.
 */
import { log } from '../../logging/index.js'
import type { QueuedMessage } from '../session-queue-store.js'

/** How long a queue read waits for the host's rows. */
export const HOST_ROWS_MS = 3_000
/** How long a retry or discard waits for the host's answer. */
const HOST_ACT_MS = 10_000

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the host did not answer within ${ms} ms`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

async function hostOf(sessionId: string): Promise<string | null> {
  const { judgingHostOf } = await import('./judge-of.js')
  return judgingHostOf(sessionId)
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function isRow(v: unknown, sessionId: string): v is QueuedMessage {
  const r = v as Partial<QueuedMessage> | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.message === 'string'
    && r.status === 'parked' && typeof r.enqueuedAt === 'string' && (r.sessionId === undefined || r.sessionId === sessionId)
}

/**
 * The host's parked rows of `sessionId`, marked `onHost`, leaving out ids the leader already lists.
 * `partial`: the session is a host's and its host did not answer (in time, or at all).
 */
export async function hostParkedRows(sessionId: string, known: ReadonlySet<string> = new Set()): Promise<{ rows: Array<QueuedMessage & { onHost: true }>; partial?: true }> {
  const host = await hostOf(sessionId)
  if (!host) return { rows: [] }
  try {
    const { onJudgingHost } = await import('./host-judged-controls.js')
    const answer = await within(onJudgingHost(sessionId, 'readParkedRows', []), HOST_ROWS_MS)
    const rows = (Array.isArray(answer) ? answer : []).filter((r): r is QueuedMessage => isRow(r, sessionId) && !known.has(r.id))
    return { rows: rows.map((r) => ({ ...r, sessionId, onHost: true as const })) }
  } catch (err) {
    log.session.info('host queue rows: the host that runs the session did not list its parked rows', { sessionId, host, error: errText(err) })
    return { rows: [], partial: true }
  }
}

/** This server's own listed rows, then the host's parked ones (hostParkedRows); `partial` as there. */
export async function withHostParkedRows<T extends { id: string }>(sessionId: string, own: T[]): Promise<{ rows: Array<T | (QueuedMessage & { onHost: true })>; partial?: true }> {
  const onHost = await hostParkedRows(sessionId, new Set(own.map((m) => m.id)))
  return { rows: [...own, ...onHost.rows], ...(onHost.partial ? { partial: true as const } : {}) }
}

/**
 * A Retry or Send now of a row the leader does not have: the host that runs the session sends its own
 * row (`unpark`: a person's, which puts a parked one back in line). Null for a session this server runs (or a host that cannot be asked):
 * the caller answers as it did before.
 */
export async function sendNowOnHost(sessionId: string, messageId: string, source: string, unpark: boolean): Promise<{ sent: true; sessionId: string } | { sent: false; why: 'gone' | 'parked'; reason?: string } | null> {
  const host = await hostOf(sessionId)
  if (!host) return null
  try {
    const { onJudgingHost } = await import('./host-judged-controls.js')
    const r = await within(onJudgingHost(sessionId, 'sendQueuedRowNow', [messageId, source, unpark]), HOST_ACT_MS) as { sent?: unknown; why?: unknown; reason?: unknown } | null
    if (r?.sent === true) return { sent: true, sessionId }
    return { sent: false, why: r?.why === 'parked' ? 'parked' : 'gone', ...(typeof r?.reason === 'string' ? { reason: r.reason } : {}) }
  } catch (err) {
    log.session.warn('host queue rows: the host did not take a Retry of its row', { sessionId, host, messageId, error: errText(err) })
    return null
  }
}

/** A person's Discard of a row the leader does not have, on the host: true when the host removed it, null when it cannot be asked. */
export async function discardOnHost(sessionId: string, messageId: string): Promise<boolean | null> {
  const host = await hostOf(sessionId)
  if (!host) return null
  try {
    const { onJudgingHost } = await import('./host-judged-controls.js')
    return (await within(onJudgingHost(sessionId, 'discardQueuedRow', [messageId]), HOST_ACT_MS)) === true
  } catch (err) {
    log.session.warn('host queue rows: the host did not take a Discard of its row', { sessionId, host, messageId, error: errText(err) })
    return null
  }
}

/**
 * A person's Discard of a queued row: this server's own row, or else (the row is not here at all) the
 * one the host that runs the session keeps. False when neither removed it (taken, or gone).
 */
export async function discardQueued(sessionId: string, messageId: string): Promise<boolean> {
  const { deleteMessage, getQueue } = await import('../session-message-queue.js')
  if (await deleteMessage(sessionId, messageId, { discarded: true })) return true
  if ((await getQueue(sessionId)).some((m) => m.id === messageId)) return false
  return (await discardOnHost(sessionId, messageId)) === true
}
