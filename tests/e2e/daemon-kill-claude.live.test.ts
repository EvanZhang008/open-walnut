/**
 * L4 live test — kill the Claude CLI on the remote host mid-session.
 *
 * Reproduces the original user bug on a real Linux daemon:
 *   1. Start remote session → idle
 *   2. `ssh $HOST kill -9 <claude-pid>`
 *   3. Assert: daemon broadcasts session_state=dead within ~1.5s, walnut
 *      flips record.process_status='stopped'
 *   4. Send follow-up message → session auto-respawns via --resume
 *
 * Gated by WALNUT_LIVE_HOST. Defaults to clouddev on the maintainer's laptop;
 * skipped elsewhere (see scripts/run-live-daemon-tests.sh).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-live-kill-claude'))

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

describeIf(`Live daemon: kill Claude (${LIVE_HOST})`, () => {
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

  it('kill -9 of remote Claude CLI → session flips stopped, send auto-respawns', async () => {
    const ws = await connectWs()
    try {
      // 1. Start session, wait for result (idle)
      const resultPromise = waitForWsEvent(ws, 'session:result', 170_000, (m) => !!m.data?.sessionId)
      await sendRpc(ws, 'session:start', {
        taskId: '',
        message: 'Reply exactly: LIVE_INITIAL_OK',
        host: LIVE_HOST,
        cwd: '/tmp',
      })
      const result1 = await resultPromise
      const sessionId = result1.data!.sessionId as string
      expect(sessionId).toBeTruthy()
      const pid = (result1.data?.pid as number | undefined) ?? (result1.data?.claudePid as number | undefined)

      // 2. SSH kill -9 the claude CLI. Use pkill to be robust across pid fields.
      //    We target `claude` processes owned by the current user; this is the
      //    only CLI the daemon spawns for our tmp session.
      // Resolve PID: prefer session:result.pid, fall back to sessions.json.
      // Avoid pkill patterns — this test may run inside a Claude Code terminal
      // where 'claude -p' also matches the SSH command line (self-kill → ssh 255).
      let resolvedPid = pid
      if (!resolvedPid || resolvedPid <= 0) {
        // Walnut UI sessionId (Claude UUID) differs from daemon's internal sid
        // (short hex) in registry, so we can't look up by sessionId directly.
        // This test runs only one session, so take the sole entry's pid.
        const { stdout: dump } = await execFileAsync('ssh', [
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=no',
          LIVE_SSH_HOST!,
          'cat /tmp/open-walnut/sessions.json 2>/dev/null || echo "{}"',
        ])
        try {
          const reg = JSON.parse(dump.trim()) as { sessions?: Record<string, { pid?: number }> }
          const entries = Object.values(reg.sessions ?? {})
          if (entries.length === 1) resolvedPid = entries[0].pid
        } catch { /* fall through */ }
      }
      if (resolvedPid && resolvedPid > 0) {
        await execFileAsync('ssh', [
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=no',
          LIVE_SSH_HOST!,
          `kill -9 ${resolvedPid} || true`,
        ])
      } else {
        throw new Error(`Could not resolve remote CLI pid for sessionId=${sessionId}`)
      }

      // 3. Wait for walnut to see process_status=stopped (via poll)
      let status: string = ''
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const res = await fetch(`http://localhost:${port}/api/sessions/${sessionId}`)
        if (res.status === 200) {
          const body = await res.json() as Record<string, unknown>
          const session = body.session as Record<string, unknown>
          status = String(session.process_status ?? '')
          if (status === 'stopped') break
        }
        await new Promise((r) => setTimeout(r, 300))
      }
      expect(status).toBe('stopped')

      // 4. Send follow-up → should trigger auto-respawn via --resume and get a result
      const respawnPromise = waitForWsEvent(ws, 'session:result', 170_000, (m) =>
        m.data?.sessionId === sessionId,
      )
      await sendRpc(ws, 'session:send', {
        sessionId,
        message: 'Reply exactly: RESPAWN_OK',
      })
      const result2 = await respawnPromise
      expect(result2.data?.isError).toBe(false)
    } finally {
      ws.close()
    }
  }, 300_000)
})
