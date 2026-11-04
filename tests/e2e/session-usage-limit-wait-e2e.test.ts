/**
 * E2E: a turn the subscription's usage limit stopped continues by itself at the reset
 * (src/core/sessions/usage-limit-wait.ts).
 *
 * Full server pipeline: WebSocket -> session runner -> mock-claude ("limit-error:<reset>": a
 * rejected rate_limit_event, the blocked reply and the CLI's error result) -> SESSION_RESULT with
 * usageLimit -> the wait -> sendMessageToSession -> the continued turn. Only the Claude CLI is fake;
 * the clock is shortened (no grace, no spread).
 *
 *   1. the task reads Waiting, Limited until the reset, keeps its session, raises no error card;
 *      at the reset: one continue, a clean turn, the wait closed
 *   2. a person's message during the wait ends it: no continue behind them
 *   3. the session's buttons: Don't auto-continue (Needs you), Continue now (one continue at once)
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
import { __setUsageLimitWaitForTesting, LIMIT_CONTINUE_NOW_TEXT, LIMIT_CONTINUE_TEXT } from '../../src/core/sessions/usage-limit-wait.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { getTask } from '../../src/core/task-manager.js'
import { syncUserStatuses } from '../../src/core/user-status-sync.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

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
  && e.data?.sessionId === sid && [LIMIT_CONTINUE_TEXT, LIMIT_CONTINUE_NOW_TEXT].some((t) => String(e.data?.message ?? '').includes(t)))

async function statusOf(taskId: string) {
  await syncUserStatuses(null)
  return (await getTask(taskId)).user_status
}


function seedTask(id: string, title: string) {
  return {
    id, title, status: 'todo', priority: 'none', category: 'Test', project: 'UsageLimitTest',
    session_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
  }
}

const resetIn = (ms: number) => Math.ceil((Date.now() + ms) / 1000)

async function act(sid: string, action: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${port}/api/sessions/${sid}/usage-limit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  __setUsageLimitWaitForTesting({ timing: { graceMs: 0, jitterMaxMs: 0, backoffMs: [2_000], resumeCheckMs: 3_000 } })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [seedTask('ul-001', 'Continues at the reset'), seedTask('ul-002', 'Person takes over'), seedTask('ul-003', 'Buttons')],
  }))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1500)
}, 30_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  __setUsageLimitWaitForTesting({ timing: null })
  await delay(500)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 15_000)

describe('usage-limit wait E2E', () => {
  it('waits for the reset as Limited, then continues once by itself', async () => {
    const ws = await connectWs()
    try {
      const events = collect(ws)
      const r1p = waitForResultFor(ws, 'ul-001')
      await sendWsRpc(ws, 'session:start', { taskId: 'ul-001', message: `limit-error:${resetIn(4_000)}` })
      const r1 = await r1p
      const sid = r1.data!.sessionId as string
      expect(r1.data!.isError).toBe(true)
      expect(r1.data!.usageLimit).toMatchObject({ engine: 'claude', window: 'five_hour', resetsFrom: 'event' })

      const rec = await until(() => getSessionByClaudeId(sid), (r) => r?.usageLimit?.state === 'waiting')
      expect(rec?.usageLimit).toMatchObject({ state: 'waiting', engine: 'claude', resumes: 0, tries: 0 })
      // The panel hears it live (the WS frame may land just after the record is written).
      expect(await until(async () => events.some((e) => e.name === 'session:usage-limit' && e.data?.sessionId === sid), (v) => v, 3_000)).toBe(true)
      const waiting = await until(() => statusOf('ul-001'), (s) => s?.state === 'waiting' && !!s.limit)
      expect(waiting?.kind).toBe('time')
      expect(waiting?.limit).toMatchObject({ engine: 'claude', auto: true })
      expect(waiting?.waitingOn).toContain('Claude 5-hour limit')
      expect((await getTask('ul-001')).session_id).toBe(sid)
      expect((await getTask('ul-001')).phase).not.toBe('NEED_ACTION')
      expect(events.some((e) => e.name === 'notification:created' && JSON.stringify(e.data).includes('hit your session limit'))).toBe(false)
      expect(continues(events, sid)).toEqual([])

      const r2p = waitForResultFor(ws, 'ul-001', 20_000)
      const queued = await until(async () => continues(events, sid), (c) => c.length > 0, 12_000)
      expect(queued).toHaveLength(1)
      expect(queued[0].data?.source).toBe('auto-continue')
      const r2 = await r2p
      expect(r2.data!.isError).toBe(false)
      const after = await until(() => getSessionByClaudeId(sid), (r) => !r?.usageLimit)
      expect(after?.usageLimit).toBeUndefined()
      // The panel says Walnut continued it, live and on the record, until the next message.
      const noted = await until(() => getSessionByClaudeId(sid), (r) => !!r?.usageLimitContinued)
      expect(noted?.usageLimitContinued).toMatchObject({ engine: 'claude', window: 'five_hour' })
      expect(await until(async () => events.some((e) => e.name === 'session:usage-limit' && e.data?.sessionId === sid && !!e.data?.continued), (v) => v, 3_000)).toBe(true)
      await delay(4_000)
      expect(continues(events, sid)).toHaveLength(1)
      const r3p = waitForResultFor(ws, 'ul-001', 20_000)
      await sendWsRpc(ws, 'session:send', { sessionId: sid, message: 'Thanks, carry on' })
      await r3p
      expect((await until(() => getSessionByClaudeId(sid), (r) => !r?.usageLimitContinued))?.usageLimitContinued).toBeUndefined()
    } finally { ws.close() }
  }, 90_000)

  it("a person's message during the wait ends it: no continue behind them", async () => {
    const ws = await connectWs()
    try {
      const events = collect(ws)
      const r1p = waitForResultFor(ws, 'ul-002')
      await sendWsRpc(ws, 'session:start', { taskId: 'ul-002', message: `limit-error:${resetIn(5_000)}` })
      const sid = (await r1p).data!.sessionId as string
      await until(() => getSessionByClaudeId(sid), (r) => r?.usageLimit?.state === 'waiting')
      const r2p = waitForResultFor(ws, 'ul-002')
      await sendWsRpc(ws, 'session:send', { sessionId: sid, message: 'I will take it from here' })
      await r2p
      await delay(7_000)
      expect(continues(events, sid)).toEqual([])
      expect((await getSessionByClaudeId(sid))?.usageLimit).toBeUndefined()
    } finally { ws.close() }
  }, 60_000)

  it("Don't auto-continue makes it the user's; Continue now sends one continue at once", async () => {
    const ws = await connectWs()
    try {
      const events = collect(ws)
      const r1p = waitForResultFor(ws, 'ul-003')
      await sendWsRpc(ws, 'session:start', { taskId: 'ul-003', message: `limit-error:${resetIn(6_000)}` })
      const sid = (await r1p).data!.sessionId as string
      await until(() => getSessionByClaudeId(sid), (r) => r?.usageLimit?.state === 'waiting')

      expect((await act(sid, 'bogus')).status).toBe(400)
      const off = await act(sid, 'off')
      expect(off.status).toBe(200)
      expect(off.body.usageLimit).toMatchObject({ state: 'off' })
      const needs = await until(() => statusOf('ul-003'), (s) => s?.state === 'needs')
      expect(needs?.ask).toContain('Auto-continue off')
      await delay(8_000)
      expect(continues(events, sid)).toEqual([])

      const r2p = waitForResultFor(ws, 'ul-003')
      const now = await act(sid, 'continue')
      expect(now.status).toBe(200)
      expect(now.body.usageLimit).toMatchObject({ state: 'resumed', resumes: 1 })
      expect((await r2p).data!.isError).toBe(false)
      expect(continues(events, sid)).toHaveLength(1)
      await until(() => getSessionByClaudeId(sid), (r) => !r?.usageLimit)
      // The stored status (what every row reads) leaves the off wait by itself, within the sync's
      // own debounce, never only at the minute sweep.
      const t0 = Date.now()
      const after = await until(async () => (await getTask('ul-003')).user_status, (s) => !s?.limit || !!s.limit.auto, 6_000)
      console.log('[ul-e2e] off row left the limit after', Date.now() - t0, 'ms', JSON.stringify(after))
      expect(after?.limit?.auto ?? true).toBe(true)
      expect((await act(sid, 'continue')).status).toBe(409)
    } finally { ws.close() }
  }, 60_000)
})
