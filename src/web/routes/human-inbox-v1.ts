/**
 * /api/v1/human-inbox — letters from agents to the ONE human who reads them.
 *
 * Mounted from api-v1.ts (additive to the frozen v1 contract), so the console,
 * the phone, and every `walnut tools call human_inbox_*` share one implementation.
 *
 *   POST   /human-inbox                  send a letter  → { id }            (201)
 *   POST   /human-inbox/body             stage a big body (raw stream) → { ref, bytes }
 *   GET    /human-inbox[?archived=1]     envelopes      → { letters, unreadCount }
 *   GET    /human-inbox/:id              full letter    → { letter }  (small bodies inlined)
 *   GET    /human-inbox/:id/body[?turn=] the document, streamed, Range-capable
 *   POST   /human-inbox/:id/reply        agent thread reply  → { letter }
 *   POST   /human-inbox/:id/read         { read }       → { letter }
 *   POST   /human-inbox/:id/pin          { pinned }     → { letter }
 *   POST   /human-inbox/:id/archive      { archived }   → { letter }
 *   POST   /human-inbox/:id/answer       { actionId, freeText? } → { letter, delivery }
 *   POST   /human-inbox/:id/human-reply  { text }       → { letter, delivery }
 *
 * The sender is stamped from the `x-walnut-caller-sid` header (set by the ops
 * executor) — never from the body, so a letter can't misattribute itself. The
 * header is provenance only: nothing here authorizes on it.
 *
 * BIG BODIES DO NOT RIDE THE JSON. A document over LETTER_INLINE_BODY_MAX_BYTES
 * is staged first (`POST /human-inbox/body`, raw stream) and the letter carries
 * `html_ref`; on the way out, the detail answers `bodyUrl` and the reader streams
 * from `/human-inbox/:id/body`. That is why the html cap can be 100MB — no hop
 * ever has to frame the whole document. See core/human-inbox/types.ts.
 *
 * Replica: letters live on the primary (delivery to the origin session needs
 * its daemons), so a cloud replica relays every route over the `server.human-
 * inbox.*` control actions, exactly like the notification routes do.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { relayControlAction, sendV1Error as sendError } from './v1-control-relay.js'
import {
  LETTER_HTML_MAX_BYTES, letterFieldMaxBytes,
  type AgentReplyInput, type NewLetter,
} from '../../core/human-inbox/types.js'

export const humanInboxV1Router = Router()

/** Relay actions ignore sessionId; pass the same placeholder as notifications. */
const SERVER_RELAY_SID = '__server__'

/**
 * Every route answers within this budget or degrades — a route that can wait on
 * the store's cross-process write lock must never pin a browser connection
 * (6-per-origin pool: one stuck route fakes an app-wide outage).
 */
const ROUTE_DEADLINE_MS = 12_000

/** LetterError.code → frozen v1 error code. */
const ERROR_CODES: Record<string, string> = {
  invalid: 'bad_request',
  not_found: 'not_found',
  already_answered: 'conflict',
}

interface LetterErrorLike { code: string; status: number; message: string }

function asLetterError(err: unknown): LetterErrorLike | null {
  const e = err as { name?: unknown; code?: unknown; status?: unknown; message?: unknown } | null
  if (!e || e.name !== 'LetterError' || typeof e.code !== 'string' || typeof e.status !== 'number') return null
  return { code: e.code, status: e.status, message: String(e.message ?? 'letter error') }
}

/**
 * Run one handler under the route deadline, translating store errors into the
 * frozen shape. `next` still funnels genuinely unexpected failures.
 */
async function guard(
  res: Response,
  next: NextFunction,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ROUTE_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    const outcome = await Promise.race([fn().then(() => 'done' as const), deadline])
    if (outcome === 'timeout' && !res.headersSent) {
      log.notif.warn('human-inbox: route deadline exceeded', { route: label })
      sendError(res, 504, 'timeout', `${label} did not finish in ${ROUTE_DEADLINE_MS}ms — try again`)
    }
  } catch (err) {
    const letterErr = asLetterError(err)
    if (letterErr && !res.headersSent) {
      sendError(res, letterErr.status, ERROR_CODES[letterErr.code] ?? 'bad_request', letterErr.message)
      return
    }
    next(err)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** The caller's session id, as provenance for the envelope. */
function callerSid(req: Request): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = (Array.isArray(raw) ? raw[0] : raw ?? '').trim()
  return sid || undefined
}

function body(req: Request): Record<string, unknown> {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : {}
}

function letterId(req: Request): string {
  const id = req.params.id
  return Array.isArray(id) ? id.join('/') : String(id ?? '')
}

/**
 * Reject an oversize body BEFORE the store writes anything. Per FIELD, not one
 * number: an html body may carry inline media (a base64 audio digest) and gets
 * the 10MB cap, while markdown and plain text keep the 200KB prose cap.
 */
/**
 * Express raises `entity.too.large` from the body parser BEFORE any router runs,
 * so an oversized letter would otherwise leave as a bare 413 with an HTML body
 * and no `error.code` — the shape the phone keys its retry UX off. Mirrors
 * sttPayloadTooLargeHandler; must be mounted at app level next to the parser.
 */
export function inboxPayloadTooLargeHandler(
  err: Error, _req: Request, res: Response, next: NextFunction,
): void {
  if ((err as { type?: string }).type === 'entity.too.large') {
    sendError(res, 413, 'too_large',
      'letter body too large to INLINE in one JSON request — stage it instead: '
      + `POST /api/v1/human-inbox/body (raw bytes) then send the letter with html_ref. `
      + `A staged body may be up to ${LETTER_HTML_MAX_BYTES} bytes.`)
    return
  }
  next(err)
}

function oversizeField(fields: Record<string, unknown>): { name: string; max: number } | null {
  for (const [name, value] of Object.entries(fields)) {
    const max = letterFieldMaxBytes(name)
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf-8') > max) return { name, max }
  }
  return null
}

function readBool(res: Response, value: unknown, field: string): boolean | null {
  if (typeof value !== 'boolean') {
    sendError(res, 400, 'bad_request', `${field} (boolean) is required`)
    return null
  }
  return value
}

// ─── Send ────────────────────────────────────────────────────────────────────

// POST /api/v1/human-inbox { subject, type, html?|markdown?, text?, actions?, task_refs?, pin? }
humanInboxV1Router.post('/human-inbox', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox', async () => {
    const b = body(req)
    const over = oversizeField({ html: b.html, markdown: b.markdown, text: b.text })
    if (over) {
      sendError(res, 413, 'too_large',
        `${over.name} is over the ${over.max}-byte letter cap — link a file instead of inlining a big artifact`)
      return
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.send', SERVER_RELAY_SID,
        { ...b, callerSid: callerSid(req) ?? null }, 201)
      return
    }
    const { sendLetterAsCaller } = await import('../../core/human-inbox/letter-ops.js')
    // The store is the validator (one implementation for every surface), so the
    // body rides through as-is rather than being re-checked field by field here.
    const letter = await sendLetterAsCaller(b as unknown as Omit<NewLetter, 'sender'>, callerSid(req))
    res.status(201).json({ id: letter.id })
  })
})

/**
 * POST /api/v1/human-inbox/body — stage a document, raw bytes, no JSON.
 *
 * The upload lane for anything over LETTER_INLINE_BODY_MAX_BYTES. The request
 * body is piped straight to a file (`Content-Type: application/octet-stream` or
 * `text/html`, so no JSON parser touches it) and the reply is a single-use ref
 * the following `POST /human-inbox` passes as `html_ref`.
 *
 * Deliberately NOT under the route deadline: this is a bulk transfer whose
 * duration is a function of the sender's link, and killing a 90MB upload at 12s
 * would make the lane useless. It cannot pin a browser connection pool the way
 * a stalled JSON route can, because it makes no other call — it only writes.
 */
humanInboxV1Router.post('/human-inbox/body', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      // Letters live on the primary, and a ref names a file on THIS box's disk.
      // Rather than invent a replica→primary push for a case no surface has (a
      // phone does not author 100MB letters), say so precisely.
      sendError(res, 501, 'not_supported_cloud',
        'staged letter bodies must be uploaded to the primary box — send the letter from the host that has the file')
      return
    }
    const { stageBodyFromStream } = await import('../../core/human-inbox/staged-body.js')
    const { ref, bytes } = await stageBodyFromStream(req, LETTER_HTML_MAX_BYTES)
    log.notif.info('human-inbox: body staged', { ref, bytes, callerSid: callerSid(req) })
    res.status(201).json({ ref, bytes })
  } catch (err) {
    const e = err as { name?: string; code?: string; status?: number; message?: string }
    if (e?.name === 'StagedBodyError' && typeof e.status === 'number') {
      sendError(res, e.status, e.code === 'too_large' ? 'too_large' : 'bad_request', String(e.message))
      return
    }
    next(err)
  }
})

// ─── Read side ───────────────────────────────────────────────────────────────

// GET /api/v1/human-inbox?archived=1 — envelopes only (no body content).
humanInboxV1Router.get('/human-inbox', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'GET /human-inbox', async () => {
    const archived = req.query.archived === '1' || req.query.archived === 'true'
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox', SERVER_RELAY_SID, { archived }, 200)
      return
    }
    const { listLetters } = await import('../../core/human-inbox/store.js')
    res.json(await listLetters({ archived }))
  })
})

// GET /api/v1/human-inbox/:id — record + body + thread bodies.
humanInboxV1Router.get('/human-inbox/:id', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'GET /human-inbox/:id', async () => {
    const id = letterId(req)
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.get', SERVER_RELAY_SID, { id }, 200)
      return
    }
    const { getLetter } = await import('../../core/human-inbox/store.js')
    const letter = await getLetter(id)
    if (!letter) {
      sendError(res, 404, 'not_found', `Letter not found: ${id}`)
      return
    }
    res.json({ letter })
  })
})

/**
 * GET /api/v1/human-inbox/:id/body[?turn=N] — the document itself, streamed.
 *
 * Outside `guard()` on purpose: a 100MB body legitimately takes longer than the
 * route deadline, and this handler holds no lock and makes no fan-out call, so
 * it can't be the thing that starves the connection pool. Deadlines live per
 * CHUNK on the replica path instead (see human-inbox-body.ts).
 */
humanInboxV1Router.get('/human-inbox/:id/body', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serveLetterBody } = await import('./human-inbox-body.js')
    await serveLetterBody(req, res, letterId(req))
  } catch (err) {
    if (res.headersSent) { res.end(); return }
    next(err)
  }
})

// ─── Agent thread reply ──────────────────────────────────────────────────────

// POST /api/v1/human-inbox/:id/reply { text, html?|markdown? } — flips unread.
humanInboxV1Router.post('/human-inbox/:id/reply', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox/:id/reply', async () => {
    const id = letterId(req)
    const b = body(req)
    const over = oversizeField({ html: b.html, markdown: b.markdown, text: b.text })
    if (over) {
      sendError(res, 413, 'too_large', `${over.name} is over the ${over.max}-byte letter cap`)
      return
    }
    if (CLOUD_MODE) {
      // `id` LAST: the URL owns the letter id, so a body field named `id` can
      // never make the primary answer a different letter than the one logged.
      await relayControlAction(res, 'server.human-inbox.reply', SERVER_RELAY_SID, { ...b, id }, 200)
      return
    }
    const { agentReply } = await import('../../core/human-inbox/store.js')
    const letter = await agentReply(id, b as unknown as AgentReplyInput)
    log.notif.info('human-inbox: agent reply accepted', { letterId: id, callerSid: callerSid(req) })
    res.json({ letter })
  })
})

// ─── Human state toggles ─────────────────────────────────────────────────────

// POST /api/v1/human-inbox/:id/read { read }
humanInboxV1Router.post('/human-inbox/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox/:id/read', async () => {
    const read = readBool(res, body(req).read, 'read')
    if (read === null) return
    const id = letterId(req)
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.read', SERVER_RELAY_SID, { id, read }, 200)
      return
    }
    const { setRead } = await import('../../core/human-inbox/store.js')
    res.json({ letter: await setRead(id, read) })
  })
})

// POST /api/v1/human-inbox/:id/pin { pinned }
humanInboxV1Router.post('/human-inbox/:id/pin', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox/:id/pin', async () => {
    const pinned = readBool(res, body(req).pinned, 'pinned')
    if (pinned === null) return
    const id = letterId(req)
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.pin', SERVER_RELAY_SID, { id, pinned }, 200)
      return
    }
    const { setPinned } = await import('../../core/human-inbox/store.js')
    res.json({ letter: await setPinned(id, pinned) })
  })
})

// POST /api/v1/human-inbox/:id/archive { archived }
humanInboxV1Router.post('/human-inbox/:id/archive', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox/:id/archive', async () => {
    const archived = readBool(res, body(req).archived, 'archived')
    if (archived === null) return
    const id = letterId(req)
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.archive', SERVER_RELAY_SID, { id, archived }, 200)
      return
    }
    const { setArchived } = await import('../../core/human-inbox/store.js')
    res.json({ letter: await setArchived(id, archived) })
  })
})

// ─── Human answers (delivered to the origin session) ─────────────────────────

// POST /api/v1/human-inbox/:id/answer { actionId, freeText? }
// The record is written FIRST and the delivery status is reported, never thrown:
// a dead origin session must not cost the human their answer.
humanInboxV1Router.post('/human-inbox/:id/answer', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox/:id/answer', async () => {
    const b = body(req)
    const id = letterId(req)
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.answer', SERVER_RELAY_SID, { ...b, id }, 200)
      return
    }
    const { answerLetterAndDeliver } = await import('../../core/human-inbox/letter-ops.js')
    res.json(await answerLetterAndDeliver(id, {
      actionId: typeof b.actionId === 'string' ? b.actionId : '',
      ...(typeof b.freeText === 'string' ? { freeText: b.freeText } : {}),
    }))
  })
})

// POST /api/v1/human-inbox/:id/human-reply { text }
humanInboxV1Router.post('/human-inbox/:id/human-reply', async (req: Request, res: Response, next: NextFunction) => {
  await guard(res, next, 'POST /human-inbox/:id/human-reply', async () => {
    const b = body(req)
    const id = letterId(req)
    const over = oversizeField({ text: b.text })
    if (over) {
      sendError(res, 413, 'too_large', `text is over the ${over.max}-byte cap`)
      return
    }
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.human-inbox.human-reply', SERVER_RELAY_SID, { ...b, id }, 200)
      return
    }
    const { humanReplyAndDeliver } = await import('../../core/human-inbox/letter-ops.js')
    res.json(await humanReplyAndDeliver(id, { text: typeof b.text === 'string' ? b.text : '' }))
  })
})
