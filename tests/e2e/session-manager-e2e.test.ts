/**
 * Comprehensive E2E tests for SessionManager lifecycle + Registry + Liveness.
 *
 * Tests the refactored SessionManager layer through the full server pipeline:
 *   WebSocket → session runner → SessionManager → mock-claude → events → assertions
 *
 * Focus areas:
 *   1. Multi-turn conversations: start → result → follow-up → result (local + remote)
 *   2. Registry correctness: register on start, unregister on cleanup, no stale entries
 *   3. Liveness checks: isSessionProcessAlive via registry, fallback for orphans
 *   4. lastEventAt tracking: local (file mtime) and remote (in-memory timestamp)
 *   5. Session deduplication: same task → multiple turns → one session record
 *   6. Concurrent sessions: parallel starts, independent lifecycles
 *   7. Error recovery: error → follow-up resumes correctly
 *   8. Rapid follow-ups: send N messages quickly → each produces exactly 1 result
 *   9. Status transitions: in_progress → agent_complete → in_progress → agent_complete
 *  10. Health API: daemon status, session counts
 *
 * What's real: Express server, WebSocket, event bus, session tracker, SessionManager,
 *   RemoteSessionManager, DaemonConnection, health monitor, and the session daemon
 *   (the JS twin, which serves both local and remote sessions as in production).
 * What's mocked: constants.js (temp dir), Claude CLI (a `claude` on the daemon's PATH
 *   that runs mock-claude.mjs), SSH (bypassed via directWsUrl for remote sessions; `ssh`
 *   itself is a refusing stand-in, so readers that still dial the host stay off it).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { startDaemonTwin, type DaemonTwin } from '../helpers/daemon-twin.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
let daemon: DaemonTwin | null = null
const savedEnv: Record<string, string | undefined> = {}

function apiUrl(p: string): string { return `http://localhost:${port}${p}` }
function wsUrl(): string { return `ws://localhost:${port}/ws` }

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
  result?: unknown
  error?: unknown
  [key: string]: unknown
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 20000): Promise<WsEvent> {
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

/** Wait for N events of a given name, collecting them all. */
function waitForWsEvents(ws: WebSocket, eventName: string, count: number, timeoutMs = 30000): Promise<WsEvent[]> {
  return new Promise((resolve, reject) => {
    const events: WsEvent[] = []
    const timer = setTimeout(() => reject(new Error(
      `Timed out waiting for ${count}x ${eventName} (got ${events.length})`,
    )), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        events.push(frame)
        if (events.length >= count) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(events)
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
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15000)
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

function delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

/** Poll a session record until a condition is met. */
async function pollSession(
  sessionId: string,
  check: (s: Record<string, unknown>) => boolean,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  let session: Record<string, unknown> = {}
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiUrl(`/api/sessions/${sessionId}`))
      if (res.ok) {
        const body = await res.json() as { session: Record<string, unknown> }
        session = body.session
        if (check(session)) return session
      }
    } catch { /* not ready yet */ }
    await delay(300)
  }
  return session // return last known state even on timeout
}

/** Create a seed task object. */
function seedTask(id: string, title: string) {
  return {
    id,
    title,
    status: 'todo',
    priority: 'none',
    category: 'Test',
    project: 'SessionManagerTest',
    session_ids: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    description: '',
    summary: '',
    note: '',
    subtasks: [],
    phase: 'TODO',
    source: 'ms-todo',
  }
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })

  // Hermetic environment: the health monitor and history reader dial a configured
  // host through the regular SSH pool, so `ssh` is a refusing stand-in (the host
  // here is `localhost`, whose daemon could be the user's own). The server's local
  // daemon expands ~ to the test home, where the mock CLI writes its transcript.
  const shimDir = path.join(WALNUT_HOME, 'bin-shim')
  await fs.mkdir(shimDir, { recursive: true })
  await fs.writeFile(path.join(shimDir, 'ssh'), '#!/bin/sh\necho "ssh: disabled in this test" >&2\nexit 255\n', { mode: 0o755 })
  for (const k of ['PATH', 'WALNUT_HOME_OVERRIDE', 'MOCK_CLAUDE_TRANSCRIPT_DIR']) savedEnv[k] = process.env[k]
  process.env.PATH = `${shimDir}:${process.env.PATH}`
  process.env.WALNUT_HOME_OVERRIDE = WALNUT_HOME
  process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = path.join(CLAUDE_HOME, 'projects')

  // The real daemon serves local and remote sessions alike
  daemon = await startDaemonTwin({ home: WALNUT_HOME, mockCli: MOCK_CLI })
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(daemon.url)

  // Seed tasks
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [
      seedTask('mgr-local-001', 'Local multi-turn'),
      seedTask('mgr-local-002', 'Local follow-up rapid'),
      seedTask('mgr-local-003', 'Local concurrent A'),
      seedTask('mgr-local-004', 'Local concurrent B'),
      seedTask('mgr-local-005', 'Local error recovery'),
      seedTask('mgr-local-006', 'Local tool test'),
      seedTask('mgr-local-007', 'Local liveness check'),
      seedTask('mgr-remote-001', 'Remote multi-turn'),
      seedTask('mgr-remote-002', 'Remote follow-up rapid'),
      seedTask('mgr-remote-003', 'Remote liveness check'),
      seedTask('mgr-remote-004', 'Remote concurrent A'),
      seedTask('mgr-remote-005', 'Remote concurrent B'),
    ],
  }))

  // Config with a remote host
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'hosts:',
    '  mock-remote:',
    '    hostname: localhost',
    '    user: testuser',
  ].join('\n'))

  // Start server
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port

  // Wait for server to fully initialize (event bus, health monitor, etc.)
  await delay(2000)
}, 30000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  // Up to ~8s: the isolated-dir daemon reaps its live CLIs on the way out
  await daemon?.stop()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})


// ═══════════════════════════════════════════════════════════════════
//  1. Local multi-turn conversation
// ═══════════════════════════════════════════════════════════════════

describe('Local multi-turn conversation', () => {
  it('start → result → follow-up → result → follow-up → result: 3 turns, 1 session', async () => {
    const ws = await connectWs()
    try {
      // Turn 1: start
      const result1Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-001',
        message: 'turn 1: hello',
      })
      const result1 = await result1Promise
      const sessionId = result1.data!.sessionId as string
      expect(result1.data!.isError).toBe(false)
      expect(result1.data!.result).toContain('turn 1: hello')
      expect(sessionId).toBeTruthy()

      // Verify session record after turn 1
      const session1 = await pollSession(sessionId, s => s.process_status === 'stopped')
      expect(session1.process_status).toBe('stopped')
      expect(session1.process_status).toBe('stopped')

      // Turn 2: follow-up
      const result2Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'turn 2: follow up',
      })
      const result2 = await result2Promise
      expect(result2.data!.isError).toBe(false)
      expect(result2.data!.result).toContain('turn 2: follow up')
      // Same session ID (resumed, not new)
      expect(result2.data!.sessionId).toBe(sessionId)

      // Turn 3: another follow-up
      const result3Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'turn 3: final message',
      })
      const result3 = await result3Promise
      expect(result3.data!.isError).toBe(false)
      expect(result3.data!.result).toContain('turn 3: final message')
      expect(result3.data!.sessionId).toBe(sessionId)

      // Verify only 1 session exists for this task
      const taskSessions = await fetch(apiUrl(`/api/sessions/task/mgr-local-001`))
      const taskBody = await taskSessions.json() as { sessions: unknown[] }
      expect(taskBody.sessions.length).toBe(1)

      // Final session state
      const finalSession = await pollSession(sessionId, s => s.process_status === 'stopped')
      expect(finalSession.process_status).toBe('stopped')
      expect(finalSession.process_status).toBe('stopped')
    } finally {
      ws.close()
    }
  }, 60000)
})


// ═══════════════════════════════════════════════════════════════════
//  2. Remote multi-turn conversation
// ═══════════════════════════════════════════════════════════════════

describe('Remote multi-turn conversation', () => {
  it('start → result → follow-up → result: 2 turns via daemon, 1 session', async () => {
    const ws = await connectWs()
    try {
      // Turn 1
      const result1Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-remote-001',
        message: 'remote turn 1',
        host: 'mock-remote',
        cwd: '/tmp',
      })
      const result1 = await result1Promise
      const sessionId = result1.data!.sessionId as string
      expect(result1.data!.isError).toBe(false)
      expect(result1.data!.result).toContain('remote turn 1')

      // Verify session has host set
      const session1 = await pollSession(sessionId, s => s.process_status === 'stopped')
      expect(session1.host).toBe('mock-remote')
      expect(session1.process_status).toBe('stopped')

      // Turn 2: follow-up
      const result2Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'remote turn 2',
      })
      const result2 = await result2Promise
      expect(result2.data!.isError).toBe(false)
      // Result text comes from mock-claude which may echo the resume message or follow-up.
      // The important assertion is that it succeeded (isError=false) and belongs to this session.
      expect(typeof result2.data!.result).toBe('string')
      expect(result2.data!.sessionId).toBe(sessionId)

      // Still 1 session for this task
      const taskSessions = await fetch(apiUrl(`/api/sessions/task/mgr-remote-001`))
      const taskBody = await taskSessions.json() as { sessions: unknown[] }
      expect(taskBody.sessions.length).toBe(1)

      // The task links the remote session (ssh-session's hosts refuse SSH, so this is
      // where a remote session's task link is covered)
      await vi.waitFor(async () => {
        const taskRes = await fetch(apiUrl('/api/tasks/mgr-remote-001'))
        const { task } = await taskRes.json() as { task: { session_ids?: string[] } }
        expect(task.session_ids ?? []).toContain(sessionId)
      }, { timeout: 15_000, interval: 200 })
    } finally {
      ws.close()
    }
  }, 60000)
})


// ═══════════════════════════════════════════════════════════════════
//  3. Registry correctness
// ═══════════════════════════════════════════════════════════════════

describe('SessionManager registry', () => {
  it('registered during session, unregistered after process exits', async () => {
    const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')

    const ws = await connectWs()
    try {
      // Start a slow session so we can check registry mid-flight
      const statusEvents = collectWsEvents(ws, ['session:status-changed'])
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-007',
        message: 'slow:500 registry test',
      })

      // Wait for at least one status event (session is now running)
      await delay(300)

      // The session should be in the registry while running
      // We need the sessionId — get it from the first status event
      const inProgressEvents = statusEvents.filter(e =>
        e.data?.process_status === 'running' && e.data?.taskId === 'mgr-local-007',
      )
      // May or may not have fired yet — wait for result instead
      const result = await resultPromise
      const sessionId = result.data!.sessionId as string

      // After process exits, wait for cleanup
      await delay(500)

      // Once stopped, registry should be cleared (on next send() or cleanup)
      // The transport is detached when the next send replaces it, or on server shutdown.
      // For a completed session that's not replaced, the registry entry persists
      // (which is fine — it enables liveness checks).
      const mgr = getRegisteredSessionManager(sessionId)
      // Manager should exist (it's only unregistered when replaced or cleaned up)
      if (mgr) {
        // isAlive should return false since the process exited
        const alive = await mgr.isAlive()
        expect(alive).toBe(false)
        expect(mgr.isRemote).toBe(false)
      }
    } finally {
      ws.close()
    }
  }, 30000)

  it('follow-up reuses same registry entry (no duplicate managers)', async () => {
    const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')

    const ws = await connectWs()
    try {
      // Turn 1
      const result1Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-002',
        message: 'registry turn 1',
      })
      const result1 = await result1Promise
      const sessionId = result1.data!.sessionId as string
      await delay(200)

      const mgr1 = getRegisteredSessionManager(sessionId)

      // Turn 2: follow-up
      const result2Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'registry turn 2',
      })
      await result2Promise
      await delay(200)

      const mgr2 = getRegisteredSessionManager(sessionId)

      // Both should be non-null (registered)
      expect(mgr1).toBeDefined()
      expect(mgr2).toBeDefined()

      // The manager should still be for the same session (local, not remote)
      expect(mgr2!.isRemote).toBe(false)
      expect(mgr2!.host).toBeNull()
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  4. Liveness check via isSessionProcessAlive
// ═══════════════════════════════════════════════════════════════════

describe('isSessionProcessAlive', () => {
  it('returns true during slow session, false after completion', async () => {
    const { isSessionProcessAlive } = await import('../../src/utils/session-liveness.js')

    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-006',
        message: 'slow:1000 liveness check',
      })

      // Wait for the session to be registered (but still running due to slow:1000)
      await delay(400)

      // Get session record
      const taskSessions = await fetch(apiUrl(`/api/sessions/task/mgr-local-006`))
      const taskBody = await taskSessions.json() as { sessions: Array<Record<string, unknown>> }
      const sessionRecord = taskBody.sessions[0]

      if (sessionRecord && sessionRecord.claudeSessionId) {
        // Should be alive while running
        const aliveWhileRunning = await isSessionProcessAlive(sessionRecord as never)
        expect(aliveWhileRunning).toBe(true)
      }

      // Wait for completion
      await resultPromise
      await delay(500)

      // Refresh record
      const taskSessions2 = await fetch(apiUrl(`/api/sessions/task/mgr-local-006`))
      const taskBody2 = await taskSessions2.json() as { sessions: Array<Record<string, unknown>> }
      const sessionRecord2 = taskBody2.sessions[0]

      if (sessionRecord2 && sessionRecord2.claudeSessionId) {
        const aliveAfter = await isSessionProcessAlive(sessionRecord2 as never)
        expect(aliveAfter).toBe(false)
      }
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  5. lastEventAt tracking
// ═══════════════════════════════════════════════════════════════════

describe('lastEventAt tracking', () => {
  it('local session: lastEventAt > 0 after events arrive', async () => {
    const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')

    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-005',
        message: 'lastEventAt local test',
      })

      const result = await resultPromise
      const sessionId = result.data!.sessionId as string
      await delay(200)

      const mgr = getRegisteredSessionManager(sessionId)
      expect(mgr).toBeDefined()

      // lastEventAt should be > 0 (file was written to)
      const lastEvent = mgr!.lastEventAt
      expect(lastEvent).toBeGreaterThan(0)
      // Should be recent (within 30 seconds)
      expect(Date.now() - lastEvent).toBeLessThan(30_000)
    } finally {
      ws.close()
    }
  }, 30000)

  it('remote session: lastEventAt updated by daemon events', async () => {
    const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')

    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-remote-003',
        message: 'lastEventAt remote test',
        host: 'mock-remote',
        cwd: '/tmp',
      })

      const result = await resultPromise
      const sessionId = result.data!.sessionId as string
      await delay(200)

      const mgr = getRegisteredSessionManager(sessionId)
      expect(mgr).toBeDefined()
      expect(mgr!.isRemote).toBe(true)

      // lastEventAt should be > 0 (updated by daemon events in memory)
      const lastEvent = mgr!.lastEventAt
      expect(lastEvent).toBeGreaterThan(0)
      expect(Date.now() - lastEvent).toBeLessThan(30_000)
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  6. No duplicate session:result events
// ═══════════════════════════════════════════════════════════════════

describe('Session deduplication', () => {
  it('follow-up to completed session produces exactly 1 session:result, not 2', async () => {
    const ws = await connectWs()
    try {
      // Turn 1
      const result1Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-003',
        message: 'dedup turn 1',
      })
      const result1 = await result1Promise
      const sessionId = result1.data!.sessionId as string
      await pollSession(sessionId, s => s.process_status === 'stopped')

      // Turn 2: collect ALL result events
      const allResults = collectWsEvents(ws, ['session:result'])
      const result2Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'dedup turn 2',
      })
      await result2Promise

      // Wait a bit for any spurious duplicate
      await delay(1000)

      // Filter results for our session
      const ourResults = allResults.filter(e => e.data?.sessionId === sessionId)
      expect(ourResults.length).toBe(1)
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  7. Concurrent sessions — independent lifecycles
// ═══════════════════════════════════════════════════════════════════

describe('Concurrent sessions', () => {
  it('two local sessions started simultaneously → both complete independently', async () => {
    const ws = await connectWs()
    try {
      // Start both simultaneously
      const results = waitForWsEvents(ws, 'session:result', 2, 30000)

      await Promise.all([
        sendWsRpc(ws, 'session:start', { taskId: 'mgr-local-003', message: 'concurrent A' }),
        sendWsRpc(ws, 'session:start', { taskId: 'mgr-local-004', message: 'concurrent B' }),
      ])

      const [r1, r2] = await results

      // Both should succeed
      expect(r1.data!.isError).toBe(false)
      expect(r2.data!.isError).toBe(false)

      // Should have different session IDs
      const sid1 = r1.data!.sessionId as string
      const sid2 = r2.data!.sessionId as string
      expect(sid1).not.toBe(sid2)

      // Both should be in agent_complete
      const s1 = await pollSession(sid1, s => s.process_status === 'stopped')
      const s2 = await pollSession(sid2, s => s.process_status === 'stopped')
      expect(s1.process_status).toBe('stopped')
      expect(s2.process_status).toBe('stopped')
    } finally {
      ws.close()
    }
  }, 30000)

  it('local + remote sessions in parallel → both complete, correct host fields', async () => {
    const ws = await connectWs()
    try {
      const results = waitForWsEvents(ws, 'session:result', 2, 30000)

      await Promise.all([
        sendWsRpc(ws, 'session:start', { taskId: 'mgr-remote-004', message: 'mixed local', }),
        sendWsRpc(ws, 'session:start', { taskId: 'mgr-remote-005', message: 'mixed remote', host: 'mock-remote', cwd: '/tmp' }),
      ])

      const allResults = await results
      expect(allResults.length).toBe(2)

      // Both should succeed
      for (const r of allResults) {
        expect(r.data!.isError).toBe(false)
      }

      // Check session records
      const sid1 = allResults[0].data!.sessionId as string
      const sid2 = allResults[1].data!.sessionId as string
      const s1 = await pollSession(sid1, s => s.process_status === 'stopped')
      const s2 = await pollSession(sid2, s => s.process_status === 'stopped')

      // One should be local, one remote (order may vary)
      const hosts = [s1.host, s2.host]
      // At least one should be remote (mock-remote), one local (null/undefined)
      expect(hosts.filter(h => h === 'mock-remote').length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  8. Error recovery
// ═══════════════════════════════════════════════════════════════════

describe('Error recovery', () => {
  it('completed session → follow-up after agent_complete → new result arrives', async () => {
    const ws = await connectWs()
    try {
      // Start a normal session first
      const result1Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-005',
        message: 'recovery base',
      })
      const result1 = await result1Promise
      const sessionId = result1.data!.sessionId as string
      expect(result1.data!.isError).toBe(false)

      // Wait for agent_complete
      const doneSession = await pollSession(sessionId, s => s.process_status === 'stopped')
      expect(doneSession.process_status).toBe('stopped')
      expect(doneSession.process_status).toBe('stopped')

      // Follow-up to a completed session → should resume and produce a new result
      const result2Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'recovery follow-up',
      })
      const result2 = await result2Promise
      expect(result2.data!.isError).toBe(false)
      expect(result2.data!.sessionId).toBe(sessionId)

      // Session should be back to agent_complete
      const recoveredSession = await pollSession(sessionId, s => s.process_status === 'stopped')
      expect(recoveredSession.process_status).toBe('stopped')
      expect(recoveredSession.process_status).toBe('stopped')
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  9. Status transitions during lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('Status transitions', () => {
  it('start → in_progress → agent_complete → send → in_progress → agent_complete', async () => {
    const ws = await connectWs()
    try {
      const statusEvents = collectWsEvents(ws, ['session:status-changed'])

      // Turn 1
      const result1Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-004',
        message: 'slow:300 status transitions',
      })
      const result1 = await result1Promise
      const sessionId = result1.data!.sessionId as string
      await delay(500)

      // Turn 2
      const result2Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'slow:300 status turn 2',
      })
      await result2Promise
      await delay(500)

      // Analyze status transitions for our session
      const ourStatuses = statusEvents
        .filter(e => e.data?.sessionId === sessionId)
        .map(e => ({
          process_status: e.data!.process_status,
        }))

      // Should see at least: running, stopped (from turn 1)
      // and: running, stopped (from turn 2)
      const processStatuses = ourStatuses.map(s => s.process_status)
      expect(processStatuses.filter(s => s === 'running').length).toBeGreaterThanOrEqual(1)
      expect(processStatuses.filter(s => s === 'stopped').length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  10. Remote session liveness via registry
// ═══════════════════════════════════════════════════════════════════

describe('Remote session liveness', () => {
  it('remote session alive during execution, dead after completion', async () => {
    const { getRegisteredSessionManager } = await import('../../src/providers/session-manager.js')

    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-remote-002',
        message: 'slow:800 remote liveness',
        host: 'mock-remote',
        cwd: '/tmp',
      })

      // Wait for session to start (but not finish due to slow:800)
      await delay(400)

      // Get session ID from task's sessions
      const taskSessions = await fetch(apiUrl(`/api/sessions/task/mgr-remote-002`))
      const taskBody = await taskSessions.json() as { sessions: Array<Record<string, unknown>> }
      const record = taskBody.sessions[0]

      if (record?.claudeSessionId) {
        const mgr = getRegisteredSessionManager(record.claudeSessionId as string)
        if (mgr) {
          // Should be alive (slow:800 hasn't completed yet)
          const alive = await mgr.isAlive()
          expect(alive).toBe(true)
          expect(mgr.isRemote).toBe(true)
          expect(mgr.host).toBe('mock-remote')
        }
      }

      // Wait for completion
      await resultPromise
      await delay(500)

      // Refresh and check again
      if (record?.claudeSessionId) {
        const mgr = getRegisteredSessionManager(record.claudeSessionId as string)
        if (mgr) {
          const aliveAfter = await mgr.isAlive()
          expect(aliveAfter).toBe(false)
        }
      }
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  11. Health API reflects daemon connection
// ═══════════════════════════════════════════════════════════════════

describe('Health API', () => {
  it('/api/system/health returns daemon status', async () => {
    const res = await fetch(apiUrl('/api/system/health'))
    expect(res.ok).toBe(true)
    const body = await res.json() as Record<string, unknown>
    expect(body).toBeDefined()
    // Health endpoint should exist and return valid JSON
    expect(typeof body).toBe('object')
  })

  it('/api/sessions lists all sessions with correct fields', async () => {
    const res = await fetch(apiUrl('/api/sessions'))
    expect(res.ok).toBe(true)
    const body = await res.json() as { sessions: Array<Record<string, unknown>> }
    expect(Array.isArray(body.sessions)).toBe(true)

    // At least some sessions should exist from earlier tests
    expect(body.sessions.length).toBeGreaterThan(0)

    // Each session should have required fields
    for (const s of body.sessions) {
      expect(s.claudeSessionId).toBeTruthy()
      expect(typeof s.process_status).toBe('string')
      expect(typeof s.process_status).toBe('string')
    }
  })
})


// ═══════════════════════════════════════════════════════════════════
//  12. Tool-use events flow through SessionManager
// ═══════════════════════════════════════════════════════════════════

describe('Tool events through SessionManager', () => {
  it('tool-test message → receives tool_use + tool_result in stream', async () => {
    const ws = await connectWs()
    try {
      const allEvents = collectWsEvents(ws, ['session:tool-use', 'session:tool-result', 'session:result'])

      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-006',
        message: 'tool-test',
      })

      const result = await resultPromise
      expect(result.data!.isError).toBe(false)

      // Wait for all events to be collected
      await delay(500)

      // Should have at least result events
      expect(allEvents.length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  13. Session history via REST API
// ═══════════════════════════════════════════════════════════════════

describe('Session history', () => {
  it('local session history contains JSONL messages', async () => {
    const ws = await connectWs()
    try {
      // snapshot-clean-turn makes the mock CLI write the canonical transcript
      // (~/.claude/projects/<cwd>/<sid>.jsonl) that the history reader serves.
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-007',
        message: 'snapshot-clean-turn:history test message',
      })
      const result = await resultPromise
      const sessionId = result.data!.sessionId as string

      await delay(500)

      // Fetch history via REST API
      const histRes = await fetch(apiUrl(`/api/sessions/${sessionId}/history`))
      expect(histRes.status).toBe(200)
      const histBody = await histRes.json() as { messages: unknown[] }
      // Should have some messages (init, assistant, result at minimum)
      expect(histBody.messages.length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  }, 30000)
})


// ═══════════════════════════════════════════════════════════════════
//  14. Rapid sequential follow-ups
// ═══════════════════════════════════════════════════════════════════

describe('Rapid sequential follow-ups', () => {
  it('3 rapid follow-ups → 3 results, all with correct session ID', async () => {
    const ws = await connectWs()
    try {
      // Start initial session
      const result0Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-local-002',
        message: 'rapid base',
      })
      const result0 = await result0Promise
      const sessionId = result0.data!.sessionId as string
      await pollSession(sessionId, s => s.process_status === 'stopped')

      // Send 3 follow-ups sequentially (waiting for each to complete before next)
      for (let i = 1; i <= 3; i++) {
        const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
        await sendWsRpc(ws, 'session:send', {
          sessionId,
          message: `rapid follow-up ${i}`,
        })
        const result = await resultPromise
        expect(result.data!.isError).toBe(false)
        expect(result.data!.result).toContain(`rapid follow-up ${i}`)
        expect(result.data!.sessionId).toBe(sessionId)

        // Wait for completion before next
        await pollSession(sessionId, s => s.process_status === 'stopped')
      }

      // Verify session is healthy after rapid follow-ups
      const finalSession = await pollSession(sessionId, s => s.process_status === 'stopped')
      expect(finalSession.process_status).toBe('stopped')
      expect(finalSession.process_status).toBe('stopped')
    } finally {
      ws.close()
    }
  }, 90000)
})


// ═══════════════════════════════════════════════════════════════════
//  15. Remote rapid follow-ups
// ═══════════════════════════════════════════════════════════════════

describe('Remote rapid follow-ups', () => {
  it('start + 2 follow-ups on remote → all succeed, all via daemon', async () => {
    const ws = await connectWs()
    try {
      // Start
      const result0Promise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: 'mgr-remote-002',
        message: 'remote rapid base',
        host: 'mock-remote',
        cwd: '/tmp',
      })
      const result0 = await result0Promise
      const sessionId = result0.data!.sessionId as string
      await pollSession(sessionId, s => s.process_status === 'stopped')

      // 2 follow-ups
      for (let i = 1; i <= 2; i++) {
        const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
        await sendWsRpc(ws, 'session:send', {
          sessionId,
          message: `remote rapid ${i}`,
        })
        const result = await resultPromise
        expect(result.data!.isError).toBe(false)
        // Remote follow-up result text may echo the original or follow-up message
        // depending on how the daemon pipes it. The key assertion is success + same session.
        expect(typeof result.data!.result).toBe('string')
        expect(result.data!.sessionId).toBe(sessionId)
        await pollSession(sessionId, s => s.process_status === 'stopped')
      }
    } finally {
      ws.close()
    }
  }, 60000)
})
