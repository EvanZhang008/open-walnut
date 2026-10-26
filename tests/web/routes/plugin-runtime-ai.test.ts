/**
 * `walnut.ai` from a plugin App over HTTP (src/web/routes/plugin-runtime.ts): POST .../ai/run
 * streams NDJSON (text deltas, then one result or error line), a client that goes away cancels
 * the run, and GET/PATCH .../ai are the Settings row (switch, budget, spend). The model is the
 * direct-route override; the real aiRun, policy and spend store run in an isolated home.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-plugin-runtime-ai'))

import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'
import { setAiDirectOverride, type DirectCall } from '../../../src/core/ai/ai-direct.js'
import { createMockPlugin } from '../../core/plugin-test-utils.js'

function pluginApp(cloudMode = false) {
  const registry = new IntegrationRegistry()
  registry.register('tickets', createMockPlugin({ id: 'tickets', name: 'Tickets' }))
  const records: PluginLifecycleRecord[] = [{ id: 'tickets', name: 'Tickets', state: 'active', builtin: false, failureCount: 0 }]
  const app = express()
  app.use(express.json({ limit: '15mb' }))
  app.use('/api/plugin-runtime', createPluginRuntimeRouter({
    registry, list: () => records, discover: vi.fn(), reload: vi.fn(), disable: vi.fn(), clearQuarantine: vi.fn(), cloudMode,
  } as unknown as Parameters<typeof createPluginRuntimeRouter>[0]))
  return app
}

function lines(text: string): Array<Record<string, unknown>> {
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

let calls: DirectCall[] = []
afterEach(() => { setAiDirectOverride(null); calls = [] })

describe('POST /api/plugin-runtime/:id/ai/run', () => {
  it('streams the deltas, then the result; the call is interactive and billed to the plugin', async () => {
    setAiDirectOverride(async (call) => {
      calls.push(call)
      call.onText?.('Login ')
      call.onText?.('fails on Safari.')
      return { text: 'Login fails on Safari.', engine: 'claude', model: 'haiku', costUsd: 0.002 }
    })
    const res = await request(pluginApp()).post('/api/plugin-runtime/tickets/ai/run')
      .send({ prompt: 'Summarize', context: { title: 'Login broken', body: 'Safari only' }, effort: 'quick' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    const out = lines(res.text)
    expect(out.slice(0, 2)).toEqual([{ type: 'text', delta: 'Login ' }, { type: 'text', delta: 'fails on Safari.' }])
    expect(out[2]).toMatchObject({ type: 'result', text: 'Login fails on Safari.', route: 'direct', engine: 'claude', costUsd: 0.002 })
    expect(out).toHaveLength(3)
    expect(calls[0].interactive).toBe(true)
    expect(calls[0].effort).toBe('quick')
    expect(calls[0].ledgerAgentId).toBe('plugin:tickets')
    expect(calls[0].prompt).toContain('Safari only')

    const row = await request(pluginApp()).get('/api/plugin-runtime/tickets/ai')
    expect(row.body).toMatchObject({ enabled: true, monthlyUsd: 10, calls: 1 })
    expect(row.body.spentUsd).toBeCloseTo(0.002)
  })

  it('answers a refusal as an error line with its code', async () => {
    const res = await request(pluginApp()).post('/api/plugin-runtime/tickets/ai/run').send({ prompt: '' })
    expect(lines(res.text)).toEqual([{ type: 'error', code: 'ai_bad_request', message: 'ai.run needs a prompt' }])
  })

  it('refuses an inactive plugin and the companion', async () => {
    expect((await request(pluginApp()).post('/api/plugin-runtime/nope/ai/run').send({ prompt: 'x' })).status).toBe(404)
    expect((await request(pluginApp(true)).post('/api/plugin-runtime/tickets/ai/run').send({ prompt: 'x' })).status).toBe(503)
  })

  it('switched off in Settings, the next call is refused with ai_disabled', async () => {
    const app = pluginApp()
    const off = await request(app).patch('/api/plugin-runtime/tickets/ai').send({ enabled: false, monthlyUsd: 3 })
    expect(off.body).toEqual({ enabled: false, monthlyUsd: 3 })
    setAiDirectOverride(async (call) => { calls.push(call); return { text: 'x', engine: 'claude' } })
    const res = await request(app).post('/api/plugin-runtime/tickets/ai/run').send({ prompt: 'x' })
    expect(lines(res.text)[0]).toMatchObject({ type: 'error', code: 'ai_disabled' })
    expect(calls).toHaveLength(0)
    expect((await request(app).patch('/api/plugin-runtime/tickets/ai').send({ monthlyUsd: -1 })).status).toBe(400)
    await request(app).patch('/api/plugin-runtime/tickets/ai').send({ enabled: true, monthlyUsd: 10 })
  })

  describe('a client that goes away', () => {
    let server: Server
    let port = 0
    beforeAll(async () => {
      server = pluginApp().listen(0)
      await new Promise((r) => server.once('listening', r))
      port = (server.address() as AddressInfo).port
    })
    afterAll(() => new Promise<void>((r) => server.close(() => r())))

    it('cancels the run', async () => {
      let seenAbort: (() => void) | null = null
      const aborted = new Promise<void>((resolve) => { seenAbort = resolve })
      setAiDirectOverride((call) => new Promise((_resolve, reject) => {
        call.onText?.('partial')
        call.signal?.addEventListener('abort', () => { seenAbort?.(); reject(new Error('aborted')) }, { once: true })
      }))
      const controller = new AbortController()
      const res = await fetch(`http://127.0.0.1:${port}/api/plugin-runtime/tickets/ai/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'long' }), signal: controller.signal,
      })
      const reader = res.body!.getReader()
      const first = new TextDecoder().decode((await reader.read()).value)
      expect(JSON.parse(first.trim())).toEqual({ type: 'text', delta: 'partial' })
      controller.abort()
      await expect(Promise.race([aborted.then(() => 'aborted'), new Promise((r) => setTimeout(() => r('still running'), 5_000))])).resolves.toBe('aborted')
    })
  })
})
