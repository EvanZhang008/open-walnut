/**
 * E2E tests for session resume status changes.
 *
 * Verifies the fixes for:
 *   RC1: createSessionRecord upsert resets status on resume (new PID for stopped session)
 *   RC2: session:status-changed WS event carries correct status data
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

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

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

  // Seed tasks
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'resume-task-001',
          title: 'Resume status test task',
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
        },
      ],
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

describe('Session resume status changes', () => {
  it('session:status-changed events reflect running→stopped→running lifecycle during resume', async () => {
    const ws = await connectWs()
    const statusEvents = collectWsEvents(ws, ['session:status-changed'])

    // 1. Start a session — it completes quickly via mock CLI
    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'resume-task-001',
      message: 'initial session message',
      project: 'Walnut',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResult = await resultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Wait for status events to settle
    await delay(500)

    // Should have status-changed events from the first session: in_progress → agent_complete
    const firstRunEvents = statusEvents.filter(
      e => (e.data as { sessionId?: string })?.sessionId === sessionId,
    )
    expect(firstRunEvents.length).toBeGreaterThanOrEqual(1)

    // The last status event should show agent_complete or stopped
    const lastFirstStatus = firstRunEvents[firstRunEvents.length - 1]
    expect(lastFirstStatus.data?.work_status).toBe('agent_complete')

    // 2. Verify DB record shows stopped/agent_complete
    const sessRes1 = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    expect(sessRes1.status).toBe(200)
    const sessData1 = (await sessRes1.json()) as { session: { process_status: string; work_status: string } }
    expect(sessData1.session.process_status).toBe('stopped')
    expect(sessData1.session.work_status).toBe('agent_complete')

    // 3. Resume the session by sending a new message
    const statusCountBefore = statusEvents.length
    const resumeResultPromise = waitForWsEvent(ws, 'session:result')

    const sendRes = await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up after resume',
    })
    expect((sendRes as Record<string, unknown>).ok).toBe(true)

    // Wait for the resumed session to complete
    const secondResult = await resumeResultPromise
    expect((secondResult.data as { result: string }).result).toContain('follow-up after resume')

    await delay(500)

    // 4. Verify new status events were emitted during resume
    const newStatusEvents = statusEvents.slice(statusCountBefore).filter(
      e => (e.data as { sessionId?: string })?.sessionId === sessionId,
    )
    // Should have at least one in_progress status (when resuming) and one agent_complete (when done)
    const inProgressEvents = newStatusEvents.filter(e => e.data?.work_status === 'in_progress')
    const completedEvents = newStatusEvents.filter(e => e.data?.work_status === 'agent_complete')
    expect(inProgressEvents.length).toBeGreaterThanOrEqual(1)
    expect(completedEvents.length).toBeGreaterThanOrEqual(1)

    // The in_progress event should carry process_status: 'running'
    expect(inProgressEvents[0].data?.process_status).toBe('running')

    ws.close()
    await delay(50)
  })

  it('DB record resets to running/in_progress during resume then back to stopped/agent_complete', async () => {
    const ws = await connectWs()

    // Start a session
    const firstResultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'resume-task-001',
      message: 'slow:300 db status check',
      project: 'Walnut',
    })
    const firstResult = await firstResultPromise
    const sessionId = (firstResult.data as { sessionId: string }).sessionId
    await delay(200)

    // Confirm DB shows stopped after first run
    const res1 = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    const data1 = (await res1.json()) as { session: { process_status: string; work_status: string } }
    expect(data1.session.process_status).toBe('stopped')
    expect(data1.session.work_status).toBe('agent_complete')

    // Resume with a slow message to have time to check mid-flight
    const resumeResultPromise = waitForWsEvent(ws, 'session:result')

    // Use slow:500 to give us time to query DB mid-flight
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'slow:500 mid-flight check',
    })

    // Wait a bit for the session to start (process spawned, init event processed)
    await delay(300)

    // Check DB mid-flight — should be running/in_progress
    const res2 = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    const data2 = (await res2.json()) as { session: { process_status: string; work_status: string } }
    expect(data2.session.process_status).toBe('running')
    expect(data2.session.work_status).toBe('in_progress')

    // Wait for completion
    await resumeResultPromise
    await delay(500)

    // After completion — should be stopped/agent_complete again
    const res3 = await fetch(apiUrl(`/api/sessions/${sessionId}`))
    const data3 = (await res3.json()) as { session: { process_status: string; work_status: string } }
    expect(data3.session.process_status).toBe('stopped')
    expect(data3.session.work_status).toBe('agent_complete')

    ws.close()
    await delay(50)
  })

  it('status-changed event carries all fields needed by SessionPanel (RC2 fix)', async () => {
    const ws = await connectWs()
    const statusEvents = collectWsEvents(ws, ['session:status-changed'])

    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'resume-task-001',
      message: 'verify event fields',
      project: 'Walnut',
    })
    await resultPromise
    await delay(200)

    // Every status-changed event must carry the fields SessionPanel merges
    for (const evt of statusEvents) {
      expect(evt.data).toHaveProperty('sessionId')
      expect(evt.data).toHaveProperty('process_status')
      expect(evt.data).toHaveProperty('work_status')
      expect(evt.data).toHaveProperty('mode')
      // activity can be undefined, but the key should not break the merge
    }

    ws.close()
    await delay(50)
  })
})
