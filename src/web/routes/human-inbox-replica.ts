/**
 * The replica half of the reader's inbox routes: list, one letter, and the
 * read / pin / archive flags.
 *
 * The primary is asked first, because it is the freshest. When it cannot be
 * reached (no bridge, a relay timeout, a primary too old for the action), the
 * replica answers from its own git-synced copy and takes the flag changes for
 * later, so the phone keeps a working inbox while the Mac sleeps. The rules and
 * the queue live in core/human-inbox/replica-state.ts; this file only decides,
 * per request, which of the two answers.
 *
 * A refusal from the primary (404, 400) is passed through as before: the
 * primary is still the authority whenever it answers.
 */

import type { Response } from 'express'
import { log } from '../../logging/index.js'
import { callPrimaryControl, sendV1Error as sendError, type RelayFailure } from './v1-control-relay.js'
import type { LetterStateField } from '../../core/human-inbox/store.js'

const SERVER_RELAY_SID = '__server__'

/**
 * Budgets inside the route's 12s deadline. A read gives the primary 6s before
 * the copy answers (a Mac that just fell asleep keeps its socket for up to a
 * minute, so "no answer yet" is the common shape of offline). A flag write
 * gives it 8s; the phone has already flipped the row, so the wait is not seen.
 */
const READ_RELAY_TIMEOUT_MS = 6_000
const WRITE_RELAY_TIMEOUT_MS = 8_000
/** How long a request lets queued changes replay first, so it never reads around them. */
const QUEUE_FLUSH_BUDGET_MS = 3_000

type ReplicaState = typeof import('../../core/human-inbox/replica-state.js')
type Unreachable = Exclude<RelayFailure, { kind: 'error' }>

function replicaState(): Promise<ReplicaState> {
  return import('../../core/human-inbox/replica-state.js')
}

/** The primary could not take the request at all: the copy is the answer. */
function unreachable(failure: RelayFailure): failure is Unreachable {
  return failure.kind === 'bridge_offline' || failure.kind === 'needs_upgrade'
}

function offlineMessage(failure: Unreachable | null): string {
  return failure?.kind === 'bridge_offline' ? failure.message : 'Your primary box (Mac) did not answer'
}

/**
 * Replay what is queued before reading, and say whether anything is STILL
 * queued: then the primary's answer would not include it, and the copy (which
 * shows it) is the consistent one to serve.
 */
async function queueStillPending(q: ReplicaState): Promise<boolean> {
  if ((await q.pendingStateCount()) === 0) return false
  await q.flushStateQueue({ budgetMs: QUEUE_FLUSH_BUDGET_MS })
  return (await q.pendingStateCount()) > 0
}

/**
 * One relayed read. Returns the result, or true when the response was already
 * sent (the primary refused), or the reason the copy must answer.
 */
async function relayRead(
  res: Response, action: 'server.human-inbox' | 'server.human-inbox.get', params: Record<string, unknown>,
): Promise<{ result: Record<string, unknown> } | true | { failure: Unreachable }> {
  const reply = await callPrimaryControl(action, SERVER_RELAY_SID, params, READ_RELAY_TIMEOUT_MS)
  if (reply.ok) return { result: reply.result }
  if (!unreachable(reply.failure)) {
    sendError(res, reply.failure.status, reply.failure.code, reply.failure.message)
    return true
  }
  return { failure: reply.failure }
}

/** GET /human-inbox[?archived=1] on a replica. */
export async function replicaListLetters(res: Response, archived: boolean): Promise<void> {
  const q = await replicaState()
  // With changes still queued, the copy is the consistent list: the primary's
  // would show those letters as they were, and an archive moves a letter
  // between the two lists, which an overlay on one list cannot do. The primary
  // is asked anyway when there is no copy to answer from.
  const pending = await queueStillPending(q)
  let failure: Unreachable | null = null
  if (!pending || !(await q.readMirrorIndex())) {
    const relayed = await relayRead(res, 'server.human-inbox', { archived })
    if (relayed === true) return
    if ('result' in relayed) {
      res.json(relayed.result)
      return
    }
    failure = relayed.failure
  }
  const list = await q.mirrorList({ archived })
  if (!list) {
    sendError(res, 503, 'bridge_offline', offlineMessage(failure))
    return
  }
  log.notif.info('human-inbox replica: list served from the synced copy', {
    archived, letters: list.letters.length, mirrorUpdatedAt: list.mirrorUpdatedAt,
    reason: failure?.kind ?? 'queued-changes',
  })
  res.json(list)
}

/** GET /human-inbox/:id on a replica. */
export async function replicaGetLetter(res: Response, id: string): Promise<void> {
  const q = await replicaState()
  const pending = await queueStillPending(q)
  // One letter is always asked for: the queued changes go on top of the
  // primary's answer, and a letter newer than the copy still opens.
  const relayed = await relayRead(res, 'server.human-inbox.get', { id })
  if (relayed === true) return
  if ('result' in relayed) {
    const letter = relayed.result.letter as Parameters<ReplicaState['overlayQueued']>[0] | undefined
    res.json(pending && letter ? { ...relayed.result, letter: await q.overlayQueued(letter) } : relayed.result)
    return
  }
  const letter = await q.mirrorLetter(id)
  if (!letter) {
    // Not in the copy: it may be newer than the last sync, so "not found" would
    // be a guess. Say what is known instead.
    sendError(res, 503, 'bridge_offline', offlineMessage(relayed.failure))
    return
  }
  res.json({ letter, servedFrom: 'mirror' })
}

/** POST /human-inbox/:id/{read,pin,archive} on a replica. */
export async function replicaSetLetterState(
  res: Response, id: string, field: LetterStateField, value: boolean,
): Promise<void> {
  // The human's moment, taken before any wait: a replay is judged against it.
  const at = Date.now()
  const q = await replicaState()
  const { action, key } = q.STATE_ACTIONS[field]
  const reply = await callPrimaryControl(`server.human-inbox.${action}`, SERVER_RELAY_SID, {
    id, [key]: value,
  }, WRITE_RELAY_TIMEOUT_MS)
  if (reply.ok) {
    const { letter, storeUpdatedAt } = reply.result as { letter?: unknown; storeUpdatedAt?: unknown }
    await q.noteStateApplied(id, field, value, at, storeUpdatedAt)
    // The link is up: anything still queued can go now.
    if ((await q.pendingStateCount()) > 0) void q.flushStateQueue()
    res.json({ letter })
    return
  }
  if (!unreachable(reply.failure)) {
    sendError(res, reply.failure.status, reply.failure.code, reply.failure.message)
    return
  }
  // The primary did not take it, or may have (a timeout after the send). Either
  // way the change is safe to queue: setting a flag to a value is idempotent.
  // A letter the copy does not hold cannot be answered with a record, so that
  // one stays an honest error.
  if (!(await q.mirrorRecord(id)) || !(await q.queueStateChange(id, field, value, at))) {
    sendError(res, 503, 'bridge_offline', offlineMessage(reply.failure))
    return
  }
  res.json({ letter: await q.mirrorRecord(id), queued: true })
}
