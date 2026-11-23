/**
 * The ElevenLabs Scribe engine against a local fake of its API (never the real
 * one, never a real key): the quota is checked before every upload, a free or
 * paid plan with less than 10% left uploads nothing, a take whose cost does not
 * fit in what is left (less the 10%) is not uploaded, a workspace with
 * usage-based billing on uploads nothing, a take whose length is unknown is not
 * uploaded, a key that may not read its subscription or use speech-to-text reads
 * key-lacks-permission (for ten minutes, or until the key is saved again), and
 * the upload carries the multipart fields the API takes. A busy answer (429 not
 * about the quota, 5xx) or a dropped connection is tried again, a few times.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('stt-compare-11labs'))

const { runElevenLabs, elevenLabsStatus, forgetElevenLabsKeyState, takeCredits, DENIED_TTL_MS, _resetElevenLabsForTest } = await import('../../src/core/stt/compare/elevenlabs.js')
const { EngineStateError } = await import('../../src/core/stt/compare/types.js')
import type { Config } from '../../src/core/types.js'

const KEY = 'fake-key-for-tests-0001'
let server: Server
let base = ''
type Answer = { status: number; body: unknown; drop?: boolean }
/** One answer for every call, or a list answered in turn (its last one repeats). */
let subscription: Answer | Answer[]
let stt: Answer | Answer[]
const next = (a: Answer | Answer[]) => (Array.isArray(a) ? (a.length > 1 ? a.shift()! : a[0]!) : a)
const seen: Array<{ method: string; url: string; key?: string; body: string }> = []

const read = (req: IncomingMessage) => new Promise<string>((resolve) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')))
})

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await read(req)
    seen.push({ method: req.method!, url: req.url!, key: req.headers['xi-api-key'] as string | undefined, body })
    const answer = next(req.url === '/v1/user/subscription' ? subscription : req.url === '/v1/speech-to-text' ? stt : { status: 404, body: {} })
    if (answer.drop) { req.socket.destroy(); return }
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

beforeEach(() => {
  _resetElevenLabsForTest()
  seen.length = 0
  subscription = { status: 200, body: { tier: 'free', character_count: 1000, character_limit: 10000 } }
  stt = { status: 200, body: { language_code: 'en', text: ' heard by scribe ' } }
})

const config = (): Config => ({ stt: { compare: { elevenlabs_api_key: KEY, elevenlabs_base_url: base, engines: { 'elevenlabs-scribe': { allow_upload: true } } } } } as Config)
const input = { audio: Buffer.from('RIFF....WAVEfake').toString('base64'), format: 'mp3', durationSec: 3 }

describe('ElevenLabs Scribe engine', () => {
  it('checks the quota, then uploads the take with its fields and the key header', async () => {
    const out = await runElevenLabs(input, config())
    expect(out).toMatchObject({ text: 'heard by scribe', model: 'scribe_v3' })
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /v1/user/subscription', 'POST /v1/speech-to-text'])
    expect(seen.every((s) => s.key === KEY)).toBe(true)
    const upload = seen[1]!.body
    expect(upload).toMatch(/name="model_id"\r\n\r\nscribe_v3/)
    expect(upload).toMatch(/name="tag_audio_events"\r\n\r\nfalse/)
    expect(upload).toMatch(/name="file"; filename="take\.mp3"/)
  })

  it('uploads nothing when less than 10% of the free quota is left', async () => {
    subscription = { status: 200, body: { tier: 'free', character_count: 9500, character_limit: 10000 } }
    const err = await runElevenLabs(input, config()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EngineStateError)
    expect((err as InstanceType<typeof EngineStateError>).state).toBe('quota-used')
    expect((err as Error).message).toBe('free quota used up')
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription'])
  })

  it('a paid plan runs within what it includes and never into overage', async () => {
    subscription = { status: 200, body: { tier: 'creator', character_count: 50_000, character_limit: 100_000 } }
    await expect(runElevenLabs(input, config())).resolves.toMatchObject({ text: 'heard by scribe' })
    subscription = { status: 200, body: { tier: 'creator', character_count: 95_000, character_limit: 100_000 } }
    seen.length = 0
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'quota-used' })
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription'])
  })

  it('a key that cannot read its subscription cannot prove the quota: no upload', async () => {
    subscription = { status: 401, body: { detail: { status: 'missing_permissions' } } }
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'key-lacks-permission' })
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription'])
  })

  it('a 403 on speech-to-text marks the key, and its state stays until the key changes', async () => {
    stt = { status: 403, body: { detail: 'not allowed' } }
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'key-lacks-permission' })
    expect((await elevenLabsStatus(config())).state).toBe('key-lacks-permission')
    const other = config()
    other.stt!.compare!.elevenlabs_api_key = 'another-fake-key-0002'
    expect((await elevenLabsStatus(other)).state).toBe('ready')
  })

  it('reads needs-key without a key, and ready with quota details otherwise', async () => {
    const none = config()
    delete none.stt!.compare!.elevenlabs_api_key
    expect((await elevenLabsStatus(none)).state).toBe('needs-key')
    await expect(runElevenLabs(input, none)).rejects.toMatchObject({ state: 'needs-key' })
    const ready = await elevenLabsStatus(config())
    expect(ready).toMatchObject({ state: 'ready', quota: { tier: 'free', left: 9000, limit: 10000 } })
  })

  it('uploads only when this take\'s cost fits in what is left, less the 10% kept back', async () => {
    // 2000 left, 1000 kept back: 1000 credits may be spent.
    subscription = { status: 200, body: { tier: 'free', character_count: 8000, character_limit: 10000, max_credit_limit_extension: 0 } }
    expect(takeCredits(180)).toBe(990)
    await expect(runElevenLabs({ ...input, durationSec: 180 }, config())).resolves.toMatchObject({ text: 'heard by scribe' })
    seen.length = 0
    const err = await runElevenLabs({ ...input, durationSec: 200 }, config()).catch((e: unknown) => e)
    expect(err).toMatchObject({ state: 'quota-used' })
    expect((err as Error).message).toMatch(/1100 credits/)
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription'])
  })

  it('uploads nothing while usage-based billing is on, whatever is left', async () => {
    for (const extension of ['unlimited', 5000]) {
      subscription = { status: 200, body: { tier: 'creator', character_count: 0, character_limit: 100_000, max_credit_limit_extension: extension } }
      seen.length = 0
      await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'may-cost' })
      expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription'])
    }
    subscription = { status: 200, body: { tier: 'creator', character_count: 0, character_limit: 100_000, allowed_to_extend_character_limit: true } }
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'may-cost' })
    expect(await elevenLabsStatus(config(), true)).toMatchObject({ state: 'may-cost', quota: { overage: true } })
  })

  it('a take whose length cannot be read is not uploaded; a WAV\'s length is read from the audio', async () => {
    // Not audio ffmpeg can read, and no length from the recording: its cost cannot be checked.
    const err = await runElevenLabs({ audio: input.audio, format: 'mp3' }, config()).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/length could not be read/)
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription'])
    // Two seconds of 16 kHz mono 16-bit WAV: its length comes from the audio itself.
    const pcm = Buffer.alloc(64_000)
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii'); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
    header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
    header.write('data', 36, 'ascii'); header.writeUInt32LE(pcm.length, 40)
    seen.length = 0
    await expect(runElevenLabs({ audio: Buffer.concat([header, pcm]).toString('base64'), format: 'wav' }, config())).resolves.toMatchObject({ text: 'heard by scribe' })
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription', '/v1/speech-to-text'])
  })

  it('a refusal is believed for ten minutes, and forgotten at once when the key is saved again', async () => {
    stt = { status: 401, body: { detail: { status: 'missing_permissions', message: 'missing speech_to_text' } } }
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'key-lacks-permission' })
    expect((await elevenLabsStatus(config())).state).toBe('key-lacks-permission')
    // The user added the permission and saved the key again.
    forgetElevenLabsKeyState()
    expect((await elevenLabsStatus(config())).state).toBe('ready')
    // Without a save, the refusal ends by itself.
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'key-lacks-permission' })
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + DENIED_TTL_MS + 1)
    try {
      expect((await elevenLabsStatus(config(), true)).state).toBe('ready')
    } finally { clock.mockRestore() }
  })

  it('a refusal whose body says the quota is used reads quota-used, not a key problem', async () => {
    stt = { status: 401, body: { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota' } } }
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'quota-used' })
    expect((await elevenLabsStatus(config())).state).toBe('ready') // not stuck as a bad key
  })

  it('a server error is an ordinary failure, kept per take by the runner', async () => {
    stt = { status: 500, body: { detail: 'boom' } }
    const err = await runElevenLabs(input, config()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(EngineStateError)
  })

  it('a busy answer to the quota read is tried again, so the engine stays ready', async () => {
    subscription = [{ status: 429, body: { detail: { type: 'rate_limit_error', code: 'system_busy' } } }, { status: 200, body: { tier: 'free', character_count: 1000, character_limit: 10000 } }]
    expect((await elevenLabsStatus(config(), true)).state).toBe('ready')
    expect(seen.map((s) => s.url)).toEqual(['/v1/user/subscription', '/v1/user/subscription'])
  })

  it('a busy upload and a dropped connection are tried again with the whole take', async () => {
    stt = [{ status: 429, body: { detail: { type: 'rate_limit_error', code: 'system_busy' } } }, { status: 0, body: null, drop: true }, { status: 200, body: { text: 'heard on the third try' } }]
    expect((await runElevenLabs(input, config())).text).toBe('heard on the third try')
    const uploads = seen.filter((s) => s.url === '/v1/speech-to-text')
    expect(uploads).toHaveLength(3)
    expect(uploads.every((u) => /name="file"; filename="take\.mp3"/.test(u.body))).toBe(true)
  })

  it('a 429 about the quota is not tried again', async () => {
    stt = { status: 429, body: { detail: { status: 'quota_exceeded' } } }
    await expect(runElevenLabs(input, config())).rejects.toMatchObject({ state: 'quota-used' })
    expect(seen.filter((s) => s.url === '/v1/speech-to-text')).toHaveLength(1)
  })

  it('a server that stays busy fails the take after four tries', async () => {
    stt = { status: 503, body: { detail: 'busy' } }
    await expect(runElevenLabs(input, config())).rejects.toThrow(/answered 503/)
    expect(seen.filter((s) => s.url === '/v1/speech-to-text')).toHaveLength(4)
  })

  it('a stop during the wait before another try ends the take at once', async () => {
    _resetElevenLabsForTest([60_000])
    stt = { status: 503, body: { detail: 'busy' } }
    const stop = new AbortController()
    const run = runElevenLabs(input, config(), stop.signal)
    await vi.waitFor(() => expect(seen.filter((s) => s.url === '/v1/speech-to-text')).toHaveLength(1))
    const t0 = Date.now()
    stop.abort(new Error('stopped'))
    await expect(run).rejects.toThrow('stopped')
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})
