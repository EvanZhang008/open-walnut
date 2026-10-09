/**
 * /api/v1 speech-to-text — one endpoint the phone can call from anywhere.
 *
 *   POST /stt/transcribe  { audio: base64, format, language? }
 *     → 200 { text, durationMs, via: 'primary' | 'bridge' | 'local' | 'openai' }
 *   GET  /stt/vocab             → { words }            (Wave 3, A)
 *   POST /stt/vocab { word }    → { added, word, reason? }
 *
 * The engines are tried in order (sttEngines, src/core/feature-route.ts).
 *
 * Primary box (!CLOUD_MODE): run the configured local engine directly
 * (whisper-server / whisper-cpp / sherpa / openai, in src/core/stt), then the
 * hosted API when the person gave it a key of its own (stt.openai_api_key).
 *
 * Error codes: `bad_request` (400), `too_large` (413), `bad_audio` (422 — this
 * recording is undecodable, so retrying the same bytes cannot help), and
 * `stt_unavailable` (503 — the service cannot answer right now, try later).
 * `bad_audio` is additive: an older server answers 503 for the same case and the
 * client's attempt ceiling still retires it, just more slowly.
 *
 * Cloud box: relay the audio over the daemon bridge to the primary box
 * ('__local__' dials out from the Mac) and let its engine transcribe; when the
 * Mac is unreachable (bridge down, relay error, or audio too big for a bridge
 * frame) use an engine set up on the companion itself, then the OpenAI Whisper
 * API with the companion's own key. None available → 503 with a clear message,
 * so the phone can tell the user why voice input is offline.
 *
 * Frozen-contract note: additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { Config } from '../../core/types.js'
import type { FeatureAttempt, FeatureEngine } from '../../core/feature-route.js'
import { resolveSecret } from '../../model/providers/secret.js'

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

interface SttInput { audio: string; format: string; language?: string }
interface SttOutput { text: string; durationMs?: number }

/** The leader was asked: it could not be reached, or it answered and could not transcribe. */
class SttRelayError extends Error {
  constructor(readonly outcome: 'unreachable' | 'declined', message: string) {
    super(message)
  }
}

/**
 * The engines this server tries, in order (docs/plan/walnut-servers-everywhere.md,
 * "Feature with fallbacks"). `id` is the `via` the phone gets.
 *
 *   follower (the companion): the leader over the bridge (`bridge`), then an engine
 *     set up on this box (`local`, config.stt, never the Mac's: config.yaml is
 *     machine-local), then the hosted API with this box's key (`openai`);
 *   primary: its own engine (`primary`), then the hosted API, only when the person
 *     gave stt.openai_api_key and the engine is a different one.
 */
export function sttEngines(config: Config, follower: boolean): Array<FeatureEngine<SttInput, SttOutput>> {
  const stt = config.stt
  const engines: Array<FeatureEngine<SttInput, SttOutput>> = []
  if (follower) {
    engines.push({
      id: 'bridge',
      // Bigger audio skips the relay: one bridge frame could not carry it.
      unavailable: (input) => (input.audio.length > BRIDGE_MAX_AUDIO_B64 ? 'too-big' : null),
      async run(input) {
        let relayed: { ok?: unknown; text?: unknown; durationMs?: unknown; error?: unknown }
        try {
          const { bridgeRequest } = await import('../ws/bridge-registry.js')
          relayed = await bridgeRequest('__local__', 'stt', { ...input }, BRIDGE_STT_TIMEOUT_MS)
        } catch (err) {
          // BridgeOfflineError / timeout: expected while the Mac sleeps.
          throw new SttRelayError('unreachable', err instanceof Error ? err.message : String(err))
        }
        if (relayed.ok === true && typeof relayed.text === 'string') {
          return { text: relayed.text, durationMs: typeof relayed.durationMs === 'number' ? relayed.durationMs : 0 }
        }
        // The Mac answered and said no. Its words travel as they are, so a verdict
        // about the audio stays one: the relay is transport, not a relabel.
        throw new SttRelayError('declined', typeof relayed.error === 'string' ? relayed.error : 'The Mac could not transcribe it')
      },
    })
  }
  engines.push({
    id: follower ? 'local' : 'primary',
    // A primary always asks its engine (its "not set up" is the sentence to show).
    unavailable: () => (!follower ? null : !stt?.engine ? 'not-set-up' : stt.engine === 'openai' ? 'hosted' : null),
    async run(input) {
      const { transcribeAudio } = await import('../../core/stt/index.js')
      return transcribeAudio(config, input)
    },
  })
  const key = resolveSecret(stt?.openai_api_key) ?? (follower ? process.env.OPENAI_API_KEY : undefined) ?? ''
  engines.push({
    id: 'openai',
    unavailable: () => (!key ? 'no-key' : !follower && stt?.engine === 'openai' ? 'already-tried' : null),
    async run(input) {
      const { createOpenAiEngine } = await import('../../core/stt/engine-openai.js')
      return createOpenAiEngine({ apiKey: key, baseUrl: stt?.openai_base_url, model: stt?.openai_model }).transcribe(input)
    },
  })
  return engines
}

/**
 * The sentence when no engine answered. An engine that really ran and failed
 * speaks for itself; otherwise only what the relay showed is claimed (noKeyNotice).
 */
function unavailableNotice(attempts: FeatureAttempt[]): string {
  const failed = attempts.find((a) => a.outcome === 'failed' && !(a.error instanceof SttRelayError))
  if (failed) return sttEngineNotice(failed.reason)
  const relay = attempts.find((a) => a.id === 'bridge')
  const outcome = relay?.error instanceof SttRelayError ? relay.error.outcome : 'not-attempted'
  return noKeyNotice(outcome)
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

    // The engines in order (routeFeature): the leader's, this server's own, a hosted API.
    const { getConfig } = await import('../../core/config-manager.js')
    const { routeFeature } = await import('../../core/feature-route.js')
    const config = await getConfig()
    const result = await routeFeature(sttEngines(config, CLOUD_MODE), { audio, format, language: lang },
      (err) => isUndecodableAudio(err instanceof Error ? err.message : String(err)))
    const tried = result.attempts.map((a) => `${a.id}:${a.outcome}`)
    if (result.ok) {
      log.web.info('stt transcribed', { via: result.via, chars: result.output.text.length, tried })
      res.json({ text: result.output.text, durationMs: result.output.durationMs ?? 0, via: result.via })
      return
    }
    // Raw text to the log (where the ffmpeg command line is worth having), one
    // readable sentence to the phone, and a 4xx when the audio itself is the
    // problem, so the phone stops retrying a file an engine just called damaged.
    if (result.verdict) {
      const failure = sttEngineFailure(result.verdict.reason)
      log.web.warn('stt transcribe: the audio is undecodable', { via: result.verdict.id, message: result.verdict.reason, tried })
      sendError(res, failure.status, failure.code, failure.message)
      return
    }
    log.web.warn('stt transcribe failed', { attempts: result.attempts.map(({ id, outcome, reason }) => ({ id, outcome, reason })) })
    sendError(res, 503, 'stt_unavailable', unavailableNotice(result.attempts))
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
