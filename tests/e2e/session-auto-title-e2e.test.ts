/**
 * E2E: session auto-title over the real stream-json control protocol.
 *
 * Two scenarios:
 *  - PATH-FIRST quick start: POST /api/sessions/quick-start with an EMPTY
 *    message spawns the CLI init-only and leaves the task titled
 *    `Session: <basename(cwd)>`. The user then sends their first real message
 *    via the session:send RPC — the session-auto-title hook must ask the LIVE
 *    CLI for a title (generate_session_title control_request over the FIFO)
 *    and replace the placeholder on the task.
 *  - TEXT-FIRST quick start: the launch itself carries the message (which
 *    rides SESSION_START, an event the hook dispatcher never maps) — titling
 *    must fire from the quick-start launch path (autoTitleFromLaunch), with
 *    no further send needed.
 *
 * Everything is real except the CLI binary: Express server, WS RPC, event bus,
 * hook dispatcher, session-runner, mock daemon (real FIFO + sendRaw), and
 * mock-claude.mjs — whose persistent stdin listener answers
 * generate_session_title with `Mock title: <first 5 words>` (the same
 * fire-and-forget contract as the real fork CLI).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-auto-title-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { __resetAutoTitleState } from '../../src/core/session-hooks/builtins.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>
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

async function getTaskTitle(taskId: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/tasks/${taskId}`))
  const { task } = await res.json() as { task: { title: string } }
  return task.title
}

async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T
  do {
    last = await fn()
    if (ok(last)) return last
    await new Promise((r) => setTimeout(r, 250))
  } while (Date.now() < deadline)
  return last
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  __resetAutoTitleState(100)

  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

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

describe('session auto-title E2E (path-first quick start)', () => {
  it('replaces the placeholder title from the first real message via the CLI control protocol', async () => {
    // 1. Path-first launch: empty message → init-only spawn, placeholder title.
    const cwd = path.join(WALNUT_HOME, 'demo-app')
    await fs.mkdir(cwd, { recursive: true })
    const res = await fetch(apiUrl('/api/sessions/quick-start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, message: '' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { taskId: string; sessionId?: string }
    expect(body.sessionId).toBeTruthy()
    expect(await getTaskTitle(body.taskId)).toBe('Session: demo-app')

    // Give the init-only spawn a beat to register its FIFO with the daemon.
    await new Promise((r) => setTimeout(r, 500))

    // 2. First real user message via the session:send RPC (source 'ui').
    //    A send can race the cold-resume respawn (the init-only mock exits after
    //    its turn), making the hook's control write fail — by design the hook
    //    retries on LATER sends while the placeholder survives. Model exactly
    //    that: resend the SAME message if the title hasn't changed yet, so the
    //    expected title is identical whichever attempt wins.
    const ws = await connectWs()
    const message = 'title-test:please fix the login redirect loop'
    let title = 'Session: demo-app'
    for (let attempt = 0; attempt < 3 && title === 'Session: demo-app'; attempt++) {
      const rpc = await sendWsRpc(ws, 'session:send', { sessionId: body.sessionId, message })
      expect(rpc.ok).not.toBe(false)
      // 3. The hook asks the live CLI over the FIFO; mock answers with
      //    "Mock title: <first 5 words of the description>".
      title = await pollUntil(
        () => getTaskTitle(body.taskId),
        (t) => t !== 'Session: demo-app',
        10_000,
      )
    }
    expect(title).toBe('Side title: title-test:please fix the login redirect')

    // 4. The session record mirrors the new title.
    const recRes = await fetch(apiUrl(`/api/sessions/${body.sessionId}`))
    const rec = await recRes.json() as { session?: { title?: string }; title?: string }
    const recTitle = rec.session?.title ?? rec.title
    expect(recTitle).toBe('Side title: title-test:please fix the login redirect')

    ws.close()
  }, 60_000)
})

describe('session auto-title E2E (text-first quick start)', () => {
  it('titles the task from the LAUNCH message with no further send', async () => {
    // Launch WITH a message: the CLI spawns and runs the turn immediately
    // ('title-test:' mode keeps the mock alive after the turn, like the real
    // long-running CLI). autoTitleFromLaunch must pick the title up from the
    // launch alone — no session:send afterwards.
    const cwd = path.join(WALNUT_HOME, 'demo-text-first')
    await fs.mkdir(cwd, { recursive: true })
    const res = await fetch(apiUrl('/api/sessions/quick-start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, message: 'title-test:add dark mode to settings page' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { taskId: string; sessionId?: string }
    expect(body.sessionId).toBeTruthy()

    const title = await pollUntil(
      () => getTaskTitle(body.taskId),
      (t) => t !== 'Session: demo-text-first',
      30_000,
    )
    expect(title).toBe('Side title: title-test:add dark mode to settings')

    // Session record mirrors it.
    const recRes = await fetch(apiUrl(`/api/sessions/${body.sessionId}`))
    const rec = await recRes.json() as { session?: { title?: string }; title?: string }
    expect(rec.session?.title ?? rec.title).toBe('Side title: title-test:add dark mode to settings')
  }, 60_000)
})
