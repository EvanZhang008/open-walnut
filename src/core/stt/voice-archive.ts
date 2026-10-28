import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { isCompanion } from '../server-role.js'
import { withFileLock } from '../../utils/file-lock.js'

export const VOICE_CHUNK_BYTES = 256 * 1024
export const VOICE_MAX_CHUNK_BYTES = 512 * 1024
export const VOICE_MAX_AUDIO_BYTES = Number.MAX_SAFE_INTEGER
const MAX_CHUNKS = Number.MAX_SAFE_INTEGER
const FORMATS = new Set(['webm', 'wav', 'mp3', 'ogg', 'mp4', 'm4a', 'flac', 'caf'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface VoiceRecord {
  id: string
  createdAt: string
  format: string
  durationSeconds?: number
  surface?: string
  audioSizeBytes: number
  audioSha256: string
  text?: string
  via?: string
  state: 'uploading' | 'saved' | 'transcribed'
  primarySaved?: boolean
  storage: 'companion' | 'primary'
  /** How the text was made, kept for accuracy work (voiceAsr). */
  asr?: VoiceAsr
}
/** The engine behind a take's text: which model, which language was asked, how long it took. */
export interface VoiceAsr {
  engine?: string
  model?: string
  /** The language asked for; absent = detected by the model. */
  language?: string
  /** Time from asking for the text to having it, on the server the phone asked (the companion's whole wait when the Mac made it). */
  ms?: number
  /** Pieces transcribed while the take was recorded, and the seconds left at the stop. */
  livePieces?: number
  leftSeconds?: number
}
/** A valid `asr` from a request body, or undefined: an older or odd sender only loses the detail. */
export function voiceAsr(raw: unknown): VoiceAsr | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: VoiceAsr = {}
  for (const key of ['engine', 'model', 'language'] as const) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'string' && value && value.length <= 200) out[key] = value
  }
  for (const key of ['ms', 'livePieces', 'leftSeconds'] as const) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.round(value * 10) / 10
  }
  return Object.keys(out).length ? out : undefined
}
export interface VoiceChunkBody {
  index: number; audio: string; format: string; createdAt: string
  surface?: string; durationSeconds?: number
}
export interface VoiceCommitBody {
  chunkCount: number; audioSizeBytes: number; audioSha256: string; text?: string
}
interface Stored { record: VoiceRecord; chunkCount?: number; nextPrimaryChunk?: number }
export class VoiceArchiveError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
const bad = (message: string): never => { throw new VoiceArchiveError(400, 'bad_request', message) }
const conflict = (): never => { throw new VoiceArchiveError(409, 'conflict', 'Recording content conflicts with the saved copy') }
const hash = (audio: Buffer): string => createHash('sha256').update(audio).digest('hex')
const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT'
export function voiceRecordingId(id: unknown): string {
  if (typeof id !== 'string' || !UUID.test(id)) return bad('A UUID recording id is required')
  return id.toLowerCase()
}
export function decodeVoiceAudio(audio: unknown): Buffer {
  if (typeof audio !== 'string' || !audio || audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio)) return bad('audio must be canonical base64')
  const bytes = Buffer.from(audio, 'base64')
  if (bytes.toString('base64') !== audio) return bad('audio must be canonical base64')
  return bytes
}
function textValue(text: unknown): string {
  if (typeof text !== 'string') return bad('text must be a string')
  if (Buffer.byteLength(text) > 1024 * 1024) throw new VoiceArchiveError(413, 'too_large', 'Transcript exceeds 1MB')
  return text.trim()
}
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function durableWrite(file: string, bytes: Buffer | string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.pending`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, file)
    await syncDir(join(file, '..'))
  } finally { await unlink(temporary).catch((err) => { if (!missing(err)) throw err }) }
}

/** Audio and metadata are private, durable files, never disposable tmp data. */
export class VoiceArchiveStore {
  readonly root: string
  private readonly locks = new Map<string, Promise<unknown>>()
  constructor(home: string = WALNUT_HOME, readonly cloud = isCompanion()) { this.root = join(home, 'voice-archive') }
  private dir(id: string): string { return join(this.root, voiceRecordingId(id)) }
  private async prepare(id: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await syncDir(join(this.root, '..'))
    await mkdir(this.dir(id), { mode: 0o700 }).catch((err) => { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err })
    await syncDir(this.root)
  }
  private async locked<T>(raw: string, fn: (id: string) => Promise<T>): Promise<T> {
    const id = voiceRecordingId(raw)
    const previous = this.locks.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      await this.prepare(id)
      return withFileLock(join(this.dir(id), 'metadata.json'), () => fn(id))
    })
    this.locks.set(id, current)
    try { return await current } finally { if (this.locks.get(id) === current) this.locks.delete(id) }
  }
  private async stored(id: string): Promise<Stored | null> {
    try { return JSON.parse(await readFile(join(this.dir(id), 'metadata.json'), 'utf8')) as Stored }
    catch (err) { if (missing(err)) return null; throw err }
  }
  private async required(id: string): Promise<Stored> {
    const stored = await this.stored(id)
    if (!stored) {
      if (await this.removed(id)) throw new VoiceArchiveError(410, 'removed', 'Recording was removed to keep the stored recordings within their limit')
      throw new VoiceArchiveError(404, 'not_found', 'Recording not found')
    }
    return stored
  }
  /** Taken out by retention (voice-retention.ts): a mark that outlives the take, so a copy never brings it back. */
  private removedMark(id: string): string { return join(this.root, '.removed', voiceRecordingId(id)) }
  private async removed(id: string): Promise<boolean> {
    try { await stat(this.removedMark(id)); return true } catch (err) { if (missing(err)) return false; throw err }
  }
  private async save(id: string, stored: Stored): Promise<VoiceRecord> {
    await durableWrite(join(this.dir(id), 'metadata.json'), JSON.stringify(stored))
    return { ...stored.record }
  }
  async get(id: string): Promise<VoiceRecord> { return { ...(await this.required(voiceRecordingId(id))).record } }

  async saveChunk(raw: string, body: VoiceChunkBody): Promise<VoiceRecord> {
    if (!body || !Number.isSafeInteger(body.index) || body.index < 0 || body.index >= MAX_CHUNKS) return bad('index is out of range')
    if (!FORMATS.has(body.format)) return bad('Unsupported recording format')
    if (typeof body.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(body.createdAt) || !Number.isFinite(Date.parse(body.createdAt))) return bad('createdAt must be an ISO date')
    if (body.surface !== undefined && (typeof body.surface !== 'string' || body.surface.length > 100)) return bad('surface must be at most 100 characters')
    if (body.durationSeconds !== undefined && (typeof body.durationSeconds !== 'number' || !Number.isFinite(body.durationSeconds) || body.durationSeconds < 0)) return bad('durationSeconds must be nonnegative')
    if (typeof body.audio === 'string' && body.audio.length > Math.ceil(VOICE_MAX_CHUNK_BYTES / 3) * 4) throw new VoiceArchiveError(413, 'too_large', 'Chunk exceeds 512KiB')
    const bytes = decodeVoiceAudio(body.audio)
    if (bytes.length > VOICE_MAX_CHUNK_BYTES) throw new VoiceArchiveError(413, 'too_large', 'Chunk exceeds 512KiB')
    return this.locked(raw, async (id) => {
      const existing = await this.stored(id)
      const identity = { format: body.format, createdAt: new Date(body.createdAt).toISOString(), surface: body.surface, durationSeconds: body.durationSeconds }
      if (existing && Object.entries(identity).some(([key, value]) => existing.record[key as keyof VoiceRecord] !== value)) return conflict()
      const chunkFile = join(this.dir(id), `chunk-${body.index}`)
      let duplicate = false
      try { if (!(await readFile(chunkFile)).equals(bytes)) return conflict(); duplicate = true }
      catch (err) { if (!missing(err)) throw err }
      if (existing && existing.record.state !== 'uploading') {
        if (!duplicate) return conflict()
        return { ...existing.record }
      }
      if (!existing && await this.removed(id)) throw new VoiceArchiveError(410, 'removed', 'Recording was removed to keep the stored recordings within their limit')
      if (!existing) await this.save(id, { record: { id, ...identity, state: 'uploading', audioSizeBytes: 0, audioSha256: '', storage: this.cloud ? 'companion' : 'primary' } })
      let total = 0
      for (const file of await readdir(this.dir(id))) {
        if (/^chunk-\d+$/.test(file)) total += (await stat(join(this.dir(id), file))).size
      }
      if (!duplicate) total += bytes.length
      if (total > VOICE_MAX_AUDIO_BYTES) throw new VoiceArchiveError(413, 'too_large', 'Recording size exceeds the supported integer range')
      if (!duplicate) await durableWrite(chunkFile, bytes)
      // A retry repairs a crash between the durable chunk and its metadata.
      return this.save(id, { record: { ...existing?.record, id, ...identity, state: 'uploading', audioSizeBytes: total, audioSha256: '', storage: this.cloud ? 'companion' : 'primary' } })
    })
  }

  async commit(raw: string, body: VoiceCommitBody): Promise<VoiceRecord> {
    if (!body || !Number.isSafeInteger(body.chunkCount) || body.chunkCount < 1 || body.chunkCount > MAX_CHUNKS) return bad('chunkCount is out of range')
    if (!Number.isSafeInteger(body.audioSizeBytes) || body.audioSizeBytes < 1) return bad('audioSizeBytes must be positive')
    if (body.audioSizeBytes > VOICE_MAX_AUDIO_BYTES) throw new VoiceArchiveError(413, 'too_large', 'Recording size exceeds the supported integer range')
    if (typeof body.audioSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.audioSha256)) return bad('audioSha256 must be a SHA-256 hex digest')
    if (body.text !== undefined) body = { ...body, text: textValue(body.text) || undefined }
    return this.locked(raw, async (id) => {
      const stored = await this.required(id)
      const digest = body.audioSha256.toLowerCase()
      if (stored.record.text !== undefined && body.text !== undefined && stored.record.text !== body.text) return conflict()
      if (stored.record.state !== 'uploading') {
        if (stored.chunkCount !== body.chunkCount || stored.record.audioSizeBytes !== body.audioSizeBytes || stored.record.audioSha256 !== digest) return conflict()
      } else {
        const chunks = (await readdir(this.dir(id))).filter((file) => /^chunk-\d+$/.test(file))
        if (chunks.length !== body.chunkCount) return bad('The recording has missing or extra chunks')
        const temporary = join(this.dir(id), `audio.${randomUUID()}.pending`)
        const output = await open(temporary, 'wx', 0o600)
        const checksum = createHash('sha256')
        let total = 0
        try {
          for (let index = 0; index < body.chunkCount; index++) {
            let bytes: Buffer
            try { bytes = await readFile(join(this.dir(id), `chunk-${index}`)) }
            catch (err) { if (missing(err)) return bad('The recording has missing chunks'); throw err }
            total += bytes.length
            if (total > VOICE_MAX_AUDIO_BYTES) throw new VoiceArchiveError(413, 'too_large', 'Recording size exceeds the supported integer range')
            checksum.update(bytes)
            await output.writeFile(bytes)
          }
          if (total !== body.audioSizeBytes || checksum.digest('hex') !== digest) return bad('Audio size or SHA-256 does not match')
          await output.sync()
        } catch (err) {
          await output.close()
          await unlink(temporary)
          throw err
        }
        await output.close()
        await rename(temporary, join(this.dir(id), 'audio'))
        await syncDir(this.dir(id))
        stored.record = { ...stored.record, state: 'saved', audioSizeBytes: total, audioSha256: digest, primarySaved: !this.cloud }
        stored.chunkCount = body.chunkCount
      }
      if (body.text !== undefined) {
        if (stored.record.text === undefined && this.cloud) stored.record.primarySaved = false
        stored.record.text = body.text
        stored.record.state = 'transcribed'
      }
      return this.save(id, stored)
    })
  }

  async saveText(raw: string, text: string, via?: string, asr?: VoiceAsr): Promise<VoiceRecord> {
    text = textValue(text)
    if (!text) return this.get(raw)
    if (via !== undefined && (typeof via !== 'string' || via.length > 100)) return bad('via must be at most 100 characters')
    asr = voiceAsr(asr)
    return this.locked(raw, async (id) => {
      const stored = await this.required(id)
      if (stored.record.state === 'uploading') throw new VoiceArchiveError(409, 'not_committed', 'Commit audio before saving a transcript')
      if (stored.record.text !== undefined && stored.record.text !== text) return conflict()
      if (stored.record.text === text) {
        // The same text again (a copy from the box that made it) may bring the detail this copy lacks.
        if (!asr || stored.record.asr) return { ...stored.record }
        stored.record = { ...stored.record, asr }
        return this.save(id, stored)
      }
      stored.record = { ...stored.record, text, via, state: 'transcribed', primarySaved: !this.cloud, ...(asr ? { asr } : {}) }
      return this.save(id, stored)
    })
  }
  async markPrimarySaved(id: string, expectedText?: string): Promise<VoiceRecord> {
    return this.locked(id, async (key) => {
      const stored = await this.required(key)
      if (stored.record.text !== expectedText) return { ...stored.record }
      stored.record.primarySaved = true
      return this.save(key, stored)
    })
  }
  async markPrimaryChunk(id: string, next: number): Promise<void> {
    await this.locked(id, async (key) => {
      const stored = await this.required(key)
      stored.nextPrimaryChunk = Math.max(stored.nextPrimaryChunk ?? 0, next)
      await this.save(key, stored)
    })
  }
  async resetPrimaryChunks(id: string): Promise<void> {
    await this.locked(id, async (key) => {
      const stored = await this.required(key)
      stored.nextPrimaryChunk = 0
      stored.record.primarySaved = false
      await this.save(key, stored)
    })
  }
  async replicationSnapshot(id: string): Promise<{ record: VoiceRecord; chunkCount: number; nextPrimaryChunk: number }> {
    const stored = await this.required(voiceRecordingId(id))
    if (stored.record.state === 'uploading' || !stored.chunkCount) throw new VoiceArchiveError(409, 'not_committed', 'Recording is not committed')
    return { record: { ...stored.record }, chunkCount: stored.chunkCount, nextPrimaryChunk: stored.nextPrimaryChunk ?? 0 }
  }
  async readChunk(id: string, index: number): Promise<Buffer> {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CHUNKS) return bad('index is out of range')
    return readFile(join(this.dir(id), `chunk-${index}`))
  }
  async readAudio(id: string): Promise<{ audio: Buffer; format: string; record: VoiceRecord }> {
    const record = await this.get(id)
    if (record.state === 'uploading') throw new VoiceArchiveError(409, 'not_committed', 'Recording is not committed')
    return { audio: await readFile(join(this.dir(id), 'audio')), format: record.format, record }
  }
  async audioPath(id: string): Promise<{ path: string; record: VoiceRecord }> {
    const record = await this.get(id)
    if (record.state === 'uploading') throw new VoiceArchiveError(409, 'not_committed', 'Recording is not committed')
    const path = join(this.dir(id), 'audio')
    await stat(path)
    return { path, record }
  }
  async all(): Promise<VoiceRecord[]> {
    let entries: string[]
    try { entries = await readdir(this.root) } catch (err) { if (missing(err)) return []; throw err }
    const records: VoiceRecord[] = []
    for (const id of entries) {
      if (!UUID.test(id)) continue
      const stored = await this.stored(id)
      if (stored) records.push({ ...stored.record })
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }
  async list(before?: string, limit = 20): Promise<{ recordings: VoiceRecord[]; nextBefore?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return bad('limit must be between 1 and 100')
    let cutoff: { createdAt: string; id: string } | undefined
    if (before) {
      const [createdAt, id] = before.split('|')
      if (!createdAt || !Number.isFinite(Date.parse(createdAt))) return bad('Invalid before cursor')
      cutoff = { createdAt: new Date(createdAt).toISOString(), id: id ? voiceRecordingId(id) : '' }
    }
    const records = (await this.all()).filter((record) => !cutoff || record.createdAt < cutoff.createdAt || (record.createdAt === cutoff.createdAt && record.id < cutoff.id))
    const recordings = records.slice(0, limit)
    const last = recordings.at(-1)
    return { recordings, ...(records.length > limit && last ? { nextBefore: `${last.createdAt}|${last.id}` } : {}) }
  }
  /** Every take on disk with its size, for retention (voice-retention.ts). */
  async inventory(): Promise<Array<{ id: string; record?: VoiceRecord; bytes: number; modifiedMs: number }>> {
    let entries: string[]
    try { entries = await readdir(this.root) } catch (err) { if (missing(err)) return []; throw err }
    const out: Array<{ id: string; record?: VoiceRecord; bytes: number; modifiedMs: number }> = []
    for (const name of entries) {
      // A discard a crash interrupted.
      if (name.startsWith('.discard-')) { await rm(join(this.root, name), { recursive: true, force: true }); continue }
      if (!UUID.test(name)) continue
      const id = name.toLowerCase()
      let bytes = 0
      let modifiedMs = 0
      try {
        // A take that has only its directory so far is as new as the directory.
        modifiedMs = (await stat(join(this.root, name))).mtimeMs
        for (const file of await readdir(join(this.root, name))) {
          const info = await stat(join(this.root, name, file))
          bytes += info.size
          modifiedMs = Math.max(modifiedMs, info.mtimeMs)
        }
      } catch (err) { if (missing(err)) continue; throw err }
      const stored = await this.stored(id).catch(() => null)
      out.push({ id, ...(stored ? { record: { ...stored.record } } : {}), bytes, modifiedMs })
    }
    return out
  }
  /**
   * Drop a take for good (retention), after any write already queued for it, and
   * only if `still` holds for it then (it may have moved on since the take was
   * chosen). Leaves a mark: a later copy or chunk of it is refused with 410.
   */
  async discard(raw: string, still: (record: VoiceRecord | undefined, modifiedMs: number) => boolean = () => true): Promise<boolean> {
    const id = voiceRecordingId(raw)
    const previous = this.locks.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(async () => {
      let modifiedMs = 0
      try {
        modifiedMs = (await stat(this.dir(id))).mtimeMs
        for (const file of await readdir(this.dir(id))) modifiedMs = Math.max(modifiedMs, (await stat(join(this.dir(id), file))).mtimeMs)
      } catch (err) { if (missing(err)) return false; throw err }
      const record = (await this.stored(id).catch(() => null))?.record
      if (!still(record, modifiedMs)) return false
      // An upload never finished is not marked: its phone may still come back to finish it.
      if (record && record.state !== 'uploading') {
        await mkdir(join(this.root, '.removed'), { recursive: true, mode: 0o700 })
        await durableWrite(this.removedMark(id), new Date().toISOString())
      }
      // Out of the way in one step, so a crash never leaves half a take that still lists.
      const trash = join(this.root, `.discard-${randomUUID()}`)
      try { await rename(this.dir(id), trash) } catch (err) { if (missing(err)) return false; throw err }
      await rm(trash, { recursive: true, force: true })
      return true
    })
    this.locks.set(id, current)
    try { return await current } finally { if (this.locks.get(id) === current) this.locks.delete(id) }
  }
  /** Forget removal marks older than `maxAgeMs`: by then no copy of the take is still trying. */
  async forgetRemovedMarks(maxAgeMs: number, now = Date.now()): Promise<void> {
    const dir = join(this.root, '.removed')
    let names: string[]
    try { names = await readdir(dir) } catch (err) { if (missing(err)) return; throw err }
    for (const name of names) {
      const info = await stat(join(dir, name)).catch(() => null)
      if (info && now - info.mtimeMs > maxAgeMs) await unlink(join(dir, name)).catch(() => {})
    }
  }
  async ingestAudio(input: { id?: string; audio: Buffer | string; format: string; createdAt?: string; surface?: string; durationSeconds?: number }): Promise<VoiceRecord> {
    const audio = Buffer.isBuffer(input.audio) ? input.audio : decodeVoiceAudio(input.audio)
    if (!audio.length) return bad('audio must not be empty')
    if (audio.length > VOICE_MAX_AUDIO_BYTES) throw new VoiceArchiveError(413, 'too_large', 'Recording size exceeds the supported integer range')
    const id = voiceRecordingId(input.id ?? randomUUID())
    const createdAt = input.createdAt ?? new Date().toISOString()
    const chunkCount = Math.ceil(audio.length / VOICE_CHUNK_BYTES)
    for (let index = 0; index < chunkCount; index++) {
      await this.saveChunk(id, { index, audio: audio.subarray(index * VOICE_CHUNK_BYTES, (index + 1) * VOICE_CHUNK_BYTES).toString('base64'), format: input.format, createdAt, surface: input.surface, durationSeconds: input.durationSeconds })
    }
    return this.commit(id, { chunkCount, audioSizeBytes: audio.length, audioSha256: hash(audio) })
  }
}
export const voiceArchive = new VoiceArchiveStore()
export const readAudio = (id: string) => voiceArchive.readAudio(id)
export const saveText = (id: string, text: string, via?: string, asr?: VoiceAsr) => voiceArchive.saveText(id, text, via, asr)
export const ingestAudio = (input: Parameters<VoiceArchiveStore['ingestAudio']>[0]) => voiceArchive.ingestAudio(input)
