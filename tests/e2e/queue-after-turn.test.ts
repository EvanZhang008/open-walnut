/**
 * E2E: a message lined up for AFTER the running turn (POST /api/v1/sessions/:id/messages { afterTurn }).
 *
 * What's real: Express server, WS, event bus, session runner, disk queue, the v1 routes.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs, `slow:<ms>` turns) behind a mock daemon.
 *
 * Would-fail-if-reverted: without the hold the message is written into the live turn at once (the
 * queue is empty right away, so there is nothing to see, edit or withdraw); without the release it
 * is never sent; without the Stop's set-aside it starts by itself after a Stop.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-after-turn'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { waitForWsEvent } from '../helpers/ws-event-wait.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

interface WsFrame { type: string; name?: string; data?: Record<string, unknown>; id?: string; ok?: boolean; payload?: unknown; error?: unknown }

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
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

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function api(method: string, route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const queueOf = async (sid: string) => ((await api('GET', `/sessions/${sid}/queue`)).json.messages ?? []) as Array<Record<string, unknown>>
// The turn in flight keeps its own row (processing) until it ends: look at the row under test.
const rowOf = async (sid: string, id: string) => (await queueOf(sid)).find((r) => r.id === id)

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [{
      id: 'aft-local-001', title: 'After the turn', status: 'todo', priority: 'none', category: 'Test', project: 'AfterTurnTest',
      session_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
    }],
  }))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  stopServer()
  await delay(500)
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 15000)

async function startSession(ws: WebSocket): Promise<string> {
  const first = waitForWsEvent(ws, 'session:result', { taskId: 'aft-local-001' }, 30000)
  await sendWsRpc(ws, 'session:start', { taskId: 'aft-local-001', message: 'turn 1: establish' })
  return (await first).data!.sessionId as string
}

async function startSlowTurn(ws: WebSocket, sid: string, ms: number): Promise<void> {
  const delivered = waitForWsEvent(ws, 'session:messages-delivered', (d) => d.sessionId === sid, 20000)
  await sendWsRpc(ws, 'session:send', { sessionId: sid, message: `slow:${ms} a long job` })
  await delivered
}

describe('afterTurn on the phone send route', () => {
  it('holds the message while the turn runs, lets it be edited, and sends it as the next turn', async () => {
    const ws = await connectWs()
    try {
      const sid = await startSession(ws)
      await startSlowTurn(ws, sid, 5000)

      const sent = await api('POST', `/sessions/${sid}/messages`, { text: 'after the job', afterTurn: true, messageId: 'qm-mobile-e2eafter01' })
      expect(sent.status).toBe(202)
      expect(sent.json).toEqual({ messageId: 'qm-mobile-e2eafter01', afterTurn: true })

      // Held: an ordinary pending row the person can still change.
      expect(await rowOf(sid, 'qm-mobile-e2eafter01')).toMatchObject({ status: 'pending', afterTurn: true })
      const edited = await api('PATCH', `/sessions/${sid}/queue/qm-mobile-e2eafter01`, { text: 'after the job, edited' })
      expect(edited.status).toBe(200)
      await delay(1500)
      expect(await rowOf(sid, 'qm-mobile-e2eafter01')).toMatchObject({ status: 'pending' })

      // The turn ends; the held row is the next turn and the mock CLI answers it.
      const answered = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && String(d.result ?? '').includes('edited'), 40000)
      await answered
      // The row leaves the queue a moment after its turn's result.
      for (let i = 0; i < 40 && (await rowOf(sid, 'qm-mobile-e2eafter01')); i++) await delay(250)
      expect(await rowOf(sid, 'qm-mobile-e2eafter01')).toBeUndefined()
    } finally {
      ws.close()
    }
  }, 90000)

  it('also holds it during the first turn of a session (the one its launch message started)', async () => {
    const ws = await connectWs()
    try {
      const firstResult = waitForWsEvent(ws, 'session:result', { taskId: 'aft-local-001' }, 60000)
      const runningSeen = waitForWsEvent(ws, 'session:status-changed', (d) => d.taskId === 'aft-local-001' && d.process_status === 'running', 30000)
      const started = await sendWsRpc(ws, 'session:start', { taskId: 'aft-local-001', message: 'slow:6000 the first turn' })
      expect(started.ok).toBe(true)
      // The session record says Running while that turn works.
      const sid = String((await runningSeen).data!.sessionId)
      expect(sid).not.toBe('undefined')
      const sent = await api('POST', `/sessions/${sid}/messages`, { text: 'after the first turn', afterTurn: true, messageId: 'qm-mobile-e2eafter05' })
      expect(sent.status).toBe(202)
      expect(sent.json).toEqual({ messageId: 'qm-mobile-e2eafter05', afterTurn: true })
      expect(await rowOf(sid, 'qm-mobile-e2eafter05')).toMatchObject({ status: 'pending', afterTurn: true })
      const answered = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && String(d.result ?? '').includes('after the first turn'), 60000)
      await firstResult
      await answered
    } finally {
      ws.close()
    }
  }, 120000)

  it('lets a held message be withdrawn, and then nothing is sent', async () => {
    const ws = await connectWs()
    try {
      const sid = await startSession(ws)
      await startSlowTurn(ws, sid, 3000)
      await api('POST', `/sessions/${sid}/messages`, { text: 'never mind', afterTurn: true, messageId: 'qm-mobile-e2eafter02' })
      expect((await api('DELETE', `/sessions/${sid}/queue/qm-mobile-e2eafter02`)).status).toBe(200)
      expect(await rowOf(sid, 'qm-mobile-e2eafter02')).toBeUndefined()
      const results: string[] = []
      const listen = (raw: WebSocket.RawData) => {
        const frame = JSON.parse(raw.toString()) as WsFrame
        if (frame.type === 'event' && frame.name === 'session:result' && frame.data?.sessionId === sid) results.push(String(frame.data.result ?? ''))
      }
      ws.on('message', listen)
      await waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid, 20000)
      await delay(3000)
      ws.off('message', listen)
      expect(results.some((r) => r.includes('never mind'))).toBe(false)
      expect(await rowOf(sid, 'qm-mobile-e2eafter02')).toBeUndefined()
    } finally {
      ws.close()
    }
  }, 60000)

  it('a Stop sets the held message aside: it is not sent until the person says so', async () => {
    const ws = await connectWs()
    try {
      const sid = await startSession(ws)
      await startSlowTurn(ws, sid, 20000)
      await api('POST', `/sessions/${sid}/messages`, { text: 'after the stop', afterTurn: true, messageId: 'qm-mobile-e2eafter03' })
      expect(await rowOf(sid, 'qm-mobile-e2eafter03')).toMatchObject({ status: 'pending', afterTurn: true })

      const stopped = await api('POST', `/sessions/${sid}/interrupt`, {})
      expect(stopped.status).toBe(200)
      const aside = await rowOf(sid, 'qm-mobile-e2eafter03')
      expect(aside).toMatchObject({ status: 'parked' })
      expect(aside).not.toHaveProperty('afterTurn')

      // Nothing starts by itself after the interrupted turn is over.
      await delay(4000)
      expect(await rowOf(sid, 'qm-mobile-e2eafter03')).toMatchObject({ status: 'parked' })

      // A person's Send now sends it.
      const answered = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && String(d.result ?? '').includes('after the stop'), 30000)
      const now = await api('POST', `/messages/qm-mobile-e2eafter03/send-now`, {})
      expect(now.status).toBe(200)
      await answered
    } finally {
      ws.close()
    }
  }, 90000)

  it('with no turn running the message is sent at once, as before', async () => {
    const ws = await connectWs()
    try {
      const sid = await startSession(ws)
      await delay(800)
      const answered = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && String(d.result ?? '').includes('right now'), 30000)
      const sent = await api('POST', `/sessions/${sid}/messages`, { text: 'right now', afterTurn: true, messageId: 'qm-mobile-e2eafter04' })
      expect(sent.status).toBe(202)
      expect(sent.json).toEqual({ messageId: 'qm-mobile-e2eafter04' })
      await answered
    } finally {
      ws.close()
    }
  }, 60000)
})
