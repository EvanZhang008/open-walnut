/**
 * App state over HTTP: a plugin App publishes with POST
 * /api/plugin-runtime/:pluginId/app-state, clears with DELETE, and the session
 * beside it reads the whole state with GET /api/v1/me/app-state (the
 * `app_state` op). The rules of what a session is told are in
 * tests/core/sessions/app-state.test.ts; this pins the wire: status codes, who
 * may publish, and that the op reaches the caller's own task.
 *
 * Real startServer({ port: 0, dev: true }) and a real task store and session
 * registry in an isolated home. The plugin router is mounted on its own with a
 * registered mock plugin, the way plugin-runtime.test.ts does.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-plugin-app-state'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { IntegrationRegistry } from '../../../src/core/integration-registry.js'
import type { PluginLifecycleRecord } from '../../../src/core/plugins/plugin-manager.js'
import { createPluginRuntimeRouter } from '../../../src/web/routes/plugin-runtime.js'
import { MAX_STATE_BYTES, resetAppStateForTesting } from '../../../src/core/sessions/app-state.js'
import { executeOp } from '../../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../../src/lib/caller-origin.js'
import { createMockPlugin } from '../../core/plugin-test-utils.js'
import '../../../src/ops/index.js'

let server: HttpServer
let port: number
const apiBase = () => `http://localhost:${port}/api/v1`

function pluginApp(state: PluginLifecycleRecord['state'] = 'active', cloudMode = false) {
  const registry = new IntegrationRegistry()
  registry.register('practice', createMockPlugin({ id: 'practice', name: 'Practice' }))
  const records: PluginLifecycleRecord[] = [{ id: 'practice', name: 'Practice', state, builtin: false, failureCount: 0 }]
  const app = express()
  app.use(express.json({ limit: '15mb' }))
  app.use('/api/plugin-runtime', createPluginRuntimeRouter({
    registry,
    list: () => records,
    discover: vi.fn(),
    reload: vi.fn(),
    disable: vi.fn(),
    clearQuarantine: vi.fn(),
    cloudMode,
  } as unknown as Parameters<typeof createPluginRuntimeRouter>[0]))
  return app
}

let seq = 0
async function seedSession() {
  seq += 1
  const { task } = await addTask({ title: `Mock interview ${seq}`, project: 'Interview Practice' })
  const sid = `33333333-4444-5555-6666-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, 'Interview Practice', '/tmp/ws', { title: task.title })
  return { taskId: task.id, sid }
}

async function meAppState(sid?: string) {
  const res = await fetch(`${apiBase()}/me/app-state`, { headers: sid ? { 'x-walnut-caller-sid': sid } : {} })
  expect(res.status).toBe(200)
  return await res.json() as { taskId: string | null; states: Array<Record<string, unknown>> }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
})
afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})
beforeEach(() => resetAppStateForTesting())

describe('publishing app state over HTTP', () => {
  it('an active plugin publishes; the session reads it whole; DELETE takes it away', async () => {
    const { taskId, sid } = await seedSession()
    const app = pluginApp()
    const published = await request(app).post('/api/plugin-runtime/practice/app-state')
      .send({ taskId, state: { level: 2, files: { 'solution.py': 'x = 1' } }, label: 'Interview Practice', note: 'No spoilers.' })
      .expect(200)
    expect(published.body).toEqual({ version: expect.any(Number), kept: true })

    const read = await meAppState(sid)
    expect(read).toMatchObject({
      taskId,
      states: [{ plugin: 'practice', label: 'Interview Practice', note: 'No spoilers.', state: { level: 2, files: { 'solution.py': 'x = 1' } } }],
    })

    await request(app).delete(`/api/plugin-runtime/practice/app-state/${encodeURIComponent(taskId)}`).expect(200, { ok: true })
    expect((await meAppState(sid)).states).toEqual([])
  })

  it('the label defaults to the plugin name', async () => {
    const { taskId, sid } = await seedSession()
    await request(pluginApp()).post('/api/plugin-runtime/practice/app-state').send({ taskId, state: { a: 1 } }).expect(200)
    expect((await meAppState(sid)).states[0]).toMatchObject({ label: 'Practice' })
  })

  it('refuses what it cannot keep, with a status the App can act on', async () => {
    const { taskId } = await seedSession()
    const app = pluginApp()
    const post = (body: Record<string, unknown>) => request(app).post('/api/plugin-runtime/practice/app-state').send(body)
    expect((await post({ taskId: 'mt-missing', state: { a: 1 } })).status).toBe(404)
    expect((await post({ taskId, state: [1] })).status).toBe(400)
    expect((await post({ taskId, state: { a: 1 }, mode: 'loud' })).status).toBe(400)
    expect((await post({ state: { a: 1 } })).status).toBe(400)
    const big = await post({ taskId, state: { big: 'x'.repeat(MAX_STATE_BYTES) } })
    expect(big.status).toBe(413)
    expect(big.body.error).toContain(`limit is ${MAX_STATE_BYTES}`)
  })

  it('a plugin that is not active cannot publish; a replica keeps nothing', async () => {
    const { taskId, sid } = await seedSession()
    await request(pluginApp('disabled')).post('/api/plugin-runtime/practice/app-state').send({ taskId, state: { a: 1 } }).expect(404)
    await request(pluginApp('active')).post('/api/plugin-runtime/other/app-state').send({ taskId, state: { a: 1 } }).expect(404)
    const replica = await request(pluginApp('active', true)).post('/api/plugin-runtime/practice/app-state').send({ taskId, state: { a: 1 } }).expect(200)
    expect(replica.body).toEqual({ version: 0, kept: false })
    expect((await meAppState(sid)).states).toEqual([])
  })
})

describe('the app_state op', () => {
  it('reads the caller task only, and says how many Apps share', async () => {
    const mine = await seedSession()
    const other = await seedSession()
    const app = pluginApp()
    await request(app).post('/api/plugin-runtime/practice/app-state').send({ taskId: mine.taskId, state: { mine: true } }).expect(200)
    await request(app).post('/api/plugin-runtime/practice/app-state').send({ taskId: other.taskId, state: { other: true } }).expect(200)

    const r = await executeOp('app_state', {}, { apiBase: apiBase(), callerSid: mine.sid, origin: LOCAL_ORIGIN })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const out = (r as { result: Record<string, any> }).result
    expect(out.taskId).toBe(mine.taskId)
    expect(out.states).toHaveLength(1)
    expect(out.states[0].state).toEqual({ mine: true })
    expect(JSON.stringify(out)).toContain('One App shares state about your task.')
  })

  it('a caller with no session, or a session with nothing shared, reads nothing', async () => {
    expect(await meAppState()).toEqual({ taskId: null, states: [] })
    expect(await meAppState('not-a-session')).toEqual({ taskId: null, states: [] })
    const { sid, taskId } = await seedSession()
    const r = await executeOp('app_state', {}, { apiBase: apiBase(), callerSid: sid, origin: LOCAL_ORIGIN })
    expect(r.ok).toBe(true)
    const out = (r as { result: Record<string, any> }).result
    expect(out).toMatchObject({ taskId, states: [] })
    expect(JSON.stringify(out)).toContain('No App shares state about your task.')
  })
})
