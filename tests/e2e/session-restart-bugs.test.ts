/**
 * Black-box E2E: remote session survives server restart.
 *
 * Simulates the user experience end-to-end:
 *   1. Connect via WebSocket, start a remote session, send messages, get responses.
 *   2. Server restarts (daemon survives — same as real clouddev).
 *   3. User reconnects and continues the conversation.
 *
 * No internal state assertions (no process_status, no fromOffset, no bus events).
 * The ONLY thing we check: "I sent a message, did I get a valid response?"
 *
 * The daemon is the in-process MockDaemon: it lives outside the server, so it
 * survives every stopServer()/startServer() here, and nothing needs it as a
 * separate process.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let daemonPort: number
let originalPath: string | undefined

// ── Minimal WS helpers (user-facing API only) ──

interface WsMsg { type: string; name?: string; data?: Record<string, unknown>; id?: string | number }

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** Send an RPC and return the response. */
function rpc(ws: WebSocket, method: string, payload: unknown): Promise<WsMsg> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15000)
    const handler = (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMsg
        if (msg.id === id) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg) }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

/** Wait for a named event (e.g. 'session:result'). */
function waitEvent(ws: WebSocket, name: string, timeoutMs = 30000): Promise<WsMsg> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${name}`)), timeoutMs)
    const handler = (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMsg
        if (msg.type === 'event' && msg.name === name) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg) }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
  })
}

/** Start a remote session and wait for the first response. Returns { ws, sessionId }. */
async function startSessionAndGetResponse(message: string): Promise<{ ws: WebSocket; sessionId: string }> {
  const ws = await connect()
  const resultP = waitEvent(ws, 'session:result')
  await rpc(ws, 'session:start', { taskId: '', message, host: 'mock-remote', cwd: '/tmp' })
  const result = await resultP
  const sessionId = result.data?.sessionId as string
  expect(sessionId).toBeTruthy()
  expect(result.data?.isError).toBe(false)
  return { ws, sessionId }
}

/** Send a follow-up message to an existing session and wait for response. */
async function sendAndExpectResponse(ws: WebSocket, sessionId: string, message: string): Promise<void> {
  const resultP = waitEvent(ws, 'session:result')
  await rpc(ws, 'session:send', { sessionId, message })
  const result = await resultP
  expect(result.data?.sessionId).toBe(sessionId)
  expect(result.data?.isError).toBe(false)
}

/** Restart the server. Daemon stays alive. Returns new port. */
async function restartServer(): Promise<void> {
  await stopServer()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemonPort}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  // Wait for reconciler to reconnect sessions
  await new Promise(r => setTimeout(r, 3000))
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const tasksDir = path.dirname(TASKS_FILE)
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'version: 1', 'user:', '  name: TestUser', 'defaults:', '  priority: none',
    '  category: Inbox', 'hosts:', '  mock-remote:', '    hostname: localhost', '    user: testuser',
  ].join('\n') + '\n')

  // Sessions reach the host through the MockDaemon's URL, but side paths (the
  // remote cwd pre-flight, history reads) still dial the host over ssh. Answer
  // those with an instant refusal instead of a real ssh to localhost.
  const sshBin = path.join(WALNUT_HOME, 'bin')
  await fs.mkdir(sshBin, { recursive: true })
  await fs.writeFile(path.join(sshBin, 'ssh'),
    '#!/bin/sh\necho "ssh: connect to host localhost port 22: Connection refused" >&2\nexit 255\n', { mode: 0o755 })
  originalPath = process.env.PATH
  process.env.PATH = `${sshBin}${path.delimiter}${process.env.PATH}`

  // Start MockDaemon (survives server restarts, like a real remote host's daemon)
  daemon = await createMockDaemon()
  daemonPort = daemon.port

  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemonPort}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise(r => setTimeout(r, 2000))
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  if (originalPath !== undefined) process.env.PATH = originalPath
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 1: Multi-turn conversation on a remote session
//
//  User starts a session, sends a message, gets a reply,
//  then sends a follow-up and gets another reply.
// ═══════════════════════════════════════════════════════════════════════════

describe('Multi-turn remote conversation', () => {
  it('start → response → follow-up → response', async () => {
    const { ws, sessionId } = await startSessionAndGetResponse('hello from user')
    try {
      // Wait briefly for session to be ready for follow-up
      await new Promise(r => setTimeout(r, 500))
      await sendAndExpectResponse(ws, sessionId, 'follow-up message')
    } finally {
      ws.close()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 2: Conversation continues after server restart
//
//  User starts a session, completes a turn, server restarts,
//  user reconnects and sends another message — should get a response.
// ═══════════════════════════════════════════════════════════════════════════

describe('Conversation survives server restart', () => {
  it('start → response → restart server → follow-up → response', async () => {
    // Turn 1: start session, get response
    const { ws: ws1, sessionId } = await startSessionAndGetResponse('turn 1 before restart')
    ws1.close()

    // Server restart (daemon stays alive)
    await restartServer()

    // Turn 2: reconnect and send follow-up
    const ws2 = await connect()
    try {
      await sendAndExpectResponse(ws2, sessionId, 'turn 2 after restart')
    } finally {
      ws2.close()
    }
  }, 60000)
})

// ═══════════════════════════════════════════════════════════════════════════
//  Scenario 3: Slow session completes after server restart
//
//  User starts a slow session (5s), server restarts mid-execution,
//  then user sends a follow-up — should get a response.
// ═══════════════════════════════════════════════════════════════════════════

describe('Slow session completes across restart', () => {
  it('start slow → restart mid-run → wait for completion → follow-up → response', async () => {
    // Start a slow session (5s)
    const ws1 = await connect()
    let sessionId: string
    try {
      await rpc(ws1, 'session:start', {
        taskId: '', message: 'slow:5000 long running task', host: 'mock-remote', cwd: '/tmp',
      })
      // Wait for session to be registered (but don't wait for result)
      await new Promise(r => setTimeout(r, 1500))
      const listRes = await fetch(`http://localhost:${port}/api/sessions`)
      const body = await listRes.json() as { sessions: Array<Record<string, unknown>> }
      const latest = body.sessions
        .filter((s: Record<string, unknown>) => s.host === 'mock-remote')
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          new Date(b.started as string).getTime() - new Date(a.started as string).getTime(),
        )[0]
      sessionId = latest?.claudeSessionId as string
      expect(sessionId).toBeTruthy()
    } finally {
      ws1.close()
    }

    // Restart server while session is still running
    await restartServer()

    // Wait for the slow session to finish (mock-claude exits after 5s)
    await new Promise(r => setTimeout(r, 5000))

    // Send follow-up — should work regardless of restart
    const ws2 = await connect()
    try {
      await sendAndExpectResponse(ws2, sessionId, 'follow-up after slow completion')
    } finally {
      ws2.close()
    }
  }, 60000)
})
