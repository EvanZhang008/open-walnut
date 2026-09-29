/** The phone's New chat launches an ASK: POST /api/v1/sessions { walnutAgent, agentId }.
 *
 *  The phone's Chat drawer and the Mac's Ask Walnut drawer list the same rows
 *  (GET /api/v1/asks, one rule in core/sessions/ask-list.ts). That only holds if
 *  an ask born on the phone is the SAME task as one born on the Mac, so this
 *  suite launches one from each surface against a real server and compares them:
 *  project, agent stamp, marker, tier, cwd, persona, and where each lands in the
 *  list. The ask half of both launches is core/sessions/ask-launch-plan.ts.
 *
 *  Also pinned: the relayed launch (what the cloud companion forwards to the
 *  Mac) makes the same ask; a client cwd is ignored; the Ask model memory
 *  applies to a phone launch that names none and moves on one that names one;
 *  a retry on an existing ask keeps its agent; every malformed ask body is a
 *  400 before anything is written.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-mobile-launch-ask'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { getTask, listTasks } from '../../src/core/task-manager.js'
import { handleLaunchRelayRequest } from '../../src/core/sessions/mobile-launch.js'
import { rememberAskWalnutLaunch } from '../../src/core/sessions/ask-walnut-launch.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function post(p: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

/** The web draft's Ask tab. */
async function webAsk(body: Record<string, unknown>): Promise<{ taskId: string; sessionId: string }> {
  const res = await post('/api/sessions/quick-start', { walnutAgent: true, ...body })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return { taskId: res.body.taskId, sessionId: res.body.sessionId }
}

/** The phone's New chat. */
async function phoneAsk(body: Record<string, unknown>): Promise<{ taskId: string; sessionId: string; title: string }> {
  const res = await post('/api/v1/sessions', { walnutAgent: true, ...body })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { taskId: res.body.taskId, sessionId: res.body.sessionId, title: res.body.title }
}

async function asks(agentId: string): Promise<{ project: string; total: number; asks: Array<Record<string, any>> }> {
  const res = await fetch(apiUrl(`/api/v1/asks?agentId=${agentId}`))
  expect(res.status).toBe(200)
  return res.json() as Promise<{ project: string; total: number; asks: Array<Record<string, any>> }>
}

async function launchMemory(): Promise<{ model?: string }> {
  const res = await fetch(apiUrl('/api/sessions/ask-walnut-launch'))
  expect(res.status).toBe(200)
  return res.json() as Promise<{ model?: string }>
}

/** The spawn persists cliModel asynchronously: poll until the record says it spawned. */
async function spawnedCliModel(sessionId: string): Promise<string | undefined> {
  let seen: string | undefined
  await vi.waitFor(async () => {
    const record = await getSessionByClaudeId(sessionId)
    expect(record?.pid).toBeTruthy()
    seen = record!.cliModel
  }, { timeout: 10_000 })
  return seen
}

/**
 * What makes two asks "the same kind of task" on every board and drawer. The
 * title is left out: auto-titling may rename either one after its first turn,
 * so the placeholder is checked on the launch answer instead.
 */
async function askShape(taskId: string): Promise<Record<string, unknown>> {
  const t = await getTask(taskId)
  return {
    project: t.project,
    agent_id: t.agent_id,
    walnut_agent: t.walnut_agent,
    pinned: t.pinned,
    focus_tier: t.focus_tier,
    cwd: t.cwd,
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15))

/**
 * Wait until a launch's session has come up and linked to its task. The
 * drawer's activity stamp (last_session_update) is written by that link, which
 * lands when the CLI is ready, not when the launch answered: two launches in a
 * row can link in either order under load. Waiting here makes "launched later"
 * mean "linked later", which is what the order below is about.
 */
async function linked(ask: { taskId: string; sessionId: string }): Promise<void> {
  await vi.waitFor(async () => {
    const t = await getTask(ask.taskId)
    expect(t.session_id).toBe(ask.sessionId)
    expect(t.last_session_update).toBeTruthy()
  }, { timeout: 15_000 })
  await tick()
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// Every test states its own memory precondition; none leans on a sibling's.
beforeEach(async () => { await rememberAskWalnutLaunch({ model: undefined, effort: undefined }) })

describe('POST /api/v1/sessions { walnutAgent }: a phone-born ask', () => {
  it('is the same task as a web-born one, and lands on top of GET /api/v1/asks', async () => {
    const web = await webAsk({ agentId: 'mentor', message: 'web born: plan the week' })
    await linked(web)
    const phone = await phoneAsk({ agentId: 'mentor', message: 'phone born: plan the week' })
    expect(phone.sessionId).toBeTruthy()
    await linked(phone)
    expect(phone.title).toBe('Ask Mentor')

    const phoneShape = await askShape(phone.taskId)
    expect(phoneShape).toEqual(await askShape(web.taskId))
    expect(phoneShape).toEqual({
      project: 'Ask Mentor', agent_id: 'mentor', walnut_agent: true,
      pinned: true, focus_tier: 'focus', cwd: WALNUT_HOME,
    })

    // Both sessions run the Mentor persona in the server's home, as visible
    // task sessions (not hidden chat lanes).
    for (const sid of [web.sessionId, phone.sessionId]) {
      const record = await getSessionByClaudeId(sid)
      expect(record!.cwd).toBe(WALNUT_HOME)
      expect(record!.profile?.systemPrompt).toContain('You are Mentor')
      expect(record!.profile?.systemPrompt).not.toContain('You are Walnut,')
      expect(Object.keys(record!.profile?.mcpServers ?? {})).toContain('walnut')
      expect(record!.lane).toBeFalsy()
    }

    // Newest use first: the phone's ask on top, the web's right under it.
    const list = await asks('mentor')
    expect(list.project).toBe('Ask Mentor')
    expect(list.asks.slice(0, 2).map((a) => a.id)).toEqual([phone.taskId, web.taskId])
    expect(list.asks[0].sessionId).toBe(phone.sessionId)
    expect(typeof list.asks[0].title).toBe('string')
    expect(['running', 'idle']).toContain(list.asks[0].state)
    // Another agent's list never shows it.
    expect((await asks('general')).asks.map((a) => a.id)).not.toContain(phone.taskId)
  })

  it('names no agent: a Walnut ask, filed under Ask Walnut with no stamp, on top of the general list', async () => {
    const web = await webAsk({ message: 'web born: what is on my plate' })
    await linked(web)
    const phone = await phoneAsk({ message: 'phone born: what is on my plate' })
    await linked(phone)
    expect(await askShape(phone.taskId)).toEqual(await askShape(web.taskId))
    const t = await getTask(phone.taskId)
    expect(t.project).toBe('Ask Walnut')
    expect(t.agent_id).toBeUndefined()
    expect((await getSessionByClaudeId(phone.sessionId))!.profile?.systemPrompt).toContain('Personal AI')
    expect((await asks('general')).asks.slice(0, 2).map((a) => a.id)).toEqual([phone.taskId, web.taskId])
  })

  it('ignores a client cwd: an ask runs in the server home', async () => {
    const phone = await phoneAsk({ message: 'where do you run?', cwd: '/tmp/somewhere-else' })
    expect((await getTask(phone.taskId)).cwd).toBe(WALNUT_HOME)
    expect((await getSessionByClaudeId(phone.sessionId))!.cwd).toBe(WALNUT_HOME)
  })

  it('the relayed launch (what the cloud companion forwards) makes the same ask on the Mac', async () => {
    const relayed = await handleLaunchRelayRequest('launch', { walnutAgent: true, agentId: 'mentor', message: 'relayed: journal' })
    expect(relayed.ok, JSON.stringify(relayed)).toBe(true)
    const result = (relayed as { ok: true; result: Record<string, string> }).result
    expect(result.sessionId).toBeTruthy()
    const web = await webAsk({ agentId: 'mentor', message: 'web born: journal' })
    const shape = await askShape(result.taskId)
    expect(shape).toEqual(await askShape(web.taskId))
    expect((await getSessionByClaudeId(result.sessionId))!.profile?.systemPrompt).toContain('You are Mentor')

    // A refusal travels back as a precise 4xx kind, never a thrown relay.
    const refused = await handleLaunchRelayRequest('launch', { walnutAgent: true, agentId: 'no-such-agent', message: 'x' })
    expect(refused).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })

  it('a retry on an existing Mentor ask that names no agent keeps the Mentor persona', async () => {
    const first = await phoneAsk({ agentId: 'mentor', message: 'first' })
    const retry = await phoneAsk({ taskId: first.taskId, message: 'again' })
    expect(retry.taskId).toBe(first.taskId)
    const record = await getSessionByClaudeId(retry.sessionId)
    expect(record!.profile?.systemPrompt).toContain('You are Mentor')
    expect((await getTask(first.taskId)).agent_id).toBe('mentor')
  })
})

describe('POST /api/v1/sessions { walnutAgent }: the Ask model memory', () => {
  it('a phone ask that names no model starts on the model last picked for an ask', async () => {
    await webAsk({ message: 'pick sonnet on the Mac', model: 'sonnet' })
    await vi.waitFor(async () => expect((await launchMemory()).model).toBe('sonnet'))
    const phone = await phoneAsk({ message: 'no model named on the phone' })
    expect(await spawnedCliModel(phone.sessionId)).toBe('sonnet')
    // Naming none never erases it.
    expect((await launchMemory()).model).toBe('sonnet')
  })

  it("a phone pick moves the memory, and 'default' (Auto) clears it", async () => {
    const picked = await phoneAsk({ message: 'pick haiku on the phone', model: 'haiku' })
    expect(await spawnedCliModel(picked.sessionId)).toBe('haiku')
    await vi.waitFor(async () => expect((await launchMemory()).model).toBe('haiku'))

    const auto = await phoneAsk({ message: 'back to auto', model: 'default' })
    expect(await spawnedCliModel(auto.sessionId)).toBeUndefined()
    await vi.waitFor(async () => expect((await launchMemory()).model).toBeUndefined())
  })

  it('an ordinary phone launch never touches it', async () => {
    await rememberAskWalnutLaunch({ model: 'sonnet' })
    const res = await post('/api/v1/sessions', { cwd: WALNUT_HOME, message: 'refactor the parser', model: 'haiku' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect((await getTask(res.body.taskId)).walnut_agent).toBeUndefined()
    await tick()
    expect((await launchMemory()).model).toBe('sonnet')
  })
})

describe('POST /api/v1/sessions { walnutAgent }: refusals', () => {
  it('every malformed ask body is a 400 bad_request, and nothing is written', async () => {
    const before = (await listTasks()).length
    for (const [body, message] of [
      [{ agentId: 'mentor', cwd: WALNUT_HOME, message: 'hi' }, 'requires walnutAgent'],
      [{ walnutAgent: true, agentId: 'no-such-agent', message: 'hi' }, 'Unknown console agent'],
      [{ walnutAgent: true, agentId: 42, message: 'hi' }, 'agentId must be'],
      [{ walnutAgent: true, agentId: '  ', message: 'hi' }, 'agentId must be'],
      [{ walnutAgent: 'yes', message: 'hi' }, 'walnutAgent must be a boolean'],
      [{ walnutAgent: true, host: 'devbox', message: 'hi' }, 'run on the server host'],
      // Not an ask: the ordinary launch still needs its cwd.
      [{ walnutAgent: false, message: 'hi' }, 'cwd is required'],
    ] as const) {
      const res = await post('/api/v1/sessions', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error?.code, JSON.stringify(body)).toBe('bad_request')
      expect(res.body.error?.message, JSON.stringify(body)).toContain(message)
    }
    expect((await listTasks()).length).toBe(before)
  })
})
