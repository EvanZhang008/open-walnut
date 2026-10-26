import { isCompanion } from '../server-role.js'
import { log } from '../../logging/index.js'
import { voiceArchive, voiceRecordingId, type VoiceArchiveStore } from './voice-archive.js'

const HOP_TIMEOUT_MS = 10_000
const COPY_TIMEOUT_MS = 120_000
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 900_000
const active = new Map<string, Promise<boolean>>()
/** Copies the Mac has answered at least one hop of, by copy key. */
const answered = new Set<string>()
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
        .then((answer) => { answered.add(key); return answer })
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
  }).finally(() => { active.delete(key); answered.delete(key) })
  active.set(key, run)
  return run
}

/**
 * The copy, unless the Mac is quiet: 'silent' when its first hop is not answered
 * within `silenceMs` (a Mac asleep behind a bridge that still looks connected).
 * Once the Mac has answered, the copy runs to its end: a large chunk on a slow
 * link can take longer than that and the Mac is plainly there. The copy itself
 * carries on in the background either way, so the archive still reaches the Mac.
 */
export function replicateUnlessSilent(raw: string, silenceMs: number, store: VoiceArchiveStore = voiceArchive): Promise<boolean | 'silent'> {
  const key = `${store.root}|${voiceRecordingId(raw)}`
  const copy = replicateVoiceRecording(raw, store)
  const since = Date.now()
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      if (!answered.has(key) && Date.now() - since >= silenceMs) { clearInterval(tick); resolve('silent') }
    }, Math.min(250, silenceMs))
    tick.unref?.()
    void copy.then((done) => { clearInterval(tick); resolve(done) })
  })
}

export function deferVoiceReplication(id?: string): void {
  if (!isCompanion()) return
  setImmediate(() => {
    const work = id ? replicateVoiceRecording(id).then(() => {}) : retryVoiceArchives()
    void work.catch(() => { log.web.warn('voice archive retry could not read storage') })
  })
}
/** Copied already, or still being uploaded by the phone: nothing for a pass to do. */
const settled = (record: { state: string; primarySaved?: boolean; text?: string }) =>
  record.state === 'uploading' || (record.primarySaved === true && record.text !== undefined)
function retryVoiceArchives(): Promise<void> {
  retrying ??= (async () => {
    // A take being transcribed copies itself when its answer is in: a copy
    // beside a live hand-over's last hops can make the Mac look asleep.
    const { isTranscribing } = await import('./voice-archive-transcribe.js')
    for (const record of await voiceArchive.all()) {
      if (settled(record) || isTranscribing(record.id)) continue
      const { bridgeForHost } = await import('../../web/ws/bridge-registry.js')
      if (!bridgeForHost('__local__').connected) break
      await replicateVoiceRecording(record.id)
    }
  })().finally(() => { retrying = undefined })
  return retrying
}

// The bridge can connect before the Mac's daemon relays, and the next activity pass is 15 s away.
const FOLLOWUP_MS = [2_000, 5_000] as const
interface FollowupClock { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }
const realClock: FollowupClock = {
  set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
let clock = realClock
/** Bumped by every connect and by stop: a pass or timer of an older one does nothing. */
let epoch = 0
let followup: unknown
/** One pass this module started: P is the pass, C what follows it (the check, maybe a timer). */
interface FollowupRound { epoch: number; n: number; started: Promise<{ P: Promise<void>; C: Promise<void> } | null> }
/** Kept only while a test clock is set, so a test waits on the very passes it caused. */
let rounds: FollowupRound[] | undefined

async function linkUp(): Promise<boolean> {
  return (await import('../../web/ws/bridge-registry.js')).bridgeForHost('__local__').connected
}
function clearFollowup(): void {
  if (followup === undefined) return
  clock.clear(followup)
  followup = undefined
}
/** A pass in `mine`, after `after`; `n` passes of it already ran (-1: the start's, never followed up). */
function followupRound(mine: number, n: number, after: Promise<void>, needLink: boolean): void {
  const started = after.then(async () => {
    if (mine !== epoch || !unhook) return null
    if (needLink && !(await linkUp())) return null
    if (mine !== epoch || !unhook) return null
    const P = retryVoiceArchives()
    const C = P.then(() => armFollowup(mine, n))
    void C.catch(() => { log.web.warn('voice archive retry could not read storage') })
    return { P, C }
  })
  void started.catch(() => { log.web.warn('voice archive retry could not start') })
  rounds?.push({ epoch: mine, n, started })
}
async function armFollowup(mine: number, n: number): Promise<void> {
  if (n < 0 || n >= FOLLOWUP_MS.length) return
  if (!(await voiceArchive.all()).some((record) => !settled(record))) return
  if (mine !== epoch || !unhook || !(await linkUp())) return
  if (mine !== epoch || !unhook || followup !== undefined) return
  const handle = clock.set(() => {
    if (mine !== epoch || !unhook) return
    if (followup === handle) followup = undefined
    followupRound(mine, n + 1, Promise.resolve(), true)
  }, FOLLOWUP_MS[n])
  followup = handle
}
function onPrimaryConnected(): void {
  epoch++
  clearFollowup()
  followupRound(epoch, 0, new Promise<void>((resolve) => setImmediate(resolve)), false)
}

export function startVoiceArchiveReplication(): Promise<void> {
  if (!isCompanion()) return Promise.resolve()
  starting ??= (async () => {
    const { addPrimaryBridgeConnectedHandler, addPrimaryBridgeActivityHandler } = await import('../../web/ws/bridge-registry.js')
    const connected = addPrimaryBridgeConnectedHandler(onPrimaryConnected)
    const activity = addPrimaryBridgeActivityHandler(() => deferVoiceReplication())
    unhook = () => { connected(); activity() }
    followupRound(epoch, -1, new Promise<void>((resolve) => setImmediate(resolve)), false)
  })().catch(() => { starting = undefined; log.web.warn('voice archive reconnect hook unavailable') })
  return starting
}
export function stopVoiceArchiveReplication(): void {
  epoch++
  clearFollowup()
  unhook?.(); unhook = undefined; starting = undefined
}

export function _setFollowupClockForTest(next?: FollowupClock): void {
  clock = next ?? realClock
  rounds = next ? [] : undefined
}
export function _followupStateForTest(): { rounds: readonly FollowupRound[]; handle: unknown; epoch: number } {
  return { rounds: rounds ?? [], handle: followup, epoch }
}
