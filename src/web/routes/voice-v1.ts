/**
 * /api/v1 voice output: the words voice mode says and the speech it plays, for
 * every client (the web's voice mode, and the phone's).
 *
 *   GET  /voice/status              → { engine, engines: [{ id, available, reason?, model?, voice?, state? }], byLanguage? }
 *   POST /voice/warmup              → the same status, at once; loads the local voice in the background
 *   POST /voice/spoken { text, piece?, language? }
 *                                   → { text, language, truncated, chunks, rest? } | { text: null }
 *   POST /voice/speak  { text, language?, previousText?, nextText? }
 *                                   → 200 audio/mpeg (ElevenLabs, streamed as it is made) or audio/wav (the local voice, whole)
 *
 * `spoken` turns a reply into what is said (src/core/tts/spoken-text.ts: the part
 * before `---`, no code, tables or paths, about 40 seconds at most) and cuts it in
 * pieces (`rest`, only when truncated, is the rest-on-screen line it appended); a
 * client then asks `speak` for each piece, the next one while the first plays.
 * `piece: true` marks one part of an answer still streaming (the web reads the
 * answer sentence by sentence as it is written): cleaned the same way, with no
 * length budget and no rest line. `language` (a BCP-47 tag) says which language the
 * answer is said in, so the rest line matches what was said (a client reading a
 * streamed Chinese answer whose detail is English). With `engine: "device"` the client speaks the pieces with its own system
 * voice and never calls `speak`.
 *
 * A Chinese piece may have an engine of its own (the experimental local voice,
 * src/core/tts/local-voice.ts); `byLanguage.zh` names it once its model answers,
 * and a piece it cannot read in time (it has 8 s with `engine` behind it, and a long
 * piece goes straight to `engine`) is read by `engine`, which keeps its own full
 * deadline. `warmup`, called when voice mode opens, loads that model before the
 * first Chinese sentence (and sets it up the first time), waiting a moment to
 * adopt a warm one so its answer can name it; status does the setup part too.
 *
 * Errors: `bad_request` (400), `tts_unavailable` (503: no engine on this server, or
 * the engine cannot be reached; the client falls back to its own voice), `tts_quota`
 * (503: the cloud voice's credits are used up), `tts_failed` (502).
 * Every upstream call has a deadline (SPEAK_DEADLINE_MS each engine), so no request pins a connection.
 *
 * Frozen-contract note: additive (docs/reference/api-v1.md).
 */

import { Readable } from 'node:stream'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { prepareSpokenPiece, prepareSpokenText } from '../../core/tts/spoken-text.js'
import { enginesFor, isTtsError, speakWithFallback, ttsStatus, SPEAK_DEADLINE_MS } from '../../core/tts/index.js'
import { kickLocalVoice } from '../../core/tts/local-voice.js'

export const voiceV1Router = Router()

/** Longest reply `spoken` takes, and longest piece `speak` takes (a piece is a sentence or two). */
const MAX_REPLY_CHARS = 200_000
const MAX_PIECE_CHARS = 2_000

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

function optionalString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : undefined
}

voiceV1Router.get('/voice/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    // Sets the local voice up the first time it is chosen; never waits for it.
    void kickLocalVoice(config)
    res.json(ttsStatus(config))
  } catch (err) { next(err) }
})

/** Voice mode opened: load the local voice now, so the first Chinese sentence finds it warm. */
voiceV1Router.post('/voice/warmup', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    await kickLocalVoice(config, { warm: true })
    res.json(ttsStatus(config))
  } catch (err) { next(err) }
})

voiceV1Router.post('/voice/spoken', (req: Request, res: Response) => {
  const { text, piece, language } = (req.body ?? {}) as { text?: unknown; piece?: unknown; language?: unknown }
  if (typeof text !== 'string') {
    sendError(res, 400, 'bad_request', 'text (string) is required')
    return
  }
  if (language !== undefined && (typeof language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,2}$/.test(language))) {
    sendError(res, 400, 'bad_request', 'language must be a BCP-47 tag such as zh-CN')
    return
  }
  if (piece !== undefined && typeof piece !== 'boolean') {
    sendError(res, 400, 'bad_request', 'piece must be a boolean')
    return
  }
  if (text.length > MAX_REPLY_CHARS) {
    sendError(res, 400, 'bad_request', `text is longer than ${MAX_REPLY_CHARS} characters`)
    return
  }
  const spoken = piece ? prepareSpokenPiece(text) : prepareSpokenText(text, undefined, language as string | undefined)
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
  // Each engine has a deadline of its own (speakWithFallback); this one is the client's.
  const abort = new AbortController()
  // The client went away (voice mode stopped, the person talked over it): stop paying for audio.
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const since = Date.now()
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const language = optionalString(body.language, 20)
    const engines = enginesFor(await getConfig(), language)
    if (!engines.engine) {
      sendError(res, 503, 'tts_unavailable', 'No voice engine on this server: the device speaks with its own voice')
      return
    }
    const audio = await speakWithFallback(engines, {
      text,
      language,
      previousText: optionalString(body.previousText, MAX_PIECE_CHARS),
      nextText: optionalString(body.nextText, MAX_PIECE_CHARS),
      signal: abort.signal,
    }, SPEAK_DEADLINE_MS)
    const engine = audio.engine
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
