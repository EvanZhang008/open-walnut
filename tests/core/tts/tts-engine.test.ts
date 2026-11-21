/**
 * The voice engine layer (src/core/tts): which engine a config picks, the
 * ElevenLabs request, its errors in words, and the cache that keeps Replay free.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../../../src/core/types.js'
import { createElevenLabsEngine, elevenLabsError, ELEVENLABS_DEFAULT_MODEL } from '../../../src/core/tts/engine-elevenlabs.js'
import { clearTtsCache, serverEngine, speak, ttsStatus } from '../../../src/core/tts/index.js'

const cfg = (tts?: Config['tts']): Config => ({ tts } as Config)

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

function fakeFetch(calls: { url: string; body: unknown; key: string | null }[], answer: () => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), key: headers.get('xi-api-key') })
    return answer()
  }) as typeof fetch
}

afterEach(() => {
  clearTtsCache()
  delete process.env.ELEVENLABS_API_KEY
})

describe('engine choice', () => {
  it('no key: the device speaks; a key: ElevenLabs; engine device wins over a key', () => {
    expect(ttsStatus(cfg()).engine).toBe('device')
    expect(serverEngine(cfg())).toBeNull()
    expect(ttsStatus(cfg({ elevenlabs_api_key: 'k' })).engine).toBe('elevenlabs')
    expect(ttsStatus(cfg({ elevenlabs_api_key: 'k', engine: 'device' })).engine).toBe('device')
    // Picked ElevenLabs without a key: the device's voice, never silence.
    const s = ttsStatus(cfg({ engine: 'elevenlabs' }))
    expect(s.engine).toBe('device')
    expect(s.engines.find((e) => e.id === 'elevenlabs')?.reason).toMatch(/No ElevenLabs API key/)
  })

  it('reads the key from the environment', () => {
    process.env.ELEVENLABS_API_KEY = 'env-key'
    expect(serverEngine(cfg())?.id).toBe('elevenlabs')
  })
})

describe('ElevenLabs request', () => {
  it('posts the piece with the model, the key and the neighbouring text, and streams the audio', async () => {
    const calls: { url: string; body: unknown; key: string | null }[] = []
    const engine = createElevenLabsEngine({ apiKey: 'k1', fetchImpl: fakeFetch(calls, () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } })) })
    const audio = await engine.synthesize({ text: 'Hello.', language: 'en-US', previousText: 'Before.', nextText: 'After.' })
    expect(audio.mime).toBe('audio/mpeg')
    expect([...await readAll(audio.body)]).toEqual([1, 2, 3])
    expect(calls[0]!.url).toMatch(/\/v1\/text-to-speech\/[^/]+\/stream\?output_format=mp3_44100_128$/)
    expect(calls[0]!.key).toBe('k1')
    expect(calls[0]!.body).toEqual({ text: 'Hello.', model_id: ELEVENLABS_DEFAULT_MODEL, previous_text: 'Before.', next_text: 'After.' })
  })

  it('pins only Japanese; Chinese with English words is left to auto-detect', async () => {
    const calls: { url: string; body: unknown; key: string | null }[] = []
    const engine = createElevenLabsEngine({ apiKey: 'k', fetchImpl: fakeFetch(calls, () => new Response(new Uint8Array([0]))) })
    await engine.synthesize({ text: 'a', language: 'zh-CN' })
    await engine.synthesize({ text: 'b', language: 'ja-JP' })
    expect((calls[0]!.body as Record<string, unknown>).language_code).toBeUndefined()
    expect((calls[1]!.body as Record<string, unknown>).language_code).toBe('ja')
  })

  it('turns API failures into sentences with the right status', () => {
    expect(elevenLabsError(401, '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}')).toMatchObject({ status: 503, code: 'tts_unavailable' })
    expect(elevenLabsError(401, '{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}')).toMatchObject({ code: 'tts_quota' })
    expect(elevenLabsError(429, '')).toMatchObject({ status: 503, code: 'tts_unavailable' })
    expect(elevenLabsError(400, '{"detail":"bad text"}')).toMatchObject({ status: 502, code: 'tts_failed' })
  })

  it('an unreachable API is tts_unavailable', async () => {
    const engine = createElevenLabsEngine({ apiKey: 'k', fetchImpl: (async () => { throw new TypeError('fetch failed') }) as typeof fetch })
    await expect(engine.synthesize({ text: 'a' })).rejects.toMatchObject({ code: 'tts_unavailable', status: 503 })
  })
})

describe('cache', () => {
  it('the same words twice cost one request; other words another', async () => {
    const calls: { url: string; body: unknown; key: string | null }[] = []
    const engine = createElevenLabsEngine({ apiKey: 'k', fetchImpl: fakeFetch(calls, () => new Response(new Uint8Array([7, 8]))) })
    const first = await speak(engine, { text: 'Same.' })
    expect(first.cached).toBe(false)
    expect([...await readAll(first.body)]).toEqual([7, 8])
    const second = await speak(engine, { text: 'Same.' })
    expect(second.cached).toBe(true)
    expect([...await readAll(second.body)]).toEqual([7, 8])
    await readAll((await speak(engine, { text: 'Other.' })).body)
    expect(calls).toHaveLength(2)
  })

  it('a stream that was never read to its end is not cached', async () => {
    const calls: { url: string; body: unknown; key: string | null }[] = []
    const engine = createElevenLabsEngine({ apiKey: 'k', fetchImpl: fakeFetch(calls, () => new Response(new Uint8Array([1]))) })
    const first = await speak(engine, { text: 'Cut.' })
    await first.body.cancel()
    expect((await speak(engine, { text: 'Cut.' })).cached).toBe(false)
  })
})
