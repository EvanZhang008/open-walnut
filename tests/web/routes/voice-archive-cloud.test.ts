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
import { appendLive, hasLiveTake } from '../../../src/core/stt/live-transcript.js'
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
  bridge.mockImplementation(async (_host, _command, params) => {
    const { operation, id, body } = params.params
    let answer
    if (operation === 'get') answer = await primary.get(id)
    else if (operation === 'chunk') answer = await primary.saveChunk(id, body)
    else if (operation === 'commit') answer = await primary.commit(id, body)
    else if (operation === 'text') answer = await primary.saveText(id, body.text, body.via)
    else if (operation === 'transcribe') {
      const saved = await primary.saveText(id, 'primary full text', 'primary')
      answer = { text: saved.text, via: saved.via, recordingId: id, primarySaved: true }
    }
    return { ok: true, result: { status: 200, body: answer } }
  })
})
afterAll(async () => { if (primaryHome) await rm(primaryHome, { recursive: true, force: true }) })
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
