/**
 * E2E: auto-continue recovers a session turn that died to upstream retry
 * exhaustion (b12 retry hardening).
 *
 * Full server pipeline: WebSocket → session runner → mock-claude → SESSION_RESULT
 * → auto-continue scheduler → sendMessageToSession → resumed turn. Only the Claude
 * CLI is mocked (mock-claude.mjs "timeout-error" trigger emits an is_error result
 * whose text contains "Request timed out").
 *
 * The auto-continue delay is shortened to ~1s via WALNUT_AUTO_CONTINUE_DELAY_MS
 * (set before startServer, since the config is resolved at startup).
 *
 * Scenarios:
 *   1. error-result → a `continue` nudge is enqueued after the delay (resumed turn)
 *   2. a user message before the delay cancels the pending nudge
 *   3. the rolling-hour cap is respected (>maxPerHour never fires)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

// Shorten the delay + tighten the cap BEFORE the server (and thus the scheduler)
// starts. windowMs stays long so the cap test's repeated fires all land in it.
process.env.WALNUT_AUTO_CONTINUE_DELAY_MS = '800'
process.env.WALNUT_AUTO_CONTINUE_MAX_PER_HOUR = '2'
process.env.WALNUT_AUTO_CONTINUE_WINDOW_MS = '3600000'

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function apiUrl(p: string): string { return `http://localhost:${port}${p}` }
function wsUrl(): string { return `ws://localhost:${port}/ws` }
function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

interface WsEvent { type: string; name?: string; data?: Record<string, unknown>; id?: string; [k: string]: unknown }

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function collect(ws: WebSocket, names: string[]): WsEvent[] {
  const out: WsEvent[] = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsEvent
    if (frame.type === 'event' && names.includes(frame.name!)) out.push(frame)
  })
  return out
}

/** Wait for a session:result for a SPECIFIC task (results broadcast to all ws
 *  clients, so we must filter — otherwise another scenario's result races in). */
function waitForResultFor(ws: WebSocket, taskId: string, timeoutMs = 20000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for session:result of ${taskId}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === 'session:result' && (frame.data as { taskId?: string })?.taskId === taskId) {
        clearTimeout(timer); ws.off('message', handler); resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

/** Wait for a `continue` nudge (message-queued) for a specific session, or resolve
 *  null after `windowMs` if none arrives. This is the deterministic signal that the
 *  auto-continue scheduler fired through the NORMAL enqueue path. */
function waitForNudge(ws: WebSocket, sessionId: string, windowMs: number): Promise<WsEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { ws.off('message', handler); resolve(null) }, windowMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === 'session:message-queued'
        && (frame.data as { sessionId?: string })?.sessionId === sessionId
        && (frame.data as { message?: string })?.message === 'continue') {
        clearTimeout(timer); ws.off('message', handler); resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && frame.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(frame) }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function seedTask(id: string, title: string) {
  return {
    id, title, status: 'todo', priority: 'none', category: 'Test', project: 'AutoContinueTest',
    session_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // Route session spawns through a local MockDaemon (not the real host daemon /
  // real `claude` CLI). MockDaemon spawns mock-claude.mjs and delivers the start
  // message as a positional CLI arg, so the mock sees "timeout-error" directly.
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [
      seedTask('ac-001', 'Auto-continue fires'),
      seedTask('ac-002', 'User send cancels'),
      seedTask('ac-003', 'Hourly cap'),
    ],
  }))

  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  // Await the full server shutdown BEFORE stopping the mock daemon / wiping
  // WALNUT_HOME — an un-awaited stopServer() races its async teardown against
  // the daemon teardown and the rm() below (b12 review P2).
  await stopServer()
  await daemon.stop()
  await delay(500)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  delete process.env.WALNUT_AUTO_CONTINUE_DELAY_MS
  delete process.env.WALNUT_AUTO_CONTINUE_MAX_PER_HOUR
  delete process.env.WALNUT_AUTO_CONTINUE_WINDOW_MS
  delete process.env.WALNUT_MOCK_CONTINUE_TIMEOUT
}, 15000)

describe('auto-continue E2E', () => {
  it('a retry-exhaustion error-result turn enqueues a `continue` nudge after the delay', async () => {
    const ws = await connectWs()
    try {
      // Turn 1: fails with a retry-exhaustion result ("Request timed out").
      const r1p = waitForResultFor(ws, 'ac-001')
      await sendWsRpc(ws, 'session:start', { taskId: 'ac-001', message: 'timeout-error' })
      const r1 = await r1p
      const sessionId = r1.data!.sessionId as string
      expect(r1.data!.isError).toBe(true)
      expect(String(r1.data!.result)).toMatch(/Request timed out/i)

      // The scheduler fires a `continue` nudge through the NORMAL enqueue path
      // (~800ms later). We observe it as a message-queued event with message
      // 'continue' — the deterministic proof that the nudge was enqueued exactly
      // like a user "continue" (chat-visible, not bypassing the queue).
      const nudge = await waitForNudge(ws, sessionId, 6000)
      expect(nudge).toBeTruthy()
      expect((nudge!.data as { source?: string }).source).toBe('auto-continue')
    } finally { ws.close() }
  }, 40000)

  it('a user message before the delay cancels the pending nudge', async () => {
    const ws = await connectWs()
    try {
      const r1p = waitForResultFor(ws, 'ac-002')
      await sendWsRpc(ws, 'session:start', { taskId: 'ac-002', message: 'timeout-error' })
      const r1 = await r1p
      const sessionId = r1.data!.sessionId as string
      expect(r1.data!.isError).toBe(true)

      // User sends a real follow-up immediately (well before the 800ms nudge delay).
      // This must cancel the pending auto-continue — the human took over.
      await sendWsRpc(ws, 'session:send', { sessionId, message: 'user took over' })

      // No `continue` nudge may ever fire for this session (wait past the delay).
      const nudge = await waitForNudge(ws, sessionId, 3000)
      expect(nudge).toBeNull()
    } finally { ws.close() }
  }, 40000)

  it('respects the rolling-hour cap (fires at most maxPerHour=2 per session)', async () => {
    // Make resumed `continue` turns ALSO time out, so each nudge re-triggers.
    process.env.WALNUT_MOCK_CONTINUE_TIMEOUT = '1'
    const ws = await connectWs()
    try {
      const queued = collect(ws, ['session:message-queued'])
      const r1p = waitForResultFor(ws, 'ac-003')
      await sendWsRpc(ws, 'session:start', { taskId: 'ac-003', message: 'timeout-error' })
      const r1 = await r1p
      const sessionId = r1.data!.sessionId as string
      expect(r1.data!.isError).toBe(true)

      // Let the scheduler run well past 2 nudge cycles (delay 800ms each). With the
      // cap at 2, at most 2 `continue` nudges may ever be enqueued for this session.
      await delay(6000)
      const nudges = queued.filter(e =>
        (e.data as { sessionId?: string }).sessionId === sessionId
        && (e.data as { message?: string }).message === 'continue')
      expect(nudges.length).toBeGreaterThanOrEqual(1)
      expect(nudges.length).toBeLessThanOrEqual(2)
    } finally {
      ws.close()
      delete process.env.WALNUT_MOCK_CONTINUE_TIMEOUT
    }
  }, 40000)
})
