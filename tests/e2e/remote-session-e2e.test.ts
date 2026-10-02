/**
 * Full server E2E tests for remote sessions against the REAL session daemon.
 *
 * Tests the complete flow: WebSocket RPC → SessionRunner → RemoteSessionManager → daemon → mock-claude.
 * Verifies session:start, session:send, session records, health API, and error recovery.
 *
 * What's real: Express server, WebSocket, event bus, session runner, session tracker,
 *   RemoteSessionManager, and the daemon (the JS twin, so its reaps, exit-code
 *   normalization and snapshots are the production ones).
 * What's mocked: SSH (bypassed via directWsUrl; `ssh` itself is a refusing stand-in, so
 *   the readers that still dial the host directly never reach a real machine), Claude
 *   CLI (a `claude` on the daemon's PATH that runs mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate all file I/O to a temp directory
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, TASKS_FILE, CLAUDE_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startDaemonTwin, type DaemonTwin } from '../helpers/daemon-twin.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: DaemonTwin | null = null
const savedEnv: Record<string, string | undefined> = {}

// ── WS Helpers (same pattern as other E2E tests) ──

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string | number
  result?: unknown
  error?: string
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 20000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsEvent
        if (msg.type === 'event' && msg.name === eventName) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(msg)
        }
      } catch { /* not JSON — skip */ }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15000)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsEvent
        if (msg.id === id) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(msg)
        }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

// ── Setup ──

beforeAll(async () => {
  // 1. Clean home dir
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })

  // 2. Write tasks file
  const tasksDir = path.dirname(TASKS_FILE)
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))

  // 3. Write config with a mock remote host
  await fs.writeFile(
    path.join(WALNUT_HOME, 'config.yaml'),
    [
      'version: 1',
      'user:',
      '  name: TestUser',
      'defaults:',
      '  priority: none',
      '  category: Inbox',
      'hosts:',
      '  mock-remote:',
      '    hostname: localhost',
      '    user: testuser',
    ].join('\n') + '\n',
  )

  // 4. Hermetic environment. Session start/send go to the daemon below, but the
  //    health monitor and history reader dial a configured host through the regular
  //    SSH pool: a refusing `ssh` stand-in keeps them off any real machine (here the
  //    host is `localhost`, whose daemon could be the user's own). The server's local
  //    daemon expands ~ to the test home, where the mock CLI writes its transcript.
  const shimDir = path.join(WALNUT_HOME, 'bin-shim')
  await fs.mkdir(shimDir, { recursive: true })
  await fs.writeFile(path.join(shimDir, 'ssh'), '#!/bin/sh\necho "ssh: disabled in this test" >&2\nexit 255\n', { mode: 0o755 })
  for (const k of ['PATH', 'WALNUT_HOME_OVERRIDE', 'MOCK_CLAUDE_TRANSCRIPT_DIR']) savedEnv[k] = process.env[k]
  process.env.PATH = `${shimDir}:${process.env.PATH}`
  process.env.WALNUT_HOME_OVERRIDE = WALNUT_HOME
  process.env.MOCK_CLAUDE_TRANSCRIPT_DIR = path.join(CLAUDE_HOME, 'projects')

  // 5. The real daemon stands in for the remote host's (and serves local sessions too)
  daemon = await startDaemonTwin({ home: WALNUT_HOME, mockCli: MOCK_CLI })
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(daemon.url)

  // 6. Start server
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0

  // 7. Wait for server to fully initialize (event bus subscribers, plugins, etc.)
  await new Promise(r => setTimeout(r, 2000))
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════
//  1. Quick Start flow (session:start with host)
// ═══════════════════════════════════════════════════════════════════

describe('Remote session Quick Start via RPC', () => {
  it('session:start with host → session:result with correct data', async () => {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)

      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'hello from remote test',
        host: 'mock-remote',
        cwd: '/tmp',
      })

      const result = await resultPromise
      const sessionId = result.data?.sessionId as string
      expect(sessionId).toBeTruthy()
      expect(result.data?.isError).toBe(false)

      // Verify session record via REST API (poll — record creation is async, may 404 initially)
      let session: Record<string, unknown> = {}
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status !== 200) {
          await new Promise(r => setTimeout(r, 300))
          continue
        }
        const body = await res.json() as Record<string, unknown>
        session = body.session as Record<string, unknown>
        if (session.process_status === 'stopped') break
        await new Promise(r => setTimeout(r, 300))
      }
      expect(session.host).toBe('mock-remote')
    } finally {
      ws.close()
    }
  })

  // Note: error handling is tested at the transport level in daemon-transport-e2e.test.ts
  // (test: "error message → session exits with error"). The server-level error propagation
  // requires a stall timer (~3s) which makes the test slow and flaky in the E2E context.
})

// ═══════════════════════════════════════════════════════════════════
//  2. Send follow-up message to remote session
// ═══════════════════════════════════════════════════════════════════

describe('Remote session follow-up', () => {
  it('session:send to completed remote session → new result', async () => {
    const ws = await connectWs()
    try {
      // Start a session first — wait for the result (which gives us the sessionId)
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)

      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'initial message',
        host: 'mock-remote',
      })

      const result1 = await resultPromise
      const sessionId = result1.data!.sessionId as string
      expect(sessionId).toBeTruthy()

      // Now send a follow-up
      const followUpResult = waitForWsEvent(ws, 'session:result', 30000)

      await sendWsRpc(ws, 'session:send', {
        sessionId,
        message: 'follow-up message',
      })

      const result2 = await followUpResult
      expect(result2.data?.sessionId).toBe(sessionId)
      expect(result2.data?.isError).toBe(false)
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  3. Health API shows daemon status
// ═══════════════════════════════════════════════════════════════════

describe('Health API for remote sessions', () => {
  it('GET /api/system/health includes daemon connection status', async () => {
    // First, create a remote session to trigger daemon connection
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'health check trigger',
        host: 'mock-remote',
      })
      await resultPromise

      // Now check health API
      const res = await fetch(`http://localhost:${port}/api/system/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>

      // Should have daemons field
      expect(body.daemons).toBeDefined()
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  4. Session stream events via WebSocket
// ═══════════════════════════════════════════════════════════════════

describe('Remote session streaming', () => {
  it('session stream delivers JSONL events in real time', async () => {
    const ws = await connectWs()
    try {
      // Collect all events
      const allEvents: WsEvent[] = []
      const resultPromise = new Promise<WsEvent>((resolve) => {
        const handler = (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString()) as WsEvent
            if (msg.type === 'event') {
              allEvents.push(msg)
            }
            if (msg.type === 'event' && msg.name === 'session:result') {
              ws.removeListener('message', handler)
              resolve(msg)
            }
          } catch { /* skip */ }
        }
        ws.on('message', handler)
      })

      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'slow:500 streaming test',
        host: 'mock-remote',
      })

      const result = await resultPromise
      expect(result.data?.isError).toBe(false)

      // Should have received multiple events (status-changed, stream, result, etc.)
      expect(allEvents.length).toBeGreaterThanOrEqual(2)
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  5. Model override propagation
// ═══════════════════════════════════════════════════════════════════

describe('Model override', () => {
  it('session:start with model → session record stores cliModel', async () => {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)

      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'model override test',
        host: 'mock-remote',
        model: 'opus',
      })

      const result = await resultPromise
      const sessionId = result.data?.sessionId as string
      expect(sessionId).toBeTruthy()

      // Verify model was stored in session record via REST API
      let session: Record<string, unknown> = {}
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          session = body.session as Record<string, unknown>
          if (session.cliModel) break
        }
        await new Promise(r => setTimeout(r, 300))
      }

      // cliModel should reflect the MODEL_CLI_MAP mapping for 'opus'
      expect(session.cliModel).toBeTruthy()
      expect(typeof session.cliModel).toBe('string')
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  6. Permission mode propagation
// ═══════════════════════════════════════════════════════════════════

describe('Permission mode', () => {
  it('session:start with mode=plan → session record stores mode', async () => {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)

      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'plan mode test',
        host: 'mock-remote',
        mode: 'plan',
      })

      const result = await resultPromise
      const sessionId = result.data?.sessionId as string
      expect(sessionId).toBeTruthy()

      // Verify mode was stored in session record via REST API
      let session: Record<string, unknown> = {}
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          session = body.session as Record<string, unknown>
          if (session.mode) break
        }
        await new Promise(r => setTimeout(r, 300))
      }

      expect(session.mode).toBe('plan')
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  7. Concurrent session starts
// ═══════════════════════════════════════════════════════════════════

describe('Concurrent starts', () => {
  it('5 concurrent session:start RPCs all produce session:result with isError=false', async () => {
    const COUNT = 5
    const ws = await connectWs()

    try {
      // Collect COUNT distinct session:result events on a single connection
      const collected: WsEvent[] = []
      const allDone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Only got ${collected.length}/${COUNT} concurrent results`)), 60000)
        const seenIds = new Set<string>()
        const handler = (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString()) as WsEvent
            if (msg.type === 'event' && msg.name === 'session:result') {
              const sid = msg.data?.sessionId as string
              if (sid && !seenIds.has(sid)) {
                seenIds.add(sid)
                collected.push(msg)
                if (collected.length === COUNT) {
                  clearTimeout(timer)
                  ws.removeListener('message', handler)
                  resolve()
                }
              }
            }
          } catch { /* skip */ }
        }
        ws.on('message', handler)
      })

      // Fire all 5 session:start RPCs concurrently
      for (let i = 0; i < COUNT; i++) {
        sendWsRpc(ws, 'session:start', {
          taskId: '',
          message: `concurrent test ${i}`,
          host: 'mock-remote',
        })
      }

      await allDone

      // All 5 should succeed
      for (let i = 0; i < COUNT; i++) {
        expect(collected[i].data?.isError).toBe(false)
        expect(collected[i].data?.sessionId).toBeTruthy()
      }

      // All session IDs should be unique
      const ids = collected.map(r => r.data?.sessionId)
      expect(new Set(ids).size).toBe(COUNT)
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  8. Rapid follow-up messages
// ═══════════════════════════════════════════════════════════════════

describe('Sequential follow-up messages', () => {
  it('start session then send 3 sequential follow-ups → each produces a result', async () => {
    const ws = await connectWs()
    try {
      // Start session
      const firstResult = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'sequential base',
        host: 'mock-remote',
      })
      const result1 = await firstResult
      const sessionId = result1.data!.sessionId as string
      expect(sessionId).toBeTruthy()

      // Send 3 follow-ups sequentially — wait for each result before sending next.
      // This tests the full --resume round-trip without message batching interference.
      for (let i = 0; i < 3; i++) {
        // Wait for agent_complete before sending next message (processNext needs the session idle)
        for (let j = 0; j < 20; j++) {
          const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
          if (res.status === 200) {
            const body = await res.json() as Record<string, unknown>
            const session = body.session as Record<string, unknown>
            if (session.process_status === 'stopped' || session.process_status === 'error') break
          }
          await new Promise(r => setTimeout(r, 300))
        }

        const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
        await sendWsRpc(ws, 'session:send', {
          sessionId,
          message: `sequential follow-up ${i}`,
        })
        const result = await resultPromise
        expect(result.data?.isError).toBe(false)
        expect(result.data?.sessionId).toBe(sessionId)
      }
    } finally {
      ws.close()
    }
  }, 90000)
})

// ═══════════════════════════════════════════════════════════════════
//  9. Error recovery — send new message after error
// ═══════════════════════════════════════════════════════════════════

describe('Error recovery', () => {
  it('completed session → follow-up after agent_complete → new result arrives', async () => {
    const ws = await connectWs()
    try {
      // Start a session and wait for completion
      const startResult = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'error recovery base',
        host: 'mock-remote',
      })
      const result1 = await startResult
      const sessionId = result1.data!.sessionId as string
      expect(sessionId).toBeTruthy()

      // Verify session is in stopped state (poll)
      let session: Record<string, unknown> = {}
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          session = body.session as Record<string, unknown>
          if (session.process_status === 'stopped') break
        }
        await new Promise(r => setTimeout(r, 300))
      }
      expect(session.process_status).toBe('stopped')

      // Send a follow-up message — session should resume and produce a new result
      const recoveryResult = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', { sessionId, message: 'recovery after completion' })
      const result2 = await recoveryResult
      expect(result2.data?.sessionId).toBe(sessionId)
      expect(result2.data?.isError).toBe(false)
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  10. Session record fields via REST API
// ═══════════════════════════════════════════════════════════════════

describe('Session record fields', () => {
  it('session record has host, cwd, and outputFile set', async () => {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'record fields test',
        host: 'mock-remote',
        cwd: '/tmp',
      })
      const result = await resultPromise
      const sessionId = result.data!.sessionId as string

      // Poll for the session record to be fully populated (record creation is async, may 404 initially)
      let session: Record<string, unknown> = {}
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status !== 200) {
          await new Promise(r => setTimeout(r, 300))
          continue
        }
        const body = await res.json() as Record<string, unknown>
        session = body.session as Record<string, unknown>
        // Remote sessions may not have outputFile (no local mirror).
        // Break once we have a session with host set (= record is populated).
        if (session.host) break
        await new Promise(r => setTimeout(r, 300))
      }

      expect(session.host).toBe('mock-remote')
      // CWD is set from the init event (mock-claude cwd is /tmp, which may be /private/tmp on macOS)
      expect(session.cwd).toBeTruthy()
      // Remote sessions don't have a local output file — outputFile may be null
      // or a sentinel path (remote://host/sid). Either is correct.
      if (session.outputFile) {
        expect(typeof session.outputFile).toBe('string')
      }
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  11. Health monitor — detect natural process exit
// ═══════════════════════════════════════════════════════════════════

describe('Health monitor detects process exit', () => {
  it('slow session → process exits → process_status becomes stopped', async () => {
    const ws = await connectWs()
    try {
      // Start a slow session (2s delay before output — fast enough but still exercises the delay path)
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'slow:2000 health monitor test',
        host: 'mock-remote',
      })

      // Wait for the session:result event (mock-claude exits after emitting result)
      const result = await resultPromise
      const sessionId = result.data!.sessionId as string
      expect(result.data?.isError).toBe(false)

      // Poll the REST API to verify process_status eventually becomes stopped
      let session: Record<string, unknown> = {}
      for (let i = 0; i < 30; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        const body = await res.json() as Record<string, unknown>
        session = body.session as Record<string, unknown>
        if (session.process_status === 'stopped') break
        await new Promise(r => setTimeout(r, 500))
      }

      expect(session.process_status).toBe('stopped')
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
//  12. No duplicate session:result on follow-up (regression: liveness monitor false positive)
// ═══════════════════════════════════════════════════════════════════

describe('No duplicate session:result on follow-up', () => {
  it('follow-up to remote session produces exactly 1 session:result, not 2', async () => {
    const ws = await connectWs()
    try {
      // Start a session and wait for the first result
      const startResult = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'duplicate check base',
        host: 'mock-remote',
      })
      const result1 = await startResult
      const sessionId = result1.data!.sessionId as string
      expect(sessionId).toBeTruthy()

      // Wait for session to reach stopped
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          const session = body.session as Record<string, unknown>
          if (session.process_status === 'stopped') break
        }
        await new Promise(r => setTimeout(r, 300))
      }

      // Now send a follow-up — collect ALL session:result events for this sessionId
      // during a window. If there's a duplicate, we'll catch it.
      const resultEvents: WsEvent[] = []
      const collectResults = new Promise<void>((resolve) => {
        const handler = (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString()) as WsEvent
            if (msg.type === 'event' && msg.name === 'session:result' && msg.data?.sessionId === sessionId) {
              resultEvents.push(msg)
            }
          } catch { /* skip */ }
        }
        ws.on('message', handler)

        // Wait long enough for any duplicate to arrive (liveness monitor fires every 3s)
        setTimeout(() => {
          ws.removeListener('message', handler)
          resolve()
        }, 15000)
      })

      // Send the follow-up
      await sendWsRpc(ws, 'session:send', { sessionId, message: 'duplicate check follow-up' })

      await collectResults

      // Exactly 1 result event — not 0 (missing) and not 2+ (duplicate)
      expect(resultEvents.length).toBe(1)
      expect(resultEvents[0].data?.isError).toBe(false)
    } finally {
      ws.close()
    }
  }, 45000)
})

// ═══════════════════════════════════════════════════════════════════
//  13. Session status during follow-up (regression: premature idle/agent_complete)
// ═══════════════════════════════════════════════════════════════════

describe('Session status during follow-up execution', () => {
  it('follow-up sets process_status to running, then to idle (remote session)', async () => {
    const ws = await connectWs()
    try {
      // Start a session. snapshot-clean-turn keeps the mock CLI alive after its
      // result, like the real stream-json CLI: a one-shot mock exits at its result,
      // and the daemon then (correctly) reports the dead CLI as 'stopped', not idle.
      const startResult = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'slow:2000 snapshot-clean-turn:status lifecycle test',
        host: 'mock-remote',
      })
      const result1 = await startResult
      const sessionId = result1.data!.sessionId as string

      // Wait for session to settle (idle or stopped)
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          const session = body.session as Record<string, unknown>
          if (session.process_status === 'stopped' || session.process_status === 'idle') break
        }
        await new Promise(r => setTimeout(r, 300))
      }

      // Send a follow-up to the live CLI and capture status transitions
      const statusChanges: Array<{ process_status: string }> = []
      const statusHandler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsEvent
          if (msg.type === 'event' && msg.name === 'session:status-changed'
              && msg.data?.sessionId === sessionId) {
            statusChanges.push({
              process_status: msg.data.process_status as string,
            })
          }
        } catch { /* skip */ }
      }
      ws.on('message', statusHandler)

      const followUpResult = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:send', { sessionId, message: 'snapshot-clean-turn:status follow-up' })
      await followUpResult

      // Wait a bit for final status events to settle
      await new Promise(r => setTimeout(r, 2000))
      ws.removeListener('message', statusHandler)

      // Status should have gone through: running → idle (the CLI is still alive
      // after its result, so the session waits for the next message).
      const runningEvents = statusChanges.filter(s => s.process_status === 'running')
      const idleEvents = statusChanges.filter(s => s.process_status === 'idle')

      // Must have at least one running transition
      expect(runningEvents.length).toBeGreaterThanOrEqual(1)

      expect(idleEvents.length, JSON.stringify(statusChanges)).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  }, 45000)
})

// ═══════════════════════════════════════════════════════════════════
//  14. Session history API
// ═══════════════════════════════════════════════════════════════════

describe('Session history API', () => {
  it('GET /api/sessions/:id/history returns messages for a local session', async () => {
    const ws = await connectWs()
    try {
      // A LOCAL session (no host). History is read from the CLI's canonical
      // transcript (~/.claude/projects), which the mock CLI writes only in its
      // snapshot-clean-turn mode (the real long-running FIFO CLI's turn shape).
      const resultPromise = waitForWsEvent(ws, 'session:result', 30000)
      await sendWsRpc(ws, 'session:start', {
        taskId: '',
        message: 'snapshot-clean-turn:history api test',
        cwd: '/tmp',
      })
      const result = await resultPromise
      const sessionId = result.data!.sessionId as string

      // Poll the history API — JSONL file may take a moment to be fully written
      let messages: unknown[] = []
      for (let i = 0; i < 20; i++) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}/history?source=streams`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          messages = body.messages as unknown[]
          if (messages && messages.length > 0) break
        }
        await new Promise(r => setTimeout(r, 500))
      }

      // Should have at least one message (the assistant response from mock-claude)
      expect(messages.length).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  })
})
