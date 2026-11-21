/**
 * /api/v1 voice output: the words voice mode says and the speech it plays, for
 * every client (the web's voice mode, and the phone's).
 *
 *   GET  /voice/status              → { engine, engines: [{ id, available, reason?, model?, voice? }] }
 *   POST /voice/spoken { text }     → { text, language, truncated, chunks } | { text: null }
 *   POST /voice/speak  { text, language?, previousText?, nextText? }
 *                                   → 200 audio/mpeg, streamed as the engine makes it
 *
 * `spoken` turns a reply into what is said (src/core/tts/spoken-text.ts: the part
 * before `---`, no code, tables or paths, about 40 seconds at most) and cuts it in
 * pieces; a client then asks `speak` for each piece, the next one while the first
 * plays. With `engine: "device"` the client speaks the pieces with its own system
 * voice and never calls `speak`.
 *
 * Errors: `bad_request` (400), `tts_unavailable` (503: no engine on this server, or
 * the engine cannot be reached; the client falls back to its own voice), `tts_quota`
 * (503: the cloud voice's credits are used up), `tts_failed` (502).
 * Every upstream call has a deadline, so no request pins a connection.
 *
 * Frozen-contract note: additive (docs/reference/api-v1.md).
 */

import { Readable } from 'node:stream'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { prepareSpokenText } from '../../core/tts/spoken-text.js'
import { isTtsError, serverEngine, speak, ttsStatus } from '../../core/tts/index.js'

export const voiceV1Router = Router()

/** Longest reply `spoken` takes, and longest piece `speak` takes (a piece is a sentence or two). */
const MAX_REPLY_CHARS = 200_000
const MAX_PIECE_CHARS = 2_000
/** The engine must start answering within this, or the client hears its own voice instead. */
const SPEAK_DEADLINE_MS = 20_000

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

function optionalString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined
}

voiceV1Router.get('/voice/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    res.json(ttsStatus(await getConfig()))
  } catch (err) { next(err) }
})

voiceV1Router.post('/voice/spoken', (req: Request, res: Response) => {
  const text = (req.body ?? {}).text
  if (typeof text !== 'string') {
    sendError(res, 400, 'bad_request', 'text (string) is required')
    return
  }
  if (text.length > MAX_REPLY_CHARS) {
    sendError(res, 400, 'bad_request', `text is longer than ${MAX_REPLY_CHARS} characters`)
    return
  }
  const spoken = prepareSpokenText(text)
  res.json(spoken ?? { text: null })
})

voiceV1Router.post('/voice/speak', async (req: Request, res: Response, next: NextFunction) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const text = optionalString(body.text, MAX_PIECE_CHARS + 1)
  if (!text) {
    sendError(res, 400, 'bad_request', 'text (non-empty string) is required')
    return
  }
  if (text.length > MAX_PIECE_CHARS) {
    sendError(res, 400, 'bad_request', `text is longer than ${MAX_PIECE_CHARS} characters: ask /voice/spoken for pieces`)
    return
  }
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), SPEAK_DEADLINE_MS)
  // The client went away (voice mode stopped, the person talked over it): stop paying for audio.
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const since = Date.now()
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const engine = serverEngine(await getConfig())
    if (!engine) {
      sendError(res, 503, 'tts_unavailable', 'No voice engine on this server: the device speaks with its own voice')
      return
    }
    const audio = await speak(engine, {
      text,
      language: optionalString(body.language, 20),
      previousText: optionalString(body.previousText, MAX_PIECE_CHARS),
      nextText: optionalString(body.nextText, MAX_PIECE_CHARS),
      signal: abort.signal,
    })
    clearTimeout(deadline)
    res.status(200)
    res.setHeader('Content-Type', audio.mime)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Walnut-Tts-Engine', `${engine.id}/${engine.model}`)
    res.setHeader('X-Walnut-Tts-Cached', audio.cached ? '1' : '0')
    res.flushHeaders()
    log.web.info('tts speak', { engine: engine.id, model: engine.model, chars: text.length, cached: audio.cached, firstMs: Date.now() - since })
    const stream = Readable.fromWeb(audio.body as import('node:stream/web').ReadableStream<Uint8Array>)
    stream.on('error', (err) => {
      if (!abort.signal.aborted) log.web.warn('tts stream broke', { error: err instanceof Error ? err.message : String(err) })
      res.destroy()
    })
    stream.pipe(res)
  } catch (err) {
    clearTimeout(deadline)
    if (res.headersSent) { res.destroy(); return }
    if (abort.signal.aborted && !res.writable) return
    if (isTtsError(err)) {
      log.web.warn('tts failed', { code: err.code, status: err.status, message: err.message })
      sendError(res, err.status === 499 ? 503 : err.status, err.code, err.message)
      return
    }
    next(err)
  }
})
