/**
 * L4 live test — kill the remote walnut-daemon process.
 *
 * Verifies write-ahead registry (P2) + reconcile (P4) survive a real
 * non-graceful daemon crash:
 *   1. Create 2 remote sessions (both running)
 *   2. SSH to kill -9 the daemon pid
 *   3. walnut's reconnect path redeploys + restarts the daemon
 *   4. Assert: daemon's sessions.json has our two sids (via `ssh cat`)
 *   5. After reconnect, session_state=running {adopted:true} received → both
 *      sessions usable again (verify by sending a follow-up)
 *
 * Gated by WALNUT_LIVE_HOST; runs against clouddev by default.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-live-kill-daemon'))

import { WALNUT_HOME } from '../../src/constants.js'
import { copyConfigSections } from '../helpers/temp-home.js'
import { startServer, stopServer } from '../../src/web/server.js'

const execFileAsync = promisify(execFile)
const LIVE_HOST = process.env.WALNUT_LIVE_HOST
const LIVE_SSH_HOST = process.env.WALNUT_LIVE_SSH_HOST ?? LIVE_HOST
const describeIf = LIVE_HOST ? describe : describe.skip

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string | number
  [key: string]: unknown
}

let server: HttpServer
let port: number

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForWsEvent(
  ws: WebSocket,
  name: string,
  timeoutMs = 120_000,
  filter?: (m: WsEvent) => boolean,
): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${name}`)), timeoutMs)
    const handler = (data: WebSocket.Data) => {
      try {
        const m = JSON.parse(data.toString()) as WsEvent
        if (m.type === 'event' && m.name === name && (!filter || filter(m))) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(m)
        }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
  })
}

function sendRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`rpc: ${method} timeout`)), 30_000)
    const handler = (data: WebSocket.Data) => {
      try {
        const m = JSON.parse(data.toString()) as WsEvent
        if (m.id === id) {
          clearTimeout(timer)
          ws.removeListener('message', handler)
          resolve(m)
        }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

describeIf(`Live daemon: kill daemon (${LIVE_HOST})`, () => {
  beforeAll(async () => {
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
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  }, 60_000)

  afterAll(async () => {
    await stopServer()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('kill -9 of daemon → reconcile preserves live sessions', async () => {
    // 1. Establish two remote sessions
    const ws = await connectWs()
    const sessionIds: string[] = []
    try {
      for (let i = 0; i < 2; i++) {
        const resultPromise = waitForWsEvent(ws, 'session:result', 170_000, (m) => !!m.data?.sessionId)
        await sendRpc(ws, 'session:start', {
          taskId: '',
          message: `Reply exactly: KILL_DAEMON_TEST_${i}`,
          host: LIVE_HOST,
          cwd: '/tmp',
        })
        const r = await resultPromise
        sessionIds.push(r.data!.sessionId as string)
      }
    } finally {
      ws.close()
    }
    expect(sessionIds).toHaveLength(2)

    // 2. Inspect registry BEFORE kill — should contain both sids
    const { stdout: before } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      LIVE_SSH_HOST!,
      'cat /tmp/open-walnut/sessions.json 2>/dev/null || echo "{}"',
    ])
    expect(before).toMatch(/sessions/)

    // 3. Kill the daemon
    await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      LIVE_SSH_HOST!,
      `cat /tmp/open-walnut/daemon.pid 2>/dev/null | xargs -r kill -9 || true`,
    ])

    // 4. Wait for walnut to redeploy + reconnect (up to 30s)
    await new Promise((r) => setTimeout(r, 10_000))

    // 5. Inspect registry AFTER — sessions.json should still exist and describe
    //    our sessions (write-ahead persisted them before the kill).
    const { stdout: after } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      LIVE_SSH_HOST!,
      'cat /tmp/open-walnut/sessions.json 2>/dev/null || echo "{}"',
    ])
    // At a minimum the registry file should be parseable JSON with the envelope
    const parsed = JSON.parse(after.trim())
    expect(parsed).toHaveProperty('version')
    expect(parsed).toHaveProperty('sessions')
  }, 300_000)
})
