/**
 * A long take is heard while it records, so the stop waits only for its tail
 * (2026-11-21: the wait after the stop grew with the take, 17.7 s for 4.3
 * minutes). Through the real server: the clip is appended in parts
 * (POST /api/stt/takes/:id/append), pieces are heard ahead, and the stop
 * (POST /api/stt/transcribe?take=<id>) hears only the rest and joins the texts.
 * Every other stop hears the whole clip exactly as before. The engine is a stub
 * that says how long each clip it heard was; WAV clips, so no ffmpeg runs.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { speechPcm, RATE } from '../helpers/speech-pcm.js'

vi.mock('../../src/constants.js', () => createMockConstants('stt-take-ahead-e2e', { IS_EPHEMERAL: true }))
const engine = vi.hoisted(() => vi.fn())
const currentEngine = vi.hoisted(() => vi.fn(() => ({ name: 'stub' })))
vi.mock('../../src/core/stt/index.js', () => ({
  transcribeAudio: engine,
  runShadowTranscription: vi.fn(async () => {}),
  createEngine: vi.fn(() => null),
  getOrCreateEngine: currentEngine,
  ensureSttVocabMigrated: vi.fn(async () => {}),
  prewarmSttEngines: vi.fn(async () => {}),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { pcmToWav, wavPcm } from '../../src/core/stt/wav-segment.js'
import { _resetTakesForTest } from '../../src/core/stt/take-ahead.js'

let server: Server
let root: string
/** Seconds of every clip the engine heard, in order. */
let heard: number[]
let wholeClip: Buffer | null

beforeAll(async () => {
  await mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 120_000)
afterAll(async () => { await _resetTakesForTest(); await stopServer(); await rm(WALNUT_HOME, { recursive: true, force: true }) })

beforeEach(async () => {
  await _resetTakesForTest()
  heard = []
  wholeClip = null
  engine.mockReset()
  currentEngine.mockReset()
  currentEngine.mockImplementation(() => ({ name: 'stub' }))
  engine.mockImplementation(async (_config: unknown, req: { audio: string; format: string }) => {
    const audio = Buffer.from(req.audio, 'base64')
    if (wholeClip && audio.equals(wholeClip)) {
      heard.push(-1)
      return { text: 'the whole take', durationMs: 900, engine: 'stub' }
    }
    const sec = wavPcm(audio).length / RATE
    heard.push(sec)
    return { text: `[${sec.toFixed(1)}s]`, durationMs: 10, engine: 'stub' }
  })
})

const octets = { 'Content-Type': 'application/octet-stream' }

async function append(id: string, offset: number, bytes: Buffer) {
  const res = await fetch(`${root}/api/stt/takes/${id}/append?offset=${offset}&format=wav`, { method: 'POST', headers: octets, body: new Blob([new Uint8Array(bytes)]) })
  return { status: res.status, body: await res.json() as { size?: number; error?: string } }
}

async function appendInParts(id: string, clip: Buffer, parts: number) {
  const step = Math.ceil(clip.length / parts)
  for (let at = 0; at < clip.length; at += step) {
    const out = await append(id, at, clip.subarray(at, Math.min(clip.length, at + step)))
    expect(out).toEqual({ status: 200, body: { size: Math.min(clip.length, at + step) } })
  }
}

async function stop(clip: Buffer, take?: string) {
  const q = new URLSearchParams({ format: 'wav', ...(take ? { take } : {}) })
  const res = await fetch(`${root}/api/stt/transcribe?${q}`, { method: 'POST', headers: octets, body: new Blob([new Uint8Array(clip)]) })
  return { status: res.status, body: await res.json() as { text: string; durationMs: number; heardAheadSec?: number; aheadEngineMs?: number; recordingId?: string } }
}

describe('a long take heard ahead through the real server', () => {
  it('hears pieces while it records; the stop hears only the tail and answers the joined text', async () => {
    const clip = pcmToWav(speechPcm(150, 21))
    wholeClip = clip
    await appendInParts('take-e2e-long-01', clip, 10)
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(3), { timeout: 20_000 })
    // Let the last decode's pieces finish, as the user talking on would.
    await new Promise((r) => setTimeout(r, 500))
    const piecesBefore = heard.length
    expect(heard.every((s) => s > 0 && s <= 30)).toBe(true)

    const res = await stop(clip, 'take-e2e-long-01')
    expect(res.status).toBe(200)
    // The stop heard one clip: the tail, never the whole take.
    expect(heard.length).toBe(piecesBefore + 1)
    expect(heard).not.toContain(-1)
    const tail = heard[heard.length - 1]!
    expect(tail).toBeGreaterThanOrEqual(5)
    expect(res.body.heardAheadSec! + tail).toBeCloseTo(150, 0)
    expect(res.body.text).toBe(heard.map((s) => `[${s.toFixed(1)}s]`).join(' '))
    // The stop's own engine time; the pieces' is kept apart, so the daily voice review reads both.
    expect(res.body.durationMs).toBe(10)
    expect(res.body.aheadEngineMs).toBe(10 * piecesBefore)

    // The recording keeps the joined text, as it keeps the whole-clip text today.
    const list = await (await fetch(`${root}/api/stt/recordings`)).json() as { recordings: Array<{ id: string; result?: { text: string } }> }
    expect(list.recordings.find((r) => r.id === res.body.recordingId)?.result).toMatchObject({ text: res.body.text, durationMs: 10, aheadEngineMs: 10 * piecesBefore })
  }, 60_000)

  it('a take the server lost mid-way (a restart) is sent again from byte 0 and still heard ahead', async () => {
    // 2026-11-23: a deploy restarted the server 3 minutes into a 4.5-minute take; the next part
    // got 404, the client gave up, and the stop heard the whole clip (10.8 s instead of ~2 s).
    const clip = pcmToWav(speechPcm(150, 23))
    wholeClip = clip
    const half = Math.floor(clip.length / 2)
    await appendInParts('take-e2e-restart-01', clip.subarray(0, half), 5)
    await _resetTakesForTest() // what a restart does to the takes held in memory
    heard = []
    const next = await append('take-e2e-restart-01', half, clip.subarray(half, half + 1000))
    expect(next).toMatchObject({ status: 404, body: { error: 'Unknown take' } })
    // The client's start-over: everything recorded so far at offset 0, then on as before.
    expect(await append('take-e2e-restart-01', 0, clip.subarray(0, half + 1000))).toEqual({ status: 200, body: { size: half + 1000 } })
    expect((await append('take-e2e-restart-01', half + 1000, clip.subarray(half + 1000))).status).toBe(200)
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(3), { timeout: 20_000 })
    await new Promise((r) => setTimeout(r, 500))
    const res = await stop(clip, 'take-e2e-restart-01')
    expect(res.status).toBe(200)
    expect(heard).not.toContain(-1)
    expect(res.body.heardAheadSec).toBeGreaterThan(60)
    expect(res.body.heardAheadSec! + heard[heard.length - 1]!).toBeCloseTo(150, 0)
  }, 60_000)

  it('the append answers 409 with its size for a wrong offset, and refuses a bad take id', async () => {
    const clip = pcmToWav(speechPcm(4))
    expect((await append('take-e2e-off-01', 0, clip.subarray(0, 2000))).body).toEqual({ size: 2000 })
    expect(await append('take-e2e-off-01', 1500, clip.subarray(1500, 3000))).toMatchObject({ status: 409, body: { size: 2000 } })
    expect((await append('bad', 0, clip)).status).toBe(400)
    expect((await append('take-e2e-unknown', 100, clip)).status).toBe(404)
  })
})

describe('guard: every other stop hears the whole clip, as before', () => {
  it('no take id: one engine call with the whole clip, as raw bytes were always heard', async () => {
    const clip = pcmToWav(speechPcm(90, 3))
    wholeClip = clip
    const res = await stop(clip)
    expect(res.body.text).toBe('the whole take')
    expect(engine).toHaveBeenCalledTimes(1)
    expect(engine.mock.calls[0]![1]).toMatchObject({ format: 'wav', audio: clip.toString('base64') })
    expect(res.body.heardAheadSec).toBeUndefined()
  })

  it('an unknown take id: the whole clip', async () => {
    const clip = pcmToWav(speechPcm(90, 4))
    wholeClip = clip
    const res = await stop(clip, 'take-e2e-never-appended')
    expect(res.body.text).toBe('the whole take')
    expect(heard).toEqual([-1])
  })

  it('a clip that does not start with the appended bytes: the whole clip', async () => {
    const pcm = speechPcm(120, 5)
    await appendInParts('take-e2e-prefix-01', pcmToWav(pcm), 6)
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(1), { timeout: 20_000 })
    const other = Int16Array.from(pcm)
    other[2 * RATE] = (other[2 * RATE]! + 999) | 0
    const clip = pcmToWav(other)
    wholeClip = clip
    const res = await stop(clip, 'take-e2e-prefix-01')
    expect(res.body.text).toBe('the whole take')
    expect(heard[heard.length - 1]).toBe(-1)
  }, 60_000)

  it('the engine was switched while it recorded: the whole clip, heard by one engine', async () => {
    const clip = pcmToWav(speechPcm(120, 7))
    await appendInParts('take-e2e-switch-01', clip, 6)
    await vi.waitFor(() => expect(heard.length).toBeGreaterThanOrEqual(1), { timeout: 20_000 })
    wholeClip = clip
    currentEngine.mockImplementation(() => ({ name: 'another' }))
    const res = await stop(clip, 'take-e2e-switch-01')
    expect(res.body.text).toBe('the whole take')
    expect(heard[heard.length - 1]).toBe(-1)
    expect(res.body.heardAheadSec).toBeUndefined()
  }, 60_000)

  it('a first part that lands after the stop makes no take again', async () => {
    const clip = pcmToWav(speechPcm(10, 8))
    await appendInParts('take-e2e-late-01', clip, 1)
    wholeClip = clip
    await stop(clip, 'take-e2e-late-01')
    expect((await append('take-e2e-late-01', 0, clip)).status).toBe(410)
    const res = await fetch(`${root}/api/stt/takes/take-e2e-late-01`, { method: 'DELETE' })
    expect(await res.json()).toEqual({ dropped: false })
  })

  it('a short take (under 45 s) appended in parts: nothing heard ahead, the whole clip at the stop', async () => {
    const clip = pcmToWav(speechPcm(35, 6))
    wholeClip = clip
    await appendInParts('take-e2e-short-01', clip, 3)
    await new Promise((r) => setTimeout(r, 300))
    const res = await stop(clip, 'take-e2e-short-01')
    expect(res.body.text).toBe('the whole take')
    expect(heard).toEqual([-1])
  })
})
