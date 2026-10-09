/**
 * /api/v1 session send endpoints, on sessionStreamV1Router (session-stream-v1.ts
 * registers them, so the API is unchanged):
 *
 *   POST /sessions/:id/messages             { text, images?, messageId? } → 202
 *   GET  /sessions/:id/messages/:messageId  what became of a held message
 *
 * Primary box: the durable message queue (sendMessageToSession). Cloud box: a
 * session on another machine goes through cloud-session-send.ts (the relay,
 * the hold and the direct fallback); a cloud-owned session takes the primary
 * path, its CLI being on this box.
 */

import type { Request, Response, NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { prepareOutputModeSend } from '../../core/sessions/output-mode-send.js'
import { withImagePaths, type SessionImage } from '../../core/sessions/cloud-images.js'
import { cloudSend } from './cloud-session-send.js'
import { sendError } from './cloud-send-words.js'
import { log } from '../../logging/index.js'

const SID_RE = /^[A-Za-z0-9_-]+$/

// Image attachments (additive), the same limits as session-chat.ts.
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_SESSION_IMAGES = 5
const MAX_IMAGE_BASE64_LENGTH = 14_000_000 // ~10MB binary

/** Extract valid image payloads from a request body (silently drops junk). */
function extractValidImages(raw: unknown): SessionImage[] {
  if (!Array.isArray(raw)) return []
  return (raw as Array<{ data?: unknown; mediaType?: unknown }>)
    .filter((img) =>
      typeof img?.data === 'string'
      && img.data.length > 0
      && img.data.length <= MAX_IMAGE_BASE64_LENGTH
      && typeof img.mediaType === 'string'
      && ALLOWED_MIME.has(img.mediaType),
    )
    .slice(0, MAX_SESSION_IMAGES)
    .map((img) => ({ data: img.data as string, mediaType: img.mediaType as string }))
}

// ─── POST /sessions/:id/messages ────────────────────────────────────────────

export async function postSessionMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = String(req.params.id ?? '')
    if (!SID_RE.test(sessionId)) {
      sendError(res, 400, 'bad_request', 'Invalid session id')
      return
    }
    // Additive: `images` allows an otherwise-empty text turn. Old clients that
    // send no images keep the exact 400-on-empty-text behavior.
    const images = extractValidImages(req.body?.images)
    const rawText = req.body?.text
    const text = typeof rawText === 'string' ? rawText : ''
    if (text.trim() === '' && images.length === 0) {
      sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
      return
    }

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
      await cloudSend(res, sessionId, text, images, clientMessageId)
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
    let enqueueText: string | undefined
    if (images.length > 0) {
      const { saveImageToDisk } = await import('./images.js')
      const savedPaths: string[] = []
      for (const img of images) {
        try {
          const { filePath } = await saveImageToDisk(img.data, img.mediaType)
          savedPaths.push(filePath)
        } catch (err) {
          log.web.warn('Failed to save mobile session image', { sessionId, error: err instanceof Error ? err.message : String(err) })
        }
      }
      if (savedPaths.length > 0) {
        enqueueText = withImagePaths(text, savedPaths)
      }
    }

    // Additive idempotency (parity with the cloud relay): a retrying phone
    // reuses its original qm- id, so a retry after a lost 202 can't enqueue
    // the same turn twice.
    const rawMid = req.body?.messageId
    const clientMessageId = typeof rawMid === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(rawMid)
      ? rawMid : undefined
    // Output mode rides the phone's sends too. The model only learns its reply
    // STYLE from the conversation, and the instruction/reminder used to be
    // applied by the web RPC alone, so a rich session answered the console in
    // HTML and answered the phone in plain markdown, and a phone turn in the
    // middle of a rich session dropped the standing reminder entirely. Same
    // three steps as the console (core/sessions/output-mode-send.ts): wrap the
    // text the CLI receives, leave what the human sees alone, advance the edge
    // only after the enqueue.
    const outputMode = await prepareOutputModeSend(sessionId, record, enqueueText ?? text)
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    const msg = await sendMessageToSession(sessionId, text, {
      source: 'mobile',
      taskId: record.taskId,
      ...(outputMode.enqueueText !== text ? { enqueueMessage: outputMode.enqueueText } : {}),
      ...(clientMessageId ? { messageId: clientMessageId } : {}),
    })
    await outputMode.commit()
    log.web.info('mobile session send accepted', { sessionId, messageId: msg.id, imageCount: images.length })
    res.status(202).json({ messageId: msg.id })
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
