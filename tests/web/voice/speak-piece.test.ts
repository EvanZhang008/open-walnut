/**
 * The speech client (web/src/api/voice.ts speakPiece): it asks for a stream, an
 * audio/L16 answer comes back as a PcmFeed at its first audio (read on in the
 * background), a stream with no audio fails like a failed request, and a whole
 * MP3 or WAV answer stays bytes. The route is a stubbed fetch; nothing plays.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { speakPiece, SpeakError } from '../../../web/src/api/voice'
import { PcmFeed } from '../../../web/src/voice/pcm-feed'

const L16 = 'audio/L16; rate=24000; channels=1'
const bodies: unknown[] = []

function answer(make: () => Response): void {
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return make()
  })
}

afterEach(() => { vi.unstubAllGlobals(); bodies.length = 0 })

describe('speakPiece', () => {
  it('asks for a stream; audio/L16 comes back as a feed at its first audio, the rest read on as it comes', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
    answer(() => new Response(body, { headers: { 'content-type': L16 } }))
    ctrl.enqueue(new Uint8Array([0x40, 0x00]))
    const feed = await speakPiece({ text: 'Hi.', language: 'zh-CN' })
    expect(bodies[0]).toEqual({ text: 'Hi.', language: 'zh-CN', stream: true })
    expect(feed).toBeInstanceOf(PcmFeed)
    const pcm = feed as PcmFeed
    expect(pcm.format).toEqual({ rate: 24000, channels: 1 })
    ctrl.enqueue(new Uint8Array([0xc0, 0x00]))
    ctrl.close()
    const runs: number[][] = []
    for await (const run of pcm.samples()) runs.push([...run[0]!])
    expect(runs.flat()).toEqual([0.5, -0.5])
    expect(pcm.failed).toBeNull()
  })

  it('a stream that ends or breaks before any audio fails like a failed request (the device can say it)', async () => {
    answer(() => new Response(new ReadableStream({ start(c) { c.close() } }), { headers: { 'content-type': L16 } }))
    await expect(speakPiece({ text: 'x' })).rejects.toMatchObject({ name: 'SpeakError', fallback: true, code: 'tts_unavailable' })
    answer(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('cut')) } }), { headers: { 'content-type': L16 } }))
    const err = await speakPiece({ text: 'y' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SpeakError)
    expect((err as SpeakError).message).toMatch(/before any audio/)
  })

  it('a whole answer (MP3, or a cached WAV) is bytes, as before; an error is a SpeakError', async () => {
    answer(() => new Response(new Uint8Array([0xff, 0xf3, 1]), { headers: { 'content-type': 'audio/mpeg' } }))
    const mp3 = await speakPiece({ text: 'a' })
    expect(mp3).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(mp3 as ArrayBuffer)]).toEqual([0xff, 0xf3, 1])
    answer(() => new Response(new Uint8Array([0x52, 0x49]), { headers: { 'content-type': 'audio/wav' } }))
    expect(await speakPiece({ text: 'b' })).toBeInstanceOf(ArrayBuffer)
    answer(() => Response.json({ error: { code: 'tts_failed', message: 'refused' } }, { status: 502 }))
    await expect(speakPiece({ text: 'c' })).rejects.toMatchObject({ status: 502, fallback: false, code: 'tts_failed' })
  })

  it('a stopped request ends the feed\'s reading', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0, 1])) } })
    answer(() => new Response(body, { headers: { 'content-type': L16 } }))
    const abort = new AbortController()
    const feed = await speakPiece({ text: 'z' }, abort.signal) as PcmFeed
    abort.abort()
    const runs: unknown[] = []
    for await (const run of feed.samples()) runs.push(run)
    expect(runs).toHaveLength(1)
    expect(feed.failed).toBeTruthy()
  })

  it('its deadline covers only the wait for the first audio: a stream that goes on past it is not cut', async () => {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
    answer(() => new Response(body, { headers: { 'content-type': L16 } }))
    ctrl.enqueue(new Uint8Array([0x40, 0x00]))
    const feed = await speakPiece({ text: 'long' }, undefined, 50) as PcmFeed
    await new Promise((r) => setTimeout(r, 150))
    ctrl.enqueue(new Uint8Array([0xc0, 0x00]))
    ctrl.close()
    const runs: number[][] = []
    for await (const run of feed.samples()) runs.push([...run[0]!])
    expect(runs.flat()).toEqual([0.5, -0.5])
    expect(feed.failed).toBeNull()
  })

  it('no first audio within its deadline: a SpeakError the device can say instead', async () => {
    answer(() => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { 'content-type': L16 } }))
    await expect(speakPiece({ text: 'slow' }, undefined, 50)).rejects.toMatchObject({ name: 'SpeakError', fallback: true, code: 'tts_unavailable', message: expect.stringMatching(/did not start/) })
  })
})
