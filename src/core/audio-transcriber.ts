/**
 * Audio Transcriber — auto-transcribes recorded audio chunks via STT.
 *
 * Subscribes globally to `audio:chunk-saved` events on the event bus.
 * For each chunk: reads WAV → base64 → transcribeAudio() → saves .txt + updates .json metadata.
 * Emits `audio:transcription-complete` when done.
 */

import { readFile, writeFile, unlink } from 'node:fs/promises'
import { bus, EventNames, eventData } from './event-bus.js'
import { getConfig } from './config-manager.js'
import { transcribeAudio } from './stt/index.js'
import { log } from '../logging/index.js'
import type { RecordingChunkMeta } from './audio-capture.js'
import { voiceOffHere } from './stt/voice-here.js'

// Simple serial queue — process one chunk at a time to avoid concurrent STT calls
let processing = false
const queue: Array<{ recordingId: string; chunkIndex: number; filePath: string; duration: number }> = []

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true

  while (queue.length > 0) {
    const item = queue.shift()!
    try {
      await transcribeChunk(item.recordingId, item.chunkIndex, item.filePath, item.duration)
    } catch (err) {
      // Transcription failure should never crash the service — just log and continue
      log.audio.warn('transcription failed', {
        recordingId: item.recordingId,
        chunkIndex: item.chunkIndex,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  processing = false
}

async function transcribeChunk(
  recordingId: string,
  chunkIndex: number,
  filePath: string,
  duration: number,
): Promise<void> {
  const config = await getConfig()

  // Skip if no STT engine configured
  if (!config.stt?.engine) {
    log.audio.debug('transcription skipped — no STT engine configured', { recordingId, chunkIndex })
    return
  }

  log.audio.info('transcribing chunk', { recordingId, chunkIndex, filePath })

  // Read WAV → base64
  const wavBuffer = await readFile(filePath)
  const audio = wavBuffer.toString('base64')

  // Transcribe — whisper-server's --convert flag handles 48kHz→16kHz automatically
  const result = await transcribeAudio(config, { audio, format: 'wav' })

  // Save .txt alongside the .wav (even if empty — marks chunk as processed)
  const txtPath = filePath.replace(/\.wav$/, '.txt')
  await writeFile(txtPath, result.text, 'utf-8')

  // Update .json metadata — single read/modify/write for transcription + optional WAV deletion
  const metaPath = filePath.replace(/\.wav$/, '.json')
  try {
    const metaRaw = await readFile(metaPath, 'utf-8')
    const meta: RecordingChunkMeta = JSON.parse(metaRaw)
    meta.transcription = result.text
    meta.transcriptionDurationMs = result.durationMs

    // Delete WAV after successful transcription (default: true)
    if (config.audio?.delete_after_transcription !== false) {
      try {
        await unlink(filePath)
        meta.audioDeleted = true
        meta.filePath = null
        log.audio.info('audio file deleted after transcription', {
          recordingId, chunkIndex, deletedBytes: meta.size, path: filePath,
        })
      } catch (err) {
        log.audio.warn('failed to delete audio after transcription', {
          filePath, error: (err as Error).message,
        })
      }
    }

    await writeFile(metaPath, JSON.stringify(meta, null, 2))
  } catch (err) {
    log.audio.warn('failed to update chunk metadata', { metaPath, error: (err as Error).message })
  }

  if (!result.text.trim()) {
    log.audio.debug('transcription empty', { recordingId, chunkIndex })
    return
  }

  log.audio.info('transcription complete', {
    recordingId,
    chunkIndex,
    textLength: result.text.length,
    durationMs: result.durationMs,
  })

  // Emit completion event
  bus.emit(EventNames.AUDIO_TRANSCRIPTION_COMPLETE, {
    recordingId,
    chunkIndex,
    filePath,
    text: result.text,
    durationMs: result.durationMs,
  }, ['*'], { source: 'audio-transcriber' })
}

/**
 * Initialize the audio transcriber — subscribe to chunk-saved events.
 */
export function initAudioTranscriber(): void {
  // An isolated server records nothing and runs no engine, so it has nothing to transcribe.
  const off = voiceOffHere()
  if (off) {
    log.audio.info('audio transcriber not started', { reason: off })
    return
  }
  bus.subscribe('audio-transcriber', (event) => {
    if (event.name !== EventNames.AUDIO_CHUNK_SAVED) return

    const { recordingId, chunkIndex, filePath, duration } = eventData<'audio:chunk-saved'>(event)
    queue.push({ recordingId, chunkIndex, filePath, duration })
    processQueue()
  }, { global: true, interest: ['audio:'] })

  log.audio.info('audio transcriber initialized')
}
