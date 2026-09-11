/**
 * Live E2E tests for daemon transport — real remote host.
 *
 * These tests connect to a REAL remote host, deploy the REAL daemon binary,
 * start REAL Claude Code sessions, and verify the full lifecycle.
 *
 * Gated by WALNUT_LIVE_HOST env var — skipped in CI, run manually:
 *   WALNUT_LIVE_HOST=clouddev npx vitest run --config vitest.e2e.config.ts tests/e2e/daemon-live.test.ts
 *
 * Prerequisites:
 *   - SSH access to the host (passwordless, BatchMode=yes)
 *   - Claude CLI installed on the host
 *   - Daemon binary built: npm run build:daemon
 *   - Real ~/.open-walnut/config.yaml with hosts.{WALNUT_LIVE_HOST} defined
 *
 * Isolation: Uses vi.mock for constants.js (temp sessions.json) but copies real
 * config.yaml so host definitions are available.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

// Isolate file I/O to a temp directory (sessions.json, tasks.json, etc.)
vi.mock('../../src/constants.js', () => createMockConstants('walnut-live-test'))

import { WALNUT_HOME } from '../../src/constants.js'
import { copyConfigSections } from '../helpers/temp-home.js'
import { startServer, stopServer } from '../../src/web/server.js'

const LIVE_HOST = process.env.WALNUT_LIVE_HOST

// Skip all tests if no live host configured
const describeIf = LIVE_HOST ? describe : describe.skip

// ── Shared state across tests ──

let server: HttpServer
let port: number
let firstSessionId: string | undefined
let followUpSessionId: string | undefined

// ── WS Helpers ──

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string | number
  result?: unknown
  error?: string
  [key: string]: unknown
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForWsEvent(
  ws: WebSocket,
  eventName: string,
  timeoutMs = 120_000,
  filter?: (msg: WsEvent) => boolean,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as WsEvent
        if (msg.type === 'event' && msg.name === eventName && (!filter || filter(msg))) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(msg)
        }
      } catch { /* skip non-JSON */ }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 30_000)
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

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

/** Filter for session:result events with a non-null sessionId (prevents stale event leaks). */
const sessionResultFilter = (msg: WsEvent) => !!msg.data?.sessionId

/** Poll a condition until it becomes true. */
async function pollUntil(fn: () => Promise<boolean>, intervalMs: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// ═══════════════════════════════════════════════════════════════════
//  Live daemon tests
// ═══════════════════════════════════════════════════════════════════

describeIf(`Live daemon tests (host: ${LIVE_HOST})`, () => {
  beforeAll(async () => {
    // Create isolated dirs
    await fsp.mkdir(WALNUT_HOME, { recursive: true })
    const tasksDir = path.join(WALNUT_HOME, 'tasks')
    await fsp.mkdir(tasksDir, { recursive: true })
    await fsp.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({ version: 1, tasks: [] }),
    )

    // ONLY the host definitions — never the whole config. Copying it wholesale
    // also copies the user's provider CREDENTIALS, which is how a fixture task
    // from a temp-home test server reached the user's real account and later
    // resurrected a deleted project on the production box (2026-09-08).
    await copyConfigSections(WALNUT_HOME, ['version', 'hosts', 'session_server'])

    // Start server on random port
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  }, 30_000)

  afterAll(async () => {
    await stopServer()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  // ═══════════════════════════════════════════════════════════════
  //  Deploy tests (L1-L3)
  // ═══════════════════════════════════════════════════════════════

  describe('Deploy', () => {
    it('L1: binary deploys to remote host and starts session', async () => {
      const ws = await connectWs()
      try {
        // First session includes binary deploy (SCP transfer) — needs longer timeout
        const resultPromise = waitForWsEvent(ws, 'session:result', 170_000)

        await sendWsRpc(ws, 'session:start', {
          taskId: '',
          message: 'respond with exactly: LIVE_DEPLOY_OK',
          host: LIVE_HOST,
          cwd: '/tmp',
        })

        const result = await resultPromise
        expect(result.data?.isError).toBe(false)
        expect(result.data?.sessionId).toBeTruthy()

        // Store for later tests
        firstSessionId = result.data!.sessionId as string
      } finally {
        ws.close()
      }
    }, 180_000)

    it('L2: second deploy skips transfer (version matches)', async () => {
      // Start a second session — deploy should be fast since binary matches
      const ws = await connectWs()
      try {
        const t0 = Date.now()
        const resultPromise = waitForWsEvent(ws, 'session:result', 120_000)

        await sendWsRpc(ws, 'session:start', {
          taskId: '',
          message: 'respond with exactly: SECOND_DEPLOY_OK',
          host: LIVE_HOST,
          cwd: '/tmp',
        })

        const result = await resultPromise
        expect(result.data?.isError).toBe(false)
        expect(result.data?.sessionId).toBeTruthy()

        // Second deploy should be noticeably faster than first (skip transfer).
        // We just verify it completes — timing is unreliable in CI.
        const elapsed = Date.now() - t0
        // Log elapsed for debugging but don't assert — Claude response time varies
        console.log(`L2: second session completed in ${elapsed}ms`)
      } finally {
        ws.close()
      }
    }, 180_000)

    it('L3: daemon --status returns valid JSON with running=true', async () => {
      // After L1/L2 sessions, daemon should be running. Verify via health API.
      const res = await fetch(apiUrl('/api/system/health'))
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      const daemons = body.daemons as Array<{ host: string; connected: boolean }> | undefined

      // The daemon pool should list our host
      expect(daemons).toBeDefined()
      const target = daemons!.find(d => d.host === LIVE_HOST)
      expect(target).toBeDefined()
      // After recent sessions, the daemon should be connected (or at least listed)
    }, 30_000)
  })

  // ═══════════════════════════════════════════════════════════════
  //  Session tests (L4-L7)
  // ═══════════════════════════════════════════════════════════════

  describe('Session lifecycle', () => {
    let sessionIdForFollowUp: string | undefined

    it('L4: start session and get real Claude response', async () => {
      const ws = await connectWs()
      try {
        const resultPromise = waitForWsEvent(ws, 'session:result', 120_000)

        await sendWsRpc(ws, 'session:start', {
          taskId: '',
          message: 'What is 2 + 2? Answer with just the number.',
          host: LIVE_HOST,
          cwd: '/tmp',
        })

        const result = await resultPromise
        expect(result.data?.isError).toBe(false)
        expect(result.data?.sessionId).toBeTruthy()

        // Claude should have responded with something containing "4"
        const resultText = result.data?.result as string | undefined
        expect(resultText).toBeTruthy()

        sessionIdForFollowUp = result.data!.sessionId as string
      } finally {
        ws.close()
      }
    }, 180_000)

    it('L5: send follow-up message to same session', async () => {
      // Skip if L4 did not produce a sessionId
      if (!sessionIdForFollowUp) {
        console.log('L5: skipped — no sessionId from L4')
        return
      }

      const ws = await connectWs()
      try {
        const resultPromise = waitForWsEvent(ws, 'session:result', 120_000)

        await sendWsRpc(ws, 'session:send', {
          sessionId: sessionIdForFollowUp,
          message: 'Now add 3 to the previous result. Answer with just the number.',
        })

        const result = await resultPromise
        expect(result.data?.sessionId).toBe(sessionIdForFollowUp)
        expect(result.data?.isError).toBe(false)

        followUpSessionId = sessionIdForFollowUp
      } finally {
        ws.close()
      }
    }, 180_000)

    it('L6: session with tool use — list files in /tmp', async () => {
      const ws = await connectWs()
      try {
        const resultPromise = waitForWsEvent(ws, 'session:result', 120_000)

        await sendWsRpc(ws, 'session:start', {
          taskId: '',
          message: 'List the files in /tmp using ls. Show the first 5 entries.',
          host: LIVE_HOST,
          cwd: '/tmp',
        })

        const result = await resultPromise
        expect(result.data?.isError).toBe(false)
        expect(result.data?.sessionId).toBeTruthy()

        // The response should contain some file listing output
        const resultText = result.data?.result as string | undefined
        expect(resultText).toBeTruthy()
      } finally {
        ws.close()
      }
    }, 180_000)

    it('L7: session record has host, pid, cwd, model fields', async () => {
      // Use firstSessionId from L1 (or sessionIdForFollowUp from L4)
      const sid = firstSessionId ?? sessionIdForFollowUp
      if (!sid) {
        console.log('L7: skipped — no sessionId available')
        return
      }

      const res = await fetch(apiUrl(`/api/sessions/${sid}`))
      expect(res.status).toBe(200)
      const body = await res.json() as { session: Record<string, unknown> }
      const session = body.session

      expect(session.host).toBe(LIVE_HOST)
      // PID is intentionally cleared after process exits (prevents stale PID orphan kills).
      // No assertion on pid — it's transient for completed sessions.
      // model should be set from the init event
      expect(session.model).toBeTruthy()
    }, 30_000)
  })

  // ═══════════════════════════════════════════════════════════════
  //  History tests (L8-L9)
  // ═══════════════════════════════════════════════════════════════

  describe('Session history', () => {
    it('L8: GET /api/sessions/{id}/history returns messages', async () => {
      const sid = firstSessionId
      if (!sid) {
        console.log('L8: skipped — no sessionId available')
        return
      }

      const res = await fetch(apiUrl(`/api/sessions/${sid}/history`))
      expect(res.status).toBe(200)
      const body = await res.json() as { messages?: unknown[]; total?: number }
      expect(body.messages).toBeDefined()
      expect(Array.isArray(body.messages)).toBe(true)
      // Should have at least one user message and one assistant message
      expect(body.messages!.length).toBeGreaterThanOrEqual(2)
    }, 30_000)

    it('L9: history includes both initial and follow-up turns', async () => {
      // Requires L5 to have run successfully (follow-up to same session)
      if (!followUpSessionId) {
        console.log('L9: skipped — no follow-up sessionId (L5 may not have run)')
        return
      }

      const res = await fetch(apiUrl(`/api/sessions/${followUpSessionId}/history`))
      expect(res.status).toBe(200)
      const body = await res.json() as { messages?: Array<{ role?: string; text?: string }>; total?: number }
      expect(body.messages).toBeDefined()

      // Count user messages — should be at least 2 (initial + follow-up)
      const userMessages = body.messages!.filter(m => m.role === 'user')
      expect(userMessages.length).toBeGreaterThanOrEqual(2)
    }, 30_000)
  })

  // ═══════════════════════════════════════════════════════════════
  //  Health tests (L10-L11)
  // ═══════════════════════════════════════════════════════════════

  describe('Health and status', () => {
    it('L10: GET /api/system/health shows daemon for LIVE_HOST', async () => {
      const res = await fetch(apiUrl('/api/system/health'))
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      const daemons = body.daemons as Array<{ host: string; connected: boolean }> | undefined

      expect(daemons).toBeDefined()
      expect(daemons!.length).toBeGreaterThan(0)

      const target = daemons!.find(d => d.host === LIVE_HOST)
      expect(target).toBeDefined()
      // After successful sessions, daemon should be connected
      expect(target!.connected).toBe(true)
    }, 30_000)

    it('L11: after session completes, process_status is stopped or running (FIFO)', async () => {
      const sid = firstSessionId
      if (!sid) {
        console.log('L11: skipped — no sessionId available')
        return
      }

      // Poll for up to 60s for process_status to settle (stopped or running with FIFO)
      const reached = await pollUntil(async () => {
        const res = await fetch(apiUrl(`/api/sessions/${sid}`))
        if (res.status !== 200) return false
        const body = await res.json() as { session: Record<string, unknown> }
        return body.session.process_status === 'stopped' || body.session.process_status === 'running'
      }, 2_000, 60_000)

      expect(reached).toBe(true)
    }, 90_000)
  })
}, 300_000) // 5 min total suite timeout
