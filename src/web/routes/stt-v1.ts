/**
 * /api/v1 speech-to-text — one endpoint the phone can call from anywhere.
 *
 *   POST /stt/transcribe  { audio: base64, format, language? }
 *     → 200 { text, durationMs, via: 'primary' | 'bridge' | 'openai' }
 *   GET  /stt/vocab             → { words }            (Wave 3, A)
 *   POST /stt/vocab { word }    → { added, word, reason? }
 *
 * Primary box (!CLOUD_MODE): run the configured local engine directly
 * (whisper-server / whisper-cpp / sherpa / openai — src/core/stt).
 *
 * Cloud box: the companion has no local engine. Relay the audio over the
 * daemon bridge to the primary box ('__local__' dials out from the Mac) and
 * let its engine transcribe; when the Mac is unreachable (bridge down, relay
 * error, or audio too big for a bridge frame) fall back to the OpenAI
 * Whisper API using the companion's own key. Neither available → 503 with a
 * clear message, so the phone can tell the user why voice input is offline.
 *
 * Frozen-contract note: additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'

export const sttV1Router = Router()

const ALLOWED_FORMATS = new Set(['webm', 'wav', 'mp3', 'ogg', 'mp4', 'm4a', 'flac'])
// Bridge WS frames are capped at 4MB (security audit) — leave headroom for
// the JSON envelope. Bigger audio skips the relay and goes straight to the
// OpenAI fallback (which has no such cap).
const BRIDGE_MAX_AUDIO_B64 = 3 * 1024 * 1024
const BRIDGE_STT_TIMEOUT_MS = 100_000

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

sttV1Router.post('/stt/transcribe', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { audio, format, language } = (req.body ?? {}) as {
      audio?: unknown; format?: unknown; language?: unknown
    }
    if (typeof audio !== 'string' || audio === '') {
      sendError(res, 400, 'bad_request', 'audio (base64 string) is required')
      return
    }
    if (typeof format !== 'string' || !ALLOWED_FORMATS.has(format)) {
      sendError(res, 400, 'bad_request', `format must be one of: ${[...ALLOWED_FORMATS].join(', ')}`)
      return
    }
    if (audio.length > 25 * 1024 * 1024) {
      sendError(res, 413, 'too_large', 'Audio too large (max 25MB base64)')
      return
    }
    const lang = typeof language === 'string' && language !== '' ? language : undefined

    if (!CLOUD_MODE) {
      const { getConfig } = await import('../../core/config-manager.js')
      const { transcribeAudio } = await import('../../core/stt/index.js')
      try {
        const result = await transcribeAudio(await getConfig(), { audio, format, language: lang })
        res.json({ text: result.text, durationMs: result.durationMs, via: 'primary' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.web.warn('stt transcribe failed (primary)', { message })
        sendError(res, 503, 'stt_unavailable', message)
      }
      return
    }

    // ── Cloud: bridge relay first, OpenAI fallback second ──
    if (audio.length <= BRIDGE_MAX_AUDIO_B64) {
      try {
        const { bridgeRequest } = await import('../ws/bridge-registry.js')
        const relayed = await bridgeRequest(
          '__local__', 'stt', { audio, format, language: lang }, BRIDGE_STT_TIMEOUT_MS,
        )
        if (relayed.ok === true && typeof relayed.text === 'string') {
          log.web.info('stt transcribed via bridge', { chars: relayed.text.length })
          res.json({ text: relayed.text, durationMs: relayed.durationMs ?? 0, via: 'bridge' })
          return
        }
        log.web.warn('stt bridge relay declined, falling back', { error: relayed.error })
      } catch (err) {
        // BridgeOfflineError / timeout — expected when the Mac sleeps.
        log.web.info('stt bridge unavailable, falling back to OpenAI', {
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const { getConfig } = await import('../../core/config-manager.js')
    const { resolveSecret } = await import('../../agent/providers/secret.js')
    const config = await getConfig()
    const apiKey = resolveSecret(config.stt?.openai_api_key) ?? process.env.OPENAI_API_KEY ?? ''
    if (!apiKey) {
      sendError(res, 503, 'stt_unavailable',
        'Primary box unreachable and no OpenAI API key configured on the companion')
      return
    }
    const { createOpenAiEngine } = await import('../../core/stt/engine-openai.js')
    const engine = createOpenAiEngine({
      apiKey,
      baseUrl: config.stt?.openai_base_url,
      model: config.stt?.openai_model,
    })
    try {
      const result = await engine.transcribe({ audio, format, language: lang })
      log.web.info('stt transcribed via openai fallback', { chars: result.text.length })
      res.json({ text: result.text, durationMs: result.durationMs, via: 'openai' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.web.warn('stt openai fallback failed', { message })
      sendError(res, 503, 'stt_unavailable', message)
    }
  } catch (err) {
    next(err)
  }
})

// ── Custom vocabulary (Wave 3) ───────────────────────────────────────────────
// Class A: the vocab file lives in config/share/, which IS synced, so every box
// converges on the same word list and each serves it locally. The internal
// route's `path` field is still dropped — where the file sits is the serving
// box's business, not a paired device's.

// GET /api/v1/stt/vocab — the custom vocabulary word list.
sttV1Router.get('/stt/vocab', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { readSttVocab } = await import('./stt.js')
    const { words } = await readSttVocab()
    res.json({ words })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/stt/vocab { word } — add one word (case-insensitive dedup).
sttV1Router.post('/stt/vocab', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { word } = (req.body ?? {}) as { word?: unknown }
    if (!word || typeof word !== 'string' || !word.trim()) {
      sendError(res, 400, 'bad_request', 'word (non-empty string) is required')
      return
    }
    const { addSttVocabWord } = await import('./stt.js')
    res.json(await addSttVocabWord(word))
  } catch (err) {
    next(err)
  }
})

// Body-parser overflow (PayloadTooLargeError) must come back in the frozen
// v1 error shape — the phone keys retry/preserve UX off `error.code`, and the
// generic errorHandler's `{ error: "request entity too large" }` isn't it.
// Mounted at APP level (server.ts) scoped to /api/v1/stt/transcribe: the
// overflow fires in the app-level body parser BEFORE this router is entered,
// and Express skips routers (3-arg layers) entirely while in error mode, so
// a router-internal error handler would never see it.
export function sttPayloadTooLargeHandler(
  err: Error, _req: Request, res: Response, next: NextFunction,
): void {
  if ((err as { type?: string }).type === 'entity.too.large') {
    sendError(res, 413, 'too_large', 'Audio too large for one request (max 35MB body)')
    return
  }
  next(err)
}
