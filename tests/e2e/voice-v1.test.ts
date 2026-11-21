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
    expect(await (await post('/api/v1/voice/spoken', { text: '```\nonly code\n```' })).json()).toEqual({ text: null })
    expect((await post('/api/v1/voice/spoken', { text: 42 })).status).toBe(400)
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
  })

  it('an engine failure answers in words, and bad input is 400', async () => {
    process.env.ELEVENLABS_API_KEY = 'test-key'
    upstreamAnswer = () => new Response('{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}', { status: 401 })
    const res = await post('/api/v1/voice/speak', { text: 'Not cached yet.' })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatchObject({ code: 'tts_quota' })
    expect((await post('/api/v1/voice/speak', { text: '' })).status).toBe(400)
    expect((await post('/api/v1/voice/speak', { text: 'x'.repeat(2001) })).status).toBe(400)
  })
})
