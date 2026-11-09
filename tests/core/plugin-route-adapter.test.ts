import express from 'express'
import request from 'supertest'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createPluginHttpRoute } from '../../src/core/plugins/plugin-route-adapter.js'

describe('Plugin route adapter', () => {
  it('preserves the exact raw body while also parsing JSON on demand', async () => {
    const raw = '{\n  "event": "created",\n  "count": 2\n}\n'
    const route = createPluginHttpRoute('POST', '/webhook', async (pluginRequest) => ({
      json: {
        text: await pluginRequest.text(),
        parsed: await pluginRequest.json(),
      },
    }))
    const app = express()
    app.use('/webhook', express.raw({ type: '*/*' }), route.handler)

    const response = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200)

    expect(response.body).toEqual({
      text: raw,
      parsed: { event: 'created', count: 2 },
    })
  })

  it('returns non-JSON request text unchanged', async () => {
    const route = createPluginHttpRoute('POST', '/webhook', async (pluginRequest) => ({
      text: await pluginRequest.text(),
    }))
    const app = express()
    app.use('/webhook', express.raw({ type: '*/*' }), route.handler)

    await request(app)
      .post('/webhook')
      .set('Content-Type', 'text/plain')
      .send('signed payload\n')
      .expect(200, 'signed payload\n')
  })

  it('supports an already-parsed body in standalone hosts', async () => {
    const route = createPluginHttpRoute('POST', '/webhook', async (pluginRequest) => ({
      json: {
        text: await pluginRequest.text(),
        parsed: await pluginRequest.json(),
      },
    }))
    const app = express()
    app.use(express.json())
    app.use('/webhook', route.handler)

    await request(app)
      .post('/webhook')
      .send({ ready: true })
      .expect(200, {
        text: '{"ready":true}',
        parsed: { ready: true },
      })
  })
  it('returns binary bytes and range headers without text conversion', async () => {
    const bytes = Buffer.from([0, 255, 128, 65])
    const route = createPluginHttpRoute('GET', '/media', async () => ({
      status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/4' }, body: bytes,
    }))
    const app = express(); app.use('/media', route.handler)
    const response = await request(app).get('/media').buffer(true).parse((response, done) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => done(null, Buffer.concat(chunks)))
    }).expect(206)
    expect(response.body).toEqual(bytes)
    expect(response.headers['content-range']).toBe('bytes 0-3/4')
  })

  it('streams ordered chunks lazily and closes the source after completion', async () => {
    let closed = false
    const route = createPluginHttpRoute('GET', '/media', async () => ({
      headers: { 'Content-Type': 'text/plain' },
      body: (async function* () {
        try { yield Buffer.from('first'); yield Buffer.from('second') }
        finally { closed = true }
      })(),
    }))
    const app = express(); app.use('/media', route.handler)
    await request(app).get('/media').expect(200, 'firstsecond')
    expect(closed).toBe(true)
  })

  it('answers HEAD with metadata without reading the lazy media body', async () => {
    let reads = 0, closed = false
    const route = createPluginHttpRoute('GET', '/media', async () => ({
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '400000' },
      body: {
        [Symbol.asyncIterator]() {
          return {
            async next() { reads++; throw new Error('HEAD must not fetch media chunks') },
            async return() { closed = true; return { done: true as const, value: undefined } },
          }
        },
      },
    }))
    const app = express(); app.use('/media', route.handler)
    const response = await request(app).head('/media').expect(200)
    expect(response.headers['content-length']).toBe('400000')
    expect(response.text).toBeUndefined()
    expect(reads).toBe(0)
    expect(closed).toBe(true)
  })

  it('aborts the producer when the browser closes the response and the next read is pending', async () => {
    let closed = false, aborted = false
    const route = createPluginHttpRoute('GET', '/media', async (pluginRequest) => ({
      headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: 1000,
      body: (async function* () {
        try {
          yield Buffer.from('first')
          await new Promise<void>((resolve) => {
            if (pluginRequest.signal.aborted) resolve()
            else pluginRequest.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
          })
        } finally { closed = true }
      })(),
    }))
    const app = express(); app.use('/media', route.handler)
    const server = createServer(app)
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()) })
    try {
      const address = server.address() as { port: number }
      const controller = new AbortController()
      const response = await fetch(`http://127.0.0.1:${address.port}/media`, { signal: controller.signal })
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
      controller.abort()
      await expect.poll(() => aborted && closed).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('ends a stalled stream at its deadline and allows a later request', async () => {
    let aborted = false
    const route = createPluginHttpRoute('GET', '/media', async (pluginRequest) => ({
      timeoutMs: 20,
      body: (async function* () {
        yield Buffer.from('first')
        await new Promise<void>((resolve) => pluginRequest.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      })(),
    }))
    const app = express(); app.use('/media', route.handler); app.get('/ready', (_request, response) => response.send('ready'))
    await request(app).get('/media').then(() => { throw new Error('Expected truncated stream') }, () => {})
    expect(aborted).toBe(true)
    await request(app).get('/ready').expect(200, 'ready')
  })

})
