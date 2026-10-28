/**
 * Live transcription: pieces of a take arriving while it is recorded are cut at
 * quiet moments and transcribed as they come; the finished file reuses them only
 * when it holds exactly the samples they were made from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('stt-live'))
const engine = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/stt/index.js', () => ({ transcribeAudio: engine }))

import { appendLive, finishLive, finishLiveFromSamples, dropLive, hasLiveTake, _resetLiveTakesForTest, LIVE_CUT_AT_SEC, LIVE_CUT_MIN_SEC, LIVE_CUT_MAX_SEC, LIVE_MAX_HELD_SEC } from '../../src/core/stt/live-transcript.js'
import { cafToWav, cafDataLayout } from '../../src/core/stt/caf-to-wav.js'
import { wavPcm, SAMPLE_RATE } from '../../src/core/stt/wav-segment.js'
import { voiceArchive } from '../../src/core/stt/voice-archive.js'
import { voiceArchiveV1Router, runVoiceArchiveAction } from '../../src/web/routes/voice-archive-v1.js'
import { updateConfig } from '../../src/core/config-manager.js'

/** Tone with a silent second at each of `silentAt` (seconds). */
function speech(seconds: number, silentAt: number[] = [], seed = 1): Int16Array {
  const pcm = new Int16Array(Math.round(seconds * SAMPLE_RATE))
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SAMPLE_RATE
    pcm[i] = silentAt.some((s) => t >= s && t < s + 1) ? 0 : Math.round(6000 * Math.sin(2 * Math.PI * (200 + seed) * t))
  }
  return pcm
}

/** Speech with a pause of a second every `every` seconds, the way people talk. */
function talk(seconds: number, every = 4, seed = 1): Int16Array {
  const pauses: number[] = []
  for (let t = every; t < seconds - 1; t += every + 1) pauses.push(t)
  return speech(seconds, pauses, seed)
}

/** Let queued pieces finish. */
const settle = () => new Promise((r) => setTimeout(r, 20))

/** SHA-256 of the samples, as the companion sends it to the Mac. */
const pcmSha = (pcm: Int16Array) => createHash('sha256').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex')

/**
 * The phone's CAF: while recording the data chunk's size is unknown (-1); the
 * finished file states it. Everything else is the same bytes.
 */
function caf(pcm: Int16Array, finished: boolean): Buffer {
  const desc = Buffer.alloc(32)
  desc.writeDoubleBE(16000, 0)
  desc.write('lpcm', 8, 'ascii')
  desc.writeUInt32BE(2, 12) // little-endian int
  desc.writeUInt32BE(2, 16)
  desc.writeUInt32BE(1, 20)
  desc.writeUInt32BE(1, 24)
  desc.writeUInt32BE(16, 28)
  const chunk = (type: string, body: Buffer, size = BigInt(body.length)) => {
    const h = Buffer.alloc(12); h.write(type, 0, 'ascii'); h.writeBigInt64BE(size, 4)
    return Buffer.concat([h, body])
  }
  const samples = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const data = Buffer.concat([Buffer.alloc(4), samples])
  return Buffer.concat([
    Buffer.from([0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0]), chunk('desc', desc), chunk('free', Buffer.alloc(4016)),
    chunk('data', data, finished ? BigInt(data.length) : -1n),
  ])
}

const PIECE = 256 * 1024

/** A fake engine that names the samples it was given. */
function fakeEngine() {
  const calls: number[] = []
  const fn = vi.fn(async (wav: Buffer) => {
    const seconds = wavPcm(wav).length / SAMPLE_RATE
    calls.push(seconds)
    return `[${seconds.toFixed(1)}s]`
  })
  return { fn, calls }
}

function sendAll(id: string, file: Buffer, transcribe: ReturnType<typeof fakeEngine>['fn'], piece = PIECE, opts = {}) {
  for (let from = 0; from < file.length; from += piece) {
    const ack = appendLive(id, from, file.subarray(from, from + piece), transcribe, opts)
    expect('gap' in ack).toBe(false)
  }
}

beforeEach(() => { _resetLiveTakesForTest(); engine.mockReset() })

describe('cafDataLayout', () => {
  it('finds the samples in a recording still being written', () => {
    const file = caf(speech(1), false)
    expect(cafDataLayout(file.subarray(0, 100))).toBeNull()
    expect(cafDataLayout(file)).toEqual({ dataStart: 4096, native: true })
  })
})

describe('live transcript', () => {
  it('cuts at quiet moments while the take runs, then does only the end', async () => {
    const pcm = talk(65)
    const live = caf(pcm, false)
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    // The phone's pieces: about 4 s of audio each.
    sendAll(id, live, fn, 128 * 1024)
    await settle()
    const during = calls.length
    expect(during).toBeGreaterThanOrEqual(4)
    // Every live piece ends in a silence, past the minimum and within the longest.
    for (const s of calls) {
      expect(s).toBeGreaterThanOrEqual(LIVE_CUT_MIN_SEC)
      expect(s).toBeLessThanOrEqual(LIVE_CUT_MAX_SEC)
    }
    const final = wavPcm(cafToWav(caf(pcm, true))!)
    const text = await finishLive(id, final, fn)
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(65, 1)
    // The stop leaves only the samples since the last cut.
    expect(calls.slice(during).reduce((a, b) => a + b, 0)).toBeLessThan(LIVE_CUT_MAX_SEC)
    expect(text).toBe(calls.map((s) => `[${s.toFixed(1)}s]`).join(' '))
    expect(hasLiveTake(id)).toBe(false)
  })


  it('never cuts speech without a pause before the longest piece', async () => {
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    sendAll(id, caf(speech(50), false), fn)
    await settle()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    // No pause anywhere: each cut is made only once the longest piece had
    // gathered, and never past it, even from 8 s pieces.
    for (const s of calls) {
      expect(s).toBeGreaterThanOrEqual(LIVE_CUT_MAX_SEC - LIVE_CUT_AT_SEC)
      expect(s).toBeLessThanOrEqual(LIVE_CUT_MAX_SEC)
    }
  })

  it('a cancelled take stops its queued pieces, and a late piece does not start it again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fn = vi.fn(async () => { await gate; return 'x' })
    const id = randomUUID()
    const live = caf(talk(65), false)
    sendAll(id, live, fn)
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1))
    dropLive(id)
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(hasLiveTake(id)).toBe(false)
    expect(appendLive(id, 0, live.subarray(0, PIECE), fn)).toMatchObject({ accepted: false, reason: 'finished' })
  })

  it('retries a piece once; a second failure gives the take up', async () => {
    let failures = 1
    const fn = vi.fn(async () => { if (failures-- > 0) throw new Error('busy'); return 'ok' })
    const id = randomUUID()
    const pcm = talk(30)
    sendAll(id, caf(pcm, false), fn)
    const text = await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn)
    // One call failed and was retried: every other call is one piece of the text.
    expect(text).toBe(Array(fn.mock.calls.length - 1).fill('ok').join(' '))
  })

  it('is not used when the end is asked for in another language', async () => {
    const { fn } = fakeEngine()
    const id = randomUUID()
    const pcm = talk(30)
    sendAll(id, caf(pcm, false), fn)
    expect(await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn, 'zh')).toBeNull()
  })

  it('holds the pieces while another machine is expected, and starts on them the moment it is gone', async () => {
    const pcm = talk(65)
    const live = caf(pcm, false)
    const { fn, calls } = fakeEngine()
    const wake = vi.fn()
    const id = randomUUID()
    const half = Math.floor(live.length / PIECE / 2) * PIECE
    for (let from = 0; from < half; from += PIECE) appendLive(id, from, live.subarray(from, from + PIECE), fn, { eager: false, wake })
    await new Promise((r) => setTimeout(r, 20))
    // The Mac answers: nothing ran on this box, nothing woke its engine.
    expect(calls).toEqual([])
    expect(wake).not.toHaveBeenCalled()
    for (let from = half; from < live.length; from += PIECE) appendLive(id, from, live.subarray(from, from + PIECE), fn, { eager: true, wake })
    // The Mac left mid-take: the engine woke once and caught up on what was held.
    expect(wake).toHaveBeenCalledTimes(1)
    await settle()
    const during = calls.length
    expect(during).toBeGreaterThanOrEqual(4)
    const text = await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn)
    expect(calls.slice(during).reduce((a, b) => a + b, 0)).toBeLessThan(LIVE_CUT_MAX_SEC)
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(65, 1)
    expect(text).toBe(calls.map((s) => `[${s.toFixed(1)}s]`).join(' '))
  })

  it('held pieces are all transcribed at finish when the Mac is gone only at the end', async () => {
    const pcm = speech(45, [15, 30])
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    sendAll(id, caf(pcm, false), fn, PIECE, { eager: false })
    expect(calls).toEqual([])
    const text = await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn)
    expect(text).not.toBeNull()
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(45, 1)
  })

  it('a take held longer than the bound gives up instead of growing', async () => {
    const pcm = speech(LIVE_MAX_HELD_SEC + 40, Array.from({ length: 40 }, (_, i) => 10 + i * 9))
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    const live = caf(pcm, false)
    let last: ReturnType<typeof appendLive> | undefined
    for (let from = 0; from < live.length; from += PIECE) last = appendLive(id, from, live.subarray(from, from + PIECE), fn, { eager: false })
    expect(last).toMatchObject({ accepted: false })
    expect(hasLiveTake(id)).toBe(false)
    expect(calls).toEqual([])
  })

  it('takes resent and odd-sized pieces without counting a byte twice', async () => {
    const pcm = speech(45, [15, 30])
    const live = caf(pcm, false)
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    for (let from = 0; from < live.length; from += 100_001) {
      appendLive(id, from, live.subarray(from, from + 100_001), fn)
      // A retry of the same piece changes nothing.
      appendLive(id, from, live.subarray(from, from + 100_001), fn)
    }
    const text = await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn)
    expect(text).not.toBeNull()
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(45, 1)
  })

  it('names the offset to resend from after a gap', () => {
    const live = caf(speech(30), false)
    const { fn } = fakeEngine()
    const id = randomUUID()
    expect(appendLive(id, PIECE, live.subarray(PIECE, 2 * PIECE), fn)).toEqual({ gap: true, receivedBytes: 0 })
    appendLive(id, 0, live.subarray(0, PIECE), fn)
    expect(appendLive(id, 2 * PIECE, live.subarray(2 * PIECE), fn)).toEqual({ gap: true, receivedBytes: PIECE })
  })

  it('is not used for a finished file that differs from what arrived live', async () => {
    const { fn } = fakeEngine()
    const id = randomUUID()
    sendAll(id, caf(speech(50, [15, 33], 1), false), fn)
    expect(await finishLive(id, wavPcm(cafToWav(caf(speech(50, [15, 33], 2), true))!), fn)).toBeNull()
  })

  it('a server that never gets the file finishes from the samples it holds', async () => {
    const pcm = talk(30)
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    sendAll(id, caf(pcm, false), fn, 128 * 1024)
    await settle()
    const during = calls.length
    const final = wavPcm(cafToWav(caf(pcm, true))!)
    const text = await finishLiveFromSamples(id, final.byteLength, pcmSha(final), fn)
    expect(text).toBe(calls.map((s) => `[${s.toFixed(1)}s]`).join(' '))
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(30, 1)
    expect(calls.slice(during).reduce((a, b) => a + b, 0)).toBeLessThan(LIVE_CUT_MAX_SEC)
    expect(hasLiveTake(id)).toBe(false)
  })

  it('finishing from the samples needs every sample and the same ones', async () => {
    const pcm = talk(30)
    const final = wavPcm(cafToWav(caf(pcm, true))!)
    const { fn } = fakeEngine()
    // The last piece never arrived.
    const short = randomUUID()
    const live = caf(pcm, false)
    sendAll(short, live.subarray(0, live.length - 64 * 1024), fn)
    expect(await finishLiveFromSamples(short, final.byteLength, pcmSha(final), fn)).toBeNull()
    expect(hasLiveTake(short)).toBe(false)
    // Every sample arrived, but the finished file holds others.
    const other = randomUUID()
    sendAll(other, caf(talk(30, 4, 2), false), fn)
    expect(await finishLiveFromSamples(other, final.byteLength, pcmSha(final), fn)).toBeNull()
    // The end asked for in another language.
    const lang = randomUUID()
    sendAll(lang, live, fn)
    expect(await finishLiveFromSamples(lang, final.byteLength, pcmSha(final), fn, 'zh')).toBeNull()
    // Nothing held at all.
    expect(await finishLiveFromSamples(randomUUID(), final.byteLength, pcmSha(final), fn)).toBeNull()
  })

  it('stops for a format that is not the phone PCM, and after an engine error', async () => {
    const odd = caf(speech(5), false)
    odd.writeDoubleBE(44100, 20) // desc sample rate
    const { fn } = fakeEngine()
    const a = randomUUID()
    expect(appendLive(a, 0, odd, fn)).toMatchObject({ accepted: false })

    const b = randomUUID()
    const failing = vi.fn(async () => { throw new Error('engine down') })
    sendAll(b, caf(speech(45, [15, 30]), false), failing)
    await vi.waitFor(() => expect(failing).toHaveBeenCalled())
    expect(await finishLive(b, wavPcm(cafToWav(caf(speech(45, [15, 30]), true))!), fn)).toBeNull()
  })
})

describe('POST /api/v1/stt/recordings/:id/live, then the archive', () => {
  const app = express().use(express.json({ limit: '2mb' })).use('/api/v1', voiceArchiveV1Router)
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

  beforeEach(async () => {
    await rm(voiceArchive.root, { recursive: true, force: true })
    await updateConfig({ stt: { engine: 'qwen' } })
  })

  it('transcribes while recording; the finished take only waits for its end', async () => {
    const seen: number[] = []
    engine.mockImplementation(async (_cfg: unknown, req: { audio: string }) => {
      const seconds = wavPcm(Buffer.from(req.audio, 'base64')).length / SAMPLE_RATE
      seen.push(seconds)
      return { text: `piece${seen.length}`, durationMs: 1 }
    })
    const pcm = talk(50)
    const live = caf(pcm, false)
    const id = randomUUID()
    const base = `/api/v1/stt/recordings/${id}`
    for (let from = 0; from < live.length; from += PIECE) {
      const res = await request(app).post(base + '/live').send({ from, audio: live.subarray(from, from + PIECE).toString('base64') })
      expect(res.status).toBe(200)
      expect(res.body.accepted).toBe(true)
    }
    // The engine is reached through the config: wait until it has caught up with the pieces.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(3))
    let during = -1
    while (during !== seen.length) { during = seen.length; await new Promise((r) => setTimeout(r, 200)) }

    // The phone then stores the finished file as always: chunks, commit, transcribe.
    const final = caf(pcm, true)
    const createdAt = new Date().toISOString()
    let count = 0
    for (let at = 0; at < final.length; at += PIECE) {
      expect((await request(app).post(base + '/chunks').send({ index: count++, audio: final.subarray(at, at + PIECE).toString('base64'), format: 'caf', createdAt })).status).toBe(200)
    }
    expect((await request(app).post(base + '/commit').send({ chunkCount: count, audioSizeBytes: final.length, audioSha256: sha(final) })).status).toBe(200)
    const res = await request(app).post(base + '/transcribe').send({})
    expect(res.status).toBe(200)
    const all = seen.map((_, i) => `piece${i + 1}`).join(' ')
    expect(res.body.text).toBe(all)
    expect(seen.slice(during).reduce((a, b) => a + b, 0)).toBeLessThan(LIVE_CUT_MAX_SEC)
    expect((await voiceArchive.get(id)).text).toBe(all)
  })

  it('the Mac takes the pieces the companion hands it and answers the take from them, with no file', async () => {
    // The relay ops the companion calls (core/stt/live-forward.ts), run on this server as the Mac.
    const seen: number[] = []
    engine.mockImplementation(async (_cfg: unknown, req: { audio: string }) => {
      seen.push(wavPcm(Buffer.from(req.audio, 'base64')).length / SAMPLE_RATE)
      return { text: `mac${seen.length}`, durationMs: 1 }
    })
    const pcm = talk(30)
    const live = caf(pcm, false)
    const id = randomUUID()
    for (let from = 0; from < live.length; from += PIECE) {
      const result = await runVoiceArchiveAction({ operation: 'live', id, body: { from, audio: live.subarray(from, from + PIECE).toString('base64') } })
      expect(result).toMatchObject({ status: 200, body: { accepted: true } })
    }
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1))
    const final = wavPcm(cafToWav(caf(pcm, true))!)
    const done = await runVoiceArchiveAction({ operation: 'live-finish', id, body: { pcmBytes: final.byteLength, pcmSha256: pcmSha(final) } })
    expect(done).toMatchObject({ status: 200, body: { text: seen.map((_, i) => `mac${i + 1}`).join(' ') } })
    // With how it was made: the pieces done live and the seconds left at the stop.
    expect((done.body as { asr: { livePieces: number; leftSeconds: number } }).asr).toMatchObject({ livePieces: expect.any(Number), leftSeconds: expect.any(Number), ms: expect.any(Number) })
    // Asked again, or for samples that do not match: refused, never a guess.
    expect(await runVoiceArchiveAction({ operation: 'live-finish', id, body: { pcmBytes: final.byteLength, pcmSha256: pcmSha(final) } })).toMatchObject({ status: 409 })
    expect(await runVoiceArchiveAction({ operation: 'live-finish', id, body: { pcmBytes: 1 } })).toMatchObject({ status: 400 })
    // Nothing was stored here: the companion keeps the recording and copies it later.
    await expect(voiceArchive.get(id)).rejects.toMatchObject({ status: 404 })
  })

  it('corrects a heard form a quiet cut split across two pieces', async () => {
    await updateConfig({ stt_corrections: { clouddev: ['Cloud Deep'] } })
    try {
      let n = 0
      engine.mockImplementation(async () => ({ text: ++n === 1 ? '在 Cloud' : n === 2 ? 'Deep 上面' : 'x', durationMs: 1 }))
      const pcm = talk(30)
      const live = caf(pcm, false)
      const id = randomUUID()
      for (let from = 0; from < live.length; from += PIECE) {
        await runVoiceArchiveAction({ operation: 'live', id, body: { from, audio: live.subarray(from, from + PIECE).toString('base64') } })
      }
      await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(2))
      const final = wavPcm(cafToWav(caf(pcm, true))!)
      const done = await runVoiceArchiveAction({ operation: 'live-finish', id, body: { pcmBytes: final.byteLength, pcmSha256: pcmSha(final) } })
      expect((done.body as { text: string }).text).toMatch(/^在 clouddev 上面( x)*$/)
    } finally {
      await updateConfig({ stt_corrections: {} })
    }
  })

  it('the Mac forgets handed-over pieces when the take is cancelled or its text arrives', async () => {
    const { fn } = fakeEngine()
    engine.mockResolvedValue({ text: 'x', durationMs: 1 })
    const live = caf(talk(10), false)
    const cancelled = randomUUID()
    await runVoiceArchiveAction({ operation: 'live', id: cancelled, body: { from: 0, audio: live.subarray(0, PIECE).toString('base64') } })
    expect(hasLiveTake(cancelled)).toBe(true)
    expect(await runVoiceArchiveAction({ operation: 'live-drop', id: cancelled })).toEqual({ status: 200, body: { ok: true } })
    expect(hasLiveTake(cancelled)).toBe(false)
    // The companion finished the take itself and copies the recording with its text.
    const finished = randomUUID()
    const final = caf(talk(10), true)
    appendLive(finished, 0, live.subarray(0, PIECE), fn)
    expect(hasLiveTake(finished)).toBe(true)
    await voiceArchive.ingestAudio({ id: finished, audio: final, format: 'caf' })
    expect(await runVoiceArchiveAction({ operation: 'text', id: finished, body: { text: 'from the companion', via: 'local' } })).toMatchObject({ status: 200 })
    expect(hasLiveTake(finished)).toBe(false)
  })

  it('a resend past the received bytes is told where to start', async () => {
    const id = randomUUID()
    const res = await request(app).post(`/api/v1/stt/recordings/${id}/live`).send({ from: 1000, audio: Buffer.alloc(10).toString('base64') })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ accepted: true, gap: true, receivedBytes: 0 })
  })

  it('a server with a hosted engine only takes the whole file', async () => {
    await updateConfig({ stt: { engine: 'openai' } })
    const res = await request(app).post(`/api/v1/stt/recordings/${randomUUID()}/live`).send({ from: 0, audio: Buffer.alloc(10).toString('base64') })
    expect(res.body).toMatchObject({ accepted: false })
  })
})
