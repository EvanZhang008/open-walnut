/**
 * E2E test for real-time session mode changes.
 *
 * Verifies the full data flow when a session transitions between modes
 * (e.g., bypass → plan via EnterPlanMode):
 *
 *   mock CLI emits system event with new permissionMode
 *   → ClaudeCodeSession.handleJsonlEvent() detects mode change
 *   → emitStatusChanged() fires session:status-changed with mode field
 *   → EventBus routes to web-ui subscriber
 *   → WebSocket broadcasts to connected browser
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

  // Seed a test task
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: ['001', '002', '003', '004'].map(n => ({
        id: `mode-change-task-${n}`,
        title: `Mode change test task ${n}`,
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

describe('Session mode change: real-time updates', () => {
  it('bypass → plan: session:status-changed event carries mode="plan" via WebSocket', async () => {
    const ws = await connectWs()
    const statusEvents = collectWsEvents(ws, ['session:status-changed'])

    // Start session in bypass mode with a message that triggers a mode change to plan.
    // The mock CLI emits: init(permissionMode=bypassPermissions) → system(permissionMode=plan) → result
    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'mode-change-task-001',
      message: 'mode-change:bypass-to-plan simulate EnterPlanMode',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for session to complete
    const result = await resultPromise
    const sessionId = (result.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Wait for all events to settle
    await delay(1000)

    // Filter status events for this task (use taskId — sessionId is null for early events before init)
    const thisTaskEvents = statusEvents.filter(
      e => (e.data as { taskId?: string })?.taskId === 'mode-change-task-001',
    )

    // There should be multiple status-changed events. At least:
    // 1. Initial in_progress (bypass mode, sessionId may be null)
    // 2. Mode change to plan (after init, sessionId set)
    // 3. Final agent_complete
    expect(thisTaskEvents.length).toBeGreaterThanOrEqual(2)

    // THE CRITICAL ASSERTION: Find a MID-SESSION mode change event.
    // This must be mode: 'plan' with work_status: 'in_progress' —
    // proving the UI gets notified in real-time, not just at session end.
    // The final 'agent_complete' event also carries mode: 'plan' (because _mode was updated),
    // but that's too late — the UI needs the update DURING the session.
    const midSessionPlanEvents = thisTaskEvents.filter(
      e => {
        const d = e.data as { mode?: string; work_status?: string }
        return d.mode === 'plan' && d.work_status === 'in_progress'
      },
    )
    expect(midSessionPlanEvents.length).toBeGreaterThanOrEqual(1)

    // The mid-session plan event should carry full metadata
    const planEvt = midSessionPlanEvents[0]
    expect(planEvt.data).toHaveProperty('sessionId', sessionId)
    expect(planEvt.data).toHaveProperty('mode', 'plan')
    expect(planEvt.data).toHaveProperty('process_status', 'running')

    // Verify the initial events had mode: 'bypass'
    const bypassEvents = thisTaskEvents.filter(
      e => (e.data as { mode?: string })?.mode === 'bypass',
    )
    expect(bypassEvents.length).toBeGreaterThanOrEqual(1)

    // Verify temporal ordering: bypass event came before mid-session plan event
    const bypassIdx = thisTaskEvents.indexOf(bypassEvents[0])
    const planIdx = thisTaskEvents.indexOf(midSessionPlanEvents[0])
    expect(bypassIdx).toBeLessThan(planIdx)

    ws.close()
    await delay(50)
  })

  it('all status-changed events carry the mode field (never undefined)', async () => {
    const ws = await connectWs()
    const statusEvents = collectWsEvents(ws, ['session:status-changed'])

    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'mode-change-task-002',
      message: 'mode-change:bypass-to-plan always has mode',
      project: 'Walnut',
      mode: 'bypass',
    })
    await resultPromise
    await delay(1000)

    // Filter to this task only
    const taskEvents = statusEvents.filter(
      e => (e.data as { taskId?: string })?.taskId === 'mode-change-task-002',
    )

    // Every status-changed event must carry the `mode` field
    expect(taskEvents.length).toBeGreaterThanOrEqual(1)
    for (const evt of taskEvents) {
      expect(evt.data).toHaveProperty('mode')
      expect(typeof evt.data?.mode).toBe('string')
      expect(['bypass', 'plan', 'accept', 'default']).toContain(evt.data?.mode)
    }

    ws.close()
    await delay(50)
  })

  it('mode stays "bypass" when no mode change occurs (no false mode-change events)', async () => {
    const ws = await connectWs()
    const statusEvents = collectWsEvents(ws, ['session:status-changed'])

    // Start a normal bypass session (no mode-change message)
    const resultPromise = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'mode-change-task-003',
      message: 'normal bypass session, no mode change',
      project: 'Walnut',
      mode: 'bypass',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)
    const result = await resultPromise
    const sessionId = (result.data as { sessionId: string }).sessionId
    await delay(1000)

    // Filter only events for THIS specific task+session
    const sessionEvents = statusEvents.filter(e => {
      const d = e.data as { taskId?: string; sessionId?: string; mode?: string }
      return d.taskId === 'mode-change-task-003' && d.mode !== undefined
    })

    // All events from this bypass-only session should have mode: 'bypass'
    for (const evt of sessionEvents) {
      expect(evt.data?.mode).toBe('bypass')
    }

    ws.close()
    await delay(50)
  })

  it('REST API returns updated mode after real-time mode change', async () => {
    const ws = await connectWs()

    // Wait for the mode-change event specifically
    const modeChangePromise = waitForWsEvent(
      ws,
      'session:status-changed',
      (evt) => (evt.data as { mode?: string })?.mode === 'plan',
    )

    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'mode-change-task-001',
      message: 'mode-change:bypass-to-plan verify REST enrichment',
      project: 'Walnut',
      mode: 'bypass',
    })

    // Wait for the mode change event to arrive
    const modeEvt = await modeChangePromise
    const sessionId = (modeEvt.data as { sessionId: string }).sessionId

    // Wait for updateSessionRecord() to persist (async fire-and-forget in the event handler)
    await delay(500)

    // Now check the REST API — should reflect the updated mode
    const sessRes = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
    expect(sessRes.status).toBe(200)
    const sessData = (await sessRes.json()) as { session: { mode: string } }
    expect(sessData.session.mode).toBe('plan')

    // Wait for session to fully complete
    await resultPromise
    await delay(200)

    // Also verify via the task enrichment endpoint
    const taskRes = await fetch(`http://localhost:${port}/api/tasks/mode-change-task-001`)
    expect(taskRes.status).toBe(200)
    const taskData = (await taskRes.json()) as {
      task: { session_status?: { mode?: string } }
    }
    // After session completes the session_status should still reflect the final mode
    if (taskData.task.session_status) {
      expect(taskData.task.session_status.mode).toBe('plan')
    }

    ws.close()
    await delay(50)
  })
})
