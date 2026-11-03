/**
 * E2E: a turn that could not reach the model endpoint waits for it and continues by itself
 * (src/core/sessions/endpoint-wait.ts; 2026-11-03, a model proxy that went down with the Mac's login
 * session ended eight sessions on "Connection refused" and every task read Needs you).
 *
 * Full server pipeline: WebSocket → session runner → mock-claude ("unreachable-error": the CLI's
 * ECONNREFUSED result) → SESSION_RESULT → the endpoint wait → the probe (a test seam standing in for
 * the host daemon's host.endpoint, whose twins are tested in daemon-transfer-twins-e2e) →
 * sendMessageToSession → the continued turn. Only the Claude CLI and the probe's answer are fake.
 *
 *   1. while the endpoint refuses: the task reads Waiting on its machine, no continue is sent, and
 *      no error card is raised; once it answers: one continue, a clean turn, the wait is closed
 *   2. a person's message during the wait ends it: no continue behind them
 *   3. continues that keep failing the same way give up: Needs you, naming the endpoint
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { __setEndpointWaitForTesting } from '../../src/core/sessions/endpoint-wait.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { getTask } from '../../src/core/task-manager.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const ENDPOINT = 'http://127.0.0.1:8402'

let server: HttpServer
let port: number
let daemon: MockDaemon
let endpointUp = false
const probedHosts: string[] = []

interface WsEvent { type: string; name?: string; data?: Record<string, unknown>; id?: string; source?: string }

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function collect(ws: WebSocket): WsEvent[] {
  const out: WsEvent[] = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsEvent
    if (frame.type === 'event') out.push(frame)
  })
  return out
}

function waitForResultFor(ws: WebSocket, taskId: string, timeoutMs = 20_000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for session:result of ${taskId}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === 'session:result' && frame.data?.taskId === taskId) {
        clearTimeout(timer); ws.off('message', handler); resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15_000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && frame.id === id) { clearTimeout(timer); ws.off('message', handler); resolve(frame) }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let v = await read()
  while (!ok(v) && Date.now() < end) { await delay(150); v = await read() }
  return v
}

const continues = (events: WsEvent[], sid: string) => events.filter((e) => e.name === 'session:message-queued'
  && e.data?.sessionId === sid && e.data?.message === 'continue')

async function statusOf(taskId: string) {
  await syncUserStatuses(null)
  return (await getTask(taskId)).user_status
}

function seedTask(id: string, title: string) {
  return {
    id, title, status: 'todo', priority: 'none', category: 'Test', project: 'EndpointWaitTest',
    session_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  __setEndpointWaitForTesting({
    probe: async (host) => {
      probedHosts.push(host)
      return { kind: 'probed', url: ENDPOINT, probed: ENDPOINT, reachable: endpointUp, ...(endpointUp ? {} : { error: 'ECONNREFUSED' }) }
    },
    timing: { firstMs: 200, fastMs: 200, slowMs: 200, resumeCheckMs: 3_000 },
  })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [seedTask('ew-001', 'Endpoint comes back'), seedTask('ew-002', 'Person takes over'), seedTask('ew-003', 'Gives up')],
  }))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  __setEndpointWaitForTesting({ probe: null, timing: null })
  delete process.env.WALNUT_MOCK_CONTINUE_UNREACHABLE
  await delay(500)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 15_000)

describe('endpoint wait E2E', () => {
  it('waits on its machine while the endpoint refuses, then continues once when it answers', async () => {
    endpointUp = false
    const ws = await connectWs()
    try {
      const events = collect(ws)
      const r1p = waitForResultFor(ws, 'ew-001')
      await sendWsRpc(ws, 'session:start', { taskId: 'ew-001', message: 'unreachable-error' })
      const r1 = await r1p
      const sid = r1.data!.sessionId as string
      expect(r1.data!.isError).toBe(true)
      expect(String(r1.data!.result)).toContain('ECONNREFUSED')

      const rec = await until(() => getSessionByClaudeId(sid), (r) => r?.endpointWait?.state === 'waiting' && !!r.endpointWait.url)
      expect(rec?.endpointWait).toMatchObject({ state: 'waiting', url: ENDPOINT, probeError: 'ECONNREFUSED', resumes: 0 })
      await delay(1_500)
      expect(continues(events, sid)).toEqual([])
      expect(probedHosts.length).toBeGreaterThan(2)
      const waiting = await statusOf('ew-001')
      expect(waiting?.state).toBe('waiting')
      expect(waiting?.kind).toBe('machine')
      expect(waiting?.waitingOn).toContain(ENDPOINT)
      // The task keeps its session, and no error card was raised for a turn Walnut continues.
      expect((await getTask('ew-001')).session_id).toBe(sid)
      expect(events.some((e) => e.name === 'notification:created' && JSON.stringify(e.data).includes('ECONNREFUSED'))).toBe(false)

      endpointUp = true
      const r2p = waitForResultFor(ws, 'ew-001')
      const queued = await until(async () => continues(events, sid), (c) => c.length > 0, 8_000)
      expect(queued).toHaveLength(1)
      expect(queued[0].data?.source).toBe('auto-continue')
      const r2 = await r2p
      expect(r2.data!.isError).toBe(false)
      const after = await until(() => getSessionByClaudeId(sid), (r) => !r?.endpointWait)
      expect(after?.endpointWait).toBeUndefined()
      await delay(1_000)
      expect(continues(events, sid)).toHaveLength(1)
    } finally { ws.close() }
  }, 60_000)

  it('a person\'s message during the wait ends it: no continue behind them', async () => {
    endpointUp = false
    const ws = await connectWs()
    try {
      const events = collect(ws)
      const r1p = waitForResultFor(ws, 'ew-002')
      await sendWsRpc(ws, 'session:start', { taskId: 'ew-002', message: 'unreachable-error' })
      const sid = (await r1p).data!.sessionId as string
      await until(() => getSessionByClaudeId(sid), (r) => r?.endpointWait?.state === 'waiting')
      const r2p = waitForResultFor(ws, 'ew-002')
      await sendWsRpc(ws, 'session:send', { sessionId: sid, message: 'I will take it from here' })
      await r2p
      endpointUp = true
      await delay(2_000)
      expect(continues(events, sid)).toEqual([])
      expect((await getSessionByClaudeId(sid))?.endpointWait).toBeUndefined()
    } finally { ws.close() }
  }, 60_000)

  it('continues that keep failing the same way give up and name the endpoint', async () => {
    endpointUp = true
    process.env.WALNUT_MOCK_CONTINUE_UNREACHABLE = '1'
    const ws = await connectWs()
    try {
      const events = collect(ws)
      const r1p = waitForResultFor(ws, 'ew-003')
      await sendWsRpc(ws, 'session:start', { taskId: 'ew-003', message: 'unreachable-error' })
      const sid = (await r1p).data!.sessionId as string
      const gave = await until(() => getSessionByClaudeId(sid), (r) => r?.endpointWait?.state === 'gave_up', 30_000)
      expect(gave?.endpointWait).toMatchObject({ state: 'gave_up', gaveUpWhy: 'resumes', resumes: 3 })
      expect(continues(events, sid)).toHaveLength(3)
      const needs = await until(() => statusOf('ew-003'), (s) => s?.state === 'needs')
      expect(needs?.state).toBe('needs')
      expect(needs?.ask).toContain(ENDPOINT)
      await delay(1_500)
      expect(continues(events, sid)).toHaveLength(3)
    } finally {
      ws.close()
      delete process.env.WALNUT_MOCK_CONTINUE_UNREACHABLE
    }
  }, 60_000)
})
