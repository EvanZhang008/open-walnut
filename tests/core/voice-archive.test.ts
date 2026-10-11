import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createMockConstants } from '../helpers/mock-constants.js'
vi.mock('../../src/constants.js', () => createMockConstants('voice-archive-store'))
import { VoiceArchiveStore, VOICE_MAX_CHUNK_BYTES } from '../../src/core/stt/voice-archive.js'

const createdAt = '2026-10-11T01:02:03.000Z'
const sha = (audio: Buffer) => createHash('sha256').update(audio).digest('hex')
let home: string
let store: VoiceArchiveStore
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'voice-archive-store-')); store = new VoiceArchiveStore(home, false) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })
const chunk = (audio = Buffer.from('audio'), index = 0) => ({ index, audio: audio.toString('base64'), format: 'caf', createdAt, surface: 'ios', durationSeconds: 420 })

describe('durable voice archive', () => {
  it('preserves 13.44MB PCM and a long Unicode transcript after reopening the store', async () => {
    const audio = Buffer.alloc(13_440_068, 0x32)
    const record = await store.ingestAudio({ audio, format: 'caf', createdAt, durationSeconds: 420 })
    const text = String.fromCodePoint(0x4f60, 0x597d).concat(' voice ').repeat(20_000).trim()
    await store.saveText(record.id, text, 'primary')
    const reopened = new VoiceArchiveStore(home, false)
    expect(await reopened.get(record.id)).toMatchObject({ state: 'transcribed', text, audioSha256: sha(audio), audioSizeBytes: audio.length, primarySaved: true, storage: 'primary' })
    expect((await reopened.readAudio(record.id)).audio.equals(audio)).toBe(true)
    const metadata = join(store.root, record.id, 'metadata.json')
    expect((await stat(metadata)).mode & 0o777).toBe(0o600)
    expect(store.root).toBe(join(home, 'voice-archive'))
  })
  it('accepts out-of-order chunks and duplicate concurrent writers without overwriting', async () => {
    const id = randomUUID()
    await store.saveChunk(id.toUpperCase(), chunk(Buffer.from('tail'), 1))
    const answers = await Promise.all([store.saveChunk(id, chunk(Buffer.from('head'))), store.saveChunk(id, chunk(Buffer.from('head')))])
    expect(answers.every((record) => record.id === id)).toBe(true)
    await expect(store.saveChunk(id, chunk(Buffer.from('other')))).rejects.toMatchObject({ status: 409 })
    const audio = Buffer.from('headtail')
    const commit = { chunkCount: 2, audioSizeBytes: audio.length, audioSha256: sha(audio).toUpperCase(), text: 'original' }
    expect(await store.commit(id, commit)).toMatchObject({ audioSha256: sha(audio), text: 'original', state: 'transcribed' })
    expect(await store.commit(id, commit)).toMatchObject({ text: 'original' })
    await expect(store.commit(id, { ...commit, text: 'different' })).rejects.toMatchObject({ status: 409 })
    await expect(store.saveText(id, 'different')).rejects.toMatchObject({ status: 409 })
    await expect(store.saveChunk(id, chunk(Buffer.from('head'), 2))).rejects.toMatchObject({ status: 409 })
    expect((await store.readAudio(id)).audio.toString()).toBe('headtail')
  })
  it('refuses malformed ids, base64 and oversize chunks without accepting data', async () => {
    await expect(store.saveChunk('../escape', chunk())).rejects.toMatchObject({ status: 400 })
    for (const audio of ['@bad', 'aA', 'a===', 'YR==']) await expect(store.saveChunk(randomUUID(), { ...chunk(), audio })).rejects.toMatchObject({ status: 400 })
    await expect(store.saveChunk(randomUUID(), chunk(Buffer.alloc(VOICE_MAX_CHUNK_BYTES + 1)))).rejects.toMatchObject({ status: 413 })
    await expect(store.saveChunk(randomUUID(), { ...chunk(), durationSeconds: NaN })).rejects.toMatchObject({ status: 400 })
    expect(await store.list()).toEqual({ recordings: [] })
  })
  it('keeps uploading audio after bad hash, bad size and missing chunks, then repairs on retry', async () => {
    const id = randomUUID(), audio = Buffer.from('recoverable')
    await store.saveChunk(id, chunk(audio))
    const commit = { chunkCount: 1, audioSizeBytes: audio.length, audioSha256: sha(audio) }
    await expect(store.commit(id, { ...commit, chunkCount: 2 })).rejects.toMatchObject({ status: 400 })
    await expect(store.commit(id, { ...commit, audioSizeBytes: 1 })).rejects.toMatchObject({ status: 400 })
    await expect(store.commit(id, { ...commit, audioSha256: '0'.repeat(64) })).rejects.toMatchObject({ status: 400 })
    expect(await store.get(id)).toMatchObject({ state: 'uploading' })
    await expect(store.saveText(id, 'too soon')).rejects.toMatchObject({ status: 409 })
    await expect(store.readAudio(id)).rejects.toMatchObject({ status: 409 })
    await store.commit(id, commit)
    expect((await store.readAudio(id)).audio.equals(audio)).toBe(true)
  })
  it('paginates equal timestamps without dropping records and returns metadata only', async () => {
    for (let count = 0; count < 3; count++) await store.ingestAudio({ audio: Buffer.from('x'), format: 'caf', createdAt })
    const first = await store.list(undefined, 2)
    expect(first.recordings).toHaveLength(2)
    const second = await store.list(first.nextBefore, 2)
    expect(second.recordings).toHaveLength(1)
    expect(new Set([...first.recordings, ...second.recordings].map((record) => record.id)).size).toBe(3)
    expect(second.nextBefore).toBeUndefined()
    expect(first.recordings[0]).not.toHaveProperty('audio')
  })
  it('does not acknowledge a failed storage write or silently discard unreadable metadata', async () => {
    const broken = join(home, 'not-a-directory')
    await writeFile(broken, 'file')
    await expect(new VoiceArchiveStore(broken).ingestAudio({ audio: Buffer.from('x'), format: 'caf' })).rejects.toBeDefined()
    const record = await store.ingestAudio({ audio: Buffer.from('x'), format: 'caf' })
    await writeFile(join(store.root, record.id, 'metadata.json'), '{')
    await expect(store.list()).rejects.toBeDefined()
    expect(await readFile(join(store.root, record.id, 'audio'), 'utf8')).toBe('x')
  })
  it('keeps empty transcription retryable and normalizes surrounding whitespace once', async () => {
    const record = await store.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    expect((await store.saveText(record.id, '  ')).text).toBeUndefined()
    expect((await store.saveText(record.id, ' words ')).text).toBe('words')
    expect((await store.saveText(record.id, 'words')).text).toBe('words')
  })
  it('persists copy progress so a retry can start at the first unacknowledged chunk', async () => {
    const record = await store.ingestAudio({ audio: Buffer.from('speech'), format: 'caf' })
    await store.markPrimaryChunk(record.id, 1)
    expect((await new VoiceArchiveStore(home).replicationSnapshot(record.id)).nextPrimaryChunk).toBe(1)
    await store.resetPrimaryChunks(record.id)
    expect((await store.replicationSnapshot(record.id)).nextPrimaryChunk).toBe(0)
  })
  it('does not mark a concurrent new transcript as replicated by an audio-only acknowledgement', async () => {
    store = new VoiceArchiveStore(home, true)
    const record = await store.ingestAudio({ audio: Buffer.from('x'), format: 'caf' })
    expect(record.primarySaved).toBe(false)
    await store.saveText(record.id, 'new text', 'local')
    expect((await store.markPrimarySaved(record.id, undefined)).primarySaved).toBe(false)
    expect((await store.markPrimarySaved(record.id, 'new text')).primarySaved).toBe(true)
  })
})
