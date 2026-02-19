/**
 * E2E tests for session plan mode — plan-then-execute workflow.
 *
 * What's real: Express server, WebSocket connections, event bus, session-tracker
 * persistence, REST endpoints, session mode storage.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Tests verify:
 *   1. Plan mode session stores mode='plan' in SessionRecord
 *   2. Plan info capture (planFile, planCompleted) from JSONL events
 *   3. REST execute endpoint (POST /api/sessions/:id/execute)
 *   4. from_plan creates a new session with plan content in message
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js'
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

  sessionRunner.setCliCommand(MOCK_CLI)

  // Seed a task for plan mode tests
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'plan-task-001',
          title: 'Plan mode test task',
          status: 'todo',
          priority: 'immediate',
          category: 'Work',
          project: 'TestProject',
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

// ── Plan Mode Session ──

describe('Plan mode session lifecycle', () => {
  let planSessionId: string

  it('plan-mode session starts and stores mode=plan in session record', async () => {
    const ws = await connectWs()

    // Create a plan file path inside our mock CLAUDE_HOME
    const planDir = path.join(CLAUDE_HOME, 'plans')
    await fs.mkdir(planDir, { recursive: true })
    const planFilePath = path.join(planDir, 'mock-plan-test.md')
    await fs.writeFile(planFilePath, '# Plan\n\nStep 1: Do the thing\nStep 2: Verify the thing\n')

    const resultPromise = waitForWsEvent(ws, 'session:result')

    // Start plan session — mock CLI will emit ExitPlanMode + Write events
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'plan-task-001',
      message: `plan-test:${planFilePath}`,
      project: 'TestProject',
      mode: 'plan',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      result: string
      taskId: string
      sessionId: string
      isError: boolean
    }
    expect(rd.taskId).toBe('plan-task-001')
    expect(rd.isError).toBe(false)
    expect(rd.result).toContain('[permission-mode:plan]')
    planSessionId = rd.sessionId

    ws.close()
    await delay(200)
  })

  it('session record has mode=plan and plan info fields', async () => {
    // Poll until the session record is persisted
    let record: Record<string, unknown> | undefined
    await pollUntil(async () => {
      const res = await fetch(apiUrl('/api/sessions/task/plan-task-001'))
      if (res.status !== 200) return false
      const body = (await res.json()) as { sessions: Array<Record<string, unknown>> }
      record = body.sessions.find(
        (s) => s.claudeSessionId === planSessionId,
      )
      return record !== undefined
    })

    expect(record).toBeDefined()
    expect(record!.mode).toBe('plan')
    expect(record!.planCompleted).toBe(true)
    expect(record!.planFile).toBeDefined()
    expect(typeof record!.planFile).toBe('string')
    expect((record!.planFile as string)).toContain('.claude/plans/')
  })

  it('REST execute endpoint validates session is a completed plan', async () => {
    // Should reject a non-existent session
    const res1 = await fetch(apiUrl('/api/sessions/nonexistent-id/execute'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res1.status).toBe(404)

    // Get the plan session record to verify it exists
    const sessRes = await fetch(apiUrl('/api/sessions/task/plan-task-001'))
    const sessBody = (await sessRes.json()) as { sessions: Array<Record<string, unknown>> }
    const planRec = sessBody.sessions.find(
      (s) => s.claudeSessionId === planSessionId,
    )
    expect(planRec).toBeDefined()
  })

  it('REST execute endpoint starts a new session from completed plan', async () => {
    const ws = await connectWs()

    // Call the execute endpoint (provide working_directory since mock sessions don't have cwd stored)
    const execRes = await fetch(apiUrl(`/api/sessions/${planSessionId}/execute`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task_id: 'plan-task-001',
        working_directory: process.cwd(),
      }),
    })
    expect(execRes.status).toBe(200)
    const execBody = (await execRes.json()) as { status: string; planSessionId: string; mode: string }
    expect(execBody.status).toBe('started')
    expect(execBody.planSessionId).toBe(planSessionId)
    expect(execBody.mode).toBe('bypass')

    // Wait for the execution session's result
    const resultEvent = await waitForWsEvent(ws, 'session:result')
    const rd = resultEvent.data as {
      result: string
      taskId: string
      sessionId: string
      isError: boolean
    }
    expect(rd.taskId).toBe('plan-task-001')
    expect(rd.isError).toBe(false)
    // Execution session should have system prompt (task context) and bypass mode
    expect(rd.result).toContain('[has-system-prompt]')
    expect(rd.result).toContain('[permission-mode:bypassPermissions]')
    // The session ID should be different from the plan session (new clean context)
    expect(rd.sessionId).not.toBe(planSessionId)

    ws.close()
    await delay(200)
  })
})

// ── from_plan Fallback ──

describe('from_plan fallback to resume mode', () => {
  let planSessionId: string

  it('setup: create a completed plan session', async () => {
    const ws = await connectWs()

    // Create a plan file inside our mock CLAUDE_HOME
    const planDir = path.join(CLAUDE_HOME, 'plans')
    await fs.mkdir(planDir, { recursive: true })
    const planFilePath = path.join(planDir, 'fallback-plan-test.md')
    await fs.writeFile(planFilePath, '# Fallback Plan\n\nStep 1: Do something\nStep 2: Verify\n')

    const resultPromise = waitForWsEvent(ws, 'session:result')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'plan-task-001',
      message: `plan-test:${planFilePath}`,
      project: 'TestProject',
      mode: 'plan',
    })

    const resultEvent = await resultPromise
    const rd = resultEvent.data as { sessionId: string; isError: boolean }
    expect(rd.isError).toBe(false)
    planSessionId = rd.sessionId

    // Wait for session record to be persisted with planCompleted=true
    await pollUntil(async () => {
      const res = await fetch(apiUrl('/api/sessions/task/plan-task-001'))
      if (res.status !== 200) return false
      const body = (await res.json()) as { sessions: Array<Record<string, unknown>> }
      const rec = body.sessions.find((s) => s.claudeSessionId === planSessionId)
      return rec?.planCompleted === true
    })

    ws.close()
    await delay(200)
  })

  it('falls back to resume when plan file is deleted', async () => {
    // Delete the plan file so readPlanFromSession will fail
    const planDir = path.join(CLAUDE_HOME, 'plans')
    const files = await fs.readdir(planDir)
    for (const f of files) {
      if (f.includes('fallback-plan-test')) {
        await fs.unlink(path.join(planDir, f))
      }
    }

    // Also clear any planFile reference in the session record to ensure strategy 1 fails
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js')
    await updateSessionRecord(planSessionId, { planFile: undefined })

    const ws = await connectWs()

    // Use the agent tool directly — from_plan should fall back to resume mode
    const { executeTool } = await import('../../src/agent/tools.js')

    // Listen for session result (the resumed session will produce one)
    const resultPromise = waitForWsEvent(ws, 'session:result', 20000)

    const toolResult = await executeTool('start_session', {
      task_id: 'plan-task-001',
      from_plan: planSessionId,
      working_directory: process.cwd(),
    })

    // Should return a fallback message, not an error
    expect(toolResult).toContain('Falling back to resume mode')
    expect(toolResult).toContain('bypass')
    expect(toolResult).not.toMatch(/^Error:/)

    // The resumed session should produce a result event
    const resultEvent = await resultPromise
    const rd = resultEvent.data as {
      sessionId: string
      isError: boolean
      result: string
    }
    expect(rd.isError).toBe(false)
    // The resumed session reuses the same session ID (--resume)
    expect(rd.sessionId).toBe(planSessionId)
    // Should have bypass permissions
    expect(rd.result).toContain('[permission-mode:bypassPermissions]')

    ws.close()
    await delay(200)
  })

  it('from_plan still hard-errors for nonexistent session', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')

    const result = await executeTool('start_session', {
      task_id: 'plan-task-001',
      from_plan: 'nonexistent-session-id-12345',
      working_directory: process.cwd(),
    })

    // Should be a hard error (no session record to fall back to)
    expect(result).toMatch(/^Error:/)
    expect(result).toContain('not found')
  })
})

// ── send_to_session mode override ──

describe('send_to_session mode override', () => {
  it('send_to_session with mode passes mode to resumed session', async () => {
    const ws = await connectWs()

    // Start a normal session first
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'plan-task-001',
      message: 'session for mode override test',
      project: 'TestProject',
    })
    const firstResult = await resultPromise
    const normalSessionId = (firstResult.data as { sessionId: string }).sessionId

    ws.close()
    await delay(500)

    // Now use send_to_session with mode=bypass via the agent tool
    const ws2 = await connectWs()
    const resumeResultPromise = waitForWsEvent(ws2, 'session:result', 20000)

    const { executeTool } = await import('../../src/agent/tools.js')
    const toolResult = await executeTool('send_to_session', {
      session_id: normalSessionId,
      message: 'follow up with bypass mode',
      mode: 'bypass',
    })

    expect(toolResult).toContain('mode: bypass')
    expect(toolResult).not.toMatch(/^Error:/)

    // Wait for the resumed session result
    const resumeResult = await resumeResultPromise
    const rd = resumeResult.data as {
      sessionId: string
      isError: boolean
      result: string
    }
    expect(rd.isError).toBe(false)
    // The resumed session should use bypass permissions
    expect(rd.result).toContain('[permission-mode:bypassPermissions]')

    ws2.close()
    await delay(200)
  })
})

// ── Edge Cases ──

describe('Plan mode edge cases', () => {
  it('execute endpoint rejects a non-plan session', async () => {
    const ws = await connectWs()

    // Start a normal (non-plan) session
    const resultPromise = waitForWsEvent(ws, 'session:result')
    await sendWsRpc(ws, 'session:start', {
      taskId: 'plan-task-001',
      message: 'normal session for rejection test',
      project: 'TestProject',
    })
    const result = await resultPromise
    const normalSessionId = (result.data as { sessionId: string }).sessionId

    ws.close()
    await delay(500)

    // Try to execute from a non-plan session — should fail
    const execRes = await fetch(apiUrl(`/api/sessions/${normalSessionId}/execute`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(execRes.status).toBe(400)
    const body = (await execRes.json()) as { error: string }
    expect(body.error).toContain('has not completed a plan')
  })
})
