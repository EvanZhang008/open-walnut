/**
 * E2E tests for session lifecycle — real server + real WebSocket + mock CLI.
 *
 * What's real: Express server, WebSocket connections, event bus, session-tracker
 * persistence, task-manager linking, REST endpoints.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Tests verify the full pipeline:
 *   WS RPC session:start → SessionRunner → spawn mock CLI → JSON parse →
 *   bus events → WS broadcast → REST API confirms persistence.
 *
 * The mock CLI outputs JSONL stream-json lines (init, assistant, result).
 * Streaming events (text deltas, tool use/result) are emitted during session.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'

// Use mock CLI directly — has #!/usr/bin/env node shebang and is executable.
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

/** Poll a check function until it returns true (or throw after timeoutMs). */
async function pollUntil(check: () => Promise<boolean>, intervalMs = 100, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(intervalMs)
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // Wire mock CLI directly into the session runner singleton before server starts
  sessionRunner.setCliCommand(MOCK_CLI)

  // Seed a task for session tests
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'sess-task-001',
          title: 'Session lifecycle test task',
          status: 'todo',
          priority: 'immediate',
          category: 'Work',
          project: 'Walnut',
          session_ids: [],
          active_session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
        },
        {
          id: 'sess-task-002',
          title: 'Another test task',
          status: 'todo',
          priority: 'none',
          category: 'Work',
          project: 'Walnut',
          session_ids: [],
          active_session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
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

// ── Session start via WS RPC ──

describe('Session start via WS RPC', () => {
  it('session:start RPC triggers session:result via WS', async () => {
    const ws = await connectWs()
    const startedEvents = collectWsEvents(ws, ['session:started'])

    // Send session:start RPC
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-001',
      message: 'hello from e2e',
      project: 'Walnut',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for session:result
    const resultEvent = await waitForWsEvent(ws, 'session:result')

    // Verify session:result has correct structure
    const rd = resultEvent.data as {
      sessionId: string
      taskId: string
      result: string
      isError: boolean
    }
    expect(rd.taskId).toBe('sess-task-001')
    expect(rd.result).toContain('hello from e2e')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()

    // Verify session:started was emitted
    expect(startedEvents.length).toBeGreaterThanOrEqual(1)

    ws.close()
    await delay(50)
  })

  it('session result persists to sessions REST API', async () => {
    // Give persistence time to complete from previous test
    await delay(1000)

    const res = await fetch(apiUrl('/api/sessions/task/sess-task-001'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessions: Array<{ taskId: string; claudeSessionId: string }> }
    expect(body.sessions.length).toBeGreaterThanOrEqual(1)
    expect(body.sessions[0].taskId).toBe('sess-task-001')
    expect(body.sessions[0].claudeSessionId).toBeTruthy()
  })

  it('session links to task — session_ids is populated', async () => {
    // Give persistence time
    await delay(500)

    const res = await fetch(apiUrl(`/api/tasks/sess-task-001`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: { active_session_ids?: string[]; session_ids?: string[] } }
    // session_ids should be populated (persists even after completion)
    expect(body.task.session_ids).toBeDefined()
    expect(body.task.session_ids!.length).toBeGreaterThan(0)
    // active_session_ids should be empty — session already completed and was cleared
    expect(body.task.active_session_ids ?? []).toHaveLength(0)
  })

  it('session:result auto-progresses task phase to AGENT_COMPLETE', async () => {
    // After a successful session completes, the task phase should auto-advance
    // from IN_PROGRESS (set at session start) to AGENT_COMPLETE.
    await delay(500)

    const res = await fetch(apiUrl(`/api/tasks/sess-task-001`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: { phase?: string; status?: string } }
    expect(body.task.phase).toBe('AGENT_COMPLETE')
    expect(body.task.status).toBe('in_progress') // AGENT_COMPLETE maps to in_progress status
  })
})

// ── Session persists at init time (not just at result time) ──

describe('Session record created at init (before result)', () => {
  it('sessions.json has record while session is still running', async () => {
    const ws = await connectWs()

    // Use "slow:2000" prefix — mock CLI emits init immediately, then waits 2s before result.
    // This gives us a window to check the REST API mid-session.
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-002',
      message: 'slow:2000 early persist test',
      project: 'Walnut',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Poll until the session record appears in the REST API (instead of a fixed delay).
    // The init event is emitted immediately; persistence is async.
    let record: { taskId: string; claudeSessionId: string; process_status: string; work_status: string } | undefined
    await pollUntil(async () => {
      const sessRes = await fetch(apiUrl('/api/sessions/task/sess-task-002'))
      if (sessRes.status !== 200) return false
      const sessBody = (await sessRes.json()) as { sessions: Array<{ taskId: string; claudeSessionId: string; process_status: string; work_status: string }> }
      record = sessBody.sessions.find(s => s.taskId === 'sess-task-002')
      return record !== undefined
    })

    expect(record).toBeDefined()
    expect(record!.claudeSessionId).toBeTruthy()
    expect(record!.process_status).toBe('running')

    // Check task was linked — session_ids and exec_session_id should be populated
    await pollUntil(async () => {
      const taskRes = await fetch(apiUrl('/api/tasks/sess-task-002'))
      if (taskRes.status !== 200) return false
      const taskBody = (await taskRes.json()) as { task: { session_ids?: string[]; exec_session_id?: string } }
      return (taskBody.task.session_ids?.length ?? 0) > 0
    })

    const taskRes = await fetch(apiUrl('/api/tasks/sess-task-002'))
    expect(taskRes.status).toBe(200)
    const taskBody = (await taskRes.json()) as { task: { session_ids?: string[]; exec_session_id?: string } }
    expect(taskBody.task.session_ids!.length).toBeGreaterThan(0)
    expect(taskBody.task.exec_session_id).toBeDefined()
    expect(taskBody.task.session_ids).toContain(record!.claudeSessionId)

    // Wait for the result to complete so the session finishes cleanly
    await resultPromise

    ws.close()
    await delay(50)
  })
})

// ── Error handling ──

describe('Session error handling', () => {
  it('session:start with error message emits session:error', async () => {
    const ws = await connectWs()
    const errorPromise = waitForWsEvent(ws, 'session:error')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-002',
      message: 'error',
      project: 'Walnut',
    })

    const errorEvent = await errorPromise
    const ed = errorEvent.data as { error: string; taskId: string }
    expect(ed.error).toBeDefined()
    expect(ed.taskId).toBe('sess-task-002')

    ws.close()
    await delay(50)
  })

  it('session:start RPC rejects invalid payload', async () => {
    const ws = await connectWs()

    const rpcRes = await sendWsRpc(ws, 'session:start', {
      // Missing required field: message
      taskId: 'sess-task-invalid',
    })

    expect((rpcRes as Record<string, unknown>).ok).toBe(false)

    ws.close()
    await delay(50)
  })

  it('session:send RPC rejects invalid payload', async () => {
    const ws = await connectWs()

    const rpcRes = await sendWsRpc(ws, 'session:send', {
      // Missing sessionId
      message: 'hello',
    })

    expect((rpcRes as Record<string, unknown>).ok).toBe(false)

    ws.close()
    await delay(50)
  })
})

// ── Session result carries response text ──

describe('Session result carries response text', () => {
  it('session:result event contains the full result text', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-001',
      message: 'verify result payload',
      project: 'Walnut',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      result: string
      taskId: string
      sessionId: string
      isError: boolean
    }

    // The result text must be present and non-empty — this is what the
    // frontend's useSessionChat hook needs to display the response
    expect(rd.result).toBeTruthy()
    expect(typeof rd.result).toBe('string')
    expect(rd.result.length).toBeGreaterThan(0)
    expect(rd.result).toContain('verify result payload')
    expect(rd.taskId).toBe('sess-task-001')
    expect(rd.sessionId).toBeTruthy()
    expect(rd.isError).toBe(false)

    ws.close()
    await delay(50)
  })
})

// ── Session send (resume) ──

describe('Session send (resume existing session)', () => {
  it('session:send to existing session produces response', async () => {
    const ws = await connectWs()

    // First, start a session to get a sessionId
    const firstResult = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-001',
      message: 'start session for resume',
      project: 'Walnut',
    })
    const firstResultEvent = await firstResult
    const sessionId = (firstResultEvent.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Now send to the existing session
    const rpcRes = await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up message to session',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for the result from the resumed session
    const secondResultEvent = await waitForWsEvent(ws, 'session:result')
    const rd = secondResultEvent.data as { result: string; taskId: string }

    // The resumed session should produce a valid response
    expect(rd.result).toBeTruthy()
    expect(rd.result).toContain('follow-up message to session')
    expect(rd.taskId).toBe('sess-task-001')

    ws.close()
    await delay(50)
  })
})

// ── Multi-client ──

describe('Multi-client session events', () => {
  it('multiple WS clients all receive session events', async () => {
    const ws1 = await connectWs()
    const ws2 = await connectWs()

    const result1 = waitForWsEvent(ws1, 'session:result')
    const result2 = waitForWsEvent(ws2, 'session:result')

    await sendWsRpc(ws1, 'session:start', {
      taskId: 'sess-task-001',
      message: 'multi client test',
      project: 'Walnut',
    })

    const [r1, r2] = await Promise.all([result1, result2])

    expect((r1.data as { taskId: string }).taskId).toBe('sess-task-001')
    expect((r2.data as { taskId: string }).taskId).toBe('sess-task-001')

    ws1.close()
    ws2.close()
    await delay(50)
  })

  it('session result text reaches all clients identically', async () => {
    const ws1 = await connectWs()
    const ws2 = await connectWs()

    const result1 = waitForWsEvent(ws1, 'session:result')
    const result2 = waitForWsEvent(ws2, 'session:result')

    await sendWsRpc(ws1, 'session:start', {
      taskId: 'sess-task-001',
      message: 'broadcast result text',
      project: 'Walnut',
    })

    const [r1, r2] = await Promise.all([result1, result2])

    // Both clients must receive identical result text
    const text1 = (r1.data as { result: string }).result
    const text2 = (r2.data as { result: string }).result
    expect(text1).toBeTruthy()
    expect(text1).toBe(text2)
    expect(text1).toContain('broadcast result text')

    ws1.close()
    ws2.close()
    await delay(50)
  })
})

// ── Permission mode (plan / bypass) ──

describe('Session permission mode', () => {
  it('session with mode "plan" spawns CLI with --permission-mode plan', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-001',
      message: 'plan mode e2e test',
      project: 'Walnut',
      mode: 'plan',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as { result: string; taskId: string; isError: boolean }
    expect(rd.taskId).toBe('sess-task-001')
    expect(rd.isError).toBe(false)
    // Mock CLI echoes back the --permission-mode flag value in the result text
    expect(rd.result).toContain('[permission-mode:plan]')

    ws.close()
    await delay(50)
  })

  it('session with mode "bypass" spawns CLI with --permission-mode bypassPermissions', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-002',
      message: 'bypass mode e2e test',
      project: 'Walnut',
      mode: 'bypass',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as { result: string; taskId: string; isError: boolean }
    expect(rd.taskId).toBe('sess-task-002')
    expect(rd.isError).toBe(false)
    expect(rd.result).toContain('[permission-mode:bypassPermissions]')

    ws.close()
    await delay(50)
  })

  it('session without mode has no permission-mode flag in result', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-001',
      message: 'default mode e2e test',
      project: 'Walnut',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as { result: string; isError: boolean }
    expect(rd.isError).toBe(false)
    // No permission-mode marker in the result when mode is not set
    expect(rd.result).not.toContain('[permission-mode:')

    ws.close()
    await delay(50)
  })
})

// ── Full event payload structure (frontend contract) ──

describe('Event payload structure — frontend contract', () => {
  it('session:result has all fields the frontend needs', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'sess-task-001',
      message: 'payload structure check',
      project: 'Walnut',
    })

    const resultEvent = await resultPromise
    const data = resultEvent.data as Record<string, unknown>

    // Required fields that useSessionChat depends on
    expect(data).toHaveProperty('result')
    expect(data).toHaveProperty('taskId')
    expect(data).toHaveProperty('sessionId')
    expect(data).toHaveProperty('isError')
    // Optional but expected (stream-json uses totalCost from total_cost_usd)
    expect(data).toHaveProperty('totalCost')

    // Type checks
    expect(typeof data.result).toBe('string')
    expect(typeof data.taskId).toBe('string')
    expect(typeof data.sessionId).toBe('string')
    expect(typeof data.isError).toBe('boolean')

    ws.close()
    await delay(50)
  })
})

// ── Taskless sessions (no task_id) ──

describe('Taskless sessions', () => {
  it('session:start without taskId succeeds and produces result', async () => {
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    // Start a session with only message — no taskId
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      message: 'taskless e2e test',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      result: string
      taskId: string
      sessionId: string
      isError: boolean
    }

    // Taskless sessions should have empty taskId
    expect(rd.taskId).toBe('')
    expect(rd.result).toContain('taskless e2e test')
    expect(rd.isError).toBe(false)
    expect(rd.sessionId).toBeTruthy()

    ws.close()
    await delay(50)
  })

  it('taskless session persists to sessions store with empty taskId', async () => {
    // Start our own taskless session (self-contained — no dependency on prior tests)
    const ws = await connectWs()
    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', { message: 'taskless persist test' })
    await resultPromise

    // Poll until persistence completes
    let tasklessSessions: Array<{ taskId: string; claudeSessionId: string }> = []
    await pollUntil(async () => {
      const res = await fetch(apiUrl('/api/sessions'))
      if (res.status !== 200) return false
      const body = (await res.json()) as { sessions: Array<{ taskId: string; claudeSessionId: string }> }
      tasklessSessions = body.sessions.filter((s) => s.taskId === '')
      return tasklessSessions.length > 0
    })

    expect(tasklessSessions.length).toBeGreaterThanOrEqual(1)
    expect(tasklessSessions[0].claudeSessionId).toBeTruthy()

    ws.close()
    await delay(50)
  })
})
