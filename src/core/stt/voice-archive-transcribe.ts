import { CLOUD_MODE } from '../../constants.js'
import { voiceArchive, VoiceArchiveError, type VoiceRecord } from './voice-archive.js'
import { deferVoiceReplication, replicateVoiceRecording, voicePrimaryAction, VOICE_TRANSCRIBE_TIMEOUT_MS } from './voice-archive-replication.js'

export interface VoiceTranscript { text: string; via?: string; recordingId: string; primarySaved?: boolean; storage: 'companion' | 'primary' }
const reply = (record: VoiceRecord): VoiceTranscript => ({ text: record.text ?? '', via: record.via, recordingId: record.id, primarySaved: record.primarySaved, storage: record.storage })
const pending = new Map<string, Promise<VoiceTranscript>>()

function languageValue(body: unknown): string | undefined {
  const language = (body as { language?: unknown } | null)?.language
  if (language !== undefined && (typeof language !== 'string' || language.length > 100)) throw new VoiceArchiveError(400, 'bad_request', 'language must be a string of at most 100 characters')
  return language as string | undefined
}
async function transcribe(id: string, language?: string): Promise<VoiceTranscript> {
  const record = await voiceArchive.get(id)
  if (record.text !== undefined) return reply(record)
  const primaryOnline = CLOUD_MODE && (await import('../../web/ws/bridge-registry.js')).bridgeForHost('__local__').connected
  // A Mac that is away, or connected but not answering the copy (asleep behind a
  // live bridge), leaves this box's own engines: it holds the whole recording.
  // Waiting for the Mac turned every recording made while it slept into a failure.
  if (primaryOnline && await replicateVoiceRecording(id)) {
    // The copy check pulls back text the Mac already saved.
    const copied = await voiceArchive.get(id)
    if (copied.text !== undefined) return reply(copied)
    let primary: VoiceTranscript | undefined
    try {
      const result = await voicePrimaryAction('transcribe', id, { language }, VOICE_TRANSCRIBE_TIMEOUT_MS)
      const body = result.body as VoiceTranscript
      if (typeof body?.text !== 'string' || body.recordingId !== id) throw new Error('Voice transcription reply does not match the recording')
      primary = body
    } catch {
      throw new VoiceArchiveError(503, 'stt_pending', 'The Mac may still be transcribing; your recording remains saved. Retry to recover its result')
    }
    if (primary) {
      const saved = await voiceArchive.saveText(id, primary.text, primary.via)
      await voiceArchive.markPrimarySaved(id, saved.text)
      return reply(await voiceArchive.get(id))
    }
  }
  const [{ getConfig }, { routeFeature }, { sttEngines, sttEngineFailure }] = await Promise.all([
    import('../config-manager.js'), import('../feature-route.js'), import('../../web/routes/stt-v1.js'),
  ])
  const config = await getConfig()
  const format = record.format
  const engines = sttEngines(config, CLOUD_MODE).filter((engine) => engine.id !== 'bridge').map((engine) => {
    if (format !== 'caf' || (engine.id !== 'openai' && !(engine.id === 'primary' && config.stt?.engine === 'openai'))) return engine
    return {
      ...engine,
      async run(input: { audio: string; format: string; language?: string }) {
        const { convertToWav, cleanupTempFile } = await import('./audio-convert.js')
        const { readFile } = await import('node:fs/promises')
        const wav = await convertToWav(input.audio, 'caf')
        try { return await engine.run({ ...input, audio: (await readFile(wav)).toString('base64'), format: 'wav' }) }
        finally { await cleanupTempFile(wav) }
      },
    }
  })
  const { audio } = await voiceArchive.readAudio(id)
  const result = await routeFeature(engines, { audio: audio.toString('base64'), format, language },
    (err) => /moov atom not found|Invalid data found when processing input|Error opening input/i.test(err instanceof Error ? err.message : String(err)))
  if (!result.ok) {
    if (result.verdict) {
      const failure = sttEngineFailure(result.verdict.reason)
      throw new VoiceArchiveError(failure.status, failure.code, failure.message)
    }
    throw new VoiceArchiveError(503, 'stt_unavailable', 'Transcription is unavailable; your recording remains saved')
  }
  const saved = await voiceArchive.saveText(id, result.output.text, result.via)
  deferVoiceReplication(id)
  return reply(saved)
}

/** Time out the caller, not the durable result write if an engine finishes later. */
export async function transcribeVoiceRecording(raw: string, body?: unknown): Promise<VoiceTranscript> {
  const language = languageValue(body)
  const record = await voiceArchive.get(raw)
  const id = record.id
  let work = pending.get(id)
  if (!work) {
    work = transcribe(id, language).finally(() => { pending.delete(id) })
    pending.set(id, work)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new VoiceArchiveError(504, 'gateway_timeout', 'Transcription timed out; your recording remains saved')), VOICE_TRANSCRIBE_TIMEOUT_MS)
      timer.unref?.()
    })])
  } finally { if (timer) clearTimeout(timer) }
}
