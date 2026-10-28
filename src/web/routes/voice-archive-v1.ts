import { Router, type Request, type Response, type NextFunction } from 'express'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { voiceArchive, VoiceArchiveError, voiceRecordingId, decodeVoiceAudio, voiceAsr, VOICE_MAX_CHUNK_BYTES, type VoiceAsr, type VoiceChunkBody, type VoiceCommitBody } from '../../core/stt/voice-archive.js'
import { deferVoiceReplication, startVoiceArchiveReplication } from '../../core/stt/voice-archive-replication.js'
import { scheduleVoiceRetention } from '../../core/stt/voice-retention.js'
import { transcribeVoiceRecording } from '../../core/stt/voice-archive-transcribe.js'

export const voiceArchiveV1Router = Router()

/** Shared HTTP/control handler: the primary uses the same validation and durability. */
export async function runVoiceArchiveAction(params: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  try {
    const id = params.id as string
    const body = params.body as Record<string, unknown> | undefined
    switch (params.operation) {
      case 'get': return { status: 200, body: await voiceArchive.get(id) }
      case 'chunk': return { status: 200, body: await voiceArchive.saveChunk(id, body as unknown as VoiceChunkBody) }
      case 'commit': {
        const record = await voiceArchive.commit(id, body as unknown as VoiceCommitBody)
        // A take the Mac has live waits for its transcribe to start the copy: a
        // copy running beside the hand-over's last hops can delay the Mac's
        // answers enough to look asleep. A take never transcribed is copied by
        // the next retry pass.
        const { hasLiveForward } = await import('../../core/stt/live-forward.js')
        if (!hasLiveForward(record.id)) deferVoiceReplication(record.id)
        scheduleVoiceRetention()
        return { status: 200, body: record }
      }
      case 'text': {
        const record = await voiceArchive.saveText(id, body?.text as string, body?.via as string | undefined, voiceAsr(body?.asr))
        deferVoiceReplication(record.id)
        // Pieces the companion handed over for a take it finished itself.
        const { dropLive } = await import('../../core/stt/live-transcript.js')
        dropLive(record.id)
        return { status: 200, body: record }
      }
      case 'transcribe': return { status: 200, body: await transcribeVoiceRecording(id, body) }
      // The companion hands the Mac a take's pieces while it is recorded (core/stt/live-forward.ts).
      case 'live': return { status: 200, body: await acceptLive(id, body) }
      case 'live-drop': {
        (await import('../../core/stt/live-transcript.js')).dropLive(voiceRecordingId(id))
        return { status: 200, body: { ok: true } }
      }
      case 'live-finish': return { status: 200, body: await finishLiveHere(id, body) }
      default: throw new VoiceArchiveError(400, 'bad_request', 'Unknown voice archive operation')
    }
  } catch (err) {
    if (err instanceof VoiceArchiveError) return { status: err.status, body: { error: { code: err.code, message: err.message } } }
    // Storage failures must never acknowledge an upload or a transcript.
    return { status: 503, body: { error: { code: 'storage_unavailable', message: 'Recording storage is unavailable; keep your local copy and retry' } } }
  }
}
/**
 * One live piece { from, audio, language? } of a take still being recorded
 * (core/stt/live-transcript.ts): from the phone, or from the companion handing
 * the Mac the pieces it got. A server with its own engine takes them (the
 * companion only holds them while the Mac is there to transcribe the take, and
 * passes each one on to it); any other answers `accepted: false`.
 */
async function acceptLive(raw: string, body: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const id = voiceRecordingId(raw)
  const { from, audio, language } = body ?? {}
  if (!Number.isSafeInteger(from) || (from as number) < 0) throw new VoiceArchiveError(400, 'bad_request', 'from must be a nonnegative integer')
  if (language !== undefined && (typeof language !== 'string' || language.length > 100)) throw new VoiceArchiveError(400, 'bad_request', 'language must be a short string')
  if (typeof audio === 'string' && audio.length > Math.ceil(VOICE_MAX_CHUNK_BYTES / 3) * 4) throw new VoiceArchiveError(413, 'too_large', 'A live piece exceeds 512KiB')
  const bytes = decodeVoiceAudio(audio)
  const { liveRole, localTranscribe, wakeLocalEngine, probeMacForTake } = await import('../../core/stt/voice-archive-transcribe.js')
  const role = await liveRole()
  if (!role.takes) return { accepted: false, receivedBytes: 0, segments: 0, reason: 'not-transcribed-here' }
  const { appendLive } = await import('../../core/stt/live-transcript.js')
  // While the Mac looks there, every piece checks that it still answers.
  if (!role.now) probeMacForTake(id)
  const ack = appendLive(id, from as number, bytes, localTranscribe, {
    language: language as string | undefined, eager: role.now, wake: wakeLocalEngine,
  })
  if ('gap' in ack) return { accepted: true, receivedBytes: ack.receivedBytes, segments: 0, gap: true }
  if (role.now || ack.reason === 'finished') return { ...ack }
  // While the Mac answers, its pieces go on to it; that hand-over keeps the
  // phone sending even once this box stops holding its own copy (past 5 min).
  const { forwardLivePiece, hasLiveForward } = await import('../../core/stt/live-forward.js')
  if (ack.accepted || hasLiveForward(id)) forwardLivePiece(id, from as number, bytes, language as string | undefined)
  return hasLiveForward(id) ? { ...ack, accepted: true, reason: undefined } : { ...ack }
}

/** `live-finish` { pcmBytes, pcmSha256, language? }: the take's text from the pieces this server was handed. */
async function finishLiveHere(raw: string, body: Record<string, unknown> | undefined): Promise<{ text: string; asr: VoiceAsr }> {
  const since = Date.now()
  const id = voiceRecordingId(raw)
  const { pcmBytes, pcmSha256, language } = body ?? {}
  if (!Number.isSafeInteger(pcmBytes) || (pcmBytes as number) < 0 || typeof pcmSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(pcmSha256)) {
    throw new VoiceArchiveError(400, 'bad_request', 'pcmBytes and a hex pcmSha256 are required')
  }
  if (language !== undefined && (typeof language !== 'string' || language.length > 100)) throw new VoiceArchiveError(400, 'bad_request', 'language must be a short string')
  const [{ finishLiveFromSamples }, { localTranscribe, localAsr }] = await Promise.all([
    import('../../core/stt/live-transcript.js'), import('../../core/stt/voice-archive-transcribe.js'),
  ])
  const text = await finishLiveFromSamples(id, pcmBytes as number, pcmSha256, localTranscribe, language as string | undefined)
  if (text === null) throw new VoiceArchiveError(409, 'live_unusable', 'The live pieces do not match the finished recording')
  return { text, asr: await localAsr(id, language as string | undefined, since) }
}

function archiveError(err: unknown, res: Response, next: NextFunction): void {
  if (res.headersSent) { next(err); return }
  const error = err instanceof VoiceArchiveError ? err : new VoiceArchiveError(503, 'storage_unavailable', 'Recording storage is unavailable; retry later')
  res.status(error.status).json({ error: { code: error.code, message: error.message } })
}
voiceArchiveV1Router.use('/stt/recordings', (_req, _res, next) => {
  void startVoiceArchiveReplication().then(() => next(), next)
})
voiceArchiveV1Router.get('/stt/recordings', async (req, res, next) => {
  try {
    if (req.query.before !== undefined && typeof req.query.before !== 'string') throw new VoiceArchiveError(400, 'bad_request', 'before must be a cursor string')
    if (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit))) throw new VoiceArchiveError(400, 'bad_request', 'limit must be a positive integer')
    const answer = await voiceArchive.list(req.query.before as string | undefined, req.query.limit === undefined ? 20 : Number(req.query.limit))
    deferVoiceReplication()
    res.json(answer)
  } catch (err) { archiveError(err, res, next) }
})
voiceArchiveV1Router.get('/stt/recordings/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id)
    res.json(await voiceArchive.get(id))
    deferVoiceReplication(id)
  } catch (err) { archiveError(err, res, next) }
})
voiceArchiveV1Router.get('/stt/recordings/:id/audio', async (req, res, next) => {
  try {
    const { path, record } = await voiceArchive.audioPath(String(req.params.id))
    const types: Record<string, string> = { caf: 'audio/x-caf', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' }
    res.set({ 'Content-Type': types[record.format] ?? 'application/octet-stream', 'Content-Length': String(record.audioSizeBytes), 'Cache-Control': 'no-store' })
    await pipeline(createReadStream(path), res)
  } catch (err) { archiveError(err, res, next) }
})
/**
 * POST /stt/recordings/:id/live { from, audio, language? }: a piece of the file
 * while the take is still being recorded (acceptLive). `accepted: false` and the
 * phone stops sending. Every answer names `receivedBytes`, the offset the phone
 * sends from next (after a gap, a resend). Never part of the durable copy:
 * chunks + commit still are.
 */
voiceArchiveV1Router.post('/stt/recordings/:id/live', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await acceptLive(String(req.params.id), req.body as Record<string, unknown> | undefined))
  } catch (err) { archiveError(err, res, next) }
})

/** DELETE /stt/recordings/:id/live: the take was cancelled; its live pieces stop. */
voiceArchiveV1Router.delete('/stt/recordings/:id/live', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = voiceRecordingId(req.params.id)
    const [{ dropLive }, { dropLiveForward }] = await Promise.all([
      import('../../core/stt/live-transcript.js'), import('../../core/stt/live-forward.js'),
    ])
    dropLive(id)
    dropLiveForward(id)
    res.json({ ok: true })
  } catch (err) { archiveError(err, res, next) }
})
for (const [suffix, operation] of [['chunks', 'chunk'], ['commit', 'commit'], ['text', 'text'], ['transcribe', 'transcribe']]) {
  voiceArchiveV1Router.post(`/stt/recordings/:id/${suffix}`, async (req: Request, res: Response) => {
    const result = await runVoiceArchiveAction({ operation, id: req.params.id, body: req.body })
    res.status(result.status).json(result.body)
  })
}
