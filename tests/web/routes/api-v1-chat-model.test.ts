/**
 * The chat composer's model pill, server side (PRIMARY box).
 *
 * A chat turn runs in the conversation's `claude` lane session, and that session
 * owns model + effort. So `GET /chat/engine` reports the lane (with no session id
 * until the conversation has had its first turn, because a picker must never spawn
 * a CLI just by being opened), and `PUT /chat/model` is a client bug: it answers
 * 409 `lane_engine` and names the session to switch instead, rather than writing a
 * second copy of "which model" that no turn would read.
 *
 * Real: Express server + the api-v1 routers, the conversation registry, the
 * conversation index on disk. Mocked: constants (temp dirs).
 *
 * Cloud twin (the same two routes relayed from a replica): api-v1-chat-model-cloud.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-chat-model'))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus } from '../../../src/core/event-bus.js'

let server: HttpServer
let port: number

/** A model that exists in the bedrock catalog and is NOT the configured default. */
const OTHER_MODEL = 'global.anthropic.claude-sonnet-4-6'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function boot(agent: Record<string, unknown>): Promise<void> {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    agent,
  }), 'utf-8')
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}

async function createConv(): Promise<string> {
  const res = await fetch(apiUrl('/api/v1/conversations'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(201)
  return (await res.json() as { id: string }).id
}

interface EngineBody {
  engine?: string
  sessionId?: string | null
  switchable?: boolean
  model?: string | null
  effort?: string | null
  models?: Array<{ id: string; label: string; supportsEffort?: boolean }>
}

async function getEngine(convId: string): Promise<{ status: number; body: EngineBody }> {
  const res = await fetch(apiUrl(`/api/v1/chat/engine?conversationId=${convId}`))
  return { status: res.status, body: await res.json().catch(() => ({})) as EngineBody }
}

async function putModel(convId: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(apiUrl(`/api/v1/chat/model?conversationId=${convId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
}

afterEach(async () => {
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the lane session owns the model, so the chat route refuses to store one', () => {
  it('PUT → 409 lane_engine, and GET reports the lane', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()

    const info = await getEngine(convId)
    expect(info.status).toBe(200)
    expect(info.body.engine).toBe('lane')
    // No lane exists before the first turn, so there is nothing to switch yet —
    // `switchable` is OMITTED rather than false (additive: no client's decode moves).
    expect(info.body.sessionId).toBeNull()
    expect(info.body.switchable).toBeUndefined()

    const res = await putModel(convId, { model: OTHER_MODEL })
    expect(res.status).toBe(409)
    expect((res.body.error as { code: string }).code).toBe('lane_engine')
    // The id to switch instead, both places a client might read it.
    expect(res.body).toHaveProperty('sessionId')
    expect((res.body.error as { sessionId?: unknown })).toHaveProperty('sessionId')
  }, 30_000)

  it('a malformed body is still a 400, checked before the engine question', async () => {
    await boot({ provider: 'claude-code' })
    const convId = await createConv()
    const res = await putModel(convId, {})
    expect(res.status).toBe(400)
    expect((res.body.error as { code: string }).code).toBe('bad_request')
  }, 30_000)

  it('404s an unknown conversation rather than inventing one', async () => {
    await boot({ provider: 'claude-code' })
    const res = await putModel('conv-ghost', { model: OTHER_MODEL })
    expect(res.status).toBe(404)
  }, 30_000)
})
