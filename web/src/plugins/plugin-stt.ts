/**
 * `walnut.stt`: Walnut's speech to text for a plugin (packages/plugin-api/src/web.ts, SttService).
 * The same server route the person's own mic buttons use (/api/stt/transcribe), so their engine,
 * language and vocabulary apply and the take is kept in their Voice history like any other; the
 * plugin is named as where it was said.
 */
import { transcribeAudio } from '@/api/stt'
import { blobToBase64 } from '@/utils/blob-base64'
import type { SttService, SttTranscript } from '../../../packages/plugin-api/src/web'

/** The route takes 25 MB of base64: about 18 MB of audio. */
const MAX_AUDIO_BYTES = 18 * 1024 * 1024
const FORMATS = ['webm', 'wav', 'mp3', 'ogg', 'mp4', 'm4a', 'flac'] as const

/** The format the route expects, from a blob's MIME type (`audio/webm;codecs=opus` -> webm). */
export function sttFormatOf(type: string): string | null {
  const sub = type.toLowerCase().split(';')[0].split('/')[1]?.trim() ?? ''
  const name = sub === 'mpeg' ? 'mp3' : sub === 'x-wav' || sub === 'wave' ? 'wav' : sub === 'x-m4a' ? 'm4a' : sub
  return (FORMATS as readonly string[]).includes(name) ? name : null
}

export function createWebStt(pluginId: string, pluginSignal: AbortSignal): SttService {
  return {
    async transcribe(audio, options = {}): Promise<SttTranscript> {
      if (!(audio instanceof Blob) || audio.size === 0) throw new Error('walnut.stt.transcribe needs a non-empty audio Blob')
      if (audio.size > MAX_AUDIO_BYTES) throw new Error('walnut.stt.transcribe takes at most about 18 MB of audio: cut it into pieces')
      const format = options.format ?? sttFormatOf(audio.type)
      if (!format || !(FORMATS as readonly string[]).includes(format)) throw new Error(`walnut.stt.transcribe: unsupported audio format ${options.format ?? audio.type ?? ''}`)
      const signal = options.signal ? AbortSignal.any([pluginSignal, options.signal]) : pluginSignal
      signal.throwIfAborted()
      const result = await transcribeAudio(await blobToBase64(audio), format, options.language, undefined, { signal, surface: `plugin:${pluginId}` })
      return { text: result.text ?? '', durationMs: result.durationMs ?? 0, ...(result.recordingId ? { recordingId: result.recordingId } : {}) }
    },
  }
}
