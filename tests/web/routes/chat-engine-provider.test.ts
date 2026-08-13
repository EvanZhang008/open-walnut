/**
 * Chat engine selection (`config.agent.provider`) — which engine answers a turn.
 *
 * The flag is a FORK in the chat RPC, so the two things worth asserting are that
 * each branch runs and that the other one does NOT:
 *   - default / 'walnut-agent' → the in-process loop runs, no lane is touched
 *   - 'claude-code'            → the turn goes to the conversation's lane session,
 *                                the RPC answers `laneSessionId`, and the loop is
 *                                never called
 * Plus the invariant that must hold on BOTH branches: the user's message is
 * persisted before the engine runs (it survives a refresh either way).
 *
 * What's real: Express server, WS RPC, chat handler, session records, lane module.
 * What's mocked: constants.js (temp dir), the agent loop (spy), and the
 * 'session-runner' bus subscriber (a fake that records SESSION_START and NEVER
 * spawns a `claude`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

const runAgentLoop = vi.fn(async (userContent: string | unknown[], history: unknown[]) => ({
  messages: [
    ...(history as Array<{ role: string; content: unknown }>),
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'mock response' }] },
  ],
  newMessages: [
    { role: 'user', content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent },
    { role: 'assistant', content: [{ type: 'text', text: 'mock response' }] },
  ],
  response: 'mock response',
  aborted: false,
}))

vi.mock('../../../src/agent/loop.js', () => ({ runAgentLoop }))

// Turn-boundary memory bookkeeping: PARTIAL mock — the real implementations still
// run (so nothing about memory behavior diverges here), the two entry points are
// merely wrapped in spies so the lane branch's calls are countable. vi.hoisted is
// required: the mock factory is lifted above every import, so it cannot close over
// ordinary top-level consts (they'd still be uninitialized when it runs).
const { getBoundedMemory, beginMemoryPromptTurn } = vi.hoisted(() => ({
  getBoundedMemory: vi.fn(),
  beginMemoryPromptTurn: vi.fn(),
}))
vi.mock('../../../src/core/bounded-memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/bounded-memory.js')>()
  getBoundedMemory.mockImplementation((agentId?: string, target?: 'memory' | 'user') =>
    actual.getBoundedMemory(agentId, target))
  beginMemoryPromptTurn.mockImplementation((agentId?: string, conversationId?: string) =>
    actual.beginMemoryPromptTurn(agentId, conversationId))
  return { ...actual, getBoundedMemory, beginMemoryPromptTurn }
})

import type { Server as HttpServer } from 'node:http'
import WebSocket from 'ws'
import { WALNUT_HOME, CONFIG_FILE } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent } from '../../../src/core/event-types.js'

let server: HttpServer
let port: number
let started: SessionStartEvent[] = []

/** Fake session-runner: records starts, never spawns anything. */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_START) started.push(event.data as SessionStartEvent)
  })
}

async function writeConfig(agent: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true })
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    user: { name: 'Ada' },
    defaults: { priority: 'none', platform: 'local' },
    provider: { type: 'claude-code' },
    agent,
  }), 'utf-8')
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendRpc(
  ws: WebSocket,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error('RPC timed out')), 20_000)
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.type === 'res' && msg.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(msg as { ok: boolean; payload?: unknown; error?: string })
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

/** Boot a server whose config carries the given agent section. */
async function boot(agent: Record<string, unknown>): Promise<void> {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await writeConfig(agent)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // startServer registers the real runner; replacing the subscriber by NAME
  // displaces it, so nothing in this file can reach a real spawn.
  installFakeRunner()
}

beforeEach(() => {
  runAgentLoop.mockClear()
  getBoundedMemory.mockClear()
  beginMemoryPromptTurn.mockClear()
  started = []
})

afterEach(async () => {
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('agent.provider unset (default) → in-process loop', () => {
  it('runs runAgentLoop and never creates a lane session', async () => {
    await boot({})
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'hello butler' })
      expect(res.ok).toBe(true)
      // No lane id in the reply — unchanged contract for every existing client.
      expect(res.payload).toBeUndefined()
      expect(runAgentLoop).toHaveBeenCalledTimes(1)
      expect(started).toHaveLength(0)
      // The bookkeeping belongs to whichever engine ran the turn. On this branch
      // that is loop.ts (mocked here) — the chat route must NOT also do it, or a
      // real in-process turn would pin the snapshot twice per turn.
      expect(beginMemoryPromptTurn).not.toHaveBeenCalled()

      const { getSessionByLane } = await import('../../../src/core/session-tracker.js')
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')
      expect(await getSessionByLane(`chat:general:${conv}`)).toBeNull()
    } finally {
      ws.close()
    }
  })

  it("explicit 'walnut-agent' behaves the same as unset", async () => {
    await boot({ provider: 'walnut-agent' })
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'hi' })
      expect(runAgentLoop).toHaveBeenCalledTimes(1)
      expect(started).toHaveLength(0)
    } finally {
      ws.close()
    }
  })

  it('an unknown provider string degrades to the in-process loop', async () => {
    // A hand-edited config must never leave the butler with "no engine".
    await boot({ provider: 'wat' })
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'hi' })
      expect(runAgentLoop).toHaveBeenCalledTimes(1)
      expect(started).toHaveLength(0)
    } finally {
      ws.close()
    }
  })
})

describe("agent.provider = 'claude-code' → lane session", () => {
  it('answers laneSessionId, spawns the lane, and does NOT run the loop', async () => {
    await boot({ provider: 'claude-code' })
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'plan my week' })
      expect(res.ok).toBe(true)
      const { laneSessionId } = (res.payload ?? {}) as { laneSessionId?: string }
      expect(laneSessionId).toMatch(/^[0-9a-f-]{36}$/)
      expect(runAgentLoop).not.toHaveBeenCalled()

      // One spawn, carrying the butler profile + the conversation's lane.
      expect(started).toHaveLength(1)
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')
      expect(started[0].lane).toBe(`chat:general:${conv}`)
      expect(started[0].preassignedSessionId).toBe(laneSessionId)
      expect(started[0].message).toContain('plan my week')
      expect(started[0].profile?.systemPromptMode).toBe('replace')
      expect(started[0].profile?.systemPrompt).toContain('You are a COORDINATOR, not an executor')
      expect(started[0].profile?.mcpServers?.walnut).toEqual({ command: 'open-walnut', args: ['mcp'] })

      const { getSessionByLane } = await import('../../../src/core/session-tracker.js')
      expect((await getSessionByLane(`chat:general:${conv}`))?.claudeSessionId).toBe(laneSessionId)
    } finally {
      ws.close()
    }
  })

  it('a second message reuses the lane and does not spawn again', async () => {
    await boot({ provider: 'claude-code' })
    const ws = await connectWs()
    try {
      const first = await sendRpc(ws, 'chat', { message: 'one' })
      const second = await sendRpc(ws, 'chat', { message: 'two' })
      const firstId = (first.payload as { laneSessionId?: string }).laneSessionId
      const secondId = (second.payload as { laneSessionId?: string }).laneSessionId
      expect(secondId).toBe(firstId)
      expect(started).toHaveLength(1)
      expect(runAgentLoop).not.toHaveBeenCalled()

      // The follow-up was delivered through the session queue instead of a spawn.
      const { getQueue } = await import('../../../src/core/session-message-queue.js')
      const queued = (await getQueue(firstId!)).map((m) => m.message)
      expect(queued.some((m) => m.includes('two'))).toBe(true)
      expect(queued.some((m) => m.includes('one'))).toBe(false)
    } finally {
      ws.close()
    }
  })

  it('does the turn-boundary memory bookkeeping the in-process loop would have done', async () => {
    // The lane path skips agent/loop.ts entirely, and with it the two things every
    // main-butler turn owes memory: clearing the consolidation breaker, and
    // re-pinning the frozen memory-prompt snapshot for this conversation. Without
    // them a single failed consolidation wedges the breaker for the process's life
    // and the prompt scope never advances.
    await boot({ provider: 'claude-code' })
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'lane bookkeeping' })
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')

      // Both global stores get their breaker reset: the general one and USER.md.
      expect(getBoundedMemory).toHaveBeenCalledWith()
      expect(getBoundedMemory).toHaveBeenCalledWith(undefined, 'user')

      // The snapshot is pinned for THIS conversation's scope, exactly once.
      expect(beginMemoryPromptTurn).toHaveBeenCalledTimes(1)
      expect(beginMemoryPromptTurn).toHaveBeenCalledWith('general', conv)
    } finally {
      ws.close()
    }
  })

  it('persists the user message and a clickable session-ref breadcrumb', async () => {
    await boot({ provider: 'claude-code' })
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'remember this' })
      const { laneSessionId } = res.payload as { laneSessionId: string }
      const chatHistory = await import('../../../src/core/chat-history.js')
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')

      // Pre-engine persistence must be identical on both branches.
      const modelMsgs = await chatHistory.getApiMessages('general', conv)
      expect(JSON.stringify(modelMsgs)).toContain('remember this')

      // And the UI gets a breadcrumb pointing at the session that ran the turn.
      const page = await chatHistory.getDisplayEntries(1, 50, 'general', conv)
      const notice = page.messages.find((e) => typeof e.content === 'string'
        && (e.content as string).includes('<session-ref'))
      expect(notice, 'a session-ref notice should be persisted').toBeTruthy()
      expect(notice!.content as string).toContain(laneSessionId)
      expect(notice!.sessionId).toBe(laneSessionId)
    } finally {
      ws.close()
    }
  })
})
