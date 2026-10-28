/**
 * Voice recordings are kept within stt.keep_recordings: oldest first, across the
 * phone archive and web dictation, never a take still in flight or one the Mac
 * has not received from the companion yet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const paths = vi.hoisted(() => ({ home: '' }))
vi.mock('../../src/constants.js', () => ({
  get TMP_DIR() { return join(paths.home, 'tmp') },
  get WALNUT_HOME() { return paths.home },
  CLOUD_MODE: false,
}))

import { VoiceArchiveStore, voiceAsr } from '../../src/core/stt/voice-archive.js'
import { keepLimits, pruneVoiceRecordings, DEFAULT_KEEP_COUNT, DEFAULT_KEEP_MB } from '../../src/core/stt/voice-retention.js'

const HOUR = 60 * 60_000
let home: string
beforeEach(async () => { home = paths.home = await mkdtemp(join(tmpdir(), 'voice-retention-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function take(store: VoiceArchiveStore, createdAt: string, bytes = 1000, text: string | null = 'hello'): Promise<string> {
  const audio = Buffer.alloc(bytes, 7)
  const record = await store.ingestAudio({ audio, format: 'caf', createdAt })
  if (text) await store.saveText(record.id, text, 'primary')
  return record.id
}
const ids = async (store: VoiceArchiveStore) => (await store.all()).map((r) => r.id)

describe('keepLimits', () => {
  it('fills defaults and refuses nonsense', () => {
    expect(keepLimits(undefined)).toEqual({ maxCount: DEFAULT_KEEP_COUNT, maxBytes: DEFAULT_KEEP_MB * 1024 * 1024 })
    expect(keepLimits({ keep_recordings: { max_count: 20, max_mb: 0.5 } })).toEqual({ maxCount: 20, maxBytes: 512 * 1024 })
    expect(keepLimits({ keep_recordings: { max_count: -1, max_mb: 'big' } })).toEqual(keepLimits(undefined))
  })
})

describe('pruneVoiceRecordings', () => {
  it('removes the oldest takes past the count, and keeps the newest', async () => {
    const store = new VoiceArchiveStore(home, false)
    const made: string[] = []
    for (let i = 0; i < 5; i++) made.push(await take(store, `2026-10-0${i + 1}T00:00:00.000Z`))
    const later = Date.now() + 2 * HOUR
    const result = await pruneVoiceRecordings({ maxCount: 3, maxBytes: 1 << 30 }, later, store)
    expect(result.removed).toBe(2)
    expect(new Set(await ids(store))).toEqual(new Set(made.slice(2)))
    // Nothing half-removed is left behind.
    expect((await readdir(store.root)).filter((n) => n.startsWith('.discard-'))).toEqual([])
  })

  it('removes by size too, counting both stores together, oldest first', async () => {
    const store = new VoiceArchiveStore(home, false)
    const old = await take(store, '2026-10-01T00:00:00.000Z', 40_000)
    const fresh = await take(store, '2026-10-03T00:00:00.000Z', 40_000)
    // A web dictation between them in time.
    const web = join(home, 'tmp', 'stt-recordings')
    await mkdir(web, { recursive: true })
    await writeFile(join(web, '2026-10-02T00-00-00-000Z.webm'), Buffer.alloc(40_000))
    await writeFile(join(web, '2026-10-02T00-00-00-000Z.json'), '{}')
    const later = Date.now() + 2 * HOUR
    // Each take is about 80 KB on disk (chunks plus the joined file).
    const result = await pruneVoiceRecordings({ maxCount: 100, maxBytes: 100_000 }, later, store)
    expect(result.removed).toBe(2)
    expect(await ids(store)).toEqual([fresh])
    expect(await readdir(web)).toEqual([])
    expect(old).not.toBe(fresh)
  })

  it('never removes a take in flight, nor one the Mac has not received from the companion', async () => {
    const companion = new VoiceArchiveStore(home, true)
    const notCopied = await take(companion, '2026-10-01T00:00:00.000Z')
    const copied = await take(companion, '2026-10-02T00:00:00.000Z')
    await companion.markPrimarySaved(copied, 'hello')
    const uploading = randomUUID()
    await companion.saveChunk(uploading, { index: 0, audio: Buffer.from('x').toString('base64'), format: 'caf', createdAt: '2026-09-01T00:00:00.000Z' })
    // Just recorded: too young to go, however old its stamp.
    const result = await pruneVoiceRecordings({ maxCount: 1, maxBytes: 1 << 30 }, Date.now(), companion)
    expect(result.removed).toBe(0)
    const later = Date.now() + 2 * HOUR
    expect((await pruneVoiceRecordings({ maxCount: 1, maxBytes: 1 << 30 }, later, companion)).removed).toBe(1)
    expect(new Set(await ids(companion))).toEqual(new Set([notCopied, uploading]))
    // An upload nobody finished for a day is abandoned and may go.
    const dayLater = Date.now() + 25 * HOUR
    expect((await pruneVoiceRecordings({ maxCount: 1, maxBytes: 1 << 30 }, dayLater, companion)).removed).toBe(1)
    expect(await ids(companion)).toEqual([notCopied])
  })
})

describe('a removed take', () => {
  it('leaves a mark, so a copy or a late chunk of it is refused rather than brought back', async () => {
    const store = new VoiceArchiveStore(home, false)
    const old = await take(store, '2026-10-01T00:00:00.000Z')
    await take(store, '2026-10-02T00:00:00.000Z')
    expect((await pruneVoiceRecordings({ maxCount: 1, maxBytes: 1 << 30 }, Date.now() + 2 * HOUR, store)).removed).toBe(1)
    await expect(store.get(old)).rejects.toMatchObject({ status: 410 })
    await expect(store.saveChunk(old, { index: 0, audio: Buffer.from('x').toString('base64'), format: 'caf', createdAt: '2026-10-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 410 })
    // A take never seen is still a plain 404.
    await expect(store.get(randomUUID())).rejects.toMatchObject({ status: 404 })
  })

  it('is judged again under its own lock: a take written to since it was chosen stays', async () => {
    const store = new VoiceArchiveStore(home, false)
    const id = await take(store, '2026-10-01T00:00:00.000Z')
    // Chosen as quiet, but written to just now: the second look keeps it.
    expect(await store.discard(id, (_record, modifiedMs) => Date.now() - modifiedMs > HOUR)).toBe(false)
    expect((await store.get(id)).text).toBe('hello')
    expect(await store.discard(id)).toBe(true)
    await expect(store.get(id)).rejects.toMatchObject({ status: 410 })
  })

  it('keeps a take with no text for a week, then lets it go', async () => {
    const store = new VoiceArchiveStore(home, false)
    const untranscribed = await take(store, '2026-10-01T00:00:00.000Z', 1000, null)
    const transcribed = await take(store, '2026-10-02T00:00:00.000Z')
    await take(store, '2026-10-03T00:00:00.000Z')
    expect((await pruneVoiceRecordings({ maxCount: 2, maxBytes: 1 << 30 }, Date.now() + 2 * HOUR, store)).removed).toBe(1)
    expect(new Set(await ids(store)).has(untranscribed)).toBe(true)
    expect(new Set(await ids(store)).has(transcribed)).toBe(false)
    expect((await pruneVoiceRecordings({ maxCount: 1, maxBytes: 1 << 30 }, Date.now() + 8 * 24 * HOUR, store)).removed).toBe(1)
    expect(new Set(await ids(store)).has(untranscribed)).toBe(false)
  })
})

describe('the engine detail kept with a take', () => {
  it('keeps only valid fields, and a later copy of the same text may add it', async () => {
    expect(voiceAsr({ engine: 'mlx', model: 'm', language: 'zh', ms: 812.345, livePieces: 2, leftSeconds: 4.27, junk: 1 }))
      .toEqual({ engine: 'mlx', model: 'm', language: 'zh', ms: 812.3, livePieces: 2, leftSeconds: 4.3 })
    expect(voiceAsr({ engine: 5, ms: -1 })).toBeUndefined()
    expect(voiceAsr('x')).toBeUndefined()
    const store = new VoiceArchiveStore(home, false)
    const audio = Buffer.from('audio')
    const record = await store.ingestAudio({ audio, format: 'caf', createdAt: '2026-10-01T00:00:00.000Z' })
    await store.saveText(record.id, 'hi', 'primary')
    expect((await store.get(record.id)).asr).toBeUndefined()
    await store.saveText(record.id, 'hi', 'primary', { engine: 'mlx', model: 'Qwen3-ASR', ms: 500 })
    expect((await store.get(record.id)).asr).toEqual({ engine: 'mlx', model: 'Qwen3-ASR', ms: 500 })
    // A second detail never replaces the first.
    await store.saveText(record.id, 'hi', 'primary', { engine: 'other' })
    expect((await store.get(record.id)).asr?.engine).toBe('mlx')
  })
})
