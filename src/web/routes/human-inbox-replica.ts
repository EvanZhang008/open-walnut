/**
 * The replica half of the reader's inbox routes: list, one letter, the
 * read / pin / archive flags, and the human's reply and answer on the companion.
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

import crypto from 'node:crypto'
import type { Response } from 'express'
import { log } from '../../logging/index.js'
import {
  callPrimaryControl, classifyRelayReply, sendRelayReplyError, sendV1Error as sendError, tryControlRelay, type RelayFailure,
} from './v1-control-relay.js'
import type { LetterStateField } from '../../core/human-inbox/store.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'

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

/** The words of a read of the inbox the user keeps from this box (Settings): the Mac's alone. */
const INBOX_NOT_KEPT = 'Your inbox is kept only on your Mac.'

/** The inbox turned off for this box: never its synced copy, only the Mac (kinds/gate.ts). */
async function inboxOff(): Promise<boolean> {
  const { copyKindOff } = await import('../../core/replication/kinds/gate.js')
  return copyKindOff('inbox')
}

/** GET /human-inbox[?archived=1] on a replica. */
export async function replicaListLetters(res: Response, archived: boolean): Promise<void> {
  if (await inboxOff()) {
    const relayed = await relayRead(res, 'server.human-inbox', { archived })
    if (relayed === true) return
    if ('result' in relayed) { res.json(relayed.result); return }
    throw new NeedsLeaderError('not_kept_here', INBOX_NOT_KEPT)
  }
  const q = await replicaState()
  // With changes still queued, the copy is the consistent list: the primary's
  // would show those letters as they were, and an archive moves a letter
  // between the two lists, which an overlay on one list cannot do. The primary
  // is asked anyway when there is no copy to answer from. A reply or answer
  // still in the journal counts too: the Mac has not got it yet.
  const pending = (await queueStillPending(q)) || (await q.pendingTurnCount()) > 0
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
  if (await inboxOff()) {
    const relayed = await relayRead(res, 'server.human-inbox.get', { id })
    if (relayed === true) return
    if ('result' in relayed) { res.json(relayed.result); return }
    throw new NeedsLeaderError('not_kept_here', INBOX_NOT_KEPT)
  }
  const q = await replicaState()
  // Queued flags replay first (what still waits goes on top of the answer below).
  await queueStillPending(q)
  // One letter is always asked for: the queued changes go on top of the
  // primary's answer, and a letter newer than the copy still opens.
  const relayed = await relayRead(res, 'server.human-inbox.get', { id })
  if (relayed === true) return
  if ('result' in relayed) {
    const letter = relayed.result.letter as Parameters<ReplicaState['overlayQueued']>[0] | undefined
    // Queued flags go on top, and so does a reply or answer this box took that the Mac's
    // letter does not show yet (still in the journal, or acked and not in the copy yet).
    // Nothing waiting is the Mac's letter as it is (overlayQueued adds nothing then).
    res.json(letter ? { ...relayed.result, letter: await q.overlayQueued(letter) } : relayed.result)
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

/** The request carries pictures (uploads named here, or inline). */
function hasPictures(b: Record<string, unknown>): boolean {
  return (Array.isArray(b.images) && b.images.length > 0) || (Array.isArray(b.imageRefs) && b.imageRefs.length > 0)
}

/** 202 when the turn is on record and its delivery is still running, else 200 (human-inbox-v1.ts). */
function deliveringStatus(result: Record<string, unknown>): number {
  return (result.delivery as { status?: unknown } | undefined)?.status === 'pending' ? 202 : 200
}

/**
 * POST /human-inbox/:id/{human-reply,answer} on the companion.
 *
 * 2026-11-05: the user answered a letter by voice on the phone while the Mac was away;
 * this route only relayed, answered `503 bridge_offline` in 1 ms, and the reply reached the
 * Mac 1h45m later when the phone resent its draft. Now the Mac is asked first, as before,
 * and every answer it gives (its refusals included) is passed through unchanged. When the
 * Mac provably did not take the request (no bridge, a daemon with no server behind it, a
 * Mac too old for the action), the turn goes into the companion's journal (`inbox-reply`,
 * core/companion-journal.ts journalInboxReply) and the answer is the Mac's own shape:
 * `202 {letter, delivery: {status: 'pending'}, queued: true}`, the letter from this box's
 * copy with the turn in its thread (replica-state.ts shows it on every read here until the
 * copy holds it). The Mac records and delivers it when it drains (apply-inbox-reply.ts).
 *
 * A relay that MAY have reached the Mac (a timeout after the send) keeps its 503, except a
 * reply: the Mac keeps one turn per `clientId`, so one is made here when the phone sent
 * none, the relay carries it, and the record replays the same turn at most once.
 *
 * Kept as before (the Mac's answer or the 503): an older Mac that does not drain the kind;
 * a session answering for the user (`callerSid`: the Mac resolves the caller and records
 * its task); a letter not in this box's copy; a turn the Mac would refuse (no words, a bad
 * clientId, an option the letter does not offer, a letter already answered otherwise).
 * KNOWN GAP: a reply or answer with pictures (`images` / `imageRefs`) still needs the Mac,
 * whose image store keeps them; the journal would have to carry the bytes as blobs.
 */
export async function replicaLetterTurn(
  res: Response,
  op: 'reply' | 'answer',
  id: string,
  body: Record<string, unknown>,
  relayParams: Record<string, unknown>,
  opts: { callerSid?: string; answerBy: number },
): Promise<void> {
  // The human's moment, taken before any wait.
  const madeAt = Date.now()
  const action = op === 'reply' ? 'server.human-inbox.human-reply' : 'server.human-inbox.answer'
  const { macDrains, journalInboxReply } = await import('../../core/companion-journal.js')
  const journalable = macDrains('inbox-reply') && !opts.callerSid && !hasPictures(body)
  const madeId = op === 'reply' && journalable && body.clientId === undefined ? `rp-${crypto.randomUUID()}` : undefined
  const params = madeId ? { ...relayParams, clientId: madeId } : relayParams
  // A journalable turn answers inside the route's deadline even when the relay hangs.
  const out = await tryControlRelay(action, SERVER_RELAY_SID, params, journalable ? Math.max(1_000, opts.answerBy - Date.now()) : undefined)
  if (out.ok) {
    const reply = out.reply
    if (reply.ok === true && reply.result && typeof reply.result === 'object') {
      const result = reply.result as Record<string, unknown>
      res.status(deliveringStatus(result)).json(result)
      return
    }
    // The Mac's daemon answered that it could not take it at all (needs_upgrade, or no
    // server behind it): provably not run. Any other answer is the Mac's, passed through.
    if (!journalable || !unreachable(classifyRelayReply(reply))) {
      sendRelayReplyError(res, reply)
      return
    }
  } else if (!journalable || !(out.notSent || op === 'reply')) {
    out.answer(res)
    return
  }
  const fail = (): void => { if (out.ok) sendRelayReplyError(res, out.reply); else out.answer(res) }
  const q = await replicaState()
  const record = await q.mirrorRecord(id)
  if (!record) { fail(); return }
  let input: Parameters<typeof journalInboxReply>[0]
  if (op === 'reply') {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    const clientId = madeId ?? body.clientId
    const { CLIENT_ID_RE } = await import('../../core/human-inbox/normalize.js')
    if (!text || typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) { fail(); return }
    input = { letterId: id, op: 'reply', text, clientId, madeAt }
  } else {
    const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : ''
    const freeText = typeof body.freeText === 'string' ? body.freeText.trim() : ''
    if (!record.actions?.some((a) => a.id === actionId)) { fail(); return }
    if (record.answered && !record.answered.by) {
      // The same answer again (a retry, its record waiting or taken): the letter as it stands.
      // Another answer the Mac refuses (one answer per letter), so it gets the old answer.
      // Notes compared as the store keeps them (bounded), whichever side was cut.
      const { boundThreadText } = await import('../../core/human-inbox/store.js')
      const same = record.answered.actionId === actionId && boundThreadText(record.answered.freeText ?? '') === boundThreadText(freeText)
      if (!same) { fail(); return }
      res.status(202).json({ letter: (await q.mirrorLetter(id)) ?? record, delivery: { status: 'pending' }, queued: true })
      return
    }
    input = { letterId: id, op: 'answer', actionId, ...(freeText ? { freeText } : {}), madeAt }
  }
  const saved = journalInboxReply(input)
  if (!saved?.ok) { fail(); return }
  log.notif.info('human-inbox replica: a reply kept for the Mac (primary unreachable)', {
    letterId: id, op, opId: saved.opId, seq: saved.seq, ...(saved.duplicate ? { duplicate: true } : {}),
    relay: out.ok ? classifyRelayReply(out.reply).kind : out.notSent ? 'not_sent' : 'maybe_sent',
  })
  res.status(202).json({
    letter: (await q.mirrorLetter(id)) ?? (await q.mirrorRecord(id)) ?? record,
    delivery: { status: 'pending' },
    queued: true,
    ...(input.op === 'reply' ? { clientId: input.clientId } : {}),
  })
}
