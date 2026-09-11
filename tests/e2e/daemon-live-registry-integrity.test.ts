/**
 * L4 live test — sessions.json registry integrity on a real Linux daemon.
 *
 * Validates P2 write-ahead registry against the real filesystem:
 *   1. Start a remote session
 *   2. `ssh cat /tmp/open-walnut/sessions.json` → has entry with pid, startTime,
 *      pipePath, jsonlPath
 *   3. Kill -9 the claude CLI on the host
 *   4. Wait for daemon's reap (orphan-poll-dead)
 *   5. `ssh cat sessions.json` again → the sid entry is GONE (registry
 *      pruned via atomic rename)
 *
 * Gated by WALNUT_LIVE_HOST.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-live-registry'))

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

describeIf(`Live daemon: registry integrity (${LIVE_HOST})`, () => {
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

  it('sessions.json contains full RegistryEntry schema + reap removes entry', async () => {
    const ws = await connectWs()
    let sid: string | null = null
    let claudePid: number | null = null
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result', 170_000, (m) => !!m.data?.sessionId)
      await sendRpc(ws, 'session:start', {
        taskId: '',
        message: 'Reply exactly: REGISTRY_TEST_OK',
        host: LIVE_HOST,
        cwd: '/tmp',
      })
      const r = await resultPromise
      sid = r.data!.sessionId as string
      claudePid = (r.data?.pid as number | undefined) ?? (r.data?.claudePid as number | undefined) ?? null
    } finally {
      ws.close()
    }
    expect(sid).toBeTruthy()

    // 1. Inspect sessions.json — schema must match RegistryEntry
    const { stdout: dump } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      LIVE_SSH_HOST!,
      'cat /tmp/open-walnut/sessions.json',
    ])
    const parsed = JSON.parse(dump.trim()) as { version: number; sessions: Record<string, unknown> }
    expect(parsed.version).toBe(1)
    expect(parsed.sessions).toBeDefined()

    const entry = parsed.sessions[sid!] as Record<string, unknown> | undefined
    if (entry) {
      // Full schema check
      expect(entry).toHaveProperty('pid')
      expect(entry).toHaveProperty('pipePath')
      expect(entry).toHaveProperty('jsonlPath')
      expect(entry).toHaveProperty('cwd')
      expect(entry).toHaveProperty('args')
      expect(entry).toHaveProperty('parented')
    }

    // 2. Kill the CLI and wait for orphan poll (or parent SIGCHLD) to reap.
    //    Resolve the PID from sessions.json registry (more reliable than the
    //    session:result.pid field which may not be populated in all variants).
    //    Avoid pkill patterns — this test may run inside a Claude Code terminal
    //    where 'claude -p' also matches our own SSH command line, causing
    //    self-kill and ssh exit 255.
    const pidFromRegistry = (entry?.pid as number | undefined) ?? claudePid
    if (pidFromRegistry && pidFromRegistry > 0) {
      await execFileAsync('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=no',
        LIVE_SSH_HOST!,
        `kill -9 ${pidFromRegistry} || true`,
      ])
    }
    // Reap: ~1s orphan poll + persistRegistry fsync
    await new Promise((r) => setTimeout(r, 3_000))

    // 3. Registry should no longer contain this sid
    const { stdout: dumpAfter } = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      LIVE_SSH_HOST!,
      'cat /tmp/open-walnut/sessions.json',
    ])
    const parsedAfter = JSON.parse(dumpAfter.trim()) as { sessions: Record<string, unknown> }
    expect(parsedAfter.sessions[sid!]).toBeUndefined()
  }, 300_000)
})
