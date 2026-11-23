/**
 * The user's takes as Voice Accuracy reads them: web/Mac dictation in
 * tmp/stt-recordings (recordings.ts) and phone takes in the voice archive. Read
 * only: nothing here writes a recording, its result, or what learn-from-sends
 * holds.
 */
import { recordingIdTime as stampTime } from '../recordings.js'
import { compareStore, takeIdOf } from './store.js'
import type { AudioRef, CompareTake } from './types.js'

type Skeleton = Pick<CompareTake, 'source' | 'at' | 'format' | 'audioRef'> & Partial<Pick<CompareTake, 'durationSec' | 'inUseText'>>

/** The fields a new entry starts with, from the recording itself; null when it is gone. */
export async function skeletonOf(ref: AudioRef): Promise<Skeleton | null> {
  if (ref.kind === 'recording') {
    const { getRecordingMeta, recordingAudioPath } = await import('../recordings.js')
    const [meta, audio] = await Promise.all([getRecordingMeta(ref.id), recordingAudioPath(ref.id)])
    if (!meta && !audio) return null
    return {
      source: 'web', at: stampTime(ref.id) ?? meta?.timestamp ?? new Date().toISOString(),
      format: audio?.format ?? meta?.format ?? 'webm', audioRef: ref,
      ...(meta?.result?.text ? { inUseText: meta.result.text } : {}),
    }
  }
  const { voiceArchive } = await import('../voice-archive.js')
  const record = await voiceArchive.get(ref.id).catch(() => null)
  if (!record || record.state === 'uploading') return null
  return {
    source: 'phone', at: record.createdAt, format: record.format, audioRef: { kind: 'archive', id: record.id },
    ...(record.durationSeconds ? { durationSec: record.durationSeconds } : {}),
    ...(record.text ? { inUseText: record.text } : {}),
  }
}

/** The entry of a recording, made from the recording when there is none yet. */
export async function ensureTake(ref: AudioRef): Promise<CompareTake | null> {
  const id = takeIdOf(ref)
  const existing = await compareStore.get(id)
  if (existing) return existing
  const skeleton = await skeletonOf(ref)
  return skeleton ? compareStore.upsert(id, skeleton) : null
}

/** The newest recordings of both stores, newest first (`sinceMs`: only those made after it). */
export async function recentRecordings(limit: number, sinceMs?: number): Promise<AudioRef[]> {
  const [{ listRecordings }, { voiceArchive }] = await Promise.all([import('../recordings.js'), import('../voice-archive.js')])
  const web = (await listRecordings(limit)).map((m) => ({ ref: { kind: 'recording' as const, id: m.id }, at: stampTime(m.id) ?? m.timestamp }))
  const phone = (await voiceArchive.all().catch(() => []))
    .filter((r) => r.state !== 'uploading').slice(0, limit)
    .map((r) => ({ ref: { kind: 'archive' as const, id: r.id }, at: r.createdAt }))
  return [...web, ...phone]
    .filter((t) => sinceMs === undefined || Date.parse(t.at) >= sinceMs)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit)
    .map((t) => t.ref)
}

/** A take's audio as base64 with its format, or null when the recording is gone. */
export async function readTakeAudio(ref: AudioRef): Promise<{ audio: string; format: string } | null> {
  if (ref.kind === 'recording') {
    const { readRecordingAudio } = await import('../recordings.js')
    return readRecordingAudio(ref.id)
  }
  const { voiceArchive } = await import('../voice-archive.js')
  const found = await voiceArchive.readAudio(ref.id).catch(() => null)
  return found ? { audio: found.audio.toString('base64'), format: found.format } : null
}

/** Where a take's audio file is, for the user's own Play button. */
export async function takeAudioPath(ref: AudioRef): Promise<{ path: string; format: string } | null> {
  if (ref.kind === 'recording') {
    const { recordingAudioPath } = await import('../recordings.js')
    return recordingAudioPath(ref.id)
  }
  const { voiceArchive } = await import('../voice-archive.js')
  const found = await voiceArchive.audioPath(ref.id).catch(() => null)
  return found ? { path: found.path, format: found.record.format } : null
}

/** The engine and model that made a take's text at the time, as its recording recorded them. */
export async function inUseEngineOf(ref: AudioRef): Promise<{ engine?: string; model?: string }> {
  if (ref.kind === 'recording') {
    const { getRecordingMeta } = await import('../recordings.js')
    const meta = await getRecordingMeta(ref.id).catch(() => null)
    const engine = meta?.result?.engine ?? meta?.engine
    const model = meta?.result?.model
    return { ...(engine ? { engine } : {}), ...(model ? { model } : {}) }
  }
  const { voiceArchive } = await import('../voice-archive.js')
  const record = await voiceArchive.get(ref.id).catch(() => null)
  const engine = record?.asr?.engine
  const model = record?.asr?.model
  return { ...(engine ? { engine } : {}), ...(model ? { model } : {}) }
}
