/**
 * E2E: background self-review trigger wiring in the chat RPC handler.
 *
 * What's real: Express server, WebSocket RPC, chat handler, chat-history
 * persistence, the background-review module (counter + fork gating), config.yaml.
 * What's mocked: constants.js (temp dir), runAgentLoop (captures every call).
 *
 * Verifies:
 * - after a clean turn at the interval boundary, a SECOND runAgentLoop call is
 *   made with source 'background-review', the runtime tool whitelist, and NO
 *   custom system prompt (cache-prefix parity with the main chat);
 * - the review's history snapshot includes the just-persisted turn;
 * - persistence isolation: the review writes nothing into the conversation;
 * - a turn that used skill_manage resets the counter and never fires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

interface CapturedCall {
  userContent: string | unknown[]
  history: unknown[]
  options?: Record<string, unknown>
}
const calls: CapturedCall[] = []
/** Tool names the NEXT chat-turn mock should report via onToolCall. */
let toolCallsToEmit: string[] = []

vi.mock('../../../src/agent/loop.js', () => ({
  runAgentLoop: vi.fn(async (
    userContent: string | unknown[],
    history: unknown[],
    callbacks?: { onToolCall?: (name: string, input: Record<string, unknown>, id: string) => void },
    options?: Record<string, unknown>,
  ) => {
    calls.push({ userContent, history, options })
    const isReview = options?.source === 'background-review'
    if (!isReview) {
      for (const name of toolCallsToEmit) callbacks?.onToolCall?.(name, {}, `tu-${name}`)
    }
    const userMsg = {
      role: 'user',
      content: typeof userContent === 'string' ? [{ type: 'text', text: userContent }] : userContent,
    }
    const reply = { role: 'assistant', content: [{ type: 'text', text: isReview ? 'Nothing to save.' : 'mock response' }] }
    return {
      messages: [...(history as unknown[]), userMsg, reply],
      newMessages: [userMsg, reply],
      response: isReview ? 'Nothing to save.' : 'mock response',
      aborted: false,
    }
  }),
}))

import type { Server as HttpServer } from 'node:http'
import WebSocket from 'ws'
import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { resetReviewState, REVIEW_TOOL_WHITELIST, REVIEW_PROMPT } from '../../../src/agent/background-review.js'
import * as chatHistory from '../../../src/core/chat-history.js'

let server: HttpServer
let port: number

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendRpc(ws: WebSocket, method: string, payload: unknown): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error('RPC timed out')), 15_000)
    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.type === 'res' && msg.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(msg as { ok: boolean })
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const reviewCalls = () => calls.filter((c) => c.options?.source === 'background-review')

describe('chat → background self-review wiring', () => {
  beforeEach(async () => {
    calls.length = 0
    toolCallsToEmit = []
    resetReviewState()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    // interval 1 → every clean turn fires a review (no 10-turn loop in tests)
    await fs.writeFile(
      path.join(WALNUT_HOME, 'config.yaml'),
      'version: 1\nuser: {}\nagent:\n  background_review:\n    interval: 1\n',
      'utf-8',
    )
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  afterEach(async () => {
    await stopServer()
    await new Promise((r) => setTimeout(r, 100))
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('fires a persistence-isolated review fork after a clean turn', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'hello Personal AI' })
      await waitFor(() => reviewCalls().length === 1)

      const review = reviewCalls()[0]
      // Fork identity: default system path (cache parity), whitelist, source tag.
      expect(review.options?.system).toBeUndefined()
      expect(review.options?.toolWhitelist).toEqual(REVIEW_TOOL_WHITELIST)
      expect(review.userContent).toBe(REVIEW_PROMPT)

      // The fork sees the just-persisted turn (getHistory ran AFTER addAIMessages).
      const historyText = JSON.stringify(review.history)
      expect(historyText).toContain('hello Personal AI')
      expect(historyText).toContain('mock response')

      // Persistence isolation: conversation on disk has ONLY the real turn.
      const agentId = (review.options?.agentId as string) ?? 'general'
      const conversationId = review.options?.conversationId as string
      const persisted = await chatHistory.getApiMessages(agentId, conversationId)
      const persistedText = JSON.stringify(persisted)
      expect(persistedText).not.toContain('Background self-review')
      expect(persistedText).not.toContain('Nothing to save.')
      expect(persisted).toHaveLength(2) // user + assistant of the real turn only
    } finally {
      ws.close()
    }
  })

  it('a turn that used skill_manage resets the window instead of firing', async () => {
    toolCallsToEmit = ['skill_manage']
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'save that as a skill' })
      // Give any (wrong) fire-and-forget review a chance to run.
      await new Promise((r) => setTimeout(r, 300))
      expect(reviewCalls()).toHaveLength(0)

      // Next clean turn fires (counter restarted at 0 → 1 ≥ interval 1).
      toolCallsToEmit = []
      await sendRpc(ws, 'chat', { message: 'ordinary question' })
      await waitFor(() => reviewCalls().length === 1)
    } finally {
      ws.close()
    }
  })

  it('review never re-triggers itself (no review-of-review loop)', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', { message: 'turn one' })
      await waitFor(() => reviewCalls().length === 1)
      // Wait a bit longer: a recursive trigger would add more review calls.
      await new Promise((r) => setTimeout(r, 400))
      expect(reviewCalls()).toHaveLength(1)
    } finally {
      ws.close()
    }
  })
})
