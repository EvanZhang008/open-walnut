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
 *            deadline: a host that does not answer in time gets its last answer listed, `partial`
 *   retry    a Retry or Send now of a row the leader does not have goes to the host
 *            (sendQueuedRowNow), which puts its own row back in line: never a copy on the leader,
 *            also when the host cannot be asked (`unavailable`: the route says so, nothing is queued)
 *   discard  a Discard of a row the leader does not have goes to the host (discardQueuedRow); a host
 *            that cannot be asked leaves the row, and the panel says so
 *
 * A host before these members answers no_such_member: the list stays the leader's, and a retry or
 * discard reads as the row being gone, as before. Nothing here for a session this server runs.
 */
import { log } from '../../logging/index.js'
import type { QueuedMessage } from '../session-queue-store.js'
import type { SendNowResult } from './send-now.js'

/** How long a queue read waits for the host's rows. */
export const HOST_ROWS_MS = 3_000
/** How long a retry or discard waits for the host's answer. */
const HOST_ACT_MS = 10_000

/**
 * The host that runs the session could not be asked (its link is down, or it did not answer in
 * time). A call that timed out may still have been carried out there, so nothing is assumed either
 * way, and nothing is done on the leader in its place: never a copy here (2026-11-24 review, B1).
 */
export class HostUnreachableError extends Error {
  constructor(readonly host: string, cause: string) {
    super(`The host that runs this session (${host}) cannot be reached right now (${cause}), so nothing was done here; try again in a moment. If the host answered late, it may have done it already.`)
    this.name = 'HostUnreachableError'
  }
}

async function hostOf(sessionId: string): Promise<string | null> {
  const { judgingHostOf } = await import('./judge-of.js')
  return judgingHostOf(sessionId)
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
/** A host before these members (host-routes.ts answers no_such_member): it lists nothing, as before. */
const olderHost = (err: unknown) => err instanceof Error && /: no_such_member$/.test(err.message)

/**
 * One call to the host that runs `sessionId`, ended at `ms` by the link itself (leader-side.ts
 * callHost drops its pending request then; a call already running on the host may still finish).
 */
async function askHost(sessionId: string, member: 'readParkedRows' | 'sendQueuedRowNow' | 'discardQueuedRow', args: unknown[], ms: number): Promise<unknown> {
  const { onJudgingHost } = await import('./host-judged-controls.js')
  return onJudgingHost(sessionId, member, args, { timeoutMs: ms })
}

function isRow(v: unknown, sessionId: string): v is QueuedMessage {
  const r = v as Partial<QueuedMessage> | null
  return !!r && typeof r === 'object' && typeof r.id === 'string' && typeof r.message === 'string'
    && r.status === 'parked' && typeof r.enqueuedAt === 'string' && (r.sessionId === undefined || r.sessionId === sessionId)
}

/**
 * The host's last answer per session: a read the host does not answer in time lists these, marked
 * partial, so a panel neither drops a parked bubble nor calls a row the host still holds delivered
 * (review S3). Also how a send-now that names only the row finds its session (review S4).
 */
const lastRows = new Map<string, QueuedMessage[]>()
const LAST_ROWS_MAX = 500
/** Hosts whose failed read was logged since their last answer: one line per host, not one per panel read. */
const loggedHosts = new Set<string>()

function keepRows(sessionId: string, rows: QueuedMessage[]): void {
  lastRows.delete(sessionId)
  if (rows.length === 0) return
  lastRows.set(sessionId, rows)
  if (lastRows.size > LAST_ROWS_MAX) lastRows.delete(lastRows.keys().next().value!)
}

function forgetRow(sessionId: string, messageId: string): void {
  const rows = lastRows.get(sessionId)
  if (rows) keepRows(sessionId, rows.filter((r) => r.id !== messageId))
}

/** The session whose host last listed row `messageId` as parked there, if any. */
export function sessionOfHostRow(messageId: string): string | null {
  for (const [sid, rows] of lastRows) if (rows.some((r) => r.id === messageId)) return sid
  return null
}

/**
 * The host's parked rows of `sessionId`, marked `onHost`, leaving out ids the leader already lists.
 * `partial`: the session is a host's and its host did not answer; the rows are its last answer.
 */
export async function hostParkedRows(sessionId: string, known: ReadonlySet<string> = new Set()): Promise<{ rows: Array<QueuedMessage & { onHost: true }>; partial?: true }> {
  const host = await hostOf(sessionId)
  if (!host) return { rows: [] }
  const shown = (rows: QueuedMessage[]) => rows.filter((r) => !known.has(r.id)).map((r) => ({ ...r, sessionId, onHost: true as const }))
  try {
    const answer = await askHost(sessionId, 'readParkedRows', [], HOST_ROWS_MS)
    const rows = (Array.isArray(answer) ? answer : []).filter((r): r is QueuedMessage => isRow(r, sessionId))
    keepRows(sessionId, rows)
    loggedHosts.delete(host)
    return { rows: shown(rows) }
  } catch (err) {
    const older = olderHost(err)
    if (!loggedHosts.has(host)) {
      loggedHosts.add(host)
      log.session.info(older
        ? 'host queue rows: the host that runs the session is older and lists no parked rows (logged once per host)'
        : 'host queue rows: the host that runs the session did not list its parked rows; its last answer stands (logged once until it answers)', { sessionId, host, error: errText(err) })
    }
    // An older host never lists any: the leader's list is the whole answer there, as before.
    if (older) return { rows: [] }
    return { rows: shown(lastRows.get(sessionId) ?? []), partial: true }
  }
}

/** This server's own listed rows, then the host's parked ones (hostParkedRows); `partial` as there. */
export async function withHostParkedRows<T extends { id: string }>(sessionId: string, own: T[]): Promise<{ rows: Array<T | (QueuedMessage & { onHost: true })>; partial?: true }> {
  const onHost = await hostParkedRows(sessionId, new Set(own.map((m) => m.id)))
  return { rows: [...own, ...onHost.rows], ...(onHost.partial ? { partial: true as const } : {}) }
}

/**
 * A Retry or Send now of a row the leader does not have: the host that runs the session sends its own
 * row (`unpark`: a person's, which puts a parked one back in line). Null for a session this server
 * runs, or a host older than these members: the caller answers as it did before. `unavailable`: the
 * host could not be asked, and the caller does nothing here in its place (review B1).
 */
export async function sendNowOnHost(sessionId: string, messageId: string, source: string, unpark: boolean): Promise<SendNowResult | null> {
  const host = await hostOf(sessionId)
  if (!host) return null
  try {
    const r = await askHost(sessionId, 'sendQueuedRowNow', [messageId, source, unpark], HOST_ACT_MS) as { sent?: unknown; why?: unknown; reason?: unknown } | null
    if (r?.sent === true) {
      forgetRow(sessionId, messageId)
      return { sent: true, sessionId }
    }
    return { sent: false, why: r?.why === 'parked' ? 'parked' : 'gone', ...(typeof r?.reason === 'string' ? { reason: r.reason } : {}) }
  } catch (err) {
    if (olderHost(err)) return null
    log.session.warn('host queue rows: the host did not answer a Retry of its row; nothing was sent from here', { sessionId, host, messageId, error: errText(err) })
    return { sent: false, why: 'unavailable', reason: new HostUnreachableError(host, errText(err)).message }
  }
}

/**
 * A person's Discard of a row the leader does not have, on the host: true when the host removed it,
 * false when it has none, null for no host (or an older one). Throws HostUnreachableError when the
 * host could not be asked.
 */
export async function discardOnHost(sessionId: string, messageId: string): Promise<boolean | null> {
  const host = await hostOf(sessionId)
  if (!host) return null
  try {
    const removed = (await askHost(sessionId, 'discardQueuedRow', [messageId], HOST_ACT_MS)) === true
    if (removed) forgetRow(sessionId, messageId)
    return removed
  } catch (err) {
    if (olderHost(err)) return null
    log.session.warn('host queue rows: the host did not answer a Discard of its row', { sessionId, host, messageId, error: errText(err) })
    throw new HostUnreachableError(host, errText(err))
  }
}

/**
 * A person's Discard of a queued row: this server's own row, or else (the row is not here at all) the
 * one the host that runs the session keeps. False when neither removed it (taken, or gone); throws
 * when the host could not be asked (the panel says so, and the row stays).
 */
export async function discardQueued(sessionId: string, messageId: string): Promise<boolean> {
  const { deleteMessage, getQueue } = await import('../session-message-queue.js')
  if (await deleteMessage(sessionId, messageId, { discarded: true })) return true
  if ((await getQueue(sessionId)).some((m) => m.id === messageId)) return false
  return (await discardOnHost(sessionId, messageId)) === true
}

/** Test seam. */
export function _resetHostQueueRowsForTesting(): void {
  lastRows.clear()
  loggedHosts.clear()
}
