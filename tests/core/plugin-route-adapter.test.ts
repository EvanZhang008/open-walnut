import express from 'express'
import request from 'supertest'
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
})
