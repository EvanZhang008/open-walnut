/**
 * E2E test for is_backgrounded task detachment (incident 07fffbe5, Fix D).
 *
 * Full path: WS client → session:start → MockDaemon → mock-claude.mjs emits the
 * `backgrounded-test` sequence (task_started → task_updated{is_backgrounded:true}
 * → result → session_state_changed{idle}, and NEVER a terminal event for the
 * task) → ClaudeCodeSession → event bus → server WS forwarding.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker,
 * task-manager, ClaudeCodeSession, MockDaemon transport.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Asserts the headline guarantee of the fix:
 *   1. The turn COMPLETES (session:result arrives) even though the backgrounded
 *      task never gets a terminal event. Pre-fix, _runningBgCount() counted the
 *      detached task forever, hasActiveBackgroundWork() withheld the result AND
 *      the idle, and the session sat "Running" for the task's full lifetime
 *      (a 16-min backgrounded grep in production).
 *   2. The persisted session record converges to idle/stopped — NOT stuck running.
 *   3. The UI background-tasks snapshot still lists the detached task (only the
 *      turn-over gating excludes it — the panel keeps showing it).
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
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

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
  id?: string
  [key: string]: unknown
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
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

/** Collect every WS `event`-frame with the given name, with their arrival order. */
function collectWsEvents(ws: WebSocket, eventName: string): {
  events: WsEvent[]
  cleanup: () => void
} {
  const events: WsEvent[] = []
  const handler = (raw: WebSocket.RawData) => {
    const frame = JSON.parse(raw.toString()) as WsEvent
    if (frame.type === 'event' && frame.name === eventName) events.push(frame)
  }
  ws.on('message', handler)
  return { events, cleanup: () => ws.off('message', handler) }
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [{
        id: 'bg-task-001',
        title: 'Backgrounded task E2E task',
        status: 'todo', priority: 'immediate',
        category: 'Work', project: 'Walnut',
        session_ids: [], active_session_ids: [],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        description: '', summary: '', note: '', subtasks: [],
      }],
    }),
  )

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

describe('Backgrounded task E2E: turn completes despite non-terminal is_backgrounded task', () => {
  it('result arrives, record converges to idle/stopped, snapshot keeps the detached task', async () => {
    const ws = await connectWs()

    // Start collecting BEFORE the send so we catch every frame in order.
    const bgCollector = collectWsEvents(ws, 'session:background-tasks')
    const resultCollector = collectWsEvents(ws, 'session:result')

    // Kick off the turn that backgrounds a bash task and never drains it.
    const rpc = await sendWsRpc(ws, 'session:start', {
      taskId: 'bg-task-001',
      message: 'backgrounded-test',
      project: 'Walnut',
    })
    expect((rpc as Record<string, unknown>).ok).toBe(true)

    // (a) The turn COMPLETES: session:result arrives even though 'bg-detached'
    // never got a terminal event. Pre-fix this timed out — the backgrounded task
    // held hasActiveBackgroundWork() true and both the result and the idle were
    // withheld forever.
    const resultEvent = await waitForWsEvent(ws, 'session:result', 15000)
    const rd = resultEvent.data as { sessionId: string; taskId: string; isError?: boolean }
    expect(rd.taskId).toBe('bg-task-001')
    expect(rd.isError).toBeFalsy()

    // Let trailing frames + the fire-and-forget record persistence flush.
    await delay(300)
    bgCollector.cleanup()
    resultCollector.cleanup()

    // Exactly one completion for the turn (the trailing idle must not double-fire).
    expect(resultCollector.events.length).toBe(1)

    // (b) The persisted session record converges to idle/stopped — NOT stuck
    // 'running'. Poll briefly: the SESSION_RESULT handler persists asynchronously.
    let recordStatus: string | undefined
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://localhost:${port}/api/sessions`)
      expect(res.status).toBe(200)
      const { sessions } = await res.json() as { sessions: Array<{ claudeSessionId: string; process_status: string }> }
      recordStatus = sessions.find(s => s.claudeSessionId === rd.sessionId)?.process_status
      if (recordStatus === 'idle' || recordStatus === 'stopped') break
      await delay(150)
    }
    expect(['idle', 'stopped']).toContain(recordStatus)

    // (c) The UI snapshot still lists the detached task (non-terminal), while the
    // turn-over gate (inFlight) already excludes it: last snapshot has inFlight 0
    // with 'bg-detached' still present and still running.
    type BgTask = { taskId: string; status: string }
    type BgData = { inFlight: number; tasks?: BgTask[] }
    expect(bgCollector.events.length).toBeGreaterThan(0)
    const last = bgCollector.events[bgCollector.events.length - 1].data as BgData
    const detached = (last.tasks ?? []).find(t => t.taskId === 'bg-detached')
    expect(detached).toBeDefined()
    expect(detached?.status).toBe('running') // never drained — that's the scenario
    expect(last.inFlight).toBe(0) // …but it no longer gates turn-over

    ws.close()
  }, 30000)
})
