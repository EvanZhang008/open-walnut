/**
 * E2E: bare turn-stop RPC (`session:interrupt`).
 *
 * The composer's stop button (streaming + empty input) issues session:interrupt —
 * a turn-stop WITHOUT a message. Distinct from `session:send {interrupt:true}`
 * (which stops-then-delivers). Pipeline under test:
 *
 *   WS RPC session:interrupt → bus SESSION_INTERRUPT → session-runner
 *     → session.interrupt() (CLI stop) + activeProcessing cleanup
 *     → SESSION_BATCH_COMPLETED (frontend optimistic-bubble GC)
 *
 * Would-fail-if-reverted: without the RPC registration the first test errors
 * with "unknown method"; without the runner's SESSION_INTERRUPT case the
 * mid-turn test times out waiting for batch-completed.
 *
 * What's real: Express server, WS, event bus, session runner, disk queue.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-interrupt'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number

function wsUrl(): string { return `ws://localhost:${port}/ws` }

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface WsFrame {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string
  ok?: boolean
  payload?: unknown
  error?: unknown
}

function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  match: (data: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 20000,
): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
      if (frame.type === 'event' && frame.name === eventName && match(frame.data ?? {})) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  sessionRunner.setCliCommand(MOCK_CLI)

  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [{
      id: 'int-local-001',
      title: 'Interrupt target',
      status: 'todo',
      priority: 'none',
      category: 'Test',
      project: 'InterruptTest',
      session_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      description: '', summary: '', note: '', subtasks: [],
      phase: 'TODO',
      source: 'ms-todo',
    }],
  }))

  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30000)

afterAll(async () => {
  stopServer()
  await delay(500)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 15000)

describe('session:interrupt RPC', () => {
  it('rejects a payload without sessionId', async () => {
    const ws = await connectWs()
    try {
      const res = await sendWsRpc(ws, 'session:interrupt', {})
      expect(res.ok).toBe(false)
      expect(String(res.error)).toContain('sessionId')
    } finally {
      ws.close()
    }
  })

  it('acks for an idle/unknown session without queuing anything', async () => {
    const ws = await connectWs()
    try {
      const res = await sendWsRpc(ws, 'session:interrupt', { sessionId: 'no-such-session' })
      expect(res.ok).toBe(true)
      expect((res.payload as { ok?: boolean })?.ok).toBe(true)
    } finally {
      ws.close()
    }
  })

  it('mid-turn interrupt stops the turn and emits batch-completed with the batch ids', async () => {
    const ws = await connectWs()
    try {
      // Turn 1: establish the session.
      const result1 = waitForWsEvent(ws, 'session:result', () => true, 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'int-local-001',
        message: 'turn 1: establish',
      })
      const sessionId = ((await result1).data!.sessionId) as string
      expect(sessionId).toBeTruthy()

      // Turn 2: a slow message (mock CLI waits 8s before result) so the
      // interrupt lands strictly mid-turn.
      const delivered = waitForWsEvent(
        ws, 'session:messages-delivered',
        (d) => d.sessionId === sessionId,
        20000,
      )
      const sendRes = await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'slow:8000 turn 2: will be stopped',
      })
      const messageId = (sendRes.payload as { messageId?: string })?.messageId
      expect(messageId).toBeTruthy()
      await delivered

      // Bare stop. The runner must clear the in-flight batch and tell the
      // frontend via batch-completed (id-first) — that is what unpins the
      // optimistic bubble.
      const batchCompleted = waitForWsEvent(
        ws, 'session:batch-completed',
        (d) => d.sessionId === sessionId,
        20000,
      )
      const stopAt = Date.now()
      const stopRes = await sendWsRpc(ws, 'session:interrupt', { sessionId })
      expect(stopRes.ok).toBe(true)

      const batch = await batchCompleted
      const ids = (batch.data!.messageIds ?? []) as string[]
      expect(ids).toContain(messageId)
      // Revert-proofing: the mock CLI would deliver the natural turn end at
      // +8000ms. The interrupt path emits batch-completed synchronously, so
      // anything under ~5s proves the STOP produced it, not the slow result.
      expect(Date.now() - stopAt).toBeLessThan(5000)
    } finally {
      ws.close()
    }
  }, 60000)
})
