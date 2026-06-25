/**
 * E2E test for dynamic-workflow / background-task turn boundaries.
 *
 * Full path: WS client → session:send → MockDaemon → mock-claude.mjs emits the
 * `workflow-test` sequence (main result while 2 subagents run → task_progress →
 * task_notification×2 → session_state_changed{idle}) → ClaudeCodeSession →
 * event bus → server WS forwarding.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker,
 * task-manager, ClaudeCodeSession, MockDaemon transport.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Asserts the headline guarantee of this feature:
 *   1. The UI receives session:background-tasks snapshots (inFlight peaks at 2).
 *   2. The session does NOT emit session:result on the main turn's own result
 *      (the bug we fixed) — it only completes after the authoritative idle.
 *   3. Exactly one session:result is emitted for the whole workflow turn.
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
        id: 'wf-task-001',
        title: 'Dynamic workflow E2E task',
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

describe('Dynamic workflow E2E: stays running until idle, surfaces progress', () => {
  it('main-turn result does not complete; idle completes; UI gets bg-task snapshots', async () => {
    const ws = await connectWs()

    // Start collecting BEFORE the send so we catch every frame in order.
    const bgCollector = collectWsEvents(ws, 'session:background-tasks')
    const resultCollector = collectWsEvents(ws, 'session:result')

    // Kick off the workflow turn.
    const rpc = await sendWsRpc(ws, 'session:start', {
      taskId: 'wf-task-001',
      message: 'workflow-test',
      project: 'Walnut',
    })
    expect((rpc as Record<string, unknown>).ok).toBe(true)

    // The mock spaces idle ~450ms after start; wait for the authoritative result.
    const resultEvent = await waitForWsEvent(ws, 'session:result', 15000)
    const rd = resultEvent.data as { sessionId: string; taskId: string; isError?: boolean }
    expect(rd.taskId).toBe('wf-task-001')
    expect(rd.isError).toBeFalsy()

    // Let any trailing frames flush.
    await delay(300)
    bgCollector.cleanup()
    resultCollector.cleanup()

    // (1) The UI received background-task snapshots. A dynamic workflow is ONE
    // top-level background task (the N subagents live inside workflow_progress),
    // so inFlight peaks at 1 and drains to 0.
    const inFlights = bgCollector.events.map(e => (e.data as { inFlight: number }).inFlight)
    expect(bgCollector.events.length).toBeGreaterThan(0)
    expect(Math.max(...inFlights)).toBe(1)
    expect(inFlights[inFlights.length - 1]).toBe(0)

    // Workflow name + generated script surfaced for the panel header / "view script".
    const named = bgCollector.events.find(e => (e.data as { workflowName?: string }).workflowName)
    expect((named?.data as { workflowName?: string } | undefined)?.workflowName).toBe('review-changes')
    const scripted = bgCollector.events.find(e => (e.data as { scriptSource?: string }).scriptSource)
    expect((scripted?.data as { scriptSource?: string } | undefined)?.scriptSource).toContain("name: 'review-changes'")

    // (1b) The per-subagent breakdown accumulated: 2 phases, and the agents union
    // reached both subagents, both ending terminal with a resultPreview.
    type Agent = { agentId: string; status: string; resultPreview?: string; label?: string }
    type BgData = { phases?: { index: number; title: string }[]; agents?: Agent[] }
    const maxAgents = Math.max(...bgCollector.events.map(e => ((e.data as BgData).agents ?? []).length))
    expect(maxAgents).toBe(2)
    const finalAgents = (bgCollector.events[bgCollector.events.length - 1].data as BgData).agents ?? []
    expect(finalAgents.length).toBe(2)
    expect(finalAgents.every(a => a.status === 'completed')).toBe(true)
    expect(finalAgents.find(a => a.label === 'bugs')?.resultPreview).toBe('Found 2 bugs')
    const phaseSnap = bgCollector.events.find(e => ((e.data as BgData).phases ?? []).length >= 2)
    expect((phaseSnap?.data as BgData | undefined)?.phases?.length).toBe(2)

    // (2) + (3) Exactly ONE session:result for the whole workflow turn — the
    // main turn's own "launched in background" result and the task-notification
    // result must NOT have produced their own completion events.
    expect(resultCollector.events.length).toBe(1)

    ws.close()
  }, 30000)

  it('large fan-out: agents union exceeds the density threshold (feeds the density-bar view)', async () => {
    const ws = await connectWs()
    const bgCollector = collectWsEvents(ws, 'session:background-tasks')

    const rpc = await sendWsRpc(ws, 'session:start', {
      taskId: 'wf-task-001',
      message: 'workflow-test-big',
      project: 'Walnut',
    })
    expect((rpc as Record<string, unknown>).ok).toBe(true)

    await waitForWsEvent(ws, 'session:result', 15000)
    await delay(300)
    bgCollector.cleanup()

    // The big fan-out accumulates to 10 agents in ONE phase — that's > DENSITY_THRESHOLD
    // (6), the condition under which the panel folds the phase into a density bar.
    type Agent = { agentId: string; status: string; phaseIndex?: number }
    type BgData = { phases?: { index: number; title: string }[]; agents?: Agent[]; workflowName?: string }
    const maxAgents = Math.max(...bgCollector.events.map(e => ((e.data as BgData).agents ?? []).length))
    expect(maxAgents).toBe(10)
    const named = bgCollector.events.find(e => (e.data as BgData).workflowName)
    expect((named?.data as BgData | undefined)?.workflowName).toBe('review-all-files')
    // All 10 land in the single "Review" phase (phaseIndex 1) → one density-bar group.
    const finalAgents = (bgCollector.events[bgCollector.events.length - 1].data as BgData).agents ?? []
    expect(finalAgents.length).toBe(10)
    expect(finalAgents.every(a => a.phaseIndex === 1)).toBe(true)
    expect(finalAgents.every(a => a.status === 'completed')).toBe(true)

    ws.close()
  }, 30000)
})
