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
 * Error codes: `bad_request` (400), `too_large` (413), `bad_audio` (422 — this
 * recording is undecodable, so retrying the same bytes cannot help), and
 * `stt_unavailable` (503 — the service cannot answer right now, try later).
 * `bad_audio` is additive: an older server answers 503 for the same case and the
 * client's attempt ceiling still retires it, just more slowly.
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

/**
 * The engine's failure, in words a phone can show.
 *
 * The iOS app renders this string verbatim in a TWO-LINE caption above the
 * composer. It used to be the engine's raw stderr, and a real screenshot from
 * the simulator (2026-08-31) showed the composer displaying
 * "Voice unavailable: Command failed: ffmpeg -y -i /var/folders/ph/qftcnrr…" —
 * forty lines of ffmpeg build configuration, truncated mid-path, as the entire
 * explanation for a recording the app was holding on to.
 *
 * Two rules, no status or code change (the frozen v1 shape is untouched, and the
 * raw text still goes to the server log where it is actually useful):
 *  - A DECODE failure gets a real sentence. Its cause is always the same and it
 *    is not the service's fault: an m4a whose recording was killed before
 *    AVAudioRecorder wrote the `moov` atom is a file no engine can ever read, so
 *    "try again later" would be a lie.
 *  - Anything else must PROVE it is a human sentence to be shown at all.
 *
 * That second rule is an allowlist, and it started life as a denylist of the
 * shapes we had seen (`Command failed`, `ffmpeg`, `/var/…`, `http://`). An
 * adversarial pass found seven realistic engine strings that walked straight
 * through it, every one reachable from the engines in `src/core/stt`:
 * `Error: connect ECONNREFUSED 127.0.0.1:8080`, a raw OpenAI 401 JSON body (which
 * can carry a redacted key fragment), `sherpa: /data/models/encoder.onnx missing`
 * (a directory the denylist did not list), a Windows path, `signal killed, core
 * dumped (pid 48213)`, and so on. A denylist of machine shapes can never be
 * complete, because it has to enumerate every future engine's diagnostics. The
 * set of things worth SHOWING is small and stable, so that is what gets
 * enumerated instead: prose. Everything else becomes the generic sentence, which
 * costs the user nothing they could have acted on.
 */
export function sttEngineNotice(raw: string): string {
  if (isUndecodableAudio(raw)) return DAMAGED_AUDIO_NOTICE
  const firstLine = raw.split('\n').map((s) => s.trim()).find(Boolean) ?? ''
  if (!isPlainProse(firstLine)) return 'Transcription failed'
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine
}

const DAMAGED_AUDIO_NOTICE =
  "That recording is damaged and can't be transcribed — it was cut off before it finished saving"

/**
 * Did the engine tell us this AUDIO is unreadable (as opposed to the engine or
 * the box being unwell)? ffmpeg says so in these words when an m4a has no `moov`
 * atom, which is what an app killed mid-recording leaves behind.
 */
function isUndecodableAudio(raw: string): boolean {
  return /moov atom not found|Invalid data found when processing input|Error opening input/i.test(raw)
}

/**
 * Is this ONE line a plain human sentence, safe to show a phone user as-is?
 *
 * Written as a whitelist of shape, deliberately conservative: a false negative
 * costs a slightly vaguer notice (the log still has everything), while a false
 * positive puts a stack frame, a temp path, or a redacted API key on someone's
 * lock screen. When in doubt, no.
 *
 * The rules, each earned by a real or probed leak:
 *  1. Length and word bounds: prose, not a dump or a token.
 *  2. Only letters, digits, spaces and ordinary sentence punctuation. This one
 *     rule removes JSON bodies, Windows and POSIX paths, URLs, bracketed ffmpeg
 *     tags, and `key=value` diagnostics in a single stroke — no enumeration.
 *  3. No bare identifiers that only a machine reads: hex/pointer literals,
 *     `host:port`, errno/signal names, pids, `sk-…` key fragments.
 *  4. Must contain at least two words of two or more letters, so a lone token
 *     ("ECONNREFUSED", "EPIPE") cannot pass as a sentence.
 */
function isPlainProse(line: string): boolean {
  if (line.length < 4 || line.length > 300) return false
  // Rule 2. Note what is NOT here: / \ { } [ ] " ' < > = | @ $ # % ^ * ` ~ + _
  if (!/^[A-Za-z0-9 ,.!?;:()'’\-—…]+$/u.test(line)) return false
  // An apostrophe is fine ("couldn't"), a quote-delimited value is not.
  if (/'.*'/.test(line)) return false
  // Rule 3.
  if (/\b(0x[0-9a-f]+|[0-9a-f]{8,})\b/i.test(line)) return false
  if (/\b\d{1,3}(\.\d{1,3}){3}\b|\b\d{2,5}:\d{1,5}\b|\bport \d+\b/i.test(line)) return false
  if (/\b(E[A-Z]{3,}|SIG[A-Z]{2,})\b/.test(line)) return false
  // Diagnostic vocabulary. Not "rude words" — words that only ever appear when a
  // process is describing its own death, which a user cannot act on.
  if (/\b(pid|errno|exit|exited|code|status|signal|stack|traceback|segmentation|stderr|stdout|spawn)\b/i.test(line)) return false
  if (/\bsk-/i.test(line)) return false
  // Any standalone 3+ digit number: HTTP statuses, ports, pids, sample rates,
  // byte counts. `mlx daemon returned 500: detail` is machine talk that no other
  // rule here catches, and no sentence a user can act on needs a number this big.
  if (/\b\d{3,}\b/.test(line)) return false
  // A `tool: message` prefix (`ffprobe: could not find codec parameters`) names an
  // implementation detail the user has no relationship with, and the tool it names
  // is the part most likely to change under them.
  if (/^[A-Za-z0-9][A-Za-z0-9.\-]*:/.test(line)) return false
  // Rule 4.
  return (line.match(/\b[A-Za-z]{2,}\b/g) ?? []).length >= 2
}

/**
 * The whole answer for a failed transcription: status, code AND sentence.
 *
 * Splitting `bad_audio` out of `stt_unavailable` is what stops the phone
 * re-uploading a file this route has already called damaged. The iOS classifier
 * reads any 4xx as a verdict ABOUT the audio and any 5xx as transport, so the
 * old blanket 503 meant an unfinalized m4a had to grind through the client's
 * whole 6-attempt ceiling before it could leave "transcription pending"; a 422
 * retires it in two. `stt_unavailable` keeps its exact meaning (the service
 * cannot answer right now), which is what it always should have meant.
 *
 * Additive per the route header, and compatible in both directions: an older
 * server still answers 503 and the client's attempt ceiling still covers it; an
 * older phone treats 422 as an ordinary server error and preserves the audio.
 */
export function sttEngineFailure(raw: string): { status: number; code: string; message: string } {
  if (isUndecodableAudio(raw)) {
    return { status: 422, code: 'bad_audio', message: DAMAGED_AUDIO_NOTICE }
  }
  return { status: 503, code: 'stt_unavailable', message: sttEngineNotice(raw) }
}

/**
 * The cloud companion has no key of its own, so what the phone is told depends
 * entirely on what happened to the relay. Each sentence states only what this
 * box actually observed.
 */
export function noKeyNotice(
  relayOutcome: 'not-attempted' | 'unreachable' | 'declined',
): string {
  switch (relayOutcome) {
    case 'unreachable':
      return 'Your Mac is offline — transcription resumes when it reconnects'
    case 'declined':
      // The Mac was there and could not do it. Do NOT blame the connection.
      return "Your Mac couldn't transcribe that recording — it kept the audio, so you can try again"
    case 'not-attempted':
      // Too big for a bridge frame, so the Mac was never asked and its
      // reachability is unknown to us. Reaching the Mac would not help either:
      // this path is skipped by SIZE, not by connectivity.
      return 'That recording is too long to transcribe from the cloud — add an OpenAI key to the companion for long recordings'
  }
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
        // Raw text to the log (where the ffmpeg command line is worth having),
        // one readable sentence to the phone — and a 4xx when the audio itself is
        // the problem, so the phone stops retrying a file we just called damaged.
        const failure = sttEngineFailure(message)
        log.web.warn('stt transcribe failed (primary)', { message, code: failure.code })
        sendError(res, failure.status, failure.code, failure.message)
      }
      return
    }

    // ── Cloud: bridge relay first, OpenAI fallback second ──
    //
    // WHY the outcome is remembered: the no-key branch below has to explain
    // itself to a phone user, and "your Mac is offline" is a claim about
    // reachability. Asserting it after the bridge REACHED the Mac and the Mac's
    // engine refused the audio is simply false, and it was: both paths fell
    // through to the same sentence. The server must only state what it knows.
    let relayOutcome: 'not-attempted' | 'unreachable' | 'declined' = 'not-attempted'
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
        // The Mac answered and said no. If it said the audio is undecodable, that
        // is a verdict and it travels as one (422) rather than as an outage — the
        // relay is transport, not an excuse to relabel the Mac's diagnosis.
        relayOutcome = 'declined'
        log.web.warn('stt bridge relay declined, falling back', { error: relayed.error })
        if (typeof relayed.error === 'string' && isUndecodableAudio(relayed.error)) {
          const failure = sttEngineFailure(relayed.error)
          sendError(res, failure.status, failure.code, failure.message)
          return
        }
      } catch (err) {
        // BridgeOfflineError / timeout — expected when the Mac sleeps.
        relayOutcome = 'unreachable'
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
      // Written FOR THE PHONE USER: the iOS app renders this string verbatim
      // inside a voice notice (`APIError.voiceNotice` → "Voice unavailable:
      // <message>"), two lines of caption text next to a recording it is keeping
      // on disk. The old copy ("Primary box unreachable and no OpenAI API key
      // configured on the companion") stated two internal facts, named no
      // recovery, and read as a permanent dead end.
      //
      // Deliberately does NOT say "recording saved": the app appends that
      // itself, and the duplicate ate the width that the recovery condition
      // needs. The owner-side remedy (put an OpenAI key on the companion so
      // voice works while the Mac sleeps) is a config action for the person who
      // deployed the companion, not something the phone user can do from this
      // notice, so it stays in the docs rather than in 60 characters of toast.
      //
      // Three outcomes, three sentences, because there are three different truths
      // here and one of them is a reachability claim. Saying "your Mac is
      // offline" when the Mac just answered and refused the audio is a lie the
      // user cannot act on.
      sendError(res, 503, 'stt_unavailable', noKeyNotice(relayOutcome))
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
      const failure = sttEngineFailure(message)
      log.web.warn('stt openai fallback failed', { message, code: failure.code })
      sendError(res, failure.status, failure.code, failure.message)
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
