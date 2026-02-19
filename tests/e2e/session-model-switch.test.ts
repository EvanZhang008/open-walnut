/**
 * E2E test for session model switching.
 *
 * Verifies the full data flow when a follow-up message includes a `model`
 * field (e.g., 'sonnet', 'haiku'):
 *
 *   session:send RPC with { model: 'sonnet' }
 *   → handleSend saves pendingModel to session record
 *   → processNext consumes pendingModel, stops process, re-spawns with --model sonnet
 *   → mock CLI echoes [model:sonnet] in result text
 *   → session:result event carries the proof
 *
 * What's real: Express server, WebSocket, event bus, session-tracker, task-manager.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

// ── Helpers ──

let server: HttpServer
let port: number

function wsUrl(): string {
  return `ws://localhost:${port}/ws`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  predicate?: (evt: WsEvent) => boolean,
  timeoutMs = 15000,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${eventName}`)),
      timeoutMs,
    )
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        if (!predicate || predicate(frame)) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(frame)
        }
      }
    }
    ws.on('message', handler)
  })
}

function collectWsEvents(ws: WebSocket, eventNames: string[]): WsEvent[] {
  const events: WsEvent[] = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsEvent
    if (frame.type === 'event' && eventNames.includes(frame.name!)) {
      events.push(frame)
    }
  })
  return events
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && (frame as Record<string, unknown>).id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  sessionRunner.setCliCommand(MOCK_CLI)

  // Seed test tasks (one per test scenario)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: ['001', '002', '003', '004', '005'].map(n => ({
        id: `model-switch-task-${n}`,
        title: `Model switch test task ${n}`,
        status: 'todo',
        priority: 'immediate',
        category: 'Work',
        project: 'Walnut',
        session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
        source: 'ms-todo',
      })),
    }),
  )

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Tests ──

describe('Session model switch: E2E', () => {
  it('deferred model switch — follow-up with model: sonnet', async () => {
    const ws = await connectWs()

    // Start session (default model = opus)
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-001',
      message: 'initial turn, no model switch',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for first turn to complete
    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    const firstText = (firstResult.data as { result?: string }).result ?? ''
    // First turn uses default model (opus) — should NOT contain [model:sonnet]
    expect(firstText).not.toContain('[model:sonnet]')

    // Send follow-up with model switch to sonnet
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId,
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up after model switch',
      model: 'sonnet',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''

    // Second turn must have [model:sonnet] — proves --model sonnet was passed
    expect(secondText).toContain('[model:sonnet]')
    expect(secondText).toContain('follow-up after model switch')

    ws.close()
    await delay(50)
  })

  it('immediate model switch (interrupt) — model: haiku with slow session', async () => {
    const ws = await connectWs()

    // Start a SLOW session (3s delay gives window for interrupt).
    // session:started doesn't carry sessionId, so we wait for session:status-changed
    // which has both taskId and sessionId (set after init event is received).
    const statusPromise = waitForWsEvent(
      ws,
      'session:status-changed',
      (evt) => {
        const d = evt.data as { taskId?: string; sessionId?: string }
        return d.taskId === 'model-switch-task-002' && !!d.sessionId
      },
    )
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-002',
      message: 'slow:3000 long running task',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for a status-changed event that has the sessionId (after init)
    const statusEvt = await statusPromise
    const sessionId = (statusEvt.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Small delay to ensure the session is mid-processing
    await delay(500)

    // Send interrupt + model switch to haiku
    const resultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => {
        const d = evt.data as { sessionId?: string; result?: string }
        return d.sessionId === sessionId && (d.result?.includes('[model:haiku]') ?? false)
      },
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'interrupt and switch model',
      model: 'haiku',
      interrupt: true,
    })

    const result = await resultPromise
    const resultText = (result.data as { result?: string }).result ?? ''

    // Must have [model:haiku] — proves --model haiku was used on resume
    expect(resultText).toContain('[model:haiku]')
    expect(resultText).toContain('interrupt and switch model')

    ws.close()
    await delay(50)
  })

  it('model persists in session record — verify via REST', async () => {
    const ws = await connectWs()

    // Start session
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-003',
      message: 'initial turn',
      project: 'Walnut',
      mode: 'bypass',
    })

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId

    // Send follow-up with model switch
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId,
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'model switch to sonnet',
      model: 'sonnet',
    })

    await secondResultPromise

    // Let async record updates settle
    await delay(500)

    // Fetch session via REST
    const sessRes = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    expect(sessRes.status).toBe(200)
    const sessData = (await sessRes.json()) as {
      session: {
        claudeSessionId: string
        pendingModel?: string
        work_status?: string
      }
    }

    // Session record should exist with a valid claude session ID
    expect(sessData.session.claudeSessionId).toBeTruthy()

    // pendingModel must be cleared (consumed by processNext)
    expect(sessData.session.pendingModel).toBeUndefined()

    ws.close()
    await delay(50)
  })

  it('pendingModel cleared after consumption — no stale model on next send', async () => {
    const ws = await connectWs()

    // Turn 1: start session (default model = opus)
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-004',
      message: 'initial turn',
      project: 'Walnut',
      mode: 'bypass',
    })

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId

    // Wait for the result handler's processNext() to run and find an empty queue.
    // This prevents a race where the RPC enqueues before handleSend saves pendingModel.
    await delay(500)

    // Turn 2: switch to sonnet
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId,
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'switch to sonnet',
      model: 'sonnet',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''
    expect(secondText).toContain('[model:sonnet]')

    // Wait for turn 2's result handler processNext to drain before sending turn 3
    await delay(500)

    // Turn 3: send WITHOUT model field — should NOT re-apply sonnet
    const thirdResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => {
        const d = evt.data as { sessionId?: string; result?: string }
        // Match on sessionId AND ensure it's a new result (contains our message text)
        return d.sessionId === sessionId && (d.result?.includes('no model override this time') ?? false)
      },
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'no model override this time',
    })

    const thirdResult = await thirdResultPromise
    const thirdText = (thirdResult.data as { result?: string }).result ?? ''

    // Third result should NOT contain [model:sonnet] — pendingModel was cleared
    expect(thirdText).not.toContain('[model:sonnet]')
    expect(thirdText).not.toContain('[model:haiku]')
    // It should contain the message text (proves it processed)
    expect(thirdText).toContain('no model override this time')
    // Default model is opus (always passed by send()), so it will have [model:opus]
    expect(thirdText).toContain('[model:opus]')

    ws.close()
    await delay(50)
  })

  it('empty message model switch — { message: "", model: "sonnet" }', async () => {
    const ws = await connectWs()

    // Start session
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'model-switch-task-005',
      message: 'initial turn before empty model switch',
      project: 'Walnut',
      mode: 'bypass',
    })

    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId

    // Wait for the result handler's processNext() to run and find an empty queue.
    // Without this delay, our session:send RPC enqueues the message before handleSend
    // saves pendingModel, causing a race where processNext (triggered by the first turn's
    // result handler) dequeues our message without the pending model switch.
    await delay(500)

    // Send empty message with model switch
    const secondResultPromise = waitForWsEvent(
      ws,
      'session:result',
      (evt) => (evt.data as { sessionId?: string })?.sessionId === sessionId,
    )
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: '',
      model: 'sonnet',
    })

    const secondResult = await secondResultPromise
    const secondText = (secondResult.data as { result?: string }).result ?? ''

    // Session must not stall — a result should arrive
    expect(secondResult).toBeTruthy()
    // Result should contain [model:sonnet] — proves model switch worked with empty message
    expect(secondText).toContain('[model:sonnet]')

    ws.close()
    await delay(50)
  })
})
