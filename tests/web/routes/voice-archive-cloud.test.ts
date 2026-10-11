import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('voice-archive-cloud', { CLOUD_MODE: true }))
const bridge = vi.hoisted(() => vi.fn())
const activity = vi.hoisted(() => new Set<() => void>())
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeRequest: bridge, bridgeForHost: () => ({ connected: true }),
  addPrimaryBridgeConnectedHandler: () => () => {},
  addPrimaryBridgeActivityHandler: (handler: () => void) => {
    activity.add(handler)
    return () => activity.delete(handler)
  },
}))
const engine = vi.hoisted(() => vi.fn())
vi.mock('../../../src/core/stt/index.js', () => ({ transcribeAudio: engine }))
import { voiceArchive, VoiceArchiveStore, VOICE_CHUNK_BYTES } from '../../../src/core/stt/voice-archive.js'
import { replicateVoiceRecording, startVoiceArchiveReplication, stopVoiceArchiveReplication } from '../../../src/core/stt/voice-archive-replication.js'
import { transcribeVoiceRecording } from '../../../src/core/stt/voice-archive-transcribe.js'
let primaryHome: string
let primary: VoiceArchiveStore
beforeEach(async () => {
  stopVoiceArchiveReplication()
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
  it('never copies a transcript from a different recording', async () => {
    const record = await voiceArchive.ingestAudio({ audio: Buffer.from('speech'), format: 'm4a' })
    expect(await replicateVoiceRecording(record.id)).toBe(true)
    bridge.mockResolvedValue({ ok: true, result: { status: 200, body: { id: record.id, audioSha256: 'different', text: 'wrong text' } } })
    expect(await replicateVoiceRecording(record.id)).toBe(false)
    expect((await voiceArchive.get(record.id)).text).toBeUndefined()
  })
})
