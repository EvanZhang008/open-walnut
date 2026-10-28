import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('voice-archive-cloud', { CLOUD_MODE: true }))
const bridge = vi.hoisted(() => vi.fn())
const activity = vi.hoisted(() => new Set<() => void>())
const connected = vi.hoisted(() => new Set<() => void>())
const link = vi.hoisted(() => ({ connected: true }))
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridge, bridgeForHost: () => ({ connected: link.connected }),
  addPrimaryBridgeConnectedHandler: (handler: () => void) => {
    connected.add(handler)
    return () => connected.delete(handler)
  },
  addPrimaryBridgeActivityHandler: (handler: () => void) => {
    activity.add(handler)
    return () => activity.delete(handler)
  },
}))
// The companion's view of the Mac: heard at `lastSeenAt` (its beats).
const leaderView = vi.hoisted(() => ({ lastSeenAt: 0, none: false }))
vi.mock('../../../src/core/leader/backup-leader.js', () => ({
  getBackupLeader: async () => leaderView.none ? null : ({
    status: () => ({ primaryHeard: true, primaryLastSeenAt: leaderView.lastSeenAt, leading: [], backupAllowed: true, takeoverMs: 45_000 }),
  }),
}))
const engine = vi.hoisted(() => vi.fn())
// Whether the companion's own engine is installed (the fast fallback needs one).
const localEngine = vi.hoisted(() => ({ available: true }))
vi.mock('../../../src/core/stt/index.js', () => ({
  transcribeAudio: engine,
  getOrCreateEngine: () => ({ isAvailable: async () => ({ available: localEngine.available }) }),
}))
import { voiceArchive, VoiceArchiveStore, VOICE_CHUNK_BYTES } from '../../../src/core/stt/voice-archive.js'
import { replicateVoiceRecording, startVoiceArchiveReplication, stopVoiceArchiveReplication, _setFollowupClockForTest, _followupStateForTest } from '../../../src/core/stt/voice-archive-replication.js'
import { transcribeVoiceRecording, liveRole, probeMacForTake, _resetMacQuietForTest, MAC_SILENCE_MS } from '../../../src/core/stt/voice-archive-transcribe.js'
import { appendLive, hasLiveTake, _resetLiveTakesForTest } from '../../../src/core/stt/live-transcript.js'
import { hasLiveForward, _resetLiveForwardsForTest } from '../../../src/core/stt/live-forward.js'
import { runVoiceArchiveAction, voiceArchiveV1Router } from '../../../src/web/routes/voice-archive-v1.js'
import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { updateConfig } from '../../../src/core/config-manager.js'
/** One probe of a held take that the Mac leaves unanswered. */
async function unansweredProbe(id: string): Promise<void> {
  probeMacForTake(id)
  await new Promise((r) => setTimeout(r, MAC_SILENCE_MS + 200))
}
let primaryHome: string
let primary: VoiceArchiveStore
beforeEach(async () => {
  stopVoiceArchiveReplication()
  link.connected = true
  // A beat just now: whatever an earlier test left unanswered, the Mac is heard after it.
  leaderView.lastSeenAt = Date.now()
  leaderView.none = false
  _resetMacQuietForTest()
  localEngine.available = true
  // An engine of the companion's own (the mocked transcribeAudio), no hosted key.
  await updateConfig({ stt: { engine: 'whisper-cpp' } })
  await rm(voiceArchive.root, { recursive: true, force: true })
  if (primaryHome) await rm(primaryHome, { recursive: true, force: true })
  primaryHome = await mkdtemp(tmpdir() + '/voice-primary-')
  primary = new VoiceArchiveStore(primaryHome, false)
  bridge.mockReset(); engine.mockReset()
  _resetLiveTakesForTest(); _resetLiveForwardsForTest(); (await macModule())._resetLiveTakesForTest(); macHeard.length = 0
  bridge.mockImplementation(async (_host, _command, params) => {
    const { operation, id, body } = params.params
    let answer
    if (operation === 'live' || operation === 'live-finish' || operation === 'live-drop') return fakeMacLive(operation, id, body)
    if (operation === 'get') answer = await primary.get(id)
    else if (operation === 'chunk') answer = await primary.saveChunk(id, body)
    else if (operation === 'commit') answer = await primary.commit(id, body)
    else if (operation === 'text') answer = await primary.saveText(id, body.text, body.via, body.asr)
    else if (operation === 'transcribe') {
      const saved = await primary.saveText(id, 'primary full text', 'primary')
      answer = { text: saved.text, via: saved.via, recordingId: id, primarySaved: true }
    }
    return { ok: true, result: { status: 200, body: answer } }
  })
})
afterAll(async () => { if (primaryHome) await rm(primaryHome, { recursive: true, force: true }) })

/**
 * The Mac's side of a live hand-over: its own instance of the live module (the
 * query makes it a second copy, as on another machine) and an engine that names
 * the seconds it was given. Mirrors runVoiceArchiveAction's live ops on the Mac.
 */
type LiveModule = typeof import('../../../src/core/stt/live-transcript.js')
const macModule = () => import('../../../src/core/stt/live-transcript.js?mac' as string) as Promise<LiveModule>
const macHeard: number[] = []
const macEngine = async (wav: Buffer) => {
  const seconds = (wav.length - 44) / 32000
  macHeard.push(seconds)
  return `mac[${seconds.toFixed(1)}]`
}
async function fakeMacLive(operation: string, id: string, body: { from?: number; audio?: string; pcmBytes?: number; pcmSha256?: string; language?: string } | undefined) {
  const mac = await macModule()
  if (operation === 'live-drop') { mac.dropLive(id); return { ok: true, result: { status: 200, body: { ok: true } } } }
  if (operation === 'live') {
    const ack = mac.appendLive(id, body!.from!, Buffer.from(body!.audio!, 'base64'), macEngine, { language: body!.language })
    return { ok: true, result: { status: 200, body: 'gap' in ack ? { accepted: true, gap: true, receivedBytes: ack.receivedBytes, segments: 0 } : ack } }
  }
  const text = await mac.finishLiveFromSamples(id, body!.pcmBytes!, body!.pcmSha256!, macEngine, body!.language)
  // The real Mac also says how it made the text (finishLiveHere): its engine, the live counts, its own time.
  return { ok: true, result: text === null ? { status: 409, body: { error: { code: 'live_unusable' } } } : { status: 200, body: { text, asr: { engine: 'mlx', ...mac.takeLiveStats(id), ms: 1 } } } }
}
const macHas = async (id: string) => (await macModule()).hasLiveTake(id)

/** A phone CAF: 4096 header bytes, then 16 kHz mono PCM; `finished` states the data size. */
const HEADER = 4096
function phoneCaf(seconds: number, finished: boolean, seed = 1, trailer = Buffer.alloc(0)): Buffer {
  const pcm = new Int16Array(seconds * 16000)
  for (let i = 0; i < pcm.length; i++) pcm[i] = (i / 16000) % 5 >= 4 ? 0 : Math.round(6000 * Math.sin(2 * Math.PI * (200 + seed) * i / 16000))
  const desc = Buffer.alloc(32)
  desc.writeDoubleBE(16000, 0); desc.write('lpcm', 8, 'ascii')
  desc.writeUInt32BE(2, 12); desc.writeUInt32BE(2, 16); desc.writeUInt32BE(1, 20); desc.writeUInt32BE(1, 24); desc.writeUInt32BE(16, 28)
  const chunk = (type: string, b: Buffer, size = BigInt(b.length)) => {
    const h = Buffer.alloc(12); h.write(type, 0, 'ascii'); h.writeBigInt64BE(size, 4)
    return Buffer.concat([h, b])
  }
  const data = Buffer.concat([Buffer.alloc(4), Buffer.from(pcm.buffer)])
  return Buffer.concat([Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]), chunk('desc', desc), chunk('free', Buffer.alloc(4016)), chunk('data', data, finished ? BigInt(data.length) : -1n), trailer])
}

/** The phone sends the take live while recording, the last `unsent` bytes not yet, then stores the finished file. */
async function recordLive(id: string, seconds: number, opts: { unsent?: number; trailer?: Buffer } = {}): Promise<void> {
  const unsent = opts.unsent ?? 50_000
  const live = phoneCaf(seconds, false)
  for (let from = 0; from < live.length - unsent; from += 128 * 1024) {
    const piece = live.subarray(from, Math.min(from + 128 * 1024, live.length - unsent))
    expect(await runVoiceArchiveAction({ operation: 'live', id, body: { from, audio: piece.toString('base64') } })).toMatchObject({ status: 200, body: { accepted: true } })
  }
  await voiceArchive.ingestAudio({ id, audio: phoneCaf(seconds, true, 1, opts.trailer), format: 'caf' })
}
const ops = () => bridge.mock.calls.map((call) => call[2].params.operation as string)
describe('durable voice cloud copies', () => {
  it('keeps an offline copy and resumes from the acknowledged chunk after interruption', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.alloc(VOICE_CHUNK_BYTES * 3, 1), format: 'caf' })
    let chunks = 0
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'chunk' && ++chunks === 2) throw new Error('connection lost')
      return real(...args)
    })
    expect(await replicateVoiceRecording(record.id)).toBe(false)
    expect((await voiceArchive.readAudio(record.id)).audio.length).toBe(VOICE_CHUNK_BYTES * 3)
    expect((await voiceArchive.replicationSnapshot(record.id)).nextPrimaryChunk).toBe(1)
    bridge.mockImplementation(real); bridge.mockClear()
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect(bridge.mock.calls.filter((call) => call[2].params.operation === 'chunk').map((call) => call[2].params.body.index)).toEqual([1, 2])
    expect((await primary.readAudio(record.id)).audio.equals((await voiceArchive.readAudio(record.id)).audio)).toBe(true)
  })
  it('never copies back a take the Mac removed for its recording limit (410)', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.alloc(VOICE_CHUNK_BYTES * 2, 1), format: 'caf' })
    const removed = { ok: true, result: { status: 410, body: { error: { code: 'removed' } } } }
    // Not on the Mac yet: its first chunk is refused as removed, and the take counts as settled.
    bridge.mockResolvedValue(removed)
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(true)
    // Already on the Mac with no text yet: the check is refused the same way, and nothing is sent again.
    bridge.mockClear()
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect(bridge.mock.calls.map((call) => call[2].params.operation)).toEqual(['get'])
    expect((await voiceArchive.readAudio(record.id)).audio.length).toBe(VOICE_CHUNK_BYTES * 2)
  })
  it('resumes an expired copy budget on daemon activity without a reconnect or phone request', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.alloc(VOICE_CHUNK_BYTES * 3, 1), format: 'caf' })
    await startVoiceArchiveReplication()
    await vi.waitFor(async () => { expect((await voiceArchive.get(record.id)).primarySaved).toBe(true) })
    await new Promise<void>((resolve) => setImmediate(resolve))
    await voiceArchive.resetPrimaryChunks(record.id)
    let now = 1000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      const answer = await real(...args)
      if (args[2].params.operation === 'chunk') now += 101
      return answer
    })
    try { expect(await replicateVoiceRecording(record.id, voiceArchive, 100)).toBe(false) }
    finally { clock.mockRestore() }
    expect((await voiceArchive.replicationSnapshot(record.id)).nextPrimaryChunk).toBe(1)
    bridge.mockImplementation(real)
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(false)
    for (const handler of activity) handler()
    await vi.waitFor(async () => { expect((await voiceArchive.get(record.id)).primarySaved).toBe(true) })
    expect((await primary.readAudio(record.id)).audio.equals((await voiceArchive.readAudio(record.id)).audio)).toBe(true)
    stopVoiceArchiveReplication()
    expect(activity.size).toBe(0)
  })
  it('a later daemon pulse copies text saved during the final audio acknowledgement', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    await startVoiceArchiveReplication()
    await vi.waitFor(async () => { expect((await voiceArchive.get(record.id)).primarySaved).toBe(true) })
    await voiceArchive.resetPrimaryChunks(record.id)
    const realMark = voiceArchive.markPrimarySaved.bind(voiceArchive)
    const mark = vi.spyOn(voiceArchive, 'markPrimarySaved').mockImplementationOnce(async (id, text) => {
      await voiceArchive.saveText(id, 'Text arriving during copy')
      return realMark(id, text)
    })
    try {
      expect(await replicateVoiceRecording(record.id)).toBe(false)
      expect((await primary.get(record.id)).text).toBeUndefined()
      for (const handler of activity) handler()
      await vi.waitFor(async () => {
        expect((await primary.get(record.id)).text).toBe('Text arriving during copy')
        expect((await voiceArchive.get(record.id)).primarySaved).toBe(true)
      })
    } finally { mark.mockRestore(); stopVoiceArchiveReplication() }
  })
  it('transcribes using only the committed ID and stores text on both boxes before returning', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.alloc(VOICE_CHUNK_BYTES * 2, 2), format: 'caf' })
    const answer = await transcribeVoiceRecording(record.id)
    expect(answer).toMatchObject({ text: 'primary full text', primarySaved: true })
    expect((await voiceArchive.get(record.id)).text).toBe('primary full text')
    expect((await primary.get(record.id)).text).toBe('primary full text')
    const call = bridge.mock.calls.find((call) => call[2].params.operation === 'transcribe')!
    expect(call[2].params).toEqual({ operation: 'transcribe', id: record.id, body: { language: undefined } })
    expect(engine).not.toHaveBeenCalled()
  })
  it('does not run a second engine after losing a primary transcription response', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'transcribe') { await primary.saveText(record.id, 'late primary', 'primary'); throw new Error('reply lost') }
      return real(...args)
    })
    await expect(transcribeVoiceRecording(record.id)).rejects.toMatchObject({ code: 'stt_pending' })
    expect(engine).not.toHaveBeenCalled()
    expect((await primary.get(record.id)).text).toBe('late primary')
    expect((await voiceArchive.readAudio(record.id)).audio.toString()).toBe('speech')
    bridge.mockImplementation(real)
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect((await voiceArchive.get(record.id)).text).toBe('late primary')
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(true)
    expect((await voiceArchive.get(record.id)).storage).toBe('companion')
    expect((await primary.get(record.id)).storage).toBe('primary')
    expect(engine).not.toHaveBeenCalled()
  })
  it('does not run a second engine for a malformed primary reply', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'transcribe') return { ok: true, result: { status: 200, body: {} } }
      return real(...args)
    })
    await expect(transcribeVoiceRecording(record.id)).rejects.toMatchObject({ code: 'stt_pending' })
    expect(engine).not.toHaveBeenCalled()
    expect((await voiceArchive.get(record.id)).text).toBeUndefined()
  })
  it('transcribes on the companion when the Mac holding the copy is offline, then hands the text over', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(true)
    link.connected = false
    bridge.mockClear()
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'companion text', via: 'local' })
    expect(bridge).not.toHaveBeenCalled()
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(false)
    link.connected = true
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect((await primary.get(record.id)).text).toBe('companion text')
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(true)
  })
  it('transcribes on the companion when the bridge is up but the Mac does not answer the copy', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    bridge.mockRejectedValue(new Error('bridge request timed out'))
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'companion text', via: 'local' })
    expect(bridge.mock.calls.some((call) => call[2].params.operation === 'transcribe')).toBe(false)
  })
  it('a Mac asleep behind a live bridge costs this box 2.5 s, not a hop timeout', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    // Every hop to the Mac hangs (it sleeps; the bridge has not noticed yet).
    bridge.mockImplementation(() => new Promise(() => {}))
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    const started = Date.now()
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'companion text', via: 'local' })
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(MAC_SILENCE_MS - 100)
    expect(took).toBeLessThan(MAC_SILENCE_MS + 2_000)
  })
  it('a take that starts while the Mac sleeps is this box\'s once two probes go unanswered, until the Mac is heard', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await liveRole()).toEqual({ takes: true, now: false })
    bridge.mockImplementation(() => new Promise(() => {}))
    await unansweredProbe(record.id)
    // One unanswered call may have queued behind a large copy: the take stays held.
    expect(await liveRole()).toEqual({ takes: true, now: false })
    await unansweredProbe(record.id)
    expect(await liveRole()).toEqual({ takes: true, now: true })
    // The finished take goes straight to this box's engine: no copy wait.
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    const started = Date.now()
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'companion text', via: 'local' })
    expect(Date.now() - started).toBeLessThan(1_000)
    // The Mac's next beat: it is asked again.
    leaderView.lastSeenAt = Date.now() + 1
    expect(await liveRole()).toEqual({ takes: true, now: false })
  }, 15_000)
  it('after a quiet mark clears, one slow probe does not mark the Mac quiet again', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    bridge.mockImplementation(() => new Promise(() => {}))
    await unansweredProbe(record.id)
    await unansweredProbe(record.id)
    expect(await liveRole()).toEqual({ takes: true, now: true })
    // The Mac's next beat clears the mark; the count starts over with it.
    leaderView.lastSeenAt = Date.now() + 1
    expect(await liveRole()).toEqual({ takes: true, now: false })
    await unansweredProbe(record.id)
    expect(await liveRole()).toEqual({ takes: true, now: false })
  }, 15_000)
  it('a Mac whose bridge connects again is asked again before its next beat', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    bridge.mockImplementation(() => new Promise(() => {}))
    await unansweredProbe(record.id)
    await unansweredProbe(record.id)
    expect(await liveRole()).toEqual({ takes: true, now: true })
    for (const handler of connected) handler()
    expect(await liveRole()).toEqual({ takes: true, now: false })
  }, 15_000)
  it('a quiet mark nothing renews lapses after 20 s, also with no beats to read', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    // No leader view (a box without the backup-leader capability): no beats ever clear the mark.
    leaderView.none = true
    bridge.mockImplementation(() => new Promise(() => {}))
    await unansweredProbe(record.id)
    await unansweredProbe(record.id)
    expect(await liveRole()).toEqual({ takes: true, now: true })
    const real = Date.now
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + 21_000)
    try { expect(await liveRole()).toEqual({ takes: true, now: false }) } finally { clock.mockRestore() }
  }, 15_000)
  it('a Mac that answers a probe, even with "no such recording", keeps the take and resets the count', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    bridge.mockImplementation(() => new Promise(() => {}))
    await unansweredProbe(record.id)
    bridge.mockReset()
    bridge.mockResolvedValue({ ok: true, result: { status: 404, body: { error: 'not found' } } })
    probeMacForTake(record.id)
    await vi.waitFor(() => expect(bridge).toHaveBeenCalledTimes(1))
    expect(bridge.mock.calls[0][2].params).toMatchObject({ operation: 'get', id: record.id })
    await new Promise((r) => setTimeout(r, 50))
    bridge.mockImplementation(() => new Promise(() => {}))
    await unansweredProbe(record.id)
    // Unanswered, answered, unanswered: never two in a row.
    expect(await liveRole()).toEqual({ takes: true, now: false })
  }, 15_000)
  it('a probe of another take left unanswered does not take a transcription away from a working Mac', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      const { operation, id } = args[2].params
      if (operation === 'get' && id === 'other') return new Promise(() => {})
      if (operation === 'transcribe') await new Promise((r) => setTimeout(r, 6_500))
      return real(...args)
    })
    const work = transcribeVoiceRecording(record.id)
    await new Promise((r) => setTimeout(r, 300))
    await unansweredProbe('other')
    await unansweredProbe('other')
    expect(await work).toMatchObject({ text: 'primary full text', via: 'primary' })
    expect(engine).not.toHaveBeenCalled()
  }, 20_000)
  it('a Mac that answered the first hop of a copy is waited for, however long a chunk takes', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.alloc(VOICE_CHUNK_BYTES * 2, 1), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      const { operation, body } = args[2].params
      // A slow link: the second chunk takes longer than the silence budget.
      if (operation === 'chunk' && body.index === 1) await new Promise((r) => setTimeout(r, MAC_SILENCE_MS + 1_500))
      return real(...args)
    })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'primary full text', via: 'primary' })
    expect(engine).not.toHaveBeenCalled()
  }, 15_000)
  it('without an engine of its own the companion still waits for the Mac', async () => {
    localEngine.available = false
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'primary full text', via: 'primary' })
    expect(engine).not.toHaveBeenCalled()
  })
  it('a Mac that leaves while transcribing hands the take back; its late answer stays on the Mac', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    let release!: () => void
    const late = new Promise<void>((resolve) => { release = resolve })
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation !== 'transcribe') return real(...args)
      setTimeout(() => { link.connected = false }, 300)
      await late
      return real(...args)
    })
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'companion text', via: 'local' })
    release()
    // One transcript per box, neither overwritten.
    await vi.waitFor(async () => { expect((await primary.get(record.id)).text).toBe('primary full text') })
    expect((await voiceArchive.get(record.id)).text).toBe('companion text')
  })
  it('a Mac that falls asleep while transcribing, bridge still up, hands the take back in seconds', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    let asleep = false
    bridge.mockImplementation(async (...args) => {
      if (asleep) return new Promise(() => {})
      if (args[2].params.operation !== 'transcribe') return real(...args)
      asleep = true
      return new Promise(() => {})
    })
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    const started = Date.now()
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'companion text', via: 'local' })
    expect(Date.now() - started).toBeLessThan(2 * MAC_SILENCE_MS + 4_000)
  }, 15_000)
  it('a Mac slow to answer one small call while transcribing keeps the take', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    let gets = 0
    bridge.mockImplementation(async (...args) => {
      const op = args[2].params.operation
      if (op === 'transcribe') await new Promise((r) => setTimeout(r, 7_000))
      // While it transcribes, its first small call goes unanswered.
      if (op === 'get' && ++gets === 2) return new Promise(() => {})
      return real(...args)
    })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'primary full text', via: 'primary' })
    expect(engine).not.toHaveBeenCalled()
  }, 15_000)
  it('a Mac busy transcribing a long take keeps it while it answers small calls', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'transcribe') await new Promise((r) => setTimeout(r, 6_000))
      return real(...args)
    })
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'primary full text', via: 'primary' })
    expect(engine).not.toHaveBeenCalled()
  }, 15_000)
  it('a Mac that answers wins and frees the pieces this box held', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    const header = Buffer.alloc(4096)
    appendLive(record.id, 0, header, async () => 'never', { eager: false })
    expect(hasLiveTake(record.id)).toBe(true)
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'primary full text' })
    expect(hasLiveTake(record.id)).toBe(false)
    expect(engine).not.toHaveBeenCalled()
  })
  it('keeps the Mac its own transcript when both boxes transcribed, and stops retrying', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    await primary.saveText(record.id, 'mac text', 'primary')
    link.connected = false
    engine.mockResolvedValue({ text: 'companion text', durationMs: 1 })
    expect((await transcribeVoiceRecording(record.id)).text).toBe('companion text')
    link.connected = true
    // The Mac refuses a second, different transcript (409): decided once, so
    // the copy counts as done instead of retrying on every bridge pulse.
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    expect((await primary.get(record.id)).text).toBe('mac text')
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(true)
  })
  it('answers with text the Mac had saved when a copy check brings it back', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    await primary.saveText(record.id, 'mac text', 'primary')
    expect(await transcribeVoiceRecording(record.id)).toMatchObject({ text: 'mac text' })
    expect(engine).not.toHaveBeenCalled()
  })
  it('a hosted-only companion still says the service is unavailable when nothing can transcribe', async () => {
    await updateConfig({ stt: { engine: 'openai' } })
    const saved = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
      link.connected = false
      await expect(transcribeVoiceRecording(record.id)).rejects.toMatchObject({ status: 503, code: 'stt_unavailable' })
      expect((await voiceArchive.readAudio(record.id)).audio.toString()).toBe('speech')
    } finally { if (saved !== undefined) process.env.OPENAI_API_KEY = saved }
  })
  it('never copies a transcript from a different recording', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    bridge.mockResolvedValue({ ok: true, result: { status: 200, body: { id: record.id, audioSha256: 'different', text: 'wrong text' } } })
    expect(await replicateVoiceRecording(record.id)).toBe(false)
    expect((await voiceArchive.get(record.id)).text).toBeUndefined()
  })
})
describe('follow-up passes after the Mac bridge connects', () => {
  // The module's own timers, recorded: each set's handle, delay and callback.
  const sets: Array<{ fn: () => void; ms: number; handle: object }> = []
  const clears: unknown[] = []
  const fired = new Set<unknown>()
  // Hops this test holds, each released with a refusal.
  const held: Array<() => void> = []
  let onHop: (() => void) | undefined
  let mode: 'real' | 'refuse' | 'hold' = 'real'
  const state = () => _followupStateForTest()
  const fire = (index: number) => { fired.add(sets[index].handle); sets[index].fn() }
  const connect = () => { for (const handler of [...connected]) handler() }
  const release = () => { for (const refuse of held.splice(0)) refuse() }
  const nextHop = () => new Promise<void>((resolve) => { onHop = resolve })
  const ops = () => bridge.mock.calls.map((call) => call[2].params.operation)
  beforeEach(() => {
    sets.length = 0; clears.length = 0; fired.clear(); held.length = 0; onHop = undefined; mode = 'real'
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation((...args) => {
      if (mode === 'refuse') return Promise.resolve({ ok: false })
      if (mode === 'hold') {
        return new Promise((resolve) => {
          held.push(() => resolve({ ok: false }))
          onHop?.(); onHop = undefined
        })
      }
      return real(...args)
    })
    _setFollowupClockForTest({
      set: (fn, ms) => { const handle = { ms }; sets.push({ fn, ms, handle }); return handle },
      clear: (handle) => { clears.push(handle) },
    })
  })
  afterEach(async () => {
    // Stop first: every pass and timer of this test's epochs is void from here.
    stopVoiceArchiveReplication()
    const setsAtStop = sets.length
    const roundsAtStop = state().rounds.length
    mode = 'refuse'
    release()
    const failures: unknown[] = []
    const late: unknown[] = []
    try {
      // Every pass this test caused, older epochs included, in order; the list may grow while waiting.
      for (let index = 0; index < state().rounds.length; index++) {
        const [start] = await Promise.allSettled([state().rounds[index].started])
        if (start.status === 'rejected') { failures.push(start.reason); continue }
        if (index >= roundsAtStop) late.push(start.value)
        if (!start.value) continue
        for (const result of await Promise.allSettled([start.value.P, start.value.C])) {
          if (result.status === 'rejected') failures.push(result.reason)
        }
      }
      expect(sets).toHaveLength(setsAtStop)
      expect(state().handle).toBeUndefined()
      expect(sets.filter((set) => !clears.includes(set.handle) && !fired.has(set.handle))).toEqual([])
      expect(late.every((value) => value === null)).toBe(true)
    } finally {
      _setFollowupClockForTest()
    }
    if (failures.length) throw failures[0]
  })

  it('R1: a connected pass the Mac refuses is followed 2 s after it ends, and that pass copies', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    await voiceArchive.saveText(record.id, 'companion text', 'local')
    mode = 'hold'
    const hop = nextHop()
    await startVoiceArchiveReplication()
    connect()
    expect(state().rounds.map((round) => round.n)).toEqual([-1, 0])
    const s0 = await state().rounds[1].started
    expect(s0).not.toBeNull()
    await hop
    expect(sets).toHaveLength(0)
    release()
    await s0!.P
    await s0!.C
    expect(sets.map((set) => set.ms)).toEqual([2_000])
    expect(state().handle).toBe(sets[0].handle)
    expect(clears).toHaveLength(0)
    mode = 'real'
    fire(0)
    expect(state().handle).toBeUndefined()
    expect(state().rounds).toHaveLength(3)
    const s1 = await state().rounds[2].started
    expect(s1).not.toBeNull()
    expect(s1).not.toBe(s0)
    await s1!.P
    await s1!.C
    expect(await voiceArchive.get(record.id)).toMatchObject({ primarySaved: true, text: 'companion text' })
    expect((await primary.get(record.id)).text).toBe('companion text')
    expect(sets).toHaveLength(1)
    expect(clears).toHaveLength(0)
  })
  it('R2: a Mac that keeps refusing gets the 5 s pass and then nothing more', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    mode = 'refuse'
    await startVoiceArchiveReplication()
    connect()
    const s0 = await state().rounds[1].started
    await s0!.P
    await s0!.C
    expect(sets.map((set) => set.ms)).toEqual([2_000])
    fire(0)
    const s1 = await state().rounds[2].started
    await s1!.P
    await s1!.C
    expect(sets.map((set) => set.ms)).toEqual([2_000, 5_000])
    expect(state().handle).toBe(sets[1].handle)
    fire(1)
    const s2 = await state().rounds[3].started
    expect(s2).not.toBeNull()
    await s2!.P
    await s2!.C
    expect(sets).toHaveLength(2)
    expect(state().handle).toBeUndefined()
    expect((await voiceArchive.get(record.id)).primarySaved).toBe(false)
  })
  it('R3: a connected pass that copies everything schedules nothing', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    await voiceArchive.saveText(record.id, 'companion text', 'local')
    await startVoiceArchiveReplication()
    connect()
    const s0 = await state().rounds[1].started
    await s0!.P
    await s0!.C
    expect(await voiceArchive.get(record.id)).toMatchObject({ primarySaved: true, text: 'companion text' })
    expect(sets).toHaveLength(0)
    expect(state().handle).toBeUndefined()
  })
  it('R4a: stop clears the exact pending timer, and its callback then does nothing', async () => {
    await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    mode = 'refuse'
    await startVoiceArchiveReplication()
    connect()
    const s0 = await state().rounds[1].started
    await s0!.P
    await s0!.C
    expect(sets).toHaveLength(1)
    stopVoiceArchiveReplication()
    expect(clears).toEqual([sets[0].handle])
    expect(state().handle).toBeUndefined()
    const calls = bridge.mock.calls.length
    const rounds = state().rounds.length
    fire(0)
    expect(state().rounds).toHaveLength(rounds)
    expect(bridge.mock.calls).toHaveLength(calls)
    expect(sets).toHaveLength(1)
    expect(state().handle).toBeUndefined()
  })
  it('R4b: a pass still running at stop schedules nothing when it ends', async () => {
    await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    mode = 'hold'
    const hop = nextHop()
    await startVoiceArchiveReplication()
    connect()
    const s0 = await state().rounds[1].started
    await hop
    stopVoiceArchiveReplication()
    release()
    await s0!.P
    await s0!.C
    expect(sets).toHaveLength(0)
    expect(state().handle).toBeUndefined()
  })
  it('R4c: a stop before the queued connected pass starts leaves it without a pass', async () => {
    await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    mode = 'refuse'
    await startVoiceArchiveReplication()
    connect()
    stopVoiceArchiveReplication()
    expect(await state().rounds[1].started).toBeNull()
    expect(await state().rounds[0].started).toBeNull()
    expect(state().rounds).toHaveLength(2)
    expect(bridge).not.toHaveBeenCalled()
    expect(sets).toHaveLength(0)
  })
  it('R5a: a timer that fires after the bridge went down runs no pass', async () => {
    await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    mode = 'refuse'
    await startVoiceArchiveReplication()
    connect()
    const s0 = await state().rounds[1].started
    await s0!.P
    await s0!.C
    expect(sets).toHaveLength(1)
    link.connected = false
    const calls = bridge.mock.calls.length
    fire(0)
    expect(state().handle).toBeUndefined()
    expect(state().rounds).toHaveLength(3)
    expect(await state().rounds[2].started).toBeNull()
    expect(bridge.mock.calls).toHaveLength(calls)
    expect(sets).toHaveLength(1)
  })
  it('R5b: after a reconnect the old epoch\'s timer leaves the new one in place', async () => {
    await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    mode = 'refuse'
    await startVoiceArchiveReplication()
    connect()
    const s0 = await state().rounds[1].started
    await s0!.P
    await s0!.C
    expect(sets).toHaveLength(1)
    const first = state().epoch
    connect()
    expect(state().epoch).toBe(first + 1)
    expect(clears).toEqual([sets[0].handle])
    const s1 = await state().rounds[2].started
    await s1!.P
    await s1!.C
    expect(sets.map((set) => set.ms)).toEqual([2_000, 2_000])
    expect(state().handle).toBe(sets[1].handle)
    const calls = bridge.mock.calls.length
    const rounds = state().rounds.length
    fire(0)
    expect(state().handle).toBe(sets[1].handle)
    expect(state().rounds).toHaveLength(rounds)
    expect(bridge.mock.calls).toHaveLength(calls)
    expect(sets).toHaveLength(2)
  })
  it('R6: two copies of one recording at once are still one copy', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    const a = replicateVoiceRecording(record.id)
    const b = replicateVoiceRecording(record.id)
    expect(b).toBe(a)
    expect(await a).toBe(true)
    expect(ops()).toEqual(['chunk', 'commit'])
    expect(sets).toHaveLength(0)
  })
})

describe('live pieces handed to the Mac while it answers', () => {
  it('the Mac transcribes while the take is recorded and answers the stop from its pieces, before the copy', async () => {
    const id = randomUUID()
    await recordLive(id, 40)
    // Every piece went on to the Mac, which transcribed while the take ran; this box held its own and ran nothing.
    await vi.waitFor(() => expect(macHeard.length).toBeGreaterThan(0))
    const during = macHeard.length
    expect(engine).not.toHaveBeenCalled()
    expect(hasLiveTake(id)).toBe(true)
    const answer = await transcribeVoiceRecording(id)
    expect(answer).toMatchObject({ via: 'primary', storage: 'companion' })
    expect(answer.text).toBe(macHeard.map((s) => `mac[${s.toFixed(1)}]`).join(' '))
    // Every second was heard once; before the stop the Mac had already done at least a piece.
    expect(macHeard.reduce((a, b) => a + b, 0)).toBeCloseTo(40, 1)
    expect(macHeard.slice(0, during).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(6)
    expect(engine).not.toHaveBeenCalled()
    // The rest of the file went first, then the finish; the Mac never transcribed a file.
    const seq = ops()
    expect(seq.lastIndexOf('live')).toBeLessThan(seq.indexOf('live-finish'))
    expect(seq).not.toContain('transcribe')
    expect(hasLiveTake(id)).toBe(false)
    expect(hasLiveForward(id)).toBe(false)
    expect(await macHas(id)).toBe(false)
    // The copy follows in the background and carries the text to the Mac.
    await vi.waitFor(async () => { expect((await primary.get(id)).text).toBe(answer.text) })
    // Both copies say how the text was made: the Mac's pieces, and the wait here.
    expect(answer.asr).toMatchObject({ engine: 'mlx', livePieces: expect.any(Number), leftSeconds: expect.any(Number), ms: expect.any(Number) })
    expect(answer.asr!.livePieces).toBeGreaterThanOrEqual(1)
    await vi.waitFor(async () => { expect((await primary.get(id)).asr).toEqual(answer.asr) })
  })

  it('a finished file with a chunk after its samples still lines up with what the Mac heard', async () => {
    const id = randomUUID()
    const info = Buffer.concat([Buffer.from('info'), Buffer.alloc(8), Buffer.alloc(40, 7)])
    info.writeBigInt64BE(40n, 4)
    await recordLive(id, 20, { trailer: info })
    expect((await transcribeVoiceRecording(id)).text).toMatch(/^mac\[/)
    expect(ops()).not.toContain('transcribe')
  })

  it('a Mac with no engine of its own for live pieces (accepted: false) gets the ordinary path', async () => {
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'live') return { ok: true, result: { status: 200, body: { accepted: false, receivedBytes: 0, segments: 0, reason: 'not-transcribed-here' } } }
      return real(...args)
    })
    const id = randomUUID()
    await recordLive(id, 20)
    await vi.waitFor(() => expect(hasLiveForward(id)).toBe(false))
    expect(await transcribeVoiceRecording(id)).toMatchObject({ text: 'primary full text' })
  })

  it('a take past the 5 min this box holds keeps going to the Mac, and the phone keeps sending', async () => {
    const id = randomUUID()
    // recordLive asserts every live answer says accepted, also past the companion's own bound.
    await recordLive(id, 320)
    expect(hasLiveTake(id)).toBe(false)
    expect(hasLiveForward(id)).toBe(true)
    expect((await transcribeVoiceRecording(id)).text).toMatch(/^mac\[/)
    expect(macHeard.reduce((a, b) => a + b, 0)).toBeCloseTo(320, 0)
  }, 60_000)

  it('the commit does not start the copy while the Mac has the take live; the transcribe does, after the answer', async () => {
    const id = randomUUID()
    const live = phoneCaf(20, false)
    for (let from = 0; from < live.length; from += 128 * 1024) {
      await runVoiceArchiveAction({ operation: 'live', id, body: { from, audio: live.subarray(from, from + 128 * 1024).toString('base64') } })
    }
    const final = phoneCaf(20, true)
    const createdAt = new Date().toISOString()
    let index = 0
    for (let at = 0; at < final.length; at += VOICE_CHUNK_BYTES) {
      expect(await runVoiceArchiveAction({ operation: 'chunk', id, body: { index: index++, audio: final.subarray(at, at + VOICE_CHUNK_BYTES).toString('base64'), format: 'caf', createdAt } })).toMatchObject({ status: 200 })
    }
    expect(await runVoiceArchiveAction({ operation: 'commit', id, body: { chunkCount: index, audioSizeBytes: final.length, audioSha256: createHash('sha256').update(final).digest('hex') } })).toMatchObject({ status: 200 })
    await new Promise((r) => setTimeout(r, 50))
    expect(ops()).not.toContain('chunk')
    expect((await transcribeVoiceRecording(id)).text).toMatch(/^mac\[/)
    const seq = ops()
    expect(seq.indexOf('live-finish')).toBeLessThan(seq.indexOf('chunk') === -1 ? Infinity : seq.indexOf('chunk'))
    await vi.waitFor(async () => { expect((await voiceArchive.get(id)).primarySaved).toBe(true) })
  })

  it('a cancel skips the hops still queued for the Mac and drops what it has', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'live') await gate
      return real(...args)
    })
    const id = randomUUID()
    const live = phoneCaf(20, false)
    for (let from = 0; from < 3 * 128 * 1024; from += 128 * 1024) {
      await runVoiceArchiveAction({ operation: 'live', id, body: { from, audio: live.subarray(from, from + 128 * 1024).toString('base64') } })
    }
    const res = await request(express().use(express.json()).use('/api/v1', voiceArchiveV1Router)).delete(`/api/v1/stt/recordings/${id}/live`)
    expect(res.status).toBe(200)
    release()
    await vi.waitFor(() => expect(ops()).toContain('live-drop'))
    await new Promise((r) => setTimeout(r, 50))
    // Only the hop already on its way went out.
    expect(ops().filter((op) => op === 'live')).toHaveLength(1)
    expect(await macHas(id)).toBe(false)
  })

  it('a Mac that does not take live pieces (an older Walnut) gets the ordinary path', async () => {
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'live') return { ok: true, result: { status: 400, body: { error: { code: 'bad_request', message: 'Unknown voice archive operation' } } } }
      return real(...args)
    })
    const id = randomUUID()
    await recordLive(id, 20)
    // One refusal ends the hand-over for the take: no hop per piece after it.
    await vi.waitFor(() => expect(hasLiveForward(id)).toBe(false))
    expect(ops().filter((op) => op === 'live')).toHaveLength(1)
    expect(await transcribeVoiceRecording(id)).toMatchObject({ text: 'primary full text' })
    expect(ops()).not.toContain('live-finish')
  })

  it('a finish the Mac refuses (its samples differ) goes the ordinary way', async () => {
    const id = randomUUID()
    await recordLive(id, 20)
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'live-finish') return { ok: true, result: { status: 409, body: { error: { code: 'live_unusable' } } } }
      return real(...args)
    })
    expect(await transcribeVoiceRecording(id)).toMatchObject({ text: 'primary full text' })
    expect(ops()).toContain('live-finish')
    expect(ops()).toContain('transcribe')
  })

  it('a Mac that goes quiet at the stop hands the take back to this box, which does it from what it held', async () => {
    engine.mockResolvedValue({ text: 'companion piece', durationMs: 1 })
    const id = randomUUID()
    await recordLive(id, 20)
    await vi.waitFor(async () => expect(await macHas(id)).toBe(true))
    // Asleep behind a live bridge: nothing answers from here on.
    bridge.mockImplementation(() => new Promise(() => {}))
    const started = Date.now()
    const answer = await transcribeVoiceRecording(id)
    expect(answer.via).toBe('local')
    expect(answer.text).toContain('companion piece')
    // Two unanswered checks, not a 30 s finish timeout.
    expect(Date.now() - started).toBeLessThan(15_000)
  }, 30_000)


  it('a hand-over that gives up at the stop leaves the Mac its pieces for the file it is sent next', async () => {
    const id = randomUUID()
    await recordLive(id, 20)
    await vi.waitFor(async () => expect(await macHas(id)).toBe(true))
    // The last piece the phone sent is still on its way past the drain wait.
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'live') await new Promise((r) => setTimeout(r, 6_000))
      return real(...args)
    })
    const live = phoneCaf(20, false)
    const last = Math.floor((live.length - 50_000) / (128 * 1024)) * 128 * 1024
    await runVoiceArchiveAction({ operation: 'live', id, body: { from: last, audio: live.subarray(last, live.length - 50_000).toString('base64') } })
    expect(await transcribeVoiceRecording(id)).toMatchObject({ text: 'primary full text' })
    expect(ops()).not.toContain('live-drop')
    expect(ops()).not.toContain('live-finish')
    expect(await macHas(id)).toBe(true)
  }, 30_000)

  it('a retry pass does not copy a take while its transcribe hands it over', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const real = bridge.getMockImplementation()!
    bridge.mockImplementation(async (...args) => {
      if (args[2].params.operation === 'live-finish') await gate
      return real(...args)
    })
    await startVoiceArchiveReplication()
    const id = randomUUID()
    await recordLive(id, 20)
    const answer = transcribeVoiceRecording(id)
    await vi.waitFor(() => expect(ops()).toContain('live-finish'))
    for (const handler of activity) handler()
    await new Promise((r) => setTimeout(r, 100))
    expect(ops()).not.toContain('chunk')
    release()
    expect((await answer).text).toMatch(/^mac\[/)
    await vi.waitFor(async () => { expect((await voiceArchive.get(id)).primarySaved).toBe(true) })
    stopVoiceArchiveReplication()
  })
})
