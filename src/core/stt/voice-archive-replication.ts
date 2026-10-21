import { isCompanion } from '../server-role.js'
import { log } from '../../logging/index.js'
import { voiceArchive, voiceRecordingId, type VoiceArchiveStore } from './voice-archive.js'

const HOP_TIMEOUT_MS = 10_000
const COPY_TIMEOUT_MS = 120_000
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 900_000
const active = new Map<string, Promise<boolean>>()
let unhook: (() => void) | undefined
let starting: Promise<void> | undefined
let retrying: Promise<void> | undefined

/** No archive lock is held while a network hop is in flight. */
export async function voicePrimaryAction(operation: string, id: string, body: unknown, timeoutMs = HOP_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const { bridgeRequest } = await import('../../web/ws/bridge-registry.js')
  const reply = await bridgeRequest('__local__', 'session.control', {
    action: 'server.voice.archive', sessionId: '__server__', params: { operation, id, body },
  }, timeoutMs)
  if (reply.ok !== true || !reply.result || typeof reply.result !== 'object') throw new Error('Voice archive primary request failed')
  const result = reply.result as Record<string, unknown>
  if (typeof result.status !== 'number' || result.status < 200 || result.status >= 300) {
    throw Object.assign(new Error('Voice archive primary refused the request'), { status: result.status })
  }
  return result
}

export function replicateVoiceRecording(raw: string, store: VoiceArchiveStore = voiceArchive, budgetMs = COPY_TIMEOUT_MS): Promise<boolean> {
  const id = voiceRecordingId(raw)
  const key = `${store.root}|${id}`
  const existing = active.get(key)
  if (existing) return existing
  const run = (async () => {
    const deadline = Date.now() + budgetMs
    const send = (operation: string, body: unknown) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Voice archive copy deadline expired')
      return voicePrimaryAction(operation, id, body, Math.min(HOP_TIMEOUT_MS, remaining))
    }
    const { record, chunkCount, nextPrimaryChunk } = await store.replicationSnapshot(id)
    if (record.primarySaved === true) {
      if (record.text !== undefined) return true
      try {
        const answer = await send('get', undefined)
        const primary = answer.body as { id?: unknown; audioSha256?: unknown; text?: unknown; via?: unknown }
        if (primary?.id !== id || primary.audioSha256 !== record.audioSha256) throw new Error('Voice archive copy identity does not match')
        if (typeof primary.text === 'string' && primary.text.trim()) {
          const saved = await store.saveText(id, primary.text, typeof primary.via === 'string' ? primary.via : undefined)
          await store.markPrimarySaved(id, saved.text)
        }
        return true
      } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error
        await store.resetPrimaryChunks(id)
        return false
      }
    }
    for (let index = nextPrimaryChunk; index < chunkCount; index++) {
      const audio = await store.readChunk(id, index)
      await send('chunk', { index, audio: audio.toString('base64'), format: record.format, createdAt: record.createdAt, surface: record.surface, durationSeconds: record.durationSeconds })
      await store.markPrimaryChunk(id, index + 1)
    }
    try {
      await send('commit', { chunkCount, audioSizeBytes: record.audioSizeBytes, audioSha256: record.audioSha256 })
    } catch (error) {
      if ((error as { status?: number }).status === 404 || (error as { status?: number }).status === 400) await store.resetPrimaryChunks(id)
      throw error
    }
    // Pick up a transcript saved during the copy rather than marking only audio replicated.
    const latest = await store.get(id)
    if (latest.text !== undefined) {
      try {
        await send('text', { text: latest.text, via: latest.via })
      } catch (error) {
        // 409: the Mac transcribed it too, and its own text stays. Each box keeps
        // the transcript it made; retrying could never change that.
        if ((error as { status?: number }).status !== 409) throw error
      }
    }
    const marked = await store.markPrimarySaved(id, latest.text)
    return marked.primarySaved === true
  })().catch(() => {
    // Deliberately no exception text: an engine/transport error can contain private data.
    log.web.warn('voice archive copy pending', { recordingId: id })
    return false
  }).finally(() => { active.delete(key) })
  active.set(key, run)
  return run
}

export function deferVoiceReplication(id?: string): void {
  if (!isCompanion()) return
  setImmediate(() => {
    const work = id ? replicateVoiceRecording(id).then(() => {}) : retryVoiceArchives()
    void work.catch(() => { log.web.warn('voice archive retry could not read storage') })
  })
}
function retryVoiceArchives(): Promise<void> {
  retrying ??= (async () => {
    for (const record of await voiceArchive.all()) {
      if (record.state === 'uploading' || (record.primarySaved === true && record.text !== undefined)) continue
      const { bridgeForHost } = await import('../../web/ws/bridge-registry.js')
      if (!bridgeForHost('__local__').connected) break
      await replicateVoiceRecording(record.id)
    }
  })().finally(() => { retrying = undefined })
  return retrying
}
export function startVoiceArchiveReplication(): Promise<void> {
  if (!isCompanion()) return Promise.resolve()
  starting ??= (async () => {
    const { addPrimaryBridgeConnectedHandler, addPrimaryBridgeActivityHandler } = await import('../../web/ws/bridge-registry.js')
    const connected = addPrimaryBridgeConnectedHandler(() => deferVoiceReplication())
    const activity = addPrimaryBridgeActivityHandler(() => deferVoiceReplication())
    unhook = () => { connected(); activity() }
    deferVoiceReplication()
  })().catch(() => { starting = undefined; log.web.warn('voice archive reconnect hook unavailable') })
  return starting
}
export function stopVoiceArchiveReplication(): void { unhook?.(); unhook = undefined; starting = undefined }
