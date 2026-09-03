/**
 * Chat engine selection (`config.agent.provider`) — which engine answers a turn.
 *
 * The flag is a FORK in the chat RPC, so the two things worth asserting are that
 * each branch runs and that the other one does NOT:
 *   - default / 'walnut-agent' → the in-process loop runs, no lane is touched
 *   - 'claude-code'            → the turn goes to the conversation's lane session,
 *                                is AWAITED, and the lane's answer is persisted as
 *                                an ordinary assistant message in THIS chat (the
 *                                lane session is an implementation detail — the
 *                                chat panel is the only surface). The loop is
 *                                never called.
 * Plus the invariant that must hold on BOTH branches: the user's message is
 * persisted before the engine runs (it survives a refresh either way).
 *
 * What's real: Express server, WS RPC, chat handler, session records, lane module.
 * What's mocked: constants.js (temp dir), the agent loop (spy), and the
 * 'session-runner' bus subscriber (a fake that records SESSION_START, answers with
 * a synthetic session:result, and NEVER spawns a `claude`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
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
import type { SessionStartEvent, SessionSendEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

let server: HttpServer
let port: number
let started: SessionStartEvent[] = []
let sent: SessionSendEvent[] = []
/** What the fake CLI "answers" each lane turn with. */
let laneReply = 'lane answer'

/**
 * Consume a session's queued messages, the way a real delivery would. Tracked so
 * teardown can await it: a message left 'pending' when the server goes down is
 * exactly what the local daemon's reconnect redelivery would later
 * cold-`--resume` into a REAL `claude` spawn (observed leaking from this file).
 */
const inFlightDrains = new Set<Promise<void>>()

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId)
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id))
    } catch { /* the store may be torn down between tests */ }
  })()
  inFlightDrains.add(p)
  void p.finally(() => inFlightDrains.delete(p))
}

/**
 * Fake session-runner: records starts, drains sends, answers each turn with a
 * synthetic session:result (the chat RPC AWAITS the lane turn, so a runner that
 * never answers would hang every lane test to its timeout), never spawns anything.
 * When `laneToolCalls` is set, it streams tool_use/tool_result pairs first —
 * the shape the relay's transcript accumulator persists.
 */
let laneToolCalls: Array<{ id: string; name: string; input: Record<string, unknown>; result: string }> = []

function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      started.push(d)
      sid = d.preassignedSessionId
      if (!sid && d.engine === 'codex') {
        // ACP mints its own session id at provider session/new — mimic
        // adoptSessionResponse: create the lane-bound codex record the lane
        // resolver is polling for (waitForLaneRecord).
        const acpSid = randomUUID()
        sid = acpSid
        void import('../../../src/core/session-tracker.js').then(({ createSessionRecord }) =>
          createSessionRecord(acpSid, '', '', d.cwd, {
            engine: 'codex',
            ...(d.lane ? { lane: d.lane } : {}),
            initialProcessStatus: 'idle',
            messageCount: 0,
          }))
      }
    } else if (event.name === EventNames.SESSION_SEND) {
      sent.push(event.data as SessionSendEvent)
      sid = (event.data as SessionSendEvent).sessionId
    }
    if (!sid) return
    drainQueue(sid)
    const sessionId = sid
    setTimeout(() => {
      for (const tc of laneToolCalls) {
        bus.emit(EventNames.SESSION_TOOL_USE, { sessionId, toolName: tc.name, toolUseId: tc.id, input: tc.input },
          ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
        bus.emit(EventNames.SESSION_TOOL_RESULT, { sessionId, toolUseId: tc.id, result: tc.result },
          ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
      }
      bus.emit(EventNames.SESSION_RESULT, { sessionId, result: laneReply, isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 5)
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
  sent = []
  laneReply = 'lane answer'
  laneToolCalls = []
})

afterEach(async () => {
  // Let every fake delivery finish draining BEFORE the server goes down (see
  // drainQueue): a message left 'pending' is exactly what triggers a real spawn.
  await Promise.allSettled([...inFlightDrains])
  await stopServer()
  await new Promise((r) => setTimeout(r, 100))
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe("explicit 'walnut-agent' → in-process loop", () => {
  it('runs runAgentLoop and never creates a lane session', async () => {
    await boot({ provider: 'walnut-agent' })
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'hello Personal AI' })
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
})

// With no explicit engine the engine follows the AI provider (Settings → AI
// Provider): Claude Code → the lane, anything else → the in-process loop that
// can call it. The unknown-string case still lands on the LANE engine as of
// 2026-08-28: the 2026-08-28 06:03 incident showed that "degrade to the loop" on
// a CLI-only install degrades to an engine that answers "Could not load
// credentials from any providers" instead of answering at all.
describe('no explicit engine choice → the engine follows the AI provider', () => {
  it('Claude Code as the provider rides the lane, not the in-process loop', async () => {
    // Pinned explicitly so the case does not depend on whether this runner has a
    // `claude` binary (that is what the default rule looks at when nothing is set).
    await boot({ main_provider: 'claude_cli' })
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'hello Personal AI' })
      expect(res.ok).toBe(true)
      expect(runAgentLoop).not.toHaveBeenCalled()
      expect(started).toHaveLength(1)
    } finally {
      ws.close()
    }
  })

  it('another provider picked in Settings runs Ask Walnut in the in-process loop on it', async () => {
    // What "AI Provider = Bedrock" must mean: Ask Walnut answers from Bedrock,
    // not from a claude session that ignores the choice.
    await boot({ main_provider: 'bedrock' })
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'hello Personal AI' })
      expect(res.ok).toBe(true)
      expect(runAgentLoop).toHaveBeenCalledTimes(1)
      expect(started).toHaveLength(0)
    } finally {
      ws.close()
    }
  })

  it('an unknown provider string degrades to the lane engine too', async () => {
    // A hand-edited config must never leave the Personal AI with "no engine" —
    // and "an engine that cannot reach credentials" is the same outage wearing a
    // different message. resolveAgentEngineProvider logs the bad value instead.
    await boot({ provider: 'wat' })
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'hi' })
      expect(runAgentLoop).not.toHaveBeenCalled()
      expect(started).toHaveLength(1)
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

      // One spawn, carrying the Personal AI profile + the conversation's lane.
      expect(started).toHaveLength(1)
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')
      expect(started[0].lane).toBe(`chat:general:${conv}`)
      expect(started[0].preassignedSessionId).toBe(laneSessionId)
      expect(started[0].message).toContain('plan my week')
      expect(started[0].profile?.systemPromptMode).toBe('append')
      expect(started[0].profile?.systemPrompt).toContain('## Walnut operating contract')
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

      // The follow-up was delivered through the session queue instead of a spawn
      // ('one' rode the spawn itself; the queue is drained by the fake runner, so
      // assert on the recorded SESSION_SEND, not the now-empty queue).
      expect(sent.map((s) => s.message)).toEqual(['two'])
    } finally {
      ws.close()
    }
  })

  it('does the turn-boundary memory bookkeeping the in-process loop would have done', async () => {
    // The lane path skips agent/loop.ts entirely, and with it the two things every
    // Personal AI turn owes memory: clearing the consolidation breaker, and
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

  it("persists the user message and the lane's ANSWER as an ordinary assistant turn", async () => {
    laneReply = 'noted — I will remember that'
    await boot({ provider: 'claude-code' })
    const ws = await connectWs()
    try {
      const res = await sendRpc(ws, 'chat', { message: 'remember this' })
      expect(res.ok).toBe(true)
      const chatHistory = await import('../../../src/core/chat-history.js')
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')

      // Pre-engine persistence must be identical on both branches.
      const modelMsgs = await chatHistory.getApiMessages('general', conv)
      expect(JSON.stringify(modelMsgs)).toContain('remember this')

      // The reply itself lands in THIS chat — no session-ref breadcrumb, no
      // "go look at a session": the lane is an implementation detail.
      // An ORDINARY assistant entry (block content, not a notification) carries
      // the answer — the same shape the in-process loop persists.
      const page = await chatHistory.getDisplayEntries(1, 50, 'general', conv)
      const answer = page.messages.find((e) => e.role === 'assistant'
        && e.notification !== true
        && JSON.stringify(e.content).includes('noted — I will remember that'))
      expect(answer, "the lane's answer should be persisted as an ordinary assistant message").toBeTruthy()
      const breadcrumb = page.messages.find((e) => typeof e.content === 'string'
        && (e.content as string).includes('<session-ref'))
      expect(breadcrumb, 'no session-ref breadcrumb should be persisted').toBeUndefined()
    } finally {
      ws.close()
    }
  })

  it('does NOT duplicate tool blocks into chat history (the CLI JSONL is the one transcript)', async () => {
    // Thin-layer contract: the lane session's own JSONL holds the full turn
    // (tools included) and the session timeline renders it directly. Persisting
    // tool_use/tool_result into chat-history again would be a second, divergent
    // copy of the same transcript — assert the answer lands and the tool blocks
    // do NOT.
    laneToolCalls = [
      { id: 'tu-1', name: 'Bash', input: { command: 'curl tasks' }, result: '42 tasks' },
      { id: 'tu-2', name: 'Read', input: { file_path: '/tmp/x' }, result: 'contents' },
    ]
    laneReply = 'you have 42 tasks'
    await boot({ provider: 'claude-code' })
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'how many tasks' })
      const chatHistory = await import('../../../src/core/chat-history.js')
      const { getActiveConversationId } = await import('../../../src/core/conversations.js')
      const conv = await getActiveConversationId('general')

      const modelMsgs = await chatHistory.getApiMessages('general', conv)
      const flat = JSON.stringify(modelMsgs)
      expect(flat).toContain('you have 42 tasks')
      expect(flat).not.toContain('"tool_use"')
      expect(flat).not.toContain('"tool_result"')

      // The display side still shows the answer as the final assistant text.
      const page = await chatHistory.getDisplayEntries(1, 50, 'general', conv)
      const answer = page.messages.find((e) => e.role === 'assistant'
        && JSON.stringify(e.content).includes('you have 42 tasks'))
      expect(answer).toBeTruthy()
    } finally {
      ws.close()
    }
  })

  it('POST /api/agents/:agentId/conversations/:cid/lane-session resolves the lane (thin-layer mount point)', async () => {
    await boot({ provider: 'claude-code' })
    const { getActiveConversationId } = await import('../../../src/core/conversations.js')
    const conv = await getActiveConversationId('general')

    // First call mints the session (created: true) …
    const res1 = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-session`, { method: 'POST' })
    expect(res1.status).toBe(200)
    const body1 = await res1.json() as { sessionId: string; cwd?: string; created: boolean }
    expect(body1.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body1.created).toBe(true)
    drainQueue(body1.sessionId)

    // … the second returns the SAME lane (no rival session).
    const res2 = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-session`, { method: 'POST' })
    const body2 = await res2.json() as { sessionId: string; created: boolean }
    expect(body2.sessionId).toBe(body1.sessionId)
    expect(body2.created).toBe(false)
  })

  it('lane-session endpoint answers 409 when the engine flag is off', async () => {
    // Explicitly off: an unset config is the LANE engine now, so "off" has to be
    // stated. Boot with the in-process loop chosen on purpose.
    await boot({ provider: 'walnut-agent' })
    const { getActiveConversationId } = await import('../../../src/core/conversations.js')
    const conv = await getActiveConversationId('general')
    const res = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-session`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(started).toHaveLength(0)
  })

  it('lane-engine swap: EMPTY conversation re-mints the lane on codex, then back on claude', async () => {
    await boot({ provider: 'claude-code' })
    const { getActiveConversationId } = await import('../../../src/core/conversations.js')
    const conv = await getActiveConversationId('general')

    // Mint the default (claude) lane — the eager mount the UI performs.
    const res1 = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-session`, { method: 'POST' })
    const body1 = await res1.json() as { sessionId: string; engine: string }
    expect(body1.engine).toBe('claude')
    drainQueue(body1.sessionId)

    // Swap to codex while empty → NEW session id, engine codex, old lane archived.
    const swap = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-engine`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'codex' }),
    })
    expect(swap.status).toBe(200)
    const swapBody = await swap.json() as { sessionId: string; engine: string }
    expect(swapBody.engine).toBe('codex')
    expect(swapBody.sessionId).not.toBe(body1.sessionId)
    const { getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
    const oldRecord = await getSessionByClaudeId(body1.sessionId)
    expect(oldRecord?.archived).toBe(true)
    expect(oldRecord?.archive_reason).toBe('engine_switched')
    // The codex spawn rode SESSION_START with engine + lane (no preassigned id).
    const codexStart = started.find((s) => s.engine === 'codex')
    expect(codexStart?.lane).toBe(`chat:general:${conv}`)

    // Idempotent: swapping to the CURRENT engine returns the same session.
    const again = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-engine`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'codex' }),
    })
    expect(((await again.json()) as { sessionId: string }).sessionId).toBe(swapBody.sessionId)

    // And back to claude — still empty, still legal.
    const back = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-engine`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'claude' }),
    })
    expect(back.status).toBe(200)
    const backBody = await back.json() as { sessionId: string; engine: string }
    expect(backBody.engine).toBe('claude')
    expect(backBody.sessionId).not.toBe(swapBody.sessionId)
    drainQueue(backBody.sessionId)
  })

  it('lane-engine swap: a conversation WITH messages answers 409 and keeps its session', async () => {
    await boot({ provider: 'claude-code' })
    const { getActiveConversationId, touchLaneConversation } = await import('../../../src/core/conversations.js')
    const conv = await getActiveConversationId('general')

    const res1 = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-session`, { method: 'POST' })
    const body1 = await res1.json() as { sessionId: string }
    drainQueue(body1.sessionId)
    // A lane send bumps ConversationMeta.messageCount — the swap guard's signal.
    await touchLaneConversation('general', conv, 'hello there')

    const swap = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-engine`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'codex' }),
    })
    expect(swap.status).toBe(409)
    // The lane is untouched: same session, not archived.
    const res2 = await fetch(`http://localhost:${port}/api/agents/general/conversations/${conv}/lane-session`, { method: 'POST' })
    const body2 = await res2.json() as { sessionId: string }
    expect(body2.sessionId).toBe(body1.sessionId)
  })
})
