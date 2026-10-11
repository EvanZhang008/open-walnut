import { Router, type Request, type Response, type NextFunction } from 'express'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { voiceArchive, VoiceArchiveError, type VoiceChunkBody, type VoiceCommitBody } from '../../core/stt/voice-archive.js'
import { deferVoiceReplication, startVoiceArchiveReplication } from '../../core/stt/voice-archive-replication.js'
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
        deferVoiceReplication(record.id)
        return { status: 200, body: record }
      }
      case 'text': {
        const record = await voiceArchive.saveText(id, body?.text as string, body?.via as string | undefined)
        deferVoiceReplication(record.id)
        return { status: 200, body: record }
      }
      case 'transcribe': return { status: 200, body: await transcribeVoiceRecording(id, body) }
      default: throw new VoiceArchiveError(400, 'bad_request', 'Unknown voice archive operation')
    }
  } catch (err) {
    if (err instanceof VoiceArchiveError) return { status: err.status, body: { error: { code: err.code, message: err.message } } }
    // Storage failures must never acknowledge an upload or a transcript.
    return { status: 503, body: { error: { code: 'storage_unavailable', message: 'Recording storage is unavailable; keep your local copy and retry' } } }
  }
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
for (const [suffix, operation] of [['chunks', 'chunk'], ['commit', 'commit'], ['text', 'text'], ['transcribe', 'transcribe']]) {
  voiceArchiveV1Router.post(`/stt/recordings/:id/${suffix}`, async (req: Request, res: Response) => {
    const result = await runVoiceArchiveAction({ operation, id: req.params.id, body: req.body })
    res.status(result.status).json(result.body)
  })
}
