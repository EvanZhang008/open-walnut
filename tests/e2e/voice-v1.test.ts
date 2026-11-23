/**
 * /api/v1/voice (src/web/routes/voice-v1.ts) on a real server: the status, the
 * words a reply becomes, and the speech of a piece through ElevenLabs (its API
 * faked at the fetch level; nothing leaves this machine).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-voice-v1'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { clearTtsCache } from '../../src/core/tts/index.js'
import { getConfig, updateConfig } from '../../src/core/config-manager.js'

let server: HttpServer
let port: number
const realFetch = globalThis.fetch
const upstream: { body: Record<string, unknown>; key: string | null }[] = []
let upstreamAnswer: () => Response = () => new Response(new Uint8Array([0xff, 0xf3, 1, 2]), { headers: { 'content-type': 'audio/mpeg' } })

const url = (p: string) => `http://localhost:${port}${p}`
const post = (p: string, body: unknown) => realFetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input)
    if (!target.startsWith('https://api.elevenlabs.io/')) return realFetch(input, init)
    upstream.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('xi-api-key') })
    return upstreamAnswer()
  }) as typeof fetch
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  globalThis.fetch = realFetch
  delete process.env.ELEVENLABS_API_KEY
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('/api/v1/voice', () => {
  it('with no key, the device speaks and /speak says so', async () => {
    delete process.env.ELEVENLABS_API_KEY
    const status = await (await realFetch(url('/api/v1/voice/status'))).json()
    expect(status.engine).toBe('device')
    const res = await post('/api/v1/voice/speak', { text: 'Hello.' })
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe('tts_unavailable')
  })

  it('turns a reply into its spoken part, in pieces', async () => {
    const res = await post('/api/v1/voice/spoken', { text: 'Done. All tests passed.\n\n---\n\n| a | b |\n```ts\nx\n```' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.text).toBe('Done. All tests passed. The rest is on screen.')
    expect(body.language).toBe('en-US')
    expect(body.truncated).toBe(true)
    expect(body.chunks[0]).toBe('Done.')
    // The line said after the cut, alone, for a client that already said the rest as it streamed.
    expect(body.rest).toBe('The rest is on screen.')
    // Nothing cut: the response is exactly the old one (no rest field).
    expect(await (await post('/api/v1/voice/spoken', { text: 'All good.' })).json()).toEqual({ text: 'All good.', language: 'en-US', truncated: false, chunks: ['All good.'] })
    expect(await (await post('/api/v1/voice/spoken', { text: '```\nonly code\n```' })).json()).toEqual({ text: null })
    expect((await post('/api/v1/voice/spoken', { text: 42 })).status).toBe(400)
  })

  it('piece: one part of a streaming answer, cleaned with no budget and no rest line', async () => {
    const long = 'This sentence is part of a long streaming answer. '.repeat(20)
    const body = await (await post('/api/v1/voice/spoken', { text: `**Checking** the \`src/app/main.ts\` file now.\n${long}`, piece: true })).json()
    expect(body.truncated).toBe(false)
    expect(body.rest).toBeUndefined()
    expect(body.text.startsWith('Checking the main.ts file now. This sentence')).toBe(true)
    expect(body.text).not.toContain('The rest is on screen.')
    // The same text as a reply is capped and says the rest is on screen.
    const reply = await (await post('/api/v1/voice/spoken', { text: long })).json()
    expect(reply.truncated).toBe(true)
    expect(reply.rest).toBe('The rest is on screen.')
    expect(await (await post('/api/v1/voice/spoken', { text: '```\ncode\n```', piece: true })).json()).toEqual({ text: null })
    expect((await post('/api/v1/voice/spoken', { text: 'x', piece: 'yes' })).status).toBe(400)
  })

  it('language: the rest line follows the language the answer was said in', async () => {
    const body = await (await post('/api/v1/voice/spoken', { text: 'Build passed.\n---\nDetail.', language: 'zh-CN' })).json()
    expect(body.language).toBe('zh-CN')
    expect(body.rest).toBe('\u8be6\u60c5\u5728\u5c4f\u5e55\u4e0a\u3002')
    expect((await post('/api/v1/voice/spoken', { text: 'x', language: 'not a tag!' })).status).toBe(400)
  })

  it('with a key, /speak streams the engine audio and caches it', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    clearTtsCache()
    upstream.length = 0
    expect((await (await realFetch(url('/api/v1/voice/status'))).json()).engine).toBe('elevenlabs')
    const res = await post('/api/v1/voice/speak', { text: 'Hello there.', language: 'en-US', nextText: 'More.' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(res.headers.get('x-walnut-tts-cached')).toBe('0')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xf3, 1, 2])
    expect(upstream[0]).toMatchObject({ key: 'test-key', body: { text: 'Hello there.', next_text: 'More.' } })
    const again = await post('/api/v1/voice/speak', { text: 'Hello there.', language: 'en-US' })
    expect(again.headers.get('x-walnut-tts-cached')).toBe('1')
    expect(upstream).toHaveLength(1)
    // A client that plays streamed PCM asks with stream: true; ElevenLabs answers its MP3 as before.
    const streamed = await post('/api/v1/voice/speak', { text: 'Streamed ask.', language: 'en-US', stream: true })
    expect(streamed.status).toBe(200)
    expect(streamed.headers.get('content-type')).toBe('audio/mpeg')
    expect(streamed.headers.get('cache-control')).toBe('no-store, no-transform')
    expect([...new Uint8Array(await streamed.arrayBuffer())]).toEqual([0xff, 0xf3, 1, 2])
    expect(upstream[1]!.body).not.toHaveProperty('stream')
  })

  it('an engine failure answers in words, and bad input is 400', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    upstreamAnswer = () => new Response('{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}', { status: 401 })
    const res = await post('/api/v1/voice/speak', { text: 'Not cached yet.' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatchObject({ code: 'tts_quota' })
    expect((await post('/api/v1/voice/speak', { text: '' })).status).toBe(400)
    expect((await post('/api/v1/voice/speak', { text: 'x'.repeat(2001) })).status).toBe(400)
    const notBool = await post('/api/v1/voice/speak', { text: 'x', stream: 'yes' })
    expect(notBool.status).toBe(400)
    expect((await notBool.json()).error.message).toMatch(/stream must be a boolean/)
  })

  it('lists the local Chinese voice, off until its experiment is on; warmup answers at once with the status', async () => {
    const status = await (await realFetch(url('/api/v1/voice/status'))).json()
    expect(status.engines.find((e: { id: string }) => e.id === 'qwen')).toMatchObject({
      id: 'qwen', available: false, state: 'off', languages: ['zh'],
      model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', voice: 'Uncle_Fu',
    })
    expect(status.byLanguage).toBeUndefined()
    // The engines a client already knew are still first, as they were.
    expect(status.engines.slice(0, 2).map((e: { id: string }) => e.id)).toEqual(['elevenlabs', 'device'])
    const t0 = Date.now()
    const warm = await post('/api/v1/voice/warmup', {})
    expect(warm.status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect((await warm.json()).engines.find((e: { id: string }) => e.id === 'qwen').state).toBe('off')
  })

  it('with the experiment on, a server that cannot run the local voice reads Chinese as before', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    clearTtsCache()
    upstream.length = 0
    upstreamAnswer = () => new Response(new Uint8Array([0xff, 0xf3, 7]), { headers: { 'content-type': 'audio/mpeg' } })
    await updateConfig({ experimental: { ...(await getConfig()).experimental, local_chinese_voice: true }, tts: { qwen_voice: 'Serena' } })
    const status = await (await realFetch(url('/api/v1/voice/status'))).json()
    // Linux has no runtime; a Mac test runner is an isolated server: either way it says why.
    expect(status.engines.find((e: { id: string }) => e.id === 'qwen')).toMatchObject({ available: false, state: 'unsupported', voice: 'Serena', reason: expect.any(String) })
    expect(status.byLanguage).toBeUndefined()
    const res = await post('/api/v1/voice/speak', { text: 'Chinese piece', language: 'zh-CN' })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-walnut-tts-engine')).toMatch(/^elevenlabs\//)
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xf3, 7])
    expect((await getConfig()).tts).toEqual({ qwen_voice: 'Serena' })
  })

  it('a local voice model that is not an mlx-community repo is never used: the status names the default', async () => {
    await updateConfig({ tts: { qwen_model: 'evil/model', qwen_port: 7893 } })
    const status = await (await realFetch(url('/api/v1/voice/status'))).json()
    expect(status.engines.find((e: { id: string }) => e.id === 'qwen')).toMatchObject({ model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit' })
    // The config keeps what the person wrote; only its use falls back.
    expect((await getConfig()).tts).toMatchObject({ qwen_model: 'evil/model', qwen_port: 7893 })
  })
})
