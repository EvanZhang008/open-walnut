/**
 * Cloud REPLICA: the send route's direct path, for a phone send the host's
 * daemon answered with "no primary server connected" (it forwarded nothing;
 * the Mac is offline, or its link to the host is down).
 *
 * Three rules, each from a gate finding (r2):
 *  - a relay of an earlier try may sit in the Mac's queue: only the Mac may
 *    free it, so the send is held and the sweep asks (send-queue-sweep.ts);
 *  - ORDER (B2, G3): nothing starts a delivery while an earlier message of the
 *    session may still wait anywhere; the Mac answers 'behind', or, when it
 *    cannot be asked, the session's own unconfirmed relays hold it
 *    (send-direct-gate.ts);
 *  - the 8 s answer DEADLINE holds on this path too (G11): a direct delivery
 *    still out by then is held, the delivery keeps running, and its end settles
 *    the held row. The sweep leaves a row alone while its delivery runs here.
 */

import type { Response } from 'express'
import { inHostTerms } from '../../core/hosts/host-display-name.js'
import type { BankOptions } from '../../core/send-queue.js'
import type { DirectSendOutcome } from '../../core/sessions/direct-host-send.js'
import { log } from '../../logging/index.js'
import {
  sendError, untilDeadline, notConnectedSentence, relayFailureSentence, unbankSend, drainBankedSends, NOT_SAVED_SENTENCE,
} from './cloud-send-words.js'

export interface DirectContext {
  res: Response
  sessionId: string
  host: string
  hostName: string
  hostLabel?: unknown
  text: string
  messageId: string
  stopFence: string | null
  acceptedAt: number
  /** When the phone must have its answer (epoch ms). */
  answerBy: number
  cwd?: string
  model?: string
  /** Hold this send (cloud-session-send.ts); false = it could not be stored. */
  holdIt: (why: string, opts?: BankOptions) => Promise<boolean>
  /** The body of a held answer (names the hop the message waits on). */
  held: () => Promise<Record<string, unknown>>
}

/** Room left for the questions before the deadline, so the answer still makes it. */
const ANSWER_MARGIN_MS = 500

async function answerHeld(ctx: DirectContext, why: string, opts: BankOptions): Promise<void> {
  if (await ctx.holdIt(why, opts)) {
    ctx.res.status(202).json(await ctx.held())
    void drainBankedSends()
    return
  }
  sendError(ctx.res, 503, 'send_state_unavailable', NOT_SAVED_SENTENCE)
}

export async function sendDirectOrHold(ctx: DirectContext): Promise<void> {
  const { sessionId, host, messageId } = ctx
  const queue = await import('../../core/send-queue.js')
  // A relay of an earlier try may sit in the Mac's queue: only the Mac may
  // free it, so it is held and the sweep asks the Mac (text and images alike;
  // an image send's pictures are already on the host and its text names them).
  if ((await queue.readSendOutcome(sessionId, messageId))?.state === 'maybe-relayed') {
    await answerHeld(ctx, 'a relay of it may still sit with the Mac', { macLinkDown: true })
    return
  }
  const { directDeliveryGate } = await import('../../core/send-direct-gate.js')
  const gate = await directDeliveryGate(
    { opId: 'route', host, sessionId, messageId },
    { mayBeOnMac: false, budgetMs: Math.max(0, ctx.answerBy - Date.now() - ANSWER_MARGIN_MS) },
  )
  if (gate === 'removed') {
    const { REMOVED_ON_MAC } = await import('../../core/send-queue-sweep.js')
    await queue.markSendOutcome(sessionId, messageId, 'not-sent', { code: 'removed_on_mac', message: REMOVED_ON_MAC })
    sendError(ctx.res, 409, 'removed_on_mac', REMOVED_ON_MAC)
    return
  }
  if (gate === 'stopped') {
    // A stop on the Mac parked an earlier relay of it there: it never runs.
    const { STOPPED_AFTER_SEND } = await import('../../core/sessions/cloud-stop-fence.js')
    await queue.markSendOutcome(sessionId, messageId, 'not-sent', { code: 'session_stopped', message: STOPPED_AFTER_SEND })
    sendError(ctx.res, 409, 'session_stopped', STOPPED_AFTER_SEND)
    return
  }
  if (gate === 'delivered') {
    await queue.markSendOutcome(sessionId, messageId, 'relayed')
    ctx.res.status(202).json({ messageId })
    return
  }
  if (gate === 'hold') {
    await answerHeld(ctx, 'an earlier message of the session may still wait on the Mac', { provablyUnsent: true, macLinkDown: true })
    return
  }
  log.web.info('mobile send falling back to direct bridge sequence', { sessionId, host, messageId })
  // Deliberately carries NO output-mode directive: the wrapper has to be paired
  // with advancing `output_mode_injected` on the session record, which lives on
  // the primary, and this path exists precisely for when the primary is not
  // reachable. The next relayed send fixes the mode.
  const { deliverDirectToHost } = await import('../../core/sessions/direct-host-send.js')
  const direct = deliverDirectToHost({
    host, sessionId, text: ctx.text, messageId, stopFence: ctx.stopFence,
    cwd: ctx.cwd, model: ctx.model, acceptedAt: ctx.acceptedAt, waitForLaunch: true,
  })
  const raced = await Promise.race([direct, untilDeadline(ctx.answerBy)])
  if (raced === 'deadline') {
    // Still out (a slow host, a spawn still starting): hold it and answer now.
    // The delivery keeps running; the sweep leaves the row alone meanwhile, and
    // its end settles the row (directSendRunning, settleDirect below).
    if (await ctx.holdIt('its direct delivery is still out at the answer deadline', { provablyUnsent: true })) {
      ctx.res.status(202).json(await ctx.held())
      void direct.then((late) => settleDirect(ctx, late, false)).catch(() => {}).finally(() => { void drainBankedSends() })
      return
    }
    await settleDirect(ctx, await direct, true)
    return
  }
  await settleDirect(ctx, raced, true)
}

/**
 * Record how a direct delivery ended, and answer the phone when it still waits
 * (`answer`). A late end (the phone was told "held") settles the held row:
 * what will never run, or already ran, leaves the bank; what may still go stays.
 */
async function settleDirect(ctx: DirectContext, outcome: DirectSendOutcome, answer: boolean): Promise<void> {
  const { sessionId, host, messageId, res } = ctx
  const queue = await import('../../core/send-queue.js')
  if (outcome.ok) {
    await queue.markSendOutcome(sessionId, messageId, 'delivered-direct')
    if (answer) res.status(202).json({ messageId })
    else await unbankSend(messageId)
    return
  }
  if (outcome.kind === 'refused') {
    if (outcome.code === 'session_stopped') {
      // A stop overtook it: it never runs, so a retry of this id is told the same.
      await queue.markSendOutcome(sessionId, messageId, 'not-sent', { code: outcome.code, message: outcome.message })
      if (!answer) await unbankSend(messageId)
    }
    if (answer) sendError(res, outcome.status, outcome.code, inHostTerms(outcome.message, host, ctx.hostLabel))
    return
  }
  if (outcome.ambiguous) {
    const lost = queue.unknownFateMessage(ctx.hostName)
    await queue.markSendOutcome(sessionId, messageId, 'maybe-direct', { code: 'delivery_unknown', message: lost })
    if (answer) sendError(res, 409, 'delivery_unknown', lost)
    else await unbankSend(messageId)
    return
  }
  if (!answer) return
  if (outcome.offline) {
    // The host's bridge went away between the relay and the direct path:
    // nothing was sent, so it is held like any send with no bridge.
    if (await ctx.holdIt('no bridge to the host', { provablyUnsent: true })) {
      res.status(202).json(await ctx.held())
      return
    }
    sendError(res, 503, 'bridge_offline', notConnectedSentence(host, ctx.hostName))
    return
  }
  sendError(res, 503, 'bridge_offline', relayFailureSentence(outcome.message, host, ctx.hostName, ctx.hostLabel))
}
