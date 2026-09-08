/**
 * The chat composer's model pill, server side (PRIMARY box).
 *
 * The pill used to be a read-only label whose reason was "the model comes from the
 * server's config". That is only true of the IN-PROCESS engine, and even there it
 * is a choice the user should be able to make per conversation without opening
 * Settings. So the in-process engine now reports `switchable: true` plus the
 * catalog it can actually run, PUT /chat/model persists the pick on the
 * conversation row, and the next turn runs on it.
 *
 * The LANE engine keeps the opposite rule: the `claude` session owns model+effort,
 * so a PUT here is a client bug and answers 409 `lane_engine` rather than writing a
 * second copy of "which model" that no turn would read.
 *
 * Real: Express server + the api-v1 routers, the conversation registry, the
 * conversation index on disk, the turn queue. Mocked: constants (temp dirs) and
 * the agent loop — a spy, which is also how the turn's model is observed (there is
 * no other honest way to prove which model a turn would have used).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-chat-model'))

const runAgentLoop = vi.fn(async (userContent: string | unknown[], history: unknown[]) => ({
  messages: [
    ...(history as Array<{ role: string; content: unknown }>),
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'in-process response' }] },
  ],
  newMessages: [
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'in-process response' }] },
  ],
  response: 'in-process response',
  aborted: false,
}))

vi.mock('../../../src/agent/loop.js', () => ({ runAgentLoop }))

import type { Server as HttpServer } from 'node:http'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus } from '../../../src/core/event-bus.js'

let server: HttpServer
let port: number

/** A model that exists in the bedrock catalog and is NOT the configured default. */
const DEFAULT_MODEL = 'global.anthropic.claude-opus-4-8'
const OTHER_MODEL = 'global.anthropic.claude-sonnet-4-6'

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/**
 * `provider` is set EXPLICITLY on both keys. The engine otherwise follows whether
 * a `claude` binary exists on the machine running the test, which would make the
 * in-process cases pass or fail depending on the developer's laptop; `main_provider`
 * pins the model catalog for the same reason.
 */
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

const IN_PROCESS_AGENT = {
  provider: 'walnut-agent',
  main_provider: 'bedrock',
  main_model: DEFAULT_MODEL,
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

async function postMessage(convId: string, text: string): Promise<Response> {
  return fetch(apiUrl(`/api/v1/conversations/${convId}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
}

/** The modelConfig the loop was actually called with on its Nth turn. */
function turnModelConfig(call = 0): { model?: string } | undefined {
  const options = runAgentLoop.mock.calls[call]?.[3] as { modelConfig?: { model?: string } } | undefined
  return options?.modelConfig
}

beforeEach(() => {
  runAgentLoop.mockClear()
})

afterEach(async () => {
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('in-process engine: the model is per-conversation and switchable', () => {
  it('reports switchable + a catalog, persists a pick, runs the turn on it, and clears back', async () => {
    await boot(IN_PROCESS_AGENT)
    const convId = await createConv()

    // ── The pill's data. `switchable` is the whole point: read-only was the bug.
    const before = await getEngine(convId)
    expect(before.status).toBe(200)
    expect(before.body.engine).toBe('in-process')
    expect(before.body.sessionId).toBeNull()
    expect(before.body.switchable).toBe(true)
    expect(before.body.model).toBe(DEFAULT_MODEL)
    expect(before.body.effort).toBeNull()
    expect((before.body.models ?? []).length).toBeGreaterThan(0)
    // Rows are ids this loop can resolve, in the picker's item shape.
    expect(before.body.models!.map((m) => m.id)).toContain(OTHER_MODEL)
    expect(before.body.models!.every((m) => typeof m.label === 'string' && m.label.length > 0)).toBe(true)

    // ── The pick persists…
    const set = await putModel(convId, { model: OTHER_MODEL })
    expect(set.status).toBe(200)
    expect(set.body).toEqual({ model: OTHER_MODEL, effort: null })

    // …and is what GET reports as effective (the client renders the pill from this).
    const after = await getEngine(convId)
    expect(after.body.model).toBe(OTHER_MODEL)

    // ── The turn actually runs on it. Anything less makes the picker decorative.
    expect((await postMessage(convId, 'which model are you')).status).toBe(202)
    await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(1), { timeout: 15_000 })
    expect(turnModelConfig()?.model).toBe(OTHER_MODEL)

    // ── null clears: back to the config default, and no modelConfig is forced on
    // the loop (it builds its own, exactly as before this field existed).
    const cleared = await putModel(convId, { model: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body).toEqual({ model: null, effort: null })
    expect((await getEngine(convId)).body.model).toBe(DEFAULT_MODEL)

    expect((await postMessage(convId, 'and now')).status).toBe(202)
    await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(2), { timeout: 15_000 })
    expect(turnModelConfig(1)).toBeUndefined()
  }, 40_000)

  it('the override is scoped to ONE conversation', async () => {
    await boot(IN_PROCESS_AGENT)
    const mine = await createConv()
    const other = await createConv()

    expect((await putModel(mine, { model: OTHER_MODEL })).status).toBe(200)
    expect((await getEngine(mine)).body.model).toBe(OTHER_MODEL)
    expect((await getEngine(other)).body.model).toBe(DEFAULT_MODEL)
  }, 30_000)

  it('rejects a model outside the catalog instead of persisting a turn that would 400 at the wire', async () => {
    await boot(IN_PROCESS_AGENT)
    const convId = await createConv()

    const bad = await putModel(convId, { model: 'totally-made-up-model' })
    expect(bad.status).toBe(400)
    expect((bad.body.error as { code: string }).code).toBe('unknown_model')
    // Nothing was written: the conversation still answers on the default.
    expect((await getEngine(convId)).body.model).toBe(DEFAULT_MODEL)

    // A lane switch string is exactly the kind of id that must NOT pass here: the
    // CLI resolves 'sonnet-1m', the in-process provider adapter cannot.
    expect((await putModel(convId, { model: 'sonnet-1m' })).status).toBe(400)
  }, 30_000)

  it('accepts and persists effort, and says nothing false about it', async () => {
    await boot(IN_PROCESS_AGENT)
    const convId = await createConv()

    const set = await putModel(convId, { effort: 'low' })
    expect(set.status).toBe(200)
    expect(set.body).toEqual({ model: null, effort: 'low' })
    expect((await getEngine(convId)).body.effort).toBe('low')
    // Honest about the no-op: the in-process loop has no effort concept, so no row
    // claims to support one and nothing is threaded into the turn.
    expect((await getEngine(convId)).body.models!.every((m) => m.supportsEffort === false)).toBe(true)

    expect((await postMessage(convId, 'think hard')).status).toBe(202)
    await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(1), { timeout: 15_000 })
    expect(turnModelConfig()).toBeUndefined()

    // An unknown level is a 400, not a silently stored string.
    expect((await putModel(convId, { effort: 'turbo' })).status).toBe(400)
    expect((await getEngine(convId)).body.effort).toBe('low')
  }, 40_000)

  it('an empty body is a 400 (a no-op PUT would look like a successful switch)', async () => {
    await boot(IN_PROCESS_AGENT)
    const convId = await createConv()
    const res = await putModel(convId, {})
    expect(res.status).toBe(400)
    expect((res.body.error as { code: string }).code).toBe('bad_request')
  }, 30_000)

  it('404s an unknown conversation rather than inventing one', async () => {
    await boot(IN_PROCESS_AGENT)
    const res = await putModel('conv-ghost', { model: OTHER_MODEL })
    expect(res.status).toBe(404)
  }, 30_000)
})

/**
 * The PRIMARY half of the relay, driven through the real control-relay entry point
 * (the cloud twin's fake daemon cannot exercise this side). `server.chat.model` has
 * to be reachable by name and has to write the row a later turn reads.
 */
describe('server.chat.model on the primary (what a replica reaches)', () => {
  it('writes the override, even for a conversation this box has never seen', async () => {
    await boot(IN_PROCESS_AGENT)
    const { handleSessionControlRelay } = await import('../../../src/core/sessions/session-controls.js')
    const { getConversationModel } = await import('../../../src/core/conversations.js')

    // A conversation the phone created on the REPLICA. Its index row may not have
    // synced here yet, and waiting for git-sync is lossy — the handler adopts it
    // rather than answering "not found" for a conversation that really exists.
    const replicaConvId = 'conv-11111111-2222-3333-4444-555555555555'
    const reply = await handleSessionControlRelay('server.chat.model', '__server__', {
      agentId: 'general', conversationId: replicaConvId, model: OTHER_MODEL,
    })
    expect(reply).toEqual({ ok: true, result: { model: OTHER_MODEL, effort: null } })
    expect(await getConversationModel('general', replicaConvId)).toEqual({ model: OTHER_MODEL })
  }, 30_000)

  it('an unknown model comes back as a 400-class refusal, not a 500', async () => {
    await boot(IN_PROCESS_AGENT)
    const { handleSessionControlRelay } = await import('../../../src/core/sessions/session-controls.js')
    const convId = await createConv()
    const reply = await handleSessionControlRelay('server.chat.model', '__server__', {
      agentId: 'general', conversationId: convId, model: 'not-a-model',
    })
    expect(reply.ok).toBe(false)
    expect(reply).toMatchObject({ errorKind: 'bad_request', errorCode: 'unknown_model' })
  }, 30_000)
})

describe('lane engine: the session owns the model, so the chat route refuses', () => {
  it('PUT → 409 lane_engine, and GET keeps its shape', async () => {
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
    expect(runAgentLoop).not.toHaveBeenCalled()
  }, 30_000)
})
