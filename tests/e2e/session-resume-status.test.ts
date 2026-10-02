/**
 * E2E tests for session resume status changes.
 *
 * Verifies the fixes for:
 *   RC1: createSessionRecord upsert resets status on cold resume
 *   RC2: session:status-changed WS event carries correct status data
 *
 * What's real: Express server, WebSocket, event bus, session-tracker, task-manager.
 * What's mocked: constants.js (temp dir), the session daemon (the in-process
 *   MockDaemon, which spawns mock-claude.mjs). Nothing here needs the daemon as
 *   a separate process.
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

// ── Helpers ──

let server: HttpServer
let port: number
let daemon: MockDaemon

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

/** Wait until the collected events (from index `from`) hold a status-changed
 *  event for `sessionId` with the given process_status. */
async function waitForStatus(
  events: WsEvent[], sessionId: string, status: string, from = 0, timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (events.slice(from).some(e =>
      (e.data as { sessionId?: string })?.sessionId === sessionId && e.data?.process_status === status)) return
    await delay(50)
  }
  throw new Error(`no ${status} status event for ${sessionId} within ${timeoutMs}ms`)
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

  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

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
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Tests ──

describe('Session resume status changes', () => {
  it('session:status-changed events reflect running→stopped→running lifecycle during cold resume', async () => {
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

    // This mock CLI exits after each turn, exercising the cold-resume fallback.
    // The turn ends `idle` (a live CLI would stay up); the exit then surfaces as
    // `stopped` once the server sees the process gone, which is not instant.
    await waitForStatus(statusEvents, sessionId, 'stopped')
    const firstRunEvents = statusEvents.filter(
      e => (e.data as { sessionId?: string })?.sessionId === sessionId,
    )
    expect(firstRunEvents[firstRunEvents.length - 1].data?.process_status).toBe('stopped')

    // 2. Verify DB record shows stopped (poll — async persist may lag)
    let sessData1: { session: { process_status: string } } | null = null
    for (let i = 0; i < 20; i++) {
      const sessRes1 = await fetch(apiUrl(`/api/sessions/${sessionId}`))
      expect(sessRes1.status).toBe(200)
      sessData1 = (await sessRes1.json()) as { session: { process_status: string } }
      if (sessData1.session.process_status === 'stopped') break
      await delay(300)
    }
    expect(sessData1!.session.process_status).toBe('stopped')

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

    // 4. Verify new status events were emitted during resume: the resumed
    // process must publish running and then return to stopped.
    await waitForStatus(statusEvents, sessionId, 'stopped', statusCountBefore)
    const newStatusEvents = statusEvents.slice(statusCountBefore).filter(
      e => (e.data as { sessionId?: string })?.sessionId === sessionId,
    )
    const runningEvents = newStatusEvents.filter(e => e.data?.process_status === 'running')
    const stoppedEvents = newStatusEvents.filter(e => e.data?.process_status === 'stopped')
    expect(runningEvents.length).toBeGreaterThanOrEqual(1)
    expect(stoppedEvents.length).toBeGreaterThanOrEqual(1)
    const firstRunning = newStatusEvents.findIndex(e => e.data?.process_status === 'running')
    const lastStopped = newStatusEvents.map(e => e.data?.process_status).lastIndexOf('stopped')
    expect(lastStopped).toBeGreaterThan(firstRunning)

    // At least one in_progress event should carry process_status: 'running'
    // (the first may have 'stopped' from handleSend before the new process starts)
    expect(runningEvents.length).toBeGreaterThanOrEqual(1)

    ws.close()
    await delay(50)
  })

  it('DB record resets to running during cold resume then returns to stopped', async () => {
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

    const dbStatus = async (): Promise<string> => {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}`))
      const data = (await res.json()) as { session: { process_status: string } }
      return data.session.process_status
    }
    const pollDbStatus = async (want: string, until: () => boolean = () => false): Promise<boolean> => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && !until()) {
        if (await dbStatus() === want) return true
        await delay(50)
      }
      return false
    }

    // Confirm DB shows stopped after first run (the mock exits after its turn)
    expect(await pollDbStatus('stopped')).toBe(true)

    // Resume with a slow message to have time to check mid-flight
    let resumed = false
    const resumeResultPromise = waitForWsEvent(ws, 'session:result').then((r) => { resumed = true; return r })

    // slow:500 holds the resumed turn open for 500ms after its init line
    await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'slow:500 mid-flight check',
    })

    // Mid-flight the record must read running, observed before the turn's result
    expect(await pollDbStatus('running', () => resumed)).toBe(true)

    // Wait for completion
    await resumeResultPromise

    // After completion the short-lived mock process is stopped again.
    expect(await pollDbStatus('stopped')).toBe(true)

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

    // Every event carries the canonical nested snapshot plus additive mirrors.
    for (const evt of statusEvents) {
      const status = evt.data?.status as Record<string, unknown>
      expect(status).toBeDefined()
      expect(status.sessionId).toEqual(expect.any(String))
      expect(status.taskId).toBe('resume-task-001')
      expect(status.process_status).toEqual(expect.stringMatching(/^(running|idle|stopped|error)$/))
      expect(status.statusRevision).toEqual(expect.any(Number))
      expect(status.mode).toEqual(expect.any(String))
      expect(status.provider).toEqual(expect.any(String))
      expect(status.engine).toEqual(expect.any(String))
      expect(status).toHaveProperty('activity')
      expect(status.activity === null || typeof status.activity === 'string').toBe(true)
      expect(status).toHaveProperty('errorMessage')
      expect(status.errorMessage === null || typeof status.errorMessage === 'string').toBe(true)
      expect(evt.data?.sessionId).toBe(status.sessionId)
      expect(evt.data?.process_status).toBe(status.process_status)
      expect(evt.data?.statusRevision).toBe(status.statusRevision)
    }

    ws.close()
    await delay(50)
  })
})
