/**
 * POST /api/v1/voice/speak with `stream: true` on a real server (src/web/routes/voice-v1.ts):
 * the local voice's audio/L16 relayed to the client as it comes, its first-audio
 * budget falling back to the usual engine, a break after audio only ending the
 * response, the cache keeping a whole piece as WAV, and no `stream` meaning the
 * whole piece as before. The engines are fakes (this host cannot run the local
 * voice); only `enginesFor` is replaced, the fallback and cache are the real ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import type { TtsEngine, TtsRequest } from '../../src/core/tts/types.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-voice-v1-stream'))

const pick = vi.hoisted(() => ({ engines: null as null | { engine: unknown; fallback: unknown } }))
vi.mock('../../src/core/tts/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/tts/index.js')>()
  return { ...real, enginesFor: (...args: Parameters<typeof real.enginesFor>) => (pick.engines as ReturnType<typeof real.enginesFor> | null) ?? real.enginesFor(...args) }
})

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { clearTtsCache } from '../../src/core/tts/index.js'
import { TtsError } from '../../src/core/tts/types.js'

const L16 = 'audio/L16; rate=24000; channels=1'
let server: HttpServer
let port: number

interface Plan { firstMs?: number; gapMs?: number; chunks?: number; breakAfter?: number }

/** A local voice that streams `chunks` 4-byte chunks (two big-endian samples each), as its plan says. */
function localVoice(plan: () => Plan): TtsEngine & { reqs: TtsRequest[]; cancels: number } {
  const reqs: TtsRequest[] = []
  const self: TtsEngine & { reqs: TtsRequest[]; cancels: number } = {
    id: 'qwen', model: 'fake-qwen', voice: 'fake-voice', reqs, cancels: 0, streams: true, fallbackBudgetMs: 400, fitsBudget: () => true,
    async synthesize(req) {
      reqs.push(req)
      const p = plan()
      const chunk = (i: number) => { const b = Buffer.alloc(4); b.writeInt16BE((i + 1) * 1000, 0); b.writeInt16BE(-(i + 1) * 1000, 2); return new Uint8Array(b) }
      if (!req.stream) return { mime: 'audio/wav', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0x52, 0x49, 0x46, 0x46])); c.close() } }) }
      // Resolves at the first audio, as the real engine does; a deadline before it is the caller's abort.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, p.firstMs ?? 0)
        req.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new TtsError('cancelled', 499, 'tts_failed')) })
      })
      let i = 1
      return {
        mime: L16,
        body: new ReadableStream<Uint8Array>({
          start(c) { c.enqueue(chunk(0)) },
          async pull(c) {
            await new Promise((r) => setTimeout(r, p.gapMs ?? 0))
            if (p.breakAfter !== undefined && i >= p.breakAfter) { c.error(new TtsError('The local voice broke off', 503, 'tts_unavailable')); return }
            if (i >= (p.chunks ?? 3)) { c.close(); return }
            c.enqueue(chunk(i++))
          },
          cancel() { self.cancels++ },
        }),
      }
    },
  }
  return self
}

const fallback: TtsEngine & { calls: string[] } = {
  id: 'elevenlabs', model: 'fake-eleven', voice: 'fake', calls: [],
  async synthesize(req) {
    fallback.calls.push(req.text)
    return { mime: 'audio/mpeg', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([0xff, 0xf3, 9])); c.close() } }) }
  },
}

let plan: Plan = {}
const qwen = localVoice(() => plan)
const post = (body: unknown) => fetch(`http://localhost:${port}/api/v1/voice/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function reads(res: Response, t0: number): Promise<{ at: number; bytes: number[] }[]> {
  const out: { at: number; bytes: number[] }[] = []
  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push({ at: Date.now() - t0, bytes: [...value] })
  }
}

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  pick.engines = { engine: qwen, fallback }
})

afterAll(async () => {
  pick.engines = null
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

beforeEach(() => { clearTtsCache(); plan = {}; fallback.calls.length = 0; qwen.reqs.length = 0; qwen.cancels = 0 })

describe('/api/v1/voice/speak stream: true', () => {
  it('relays the local voice\'s audio/L16 as it comes, then the cache answers the whole piece as WAV', async () => {
    plan = { chunks: 4, gapMs: 200 }
    const t0 = Date.now()
    const res = await post({ text: 'zh piece', language: 'zh-CN', stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(L16)
    expect(res.headers.get('x-walnut-tts-engine')).toBe('qwen/fake-qwen')
    const got = await reads(res, t0)
    // The first audio reached the client long before the last was made.
    expect(got.at(-1)!.at - got[0]!.at).toBeGreaterThanOrEqual(400)
    expect(got.flatMap((r) => r.bytes).length).toBe(16)
    expect(qwen.reqs[0]).toMatchObject({ stream: true, deadlineMs: 400 })

    const again = await post({ text: 'zh piece', language: 'zh-CN', stream: true })
    expect(again.headers.get('content-type')).toBe('audio/wav')
    expect(again.headers.get('x-walnut-tts-cached')).toBe('1')
    const wav = Buffer.from(await again.arrayBuffer())
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(40)).toBe(16)
    expect([0, 1, 6, 7].map((i) => wav.readInt16LE(44 + i * 2))).toEqual([1000, -1000, 4000, -4000])
    expect(qwen.reqs).toHaveLength(1)
  })

  it('no first audio within the local voice\'s budget: the usual engine reads the piece', async () => {
    plan = { firstMs: 2_000 }
    const t0 = Date.now()
    const res = await post({ text: 'slow piece', language: 'zh-CN', stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0xff, 0xf3, 9])
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(fallback.calls).toEqual(['slow piece'])
  })

  it('a break after audio went out only ends the response (cut, so the client\'s read fails); nothing is cached', async () => {
    plan = { chunks: 5, gapMs: 50, breakAfter: 2 }
    const res = await post({ text: 'broken piece', language: 'zh-CN', stream: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(L16)
    await expect(reads(res, Date.now())).rejects.toThrow()
    expect(fallback.calls).toEqual([])
    plan = {}
    const again = await post({ text: 'broken piece', language: 'zh-CN', stream: true })
    expect(again.headers.get('x-walnut-tts-cached')).toBe('0')
    await reads(again, Date.now())
  })

  it('a client that goes away mid-stream cancels the engine\'s stream, so the local voice stops the piece and is free', async () => {
    plan = { chunks: 100, gapMs: 100 }
    const abort = new AbortController()
    const res = await fetch(`http://localhost:${port}/api/v1/voice/speak`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'left piece', language: 'zh-CN', stream: true }), signal: abort.signal,
    })
    expect(res.headers.get('content-type')).toBe(L16)
    const reader = res.body!.getReader()
    await reader.read()
    abort.abort()
    await vi.waitFor(() => expect(qwen.cancels).toBe(1), { timeout: 5_000, interval: 50 })
    expect(qwen.reqs[0]!.signal!.aborted).toBe(true)
  })

  it('without stream the piece is whole, as before', async () => {
    const res = await post({ text: 'plain piece', language: 'zh-CN' })
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x52, 0x49, 0x46, 0x46])
    expect(qwen.reqs[0]!.stream).toBeUndefined()
  })
})
