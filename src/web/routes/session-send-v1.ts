/**
 * /api/v1 session send endpoints, on sessionStreamV1Router (session-stream-v1.ts
 * registers them, so the API is unchanged):
 *
 *   POST /sessions/:id/messages             { text, images?, messageId?, voice?, interrupt? } → 202
 *   GET  /sessions/:id/messages/:messageId  what became of a held message
 *
 * Primary box: the durable message queue (sendMessageToSession). Cloud box: a
 * session on another machine goes through cloud-session-send.ts (the relay,
 * the hold and the direct fallback); a cloud-owned session takes the primary
 * path, its CLI being on this box.
 */

import type { Request, Response, NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { prepareHintedSend } from '../../core/hints/hint-send.js'
import { routeSource } from '../../core/sessions/send-sent-by.js'
import { applyVoiceReply } from '../../core/sessions/voice-reply.js'
import { withImagePaths, type SessionImage } from '../../core/sessions/cloud-images.js'
import { cloudSend } from './cloud-session-send.js'
import { sendError } from './cloud-send-words.js'
import { MAX_SESSION_IMAGES, checkImagePayloads, compressImagesInMemory, fitsImageSaveLimits, isImageAttachError, savePicturesToDisk } from './images.js'
import { log } from '../../logging/index.js'

const SID_RE = /^[A-Za-z0-9_-]+$/

// How long the companion waits for the primary to take a stop that comes before a send.
const INTERRUPT_RELAY_TIMEOUT_MS = 15_000

/**
 * A request body's pictures, every one checked (images.ts checkImagePayloads):
 * all of them, in order, or an ImageAttachError naming the one that cannot go.
 * Never a shorter list: a picture left out while the words went on was a
 * message the person thought the agent had seen.
 */
export function sessionImagesOf(raw: unknown): SessionImage[] {
  return checkImagePayloads(raw, MAX_SESSION_IMAGES)
}

/** Answer an ImageAttachError as the v1 error shape; false for any other error. */
export function sendImageAttachError(res: Response, err: unknown): boolean {
  if (!isImageAttachError(err)) return false
  sendError(res, err.status, err.code, err.message)
  return true
}

// ─── POST /sessions/:id/messages ────────────────────────────────────────────

/** A thread id a phone's Follow up names (threads-model.ts `th-` ids), else null. */
function threadIdOf(raw: unknown): string | null {
  return typeof raw === 'string' && /^th-[a-f0-9]{6,32}$/.test(raw) ? raw : null
}

export async function postSessionMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = String(req.params.id ?? '')
    if (!SID_RE.test(sessionId)) {
      sendError(res, 400, 'bad_request', 'Invalid session id')
      return
    }
    // Additive: `images` allows an otherwise-empty text turn. Old clients that
    // send no images keep the exact 400-on-empty-text behavior.
    let images: SessionImage[]
    try {
      images = sessionImagesOf(req.body?.images)
    } catch (err) {
      if (sendImageAttachError(res, err)) return
      throw err
    }
    const rawText = req.body?.text
    const text = typeof rawText === 'string' ? rawText : ''
    if (text.trim() === '' && images.length === 0) {
      sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
      return
    }
    // Additive: `voice: true` = the person spoke this and will HEAR the answer
    // (the phone's voice mode). The CLI gets the voice-reply line after the
    // text; every display surface strips it (core/sessions/voice-reply.ts).
    const rawVoice = req.body?.voice
    if (rawVoice !== undefined && typeof rawVoice !== 'boolean') {
      sendError(res, 400, 'bad_request', 'voice must be a boolean')
      return
    }
    const voice = rawVoice === true
    // Additive: `interrupt: true` = stop the running turn and deliver this message in a
    // fresh one (the console's "Interrupt & send"); without it a message sent mid-turn
    // joins the turn or waits behind it.
    const rawInterrupt = req.body?.interrupt
    if (rawInterrupt !== undefined && typeof rawInterrupt !== 'boolean') {
      sendError(res, 400, 'bad_request', 'interrupt must be a boolean')
      return
    }
    const interrupt = rawInterrupt === true
    // Additive: `afterTurn: true` = line this message up for after the running turn instead of
    // writing it into the live CLI. Held in the queue, it can be edited or withdrawn until the
    // turn ends; with no turn running it is sent at once. `interrupt` wins when both are set.
    const rawAfterTurn = req.body?.afterTurn
    if (rawAfterTurn !== undefined && typeof rawAfterTurn !== 'boolean') {
      sendError(res, 400, 'bad_request', 'afterTurn must be a boolean')
      return
    }
    const afterTurn = rawAfterTurn === true && !interrupt

    // Cloud-owned session (cloud.exec): the CLI is on THIS box, so it takes the
    // primary-box path below: same durable queue, same session-runner delivery,
    // same images-on-local-disk handling. The bridge exists for sessions on
    // OTHER machines; relaying our own session to the Mac would hand it to a
    // machine with no such process.
    const servedLocally = CLOUD_MODE
      ? (await (await import('../../core/cloud-owned-session.js')).cloudOwnedSession(sessionId)) !== null
      : true
    if (CLOUD_MODE && !servedLocally) {
      // The CLI runs on a different machine than this EC2 replica, so images
      // are saved on the SESSION'S HOST via the narrow bridge-allowlisted
      // `image.save` daemon command (deliberately NOT fs.write: see the
      // containment note in daemon-standalone.ts), then referenced by path in
      // the augmented text the same way the primary-box path does below.
      //
      // Additive: `messageId` lets a retrying client reuse its original id so
      // the durable-queue enqueue is idempotent (a retry after a lost ack can
      // never double-deliver). Shape-gated to the queue's own qm- vocabulary.
      const rawMid = req.body?.messageId
      const clientMessageId = typeof rawMid === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(rawMid)
        ? rawMid : undefined
      // The host's `image.save` takes a picture up to its cap: an oversized one is
      // downscaled and recompressed here to fit, and one that still does not fit is
      // refused now, with the words kept on the phone, never sent without it.
      // Before the stop below: a picture refused here must not have stopped the running turn.
      if (images.length > 0) {
        images = await compressImagesInMemory(images)
        const over = images.findIndex((img) => !fitsImageSaveLimits(img.data))
        if (over >= 0) {
          sendError(res, 413, 'image_too_large', `${images.length === 1 ? 'The picture' : `Picture ${over + 1} of ${images.length}`} is too large to send to this session's host even after shrinking it. Attach it as a file instead.`)
          return
        }
      }
      // The relay carries text only, so the stop goes first and the message after it: the
      // runner's send waits out a stop still settling (claude-code-session.ts handleSend).
      // A stop that did not reach the primary sends nothing, so the words stay in the composer.
      // A repeat of a send this box has already seen (the phone's retry after a lost 202) must
      // not stop the turn that send started.
      const repeated = interrupt && clientMessageId
        ? await (await import('../../core/send-queue.js')).sendSeen(sessionId, clientMessageId)
        : false
      if (interrupt && !repeated) {
        // A session its host judges, the Mac away: the host stops the turn (session-channel/companion-host-ops.ts).
        const ops = await import('../../core/session-channel/companion-host-ops.js')
        const route = await ops.hostRoute(sessionId)
        const stopped = route.kind === 'refuse'
          ? { ok: false as const, failure: { kind: 'error' as const, status: route.status, code: route.code, message: route.message } }
          : route.kind === 'operated'
          ? await ops.interruptViaHost(route.t, INTERRUPT_RELAY_TIMEOUT_MS).then((a) => (a.status === 200 ? { ok: true as const } : { ok: false as const, failure: { kind: 'error' as const, status: a.status, code: String((a.body.error as { code?: unknown } | undefined)?.code ?? 'bridge_offline'), message: String((a.body.error as { message?: unknown } | undefined)?.message ?? '') } }))
          : await (await import('./v1-control-relay.js')).callPrimaryControl('interrupt', sessionId, undefined, INTERRUPT_RELAY_TIMEOUT_MS)
        if (!stopped.ok) {
          const f = stopped.failure
          if (f.kind === 'error') sendError(res, f.status, f.code, f.message)
          else if (f.kind === 'needs_upgrade') sendError(res, 400, 'session_control_needs_upgrade', f.message)
          else sendError(res, 503, 'bridge_offline', f.message)
          return
        }
      }
      // The voice hint rides IN the relayed text: the primary keeps the block
      // where it is when it adds its own hints (hint-format.ts splitHinted).
      await cloudSend(res, sessionId, voice ? applyVoiceReply(text) : text, images, clientMessageId)
      return
    }

    const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      sendError(res, 404, 'not_found', `Session not found: ${sessionId}`)
      return
    }

    // Save images to disk and reference them by path in the augmented message:
    // the CLI's stdin only takes text, so it reads the files with its Read tool.
    // Same "[Images attached …]" prefix format as the WS session-chat path.
    // Remote sessions: RemoteSessionManager.prepareOutbound() uploads the local
    // files and rewrites the paths on the way to the exec host (no work here).
    //
    // All or nothing: a picture that cannot be saved refuses the send (the phone
    // keeps the words and the pictures), never sends the words without it.
    let enqueueText: string | undefined
    let savedPaths: string[] = []
    if (images.length > 0) {
      try {
        savedPaths = (await savePicturesToDisk(images)).map((s) => s.filePath)
      } catch (err) {
        log.web.warn('mobile session images not saved; the send is refused', { sessionId, error: err instanceof Error ? err.message : String(err) })
        if (sendImageAttachError(res, err)) return
        throw err
      }
      enqueueText = withImagePaths(text, savedPaths)
    }

    // Additive idempotency (parity with the cloud relay): a retrying phone
    // reuses its original qm- id, so a retry after a lost 202 can't enqueue
    // the same turn twice.
    const rawMid = req.body?.messageId
    const clientMessageId = typeof rawMid === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(rawMid)
      ? rawMid : undefined
    // The phone's sends carry the same message hints as the console's
    // (core/hints/hint-send.ts): a rich session answers the phone in the same
    // style, and a voice send asks for the voice-reply hint, which goes last
    // (it overrides the output style for this one reply).
    // His words on a thread holding a live decision letter answer that letter, once by the qm- id
    // (a resend of it finds the same answer), never from an automated client (core/org/letter-follow-up.ts).
    // The 202 is an ordinary accepted send to an older app: its thread Follow up keeps no chat bubble.
    const sentThread = threadIdOf(req.body?.threadId) ? req.body.threadId as string : undefined
    if (sentThread && record.taskId && routeSource('mobile', req.headers) === 'mobile') {
      const { answerLetterOnThread } = await import('../../core/org/letter-follow-up.js')
      const answered = await answerLetterOnThread({
        taskId: record.taskId, threadId: sentThread, text,
        ...(savedPaths.length ? { images: savedPaths } : {}), ...(clientMessageId ? { clientId: clientMessageId } : {}),
      })
      if (answered?.delivery.status === 'failed') {
        // On the letter, not delivered: the app keeps his words, and its resend of this id delivers that turn.
        sendError(res, 502, 'letter_answer_not_delivered', `Your answer is on the letter but did not reach the task${answered.delivery.reason ? ` (${answered.delivery.reason})` : ''}. Send it again.`)
        return
      }
      if (answered) {
        res.status(202).json({ messageId: clientMessageId ?? `letter-${answered.letterId}`, answeredLetter: { id: answered.letterId, threadId: answered.threadId } })
        return
      }
      // A thread holding a live Board choice: his words answer the choice on its Board (core/boards/choice-follow-up.ts).
      const { answerChoiceOnThread } = await import('../../core/boards/choice-follow-up.js')
      const chose = await answerChoiceOnThread({ taskId: record.taskId, threadId: sentThread, text, ...(savedPaths.length ? { images: savedPaths } : {}) })
      if (chose) {
        res.status(202).json({ messageId: clientMessageId ?? `choice-${chose.threadId}`, answeredChoice: { board: chose.board, id: chose.choiceId, threadId: chose.threadId } })
        return
      }
    }
    const outputMode = await prepareHintedSend(sessionId, record, enqueueText ?? text, {
      sentBy: routeSource('mobile', req.headers) === 'mobile' ? 'person' : 'agent', ...(voice ? { requested: { 'voice-reply': {} } } : {}),
      // A retry reuses its qm- id: an Org node's Threads file it once (core/org/thread-capture.ts).
      ...(clientMessageId ? { threadKey: clientMessageId } : {}),
      // Additive: sent from a thread's Follow up on the phone, filed under that thread (the
      // console's `session:send` threadId). Anything else is ignored, never refused.
      ...(threadIdOf(req.body?.threadId) ? { threadId: req.body.threadId as string } : {}),
    })
    const cliText = outputMode.enqueueText
    const { sendMessageToSession, findQueuedMessage, settledLineUuid } = await import('../../core/session-message-queue.js')
    // The same repeat on the primary: a row still queued or already settled under this id is a
    // retry, and it must not stop the turn the first send started.
    const settledLine = clientMessageId && !(await findQueuedMessage(clientMessageId))
      ? await settledLineUuid(clientMessageId) : undefined
    // A repeat after a lost 202 of a line that already ran: nothing to send, and a
    // fresh enqueue would spawn a CLI for a turn that never comes (core/sessions/resend-already-ran.ts).
    if (settledLine && clientMessageId) {
      const { resendAlreadyRan } = await import('../../core/sessions/resend-already-ran.js')
      if (await resendAlreadyRan({ sessionId, host: record.host, lineUuid: settledLine, messageIds: [clientMessageId] })) {
        res.status(202).json({ messageId: clientMessageId, alreadyDelivered: true })
        return
      }
    }
    const interruptNow = interrupt && !(clientMessageId
      && ((await findQueuedMessage(clientMessageId)) || settledLine))
    const msg = await sendMessageToSession(sessionId, text, {
      source: routeSource('mobile', req.headers),
      taskId: record.taskId,
      ...(cliText !== text ? { enqueueMessage: cliText } : {}),
      ...(clientMessageId ? { messageId: clientMessageId } : {}),
      ...(interruptNow ? { interrupt: true } : {}),
      ...(afterTurn ? { afterTurn: true } : {}),
      hinted: true,
    })
    await outputMode.commit()
    const { isAfterTurnHold } = await import('../../core/sessions/queue-after-turn.js')
    const heldForTurn = afterTurn && isAfterTurnHold(msg)
    log.web.info('mobile session send accepted', { sessionId, messageId: msg.id, imageCount: images.length, voice, interrupt, afterTurn: heldForTurn })
    // Sent to a session an engine switch replaced: it went to the task's current session
    // (engine-switch.ts activeSessionFor), which a client shows instead.
    res.status(202).json({
      messageId: msg.id, ...(heldForTurn ? { afterTurn: true } : {}),
      ...(msg.sessionId && msg.sessionId !== sessionId ? { deliveredTo: msg.sessionId } : {}),
    })
  } catch (err) {
    next(err)
  }
}

// ─── GET /sessions/:id/messages/:messageId ──────────────────────────────────
//
// What became of a message the companion answered `queued` for. Read-only: it
// never sends anything, so a phone may ask as often as it likes. The phone
// keeps a held bubble until this says it went (`delivered`) or it never will
// (`not_sent` / `unknown`, with the sentence to show). Only the companion holds
// messages; the primary answers 404 (it never says `queued`).

export async function getSessionMessageStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = String(req.params.id ?? '')
    const messageId = String(req.params.messageId ?? '')
    if (!SID_RE.test(sessionId) || !/^qm-[A-Za-z0-9-]{1,64}$/.test(messageId)) {
      sendError(res, 400, 'bad_request', 'Invalid session or message id')
      return
    }
    if (!CLOUD_MODE) {
      sendError(res, 404, 'not_found', 'This server holds no messages: a send it accepts goes to the session at once')
      return
    }
    const { sendStatus } = await import('../../core/send-queue.js')
    res.status(200).json({ messageId, ...(await sendStatus(sessionId, messageId)) })
  } catch (err) {
    next(err)
  }
}
