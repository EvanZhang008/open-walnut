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

import { appendLive, finishLive, dropLive, hasLiveTake, _resetLiveTakesForTest, LIVE_CUT_AT_SEC, LIVE_CUT_MIN_SEC, LIVE_CUT_MAX_SEC } from '../../src/core/stt/live-transcript.js'
import { cafToWav, cafDataLayout } from '../../src/core/stt/caf-to-wav.js'
import { wavPcm, SAMPLE_RATE } from '../../src/core/stt/wav-segment.js'
import { voiceArchive } from '../../src/core/stt/voice-archive.js'
import { voiceArchiveV1Router } from '../../src/web/routes/voice-archive-v1.js'
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

function sendAll(id: string, file: Buffer, transcribe: ReturnType<typeof fakeEngine>['fn'], piece = PIECE) {
  for (let from = 0; from < file.length; from += piece) {
    const ack = appendLive(id, from, file.subarray(from, from + piece), transcribe)
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
    // 65 s: three cuts at the silences, the last 16 s left for the end.
    const pcm = speech(65, [14, 31, 49])
    const live = caf(pcm, false)
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    sendAll(id, live, fn)
    await vi.waitFor(() => expect(calls.length).toBe(3))
    // Every live piece is between the minimum and the cut length, and ends in a silence.
    for (const s of calls) {
      expect(s).toBeGreaterThanOrEqual(LIVE_CUT_MIN_SEC)
      expect(s).toBeLessThanOrEqual(LIVE_CUT_AT_SEC)
    }
    const final = wavPcm(cafToWav(caf(pcm, true))!)
    const text = await finishLive(id, final, fn)
    expect(calls.length).toBe(4)
    expect(calls.reduce((a, b) => a + b, 0)).toBeCloseTo(65, 1)
    // The end left to do is under one cut's worth.
    expect(calls[3]).toBeLessThan(LIVE_CUT_AT_SEC)
    expect(text).toBe(calls.map((s) => `[${s.toFixed(1)}s]`).join(' '))
    expect(hasLiveTake(id)).toBe(false)
  })

  it('never cuts speech without a pause before the longest piece', async () => {
    const { fn, calls } = fakeEngine()
    const id = randomUUID()
    sendAll(id, caf(speech(50), false), fn)
    await vi.waitFor(() => expect(calls.length).toBe(1))
    // No pause anywhere: one cut, made only once 40 s had gathered.
    expect(calls[0]).toBeGreaterThan(LIVE_CUT_AT_SEC)
    expect(calls[0]).toBeLessThanOrEqual(LIVE_CUT_MAX_SEC)
  })

  it('a cancelled take stops its queued pieces, and a late piece does not start it again', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const fn = vi.fn(async () => { await gate; return 'x' })
    const id = randomUUID()
    const live = caf(speech(65, [14, 31, 49]), false)
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
    const pcm = speech(30, [14])
    sendAll(id, caf(pcm, false), fn)
    const text = await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn)
    expect(text).toBe('ok ok')
  })

  it('is not used when the end is asked for in another language', async () => {
    const { fn } = fakeEngine()
    const id = randomUUID()
    const pcm = speech(30, [14])
    sendAll(id, caf(pcm, false), fn)
    expect(await finishLive(id, wavPcm(cafToWav(caf(pcm, true))!), fn, 'zh')).toBeNull()
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
    const pcm = speech(50, [15, 35])
    const live = caf(pcm, false)
    const id = randomUUID()
    const base = `/api/v1/stt/recordings/${id}`
    for (let from = 0; from < live.length; from += PIECE) {
      const res = await request(app).post(base + '/live').send({ from, audio: live.subarray(from, from + PIECE).toString('base64') })
      expect(res.status).toBe(200)
      expect(res.body.accepted).toBe(true)
    }
    await vi.waitFor(() => expect(seen.length).toBe(2))

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
    expect(res.body.text).toBe('piece1 piece2 piece3')
    expect(seen.length).toBe(3)
    expect(seen[2]).toBeLessThan(LIVE_CUT_AT_SEC)
    expect((await voiceArchive.get(id)).text).toBe('piece1 piece2 piece3')
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
