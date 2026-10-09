/**
 * Cloud REPLICA: POST /api/v1/sessions/:id/messages for a session on another
 * machine (session-stream-v1.ts routes here).
 *
 * The send rides the narrow `session.message` relay: the host's daemon, then
 * the Mac's durable queue (the same store web sends use), which owns delivery.
 * What cannot go now is held here (core/send-queue.ts) and answered 202 with
 * the same messageId; the drain delivers it when the hop it waits on returns.
 * A host with no Mac behind it takes the send by its direct path instead
 * (cloud-send-direct.ts). Every answer reaches the phone within
 * SEND_ANSWER_DEADLINE_MS, on every path, and every refusal names the hop that
 * failed (cloud-send-words.ts).
 */

import crypto from 'node:crypto'
import type { Response } from 'express'
import {
  resolveCloudSessionHost, PrimaryUnreachableError, cloudSessionHostName, type CloudSessionHost,
} from '../../core/sessions/cloud-session-host.js'
import { inHostTerms } from '../../core/hosts/host-display-name.js'
import { CloudImageError, type SessionImage } from '../../core/sessions/cloud-images.js'
import { log } from '../../logging/index.js'
import {
  MAC_BRIDGE_ALIAS, sendError, untilDeadline, notConnectedSentence, relayFailureSentence, stillHandingOverSentence,
  unbankSend, drainBankedSends, NOT_SAVED_SENTENCE,
} from './cloud-send-words.js'

/**
 * Hard ceiling on how long POST /messages may take to ANSWER.
 *
 * Sized against the CLIENT, not the relay: the iOS app gives a text send 15s
 * and then tries again with the same id, so an answer arriving after that is
 * indistinguishable from a dead server. Image sends answer by then too (round
 * 3): a picture save or a relay still out at the deadline holds the send, its
 * pictures with it, where it used to wait out the save's 30s or the relay's 45s
 * (matrix W1, W3: a 47 to 48 s ack). So do a slow direct delivery and a retry
 * waiting behind an earlier try of the same message (gate r2, G11: 12.1 s).
 *
 * 8s, down from 22s (iOS gate r1, P2-7: the first send after the Mac's link
 * died sat faded as "sending" for 22s before the phone heard it was held). A
 * healthy relay answers in well under a second, and holding one that is merely
 * slow costs nothing: the row is relay-only, the relay keeps its own 50s, and a
 * late success marks it relayed and drops the held copy.
 */
const SEND_ANSWER_DEADLINE_MS = 8_000
/** A send that waited for earlier ones still gives its own relay this long. */
const RELAY_WINDOW_FLOOR_MS = 1_500
/**
 * A relay still unanswered after this long gets a ping to the host's daemon
 * over the same bridge, so a held answer can say which hop it waits on: a host
 * that answers is waiting on the Mac behind it, one that does not is the link
 * to the host itself (half-open: the bridge still looks connected).
 */
const HOST_PROBE_AFTER_MS = 3_000
const HOST_PROBE_TIMEOUT_MS = 3_000

/**
 * Resolve a session's host for a cloud branch, or ANSWER the client and return
 * null: 404 not_found when the PRIMARY says so, 503 bridge_offline when the
 * primary could not be asked at all, never 404 on an unknown answer.
 *
 * bridge_offline, not a new code: "the companion cannot reach the primary" is
 * the same condition the other 503s on this path report, and the phone's silent
 * retry ladder keys on exactly that code (SendRetryPolicy.isRetryable): a
 * fresh code would make this the one bridge outage the user has to retry by
 * hand. The message still names the primary, since the session's host may be
 * perfectly healthy.
 */
export async function resolveHostOrAnswer(res: Response, sessionId: string): Promise<CloudSessionHost | null> {
  try {
    const resolved = await resolveCloudSessionHost(sessionId)
    if (resolved) return resolved
    sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
    return null
  } catch (err) {
    if (err instanceof PrimaryUnreachableError) {
      sendError(res, 503, 'bridge_offline', err.message)
      return null
    }
    throw err
  }
}

/**
 * One attempt per message at a time. A phone retries a POST it gave up on
 * (WalnutAPI `retrySafe`) while the first may still be working here, and both
 * could otherwise take the direct path before either wrote its outcome: two
 * turns for one message. A later attempt waits for the earlier one, then reads
 * what it settled (the outcomes ledger, the bank) like any other retry, and
 * never past its own deadline.
 */
const sendsInFlight = new Map<string, Promise<void>>()

export async function cloudSend(
  res: Response,
  sessionId: string,
  text: string,
  images: SessionImage[] = [],
  clientMessageId?: string,
): Promise<void> {
  // Stable id: a client-supplied one (phone retry) makes the durable-queue
  // enqueue idempotent end-to-end: the relay dedupes on it, so a retry after a
  // lost ack cannot double-deliver.
  const messageId = clientMessageId ?? `qm-mobile-${crypto.randomBytes(6).toString('hex')}`
  // When this attempt reached the companion: a stop asked for after it does not hold it back.
  const acceptedAt = Date.now()
  // The phone hears back by then, whatever the hops behind the companion do.
  const answerBy = acceptedAt + SEND_ANSWER_DEADLINE_MS
  // ORDER: registered at arrival, so a later send of the session waits for
  // this one, and the sweep holds the session's rows behind it (send-order.ts).
  const { enterSessionOrder } = await import('../../core/send-order.js')
  const turn = enterSessionOrder(sessionId, messageId, acceptedAt)
  const key = `${sessionId}\u0000${messageId}`
  const earlier = sendsInFlight.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((r) => { release = r })
  const mine = earlier.then(() => done)
  sendsInFlight.set(key, mine)
  try {
    if (await Promise.race([earlier.then(() => 'ready' as const), untilDeadline(answerBy)]) === 'deadline') {
      await answerBehindEarlierTry(res, sessionId, messageId)
      return
    }
    // Every earlier send of the session answers first (each within its own
    // deadline); one still out at this send's deadline is waited on by holding
    // this one behind it, never by overtaking it.
    await turn.waitForEarlier(answerBy)
    await cloudSendOnce(res, sessionId, text, images, messageId, acceptedAt, { behind: turn.earlierInFlight(), answerBy })
  } finally {
    release()
    if (sendsInFlight.get(key) === mine) sendsInFlight.delete(key)
    turn.leave()
    // A later send may have been held behind this one: it can go now.
    void (async () => {
      const queue = await import('../../core/send-queue.js')
      if (await queue.sessionHasBankedSend(sessionId)) await queue.flushSendQueue()
    })().catch(() => {})
  }
}

/** A retry that reached its deadline while an earlier try of the same message still works. */
async function answerBehindEarlierTry(res: Response, sessionId: string, messageId: string): Promise<void> {
  const queue = await import('../../core/send-queue.js')
  if (await queue.bankedSendFor(messageId)) {
    res.status(202).json({ messageId, queued: true, ...(await queue.heldFor(sessionId) ?? {}) })
    return
  }
  const prior = await queue.readSendOutcome(sessionId, messageId)
  if (prior?.state === 'relayed' || prior?.state === 'delivered-direct') {
    res.status(202).json({ messageId })
    return
  }
  // Retryable by the phone's own ladder: the earlier try settles it, the next retry reads that.
  const { sessionHostName } = await import('./session-stop-v1.js')
  sendError(res, 503, 'bridge_offline', stillHandingOverSentence(await sessionHostName(sessionId) ?? "the session's host"))
}

async function cloudSendOnce(
  res: Response,
  sessionId: string,
  text: string,
  images: SessionImage[],
  messageId: string,
  acceptedAt: number,
  order: { behind: boolean; answerBy: number },
): Promise<void> {
  const projected = await resolveHostOrAnswer(res, sessionId)
  if (!projected) return
  const host = projected.host
  // Every sentence below names the host by the name a person knows it by.
  const hostName = cloudSessionHostName(projected)
  // The latest stop this companion knows of: the session list's, or the one the
  // Mac named when the phone's stop through here finished (the list lags it).
  // A stop the Mac has not confirmed yet holds every path, the direct one too.
  const { latestKnownStop } = await import('../../core/sessions/cloud-stop-fence.js')
  const latestStop = await latestKnownStop(sessionId, projected.stopRequest)
  if (latestStop?.state === 'pending') {
    sendError(res, 409, 'stop_pending', `Wait for ${hostName} to confirm the stop before sending a new message.`)
    return
  }
  const { bridgeRequest, BridgeOfflineError } = await import('../ws/bridge-registry.js')
  const queue = await import('../../core/send-queue.js')
  const hints = { cwd: projected.cwd, model: projected.model, acceptedAt, hostName }
  // A held answer names the hop the message actually waits on (send-queue.ts heldFor).
  const held = async (): Promise<Record<string, unknown>> => ({
    messageId, queued: true,
    ...(await queue.heldFor(sessionId) ?? {
      waitingFor: host === MAC_BRIDGE_ALIAS ? '' : host, waitingForName: hostName, heldNote: `Can't reach ${hostName} right now.`,
    }),
  })

  // ── A retry of a message this companion already settled ──
  // Answered from what is known, never by sending it again: the other path may
  // already have delivered it (send-queue.ts, outcomes ledger).
  const prior = await queue.readSendOutcome(sessionId, messageId)
  if (prior?.state === 'delivered-direct' || prior?.state === 'relayed') {
    res.status(202).json({ messageId })
    return
  }
  if (prior?.state === 'maybe-direct' || prior?.state === 'unknown') {
    sendError(res, 409, 'delivery_unknown', prior.message ?? queue.unknownFateMessage(hostName))
    return
  }
  if (prior?.state === 'not-sent') {
    sendError(res, 409, prior.code ?? 'not_sent', prior.message ?? 'Not sent.')
    return
  }
  // A relay of an earlier try may sit in the Mac's queue: only the relay may
  // deliver this message from now on, so a bank of it is relay-only too.
  const relayedBefore = prior?.state === 'maybe-relayed'

  // The stop fence goes with the message on EVERY path, a held one included:
  // the primary's queue refuses a message whose fence is not its latest stop,
  // so a held send banked with none was refused as "predating" the stop on any
  // session that had ever been stopped.
  let stopFence: string | null
  try { stopFence = await queue.bindSessionSendFence(sessionId, messageId, latestStop?.id ?? null) }
  catch {
    sendError(res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)
    return
  }
  // Pictures the host does not have yet: a held send keeps them (cloud-images.ts).
  let pendingImages = images
  const holdIt = (why: string, opts: import('../../core/send-queue.js').BankOptions = {}): Promise<boolean> =>
    bankSend(sessionId, host, text, messageId, pendingImages, stopFence, { ...hints, ...opts }, why)
  // A retry of a send already held here is the same send.
  if (await queue.bankedSendFor(messageId)) {
    res.status(202).json(await held())
    void drainBankedSends()
    return
  }
  // The Mac gave it back (it is direct-only from here), or a direct delivery of
  // it was out when the companion restarted: the sweep settles it (it asks the
  // host before anything else), never this attempt by a relay.
  if (prior?.state === 'withdrawn' || prior?.state === 'direct-intent') {
    if (await holdIt(prior.state === 'withdrawn' ? 'the Mac gave it back' : 'a direct delivery of it may have run', { provablyUnsent: true })) {
      res.status(202).json(await held())
      void drainBankedSends()
      return
    }
    sendError(res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)
    return
  }
  // ORDER: a session with a held send ahead of this one, or an earlier send
  // still being handed over, keeps this one behind it, or the newer message
  // would reach the CLI first. Nothing carried this one anywhere yet, so the
  // direct path may take it later.
  if (order.behind || await queue.sessionHasBankedSend(sessionId)) {
    if (await holdIt(order.behind ? 'behind an earlier send still out' : 'behind an earlier held send', { provablyUnsent: !relayedBefore })) {
      res.status(202).json(await held())
      void drainBankedSends()
      return
    }
  }

  try {
    // Images first: if any save fails the send is aborted with a precise error
    // (never a text-only turn that silently dropped the pictures). Augmented
    // text mirrors the primary-box "[Images attached ...]" format. A save that
    // is still out at the answer deadline, or cannot be made now, holds the send
    // with its pictures, and the drain saves them when the host can take them.
    if (images.length > 0) {
      const { saveImagesViaBridge, withImagePaths, noteImageSaveInFlight } = await import('../../core/sessions/cloud-images.js')
      const saving = saveImagesViaBridge(host, sessionId, images, projected.hostLabel)
      const settled = saving.then((paths) => ({ paths }), (err: unknown) => ({ err }))
      let outcome = await Promise.race([settled, untilDeadline(order.answerBy)])
      if (outcome === 'deadline') {
        const saveDone = noteImageSaveInFlight(messageId)
        if (await holdIt('its pictures are still on the way', { provablyUnsent: !relayedBefore })) {
          res.status(202).json(await held())
          // When the save lands, the held row names the files; the drain then takes it.
          void settled.then(async (late) => {
            if ('paths' in late) await queue.adoptSavedImages(messageId, late.paths)
          }).catch(() => {}).finally(() => { saveDone(); void drainBankedSends() })
          return
        }
        saveDone()
        outcome = await settled
      }
      if ('err' in outcome) {
        if (outcome.err instanceof CloudImageError) throw outcome.err
        // No bridge, a timeout, the bridge going away: nothing went anywhere.
        if (await holdIt('its pictures could not be saved yet', { provablyUnsent: !relayedBefore })) {
          res.status(202).json(await held())
          return
        }
        throw outcome.err
      }
      text = withImagePaths(text, outcome.paths)
      pendingImages = []
    }

    // ── Durable path (default): session.message relay → the primary's queue ──
    // The primary enqueues into the SAME persistent store web sends use;
    // session-runner owns delivery (FIFO / mid-turn / --resume) and the
    // reconnect redelivery drains anything a daemon death stranded. 50s so
    // the daemon's own 45s relay timeout surfaces its precise error first.
    // Relay-only on disk BEFORE the first byte (gate r3, N2a): a companion that
    // dies with the relay out must not deliver it directly after its restart.
    try { await queue.markRelayIntent(sessionId, messageId) }
    catch {
      sendError(res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)
      return
    }
    const relayPromise = bridgeRequest(host, 'session.message', {
      sessionId, message: text, messageId, stopFence,
    }, 50_000).catch((err: unknown) => {
      if (err instanceof BridgeOfflineError) throw err
      // Transport-level failure mid-relay (bridge WS died, request timer):
      // the enqueue MAY have committed on the primary. Do NOT fall back to
      // the direct path (double-delivery risk): report retryable; a retry
      // with the same messageId dedupes at the queue.
      return { ok: false, error: err instanceof Error ? err.message : String(err), transport: true }
    })

    // ANSWER DEADLINE (the real 2026-08-20 bug): the phone gives up long before
    // the relay's own budget, so the route always answers inside the phone's,
    // and holds whatever the relay has not confirmed by then. Safe because the
    // held retry rides the SAME idempotent session.message path with the SAME
    // messageId (queue dedupe + the relay fates), which is exactly why the
    // non-idempotent DIRECT path still refuses this case. The deadline is the
    // phone's (answerBy), less what it already waited for earlier sends; never
    // under a moment, so a quick relay still answers.
    const relayWindowMs = Math.max(RELAY_WINDOW_FLOOR_MS, order.answerBy - Date.now())
    const probe: { answers?: Promise<boolean> } = {}
    const probeTimer = host === MAC_BRIDGE_ALIAS || relayWindowMs <= HOST_PROBE_AFTER_MS ? null
      : setTimeout(() => { probe.answers = hostBridgeAnswers(host) }, HOST_PROBE_AFTER_MS)
    probeTimer?.unref?.()
    const raced = await Promise.race([
      relayPromise,
      new Promise<'deadline'>((r) => setTimeout(() => r('deadline'), relayWindowMs).unref?.()),
    ])
    if (probeTimer) clearTimeout(probeTimer)
    if (raced === 'deadline') {
      // The relay is out and unanswered: relay-only from here (never direct).
      const hostSilent = probe.answers ? !(await probe.answers) : false
      const banked = await holdIt('the relay is still out at the answer deadline', { hostSilent })
      if (banked) {
        // The sweep leaves the row alone until this relay settles (send-order.ts).
        const { noteRelayOut } = await import('../../core/send-order.js')
        noteRelayOut(messageId, relayPromise)
        await queue.markSendOutcome(sessionId, messageId, 'maybe-relayed')
        log.web.info('mobile session send banked at the answer deadline (relay still pending)', {
          sessionId, host, messageId, deadlineMs: relayWindowMs, hostSilent,
        })
        res.status(202).json(await held())
        // A late success means the primary already has it: drop the banked copy
        // so the sweep does no redundant (though harmless) re-relay.
        void relayPromise.then(async (late) => {
          if (late && (late as Record<string, unknown>).ok === true) {
            await queue.markSendOutcome(sessionId, messageId, 'relayed')
            await unbankSend(messageId)
          }
        }).catch(() => {})
        return
      }
      // Couldn't bank (the queue write failed): let the relay finish on its own
      // budget rather than inventing an outcome.
    }
    const relayed: Record<string, unknown> = raced === 'deadline'
      ? await relayPromise
      : (raced as Record<string, unknown>)
    if (relayed.ok === true) {
      log.web.info('mobile session send enqueued via relay (durable)', {
        sessionId, host, messageId, imageCount: images.length,
      })
      // Remembered for this id: a retry after the Mac goes quiet is answered
      // from here, never delivered again by the host's direct path.
      await queue.markSendOutcome(sessionId, messageId, 'relayed')
      res.status(202).json({ messageId })
      // Opportunistic drain: a live bridge is the only thing anything banked
      // during the last outage was waiting for. After the response, never before.
      void drainBankedSends()
      return
    }
    const relayErr = String(relayed.error ?? 'unknown')
    if (relayed.errorKind === 'session_stopped') {
      // The Mac's queue refused it for good: a retry of this id is told the same.
      await queue.markSendOutcome(sessionId, messageId, 'not-sent', { code: 'session_stopped', message: relayErr })
      sendError(res, 409, 'session_stopped', relayErr)
      return
    }
    if (relayed.errorKind === 'not_found') {
      // The primary answered that it has no such session: nothing was queued.
      await queue.clearRelayIntent(sessionId, messageId)
      sendError(res, 404, 'not_found', relayErr)
      return
    }
    if (relayed.errorKind === 'removed') {
      const { REMOVED_ON_MAC } = await import('../../core/send-queue-sweep.js')
      await queue.markSendOutcome(sessionId, messageId, 'not-sent', { code: 'removed_on_mac', message: REMOVED_ON_MAC })
      sendError(res, 409, 'removed_on_mac', REMOVED_ON_MAC)
      return
    }
    if (relayed.errorKind === 'withdrawn') {
      // The Mac gave this id back earlier and refuses it now: direct-only, the sweep's to settle.
      await queue.markSendOutcome(sessionId, messageId, 'withdrawn')
      if (await holdIt('the Mac gave it back', { provablyUnsent: true })) {
        res.status(202).json(await held())
        void drainBankedSends()
        return
      }
      sendError(res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)
      return
    }
    // The direct path is possible ONLY when the primary provably never saw the
    // message: an old daemon (unknown command) or no connected primary (Mac
    // offline, or the Mac's link to this host is dead: the daemon answers this
    // at once, having forwarded nothing). Anything else (relay timeout,
    // internal error) might have enqueued.
    const canFallback = relayErr.startsWith('unknown command')
      || relayErr.includes('no primary server connected')
    if (!canFallback) {
      // Whatever went wrong past the companion (a host-side timeout, an internal
      // error, a transport death), the relay may have reached the Mac's queue:
      // every later try of this id, text or image, is relay-only.
      await queue.markSendOutcome(sessionId, messageId, 'maybe-relayed')
      sendError(res, 503, 'bridge_offline', relayFailureSentence(relayErr, host, hostName, projected.hostLabel))
      return
    }
    // This relay forwarded nothing: the message is back where it was (still
    // relay-only when an earlier relay of it may have gone out).
    await queue.clearRelayIntent(sessionId, messageId)
    const { sendDirectOrHold } = await import('./cloud-send-direct.js')
    await sendDirectOrHold({
      res, sessionId, host, hostName, hostLabel: projected.hostLabel, text, messageId, stopFence, acceptedAt,
      answerBy: order.answerBy, cwd: hints.cwd, model: hints.model, holdIt, held,
    })
  } catch (err) {
    if (err instanceof CloudImageError) {
      sendError(res, 400, err.code, inHostTerms(err.message, host, projected.hostLabel))
      return
    }
    if (err instanceof BridgeOfflineError) {
      // FAST-ACCEPT: there is no socket, so the primary provably never saw this
      // message: bank it and answer 202. Durability used to begin one hop too
      // late (only AFTER the relay reached the primary's queue), which made the
      // phone's 120s retry ladder the ONLY thing covering a bridge outage. Real
      // outages are not bounded by that: the 2026-08-20 one ran ~7 minutes
      // (Wi-Fi loss, dial timeout, redial backoff), so the ladder ran out and
      // the bubble went red on a healthy, still-streaming session. See
      // core/send-queue.ts for why a queued 202 is honest and what stays 503.
      // Nothing carried it anywhere, so the host's direct path may take it.
      await queue.clearRelayIntent(sessionId, messageId)
      if (await holdIt('no bridge to the host', { provablyUnsent: !relayedBefore })) {
        res.status(202).json(await held())
        return
      }
      sendError(res, 503, 'bridge_offline', notConnectedSentence(host, hostName))
      return
    }
    const reason = err instanceof Error ? err.message : String(err)
    sendError(res, 503, 'bridge_offline', relayFailureSentence(reason, host, hostName, projected.hostLabel))
  }
}

/**
 * Hold a send for delivery when its host can take it (send-queue.ts), its
 * pictures with it. Returns false when the caller must keep the honest 503:
 * the queue write failed (never a 202 for something we did not store).
 */
async function bankSend(
  sessionId: string, host: string, text: string, messageId: string, images: SessionImage[], stopFence: string | null,
  opts: import('../../core/send-queue.js').BankOptions, why: string,
): Promise<boolean> {
  const { enqueueSessionSend } = await import('../../core/send-queue.js')
  const opId = await enqueueSessionSend(sessionId, host, text, messageId, stopFence, { ...opts, ...(images.length ? { images } : {}) })
  if (!opId) return false
  log.web.info('mobile session send held', {
    sessionId, host, messageId, opId, why, provablyUnsent: opts.provablyUnsent === true, images: images.length,
  })
  return true
}

/** Does the host's daemon answer on its bridge? `ackSeq: -1` confirms no uplink marker. */
async function hostBridgeAnswers(host: string): Promise<boolean> {
  try {
    const { bridgeRequest } = await import('../ws/bridge-registry.js')
    const reply = await bridgeRequest(host, 'ping', { ackSeq: -1 }, HOST_PROBE_TIMEOUT_MS)
    return reply.ok !== false
  } catch {
    return false
  }
}
