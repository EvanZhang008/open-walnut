import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-interrupt-alive'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId, getSessionsForTask } from '../../src/core/session-tracker.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

interface WsFrame {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string
  ok?: boolean
  payload?: unknown
  error?: unknown
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
  match: (data: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 20000,
): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
      if (frame.type === 'event' && frame.name === eventName && match(frame.data ?? {})) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

/** Collect every frame of `eventName` for `sessionId` until stopped. */
function collectWsEvents(ws: WebSocket, eventName: string, sessionId: string): { frames: WsFrame[]; stop: () => void } {
  const frames: WsFrame[] = []
  const handler = (raw: WebSocket.RawData) => {
    const frame = JSON.parse(raw.toString()) as WsFrame
    if (frame.type === 'event' && frame.name === eventName && frame.data?.sessionId === sessionId) frames.push(frame)
  }
  ws.on('message', handler)
  return { frames, stop: () => ws.off('message', handler) }
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

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await delay(25)
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`)
}

/** Daemon commands recorded for one session, by name. */
function daemonCmds(sid: string, cmd: string): number {
  return daemon.getCommandHistoryFor(cmd).filter((c) => c.payload.sid === sid).length
}

/** Start a session on `taskId` whose FIRST turn is a long-running one. Returns
 *  the session id once the CLI reports the turn running. */
async function startLongTurn(ws: WebSocket, taskId: string, message: string): Promise<string> {
  const res = await sendWsRpc(ws, 'session:start', { taskId, message, project: 'Walnut', mode: 'bypass', model: 'opus' })
  expect(res.ok).toBe(true)
  // The CLI start path announces no id on session:started; the task's record does.
  let sid = ''
  await waitUntil(async () => {
    const running = (await getSessionsForTask(taskId)).find((r) => r.process_status === 'running')
    if (running) sid = running.claudeSessionId
    return !!running
  }, 15000, 'turn running')
  await waitUntil(() => daemonCmds(sid, 'start') === 1, 5000, 'daemon start recorded')
  // The record turns 'running' at spawn; wait for the CLI's OWN turn start (its
  // session_state_changed{running} line) so the stop lands on a turn in flight.
  await waitUntil(() => cliTurnRunning(sid), 15000, 'CLI turn running')
  return sid
}

/** The CLI announced a running turn in its stream (mock emits it first thing). */
function cliTurnRunning(sid: string): boolean {
  try { return fsSync.readFileSync(daemon.streamFilePath(sid), 'utf8').includes('"state":"running"') }
  catch { return false }
}

/** Number of streamed text deltas in the CLI's stream file so far. */
function streamedDeltas(sid: string): number {
  try { return fsSync.readFileSync(daemon.streamFilePath(sid), 'utf8').split('"type":"text_delta"').length - 1 }
  catch { return 0 }
}

/** The partial answer is on its way to the UI: a WS listener registered now would
 *  miss a delta that already went out, so the CLI's stream is the evidence. */
async function waitForStreamedText(sid: string, atLeast: number): Promise<void> {
  await waitUntil(() => streamedDeltas(sid) >= atLeast, 15000, `${atLeast} streamed text delta(s)`)
}

const TASKS = ['001', '002', '003', '004', '005', '006', '007', '008', '009']

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)

  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: TASKS.map((n) => ({
      id: `int-alive-${n}`,
      title: `Interrupt keeps CLI alive ${n}`,
      status: 'todo', priority: 'none', category: 'Test', project: 'Walnut',
      session_ids: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
    })),
  }))

  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1000)
}, 30000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 20000)

describe('turn stop keeps the CLI process alive', () => {
  it('Stop mid-stream: interrupt control_request, no daemon stop, status idle (not error), next send rides the FIFO', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-001', 'snapshot-long-turn:60000:text')
      // The partial answer was streaming when the user hit Stop.
      await waitForStreamedText(sid, 1)

      const result = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid, 10000)
      const stopAt = Date.now()
      const stopRes = await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })
      expect(stopRes.ok).toBe(true)

      const aborted = (await result).data!
      // Reclassified as a user stop, whatever the CLI's is_error said.
      expect(aborted.interrupted).toBe(true)
      expect(aborted.isError).toBe(false)
      expect(Date.now() - stopAt).toBeLessThan(5000)

      // The abort went over the FIFO as a control_request; the daemon never got a stop.
      const raws = daemon.getCommandHistoryFor('sendRaw').filter((c) => c.payload.sid === sid)
      expect(raws.some((c) => String(c.payload.raw).includes('"subtype":"interrupt"'))).toBe(true)
      expect(daemonCmds(sid, 'stop')).toBe(0)

      // Record: idle with the interrupted reason, never error, pid kept.
      await waitUntil(async () => (await getSessionByClaudeId(sid))?.status_reason === 'turn_interrupted', 5000, 'turn_interrupted record')
      const rec = (await getSessionByClaudeId(sid))!
      expect(rec.process_status).toBe('idle')
      expect(rec.errorMessage).toBeUndefined()
      const pidBefore = rec.pid
      expect(pidBefore).toBeTruthy()

      // Next send: same process, FIFO write — no second `start` (no cold --resume).
      const next = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && d.interrupted !== true, 15000)
      const sendRes = await sendWsRpc(ws, 'session:send', { sessionId: sid, message: 'snapshot-clean-turn:after the stop' })
      expect(sendRes.ok).toBe(true)
      const nextData = (await next).data!
      expect(String(nextData.result)).toContain('after the stop')
      expect(nextData.isError).toBe(false)
      expect(daemonCmds(sid, 'start')).toBe(1)
      expect(daemonCmds(sid, 'send')).toBeGreaterThanOrEqual(1)
      expect((await getSessionByClaudeId(sid))!.pid).toBe(pidBefore)
    } finally {
      ws.close()
    }
  }, 40000)

  it('Stop before the first token: the is_error [ede_diagnostic] result is a user stop, not an error', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-002', 'snapshot-long-turn:60000')
      const statuses = collectWsEvents(ws, 'session:status-changed', sid)
      const result = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid, 10000)
      const stopRes = await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })
      expect(stopRes.ok).toBe(true)
      const aborted = (await result).data!
      expect(aborted.interrupted).toBe(true)
      expect(aborted.isError).toBe(false)
      await waitUntil(async () => (await getSessionByClaudeId(sid))?.process_status === 'idle', 5000, 'idle record')
      await delay(300)
      statuses.stop()
      // No error status ever reached the UI, and the process was never stopped.
      expect(statuses.frames.map((f) => f.data!.process_status)).not.toContain('error')
      expect((await getSessionByClaudeId(sid))!.process_status).toBe('idle')
      expect(daemonCmds(sid, 'stop')).toBe(0)
    } finally {
      ws.close()
    }
  }, 30000)

  it('Interrupt & send: the aborted turn settles first, then the new message runs on the same process', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-003', 'snapshot-long-turn:60000:text')
      await waitForStreamedText(sid, 1)
      const results = collectWsEvents(ws, 'session:result', sid)

      const newTurn = waitForWsEvent(ws, 'session:result',
        (d) => d.sessionId === sid && String(d.result ?? '').includes('replacement question'), 15000)
      const sendRes = await sendWsRpc(ws, 'session:send', {
        sessionId: sid, message: 'snapshot-clean-turn:replacement question', interrupt: true,
      })
      expect(sendRes.ok).toBe(true)
      const answered = (await newTurn).data!
      expect(answered.isError).toBe(false)
      expect(answered.interrupted).toBeUndefined()
      await delay(200)
      results.stop()

      // Exactly one interrupted result, and it came BEFORE the new turn's result.
      const kinds = results.frames.map((f) => (f.data!.interrupted ? 'interrupted' : 'answer'))
      expect(kinds).toEqual(['interrupted', 'answer'])
      // One process for both turns: no stop, no second start, the FIFO carried the message.
      expect(daemonCmds(sid, 'stop')).toBe(0)
      expect(daemonCmds(sid, 'start')).toBe(1)
      expect(daemonCmds(sid, 'send')).toBeGreaterThanOrEqual(1)
    } finally {
      ws.close()
    }
  }, 40000)

  it('Stop with no turn in flight is a no-op: process untouched, no result, still idle', async () => {
    const ws = await connectWs()
    try {
      const first = waitForWsEvent(ws, 'session:result', () => true, 15000)
      const res = await sendWsRpc(ws, 'session:start', {
        taskId: 'int-alive-004', message: 'snapshot-clean-turn:idle baseline', project: 'Walnut', mode: 'bypass', model: 'opus',
      })
      expect(res.ok).toBe(true)
      const sid = (await first).data!.sessionId as string
      await waitUntil(async () => (await getSessionByClaudeId(sid))?.process_status === 'idle', 5000, 'idle after first turn')

      const results = collectWsEvents(ws, 'session:result', sid)
      const stopRes = await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })
      expect(stopRes.ok).toBe(true)
      await delay(1500)
      results.stop()
      expect(results.frames).toHaveLength(0)
      expect(daemonCmds(sid, 'stop')).toBe(0)
      const rec = (await getSessionByClaudeId(sid))!
      expect(rec.process_status).toBe('idle')

      // And the session is still fully usable on the same process.
      const next = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && String(d.result ?? '').includes('still here'), 15000)
      await sendWsRpc(ws, 'session:send', { sessionId: sid, message: 'snapshot-clean-turn:still here' })
      await next
      expect(daemonCmds(sid, 'start')).toBe(1)
    } finally {
      ws.close()
    }
  }, 30000)

  it('three stop→send rounds on one process', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-005', 'snapshot-long-turn:60000:text')
      await waitForStreamedText(sid, 1)
      for (let round = 1; round <= 3; round++) {
        const aborted = waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && d.interrupted === true, 10000)
        expect((await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })).ok).toBe(true)
        await aborted
        await waitUntil(async () => (await getSessionByClaudeId(sid))?.process_status === 'idle', 5000, `idle after stop ${round}`)
        // Start the next long turn on the same process (last round: a clean one).
        const message = round < 3 ? 'snapshot-long-turn:60000:text' : 'snapshot-clean-turn:round three done'
        const finalAnswer = round === 3
          ? waitForWsEvent(ws, 'session:result', (d) => d.sessionId === sid && String(d.result ?? '').includes('round three done'), 15000)
          : null
        expect((await sendWsRpc(ws, 'session:send', { sessionId: sid, message })).ok).toBe(true)
        if (finalAnswer) await finalAnswer
        else await waitForStreamedText(sid, round + 1)
      }
      expect(daemonCmds(sid, 'stop')).toBe(0)
      expect(daemonCmds(sid, 'start')).toBe(1)
      expect((await getSessionByClaudeId(sid))!.process_status).toBe('idle')
    } finally {
      ws.close()
    }
  }, 60000)

  it('fallback: when the FIFO cannot carry the control_request, the stop still kills the process', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-006', 'snapshot-long-turn:60000:text')
      await waitForStreamedText(sid, 1)
      // The pipe is gone (reader died): sendRaw answers ENXIO, exactly like the real daemon.
      daemon.injectSendFault(sid, 'ENXIO')
      const stopRes = await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })
      expect(stopRes.ok).toBe(true)
      // The user must still be able to stop: the hard path asks the daemon to stop the process.
      await waitUntil(() => daemonCmds(sid, 'stop') >= 1, 10000, 'daemon stop on fallback')
      const raws = daemon.getCommandHistoryFor('sendRaw').filter((c) => c.payload.sid === sid)
      expect(raws.some((c) => String(c.payload.raw).includes('"subtype":"interrupt"'))).toBe(true)
    } finally {
      ws.close()
    }
  }, 30000)

  it('two concurrent Stops share one interrupt and keep a delayed result classified as interrupted', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-008', 'snapshot-long-turn:60000:text:800')
      const results = collectWsEvents(ws, 'session:result', sid)
      await Promise.all([
        sendWsRpc(ws, 'session:interrupt', { sessionId: sid }),
        sendWsRpc(ws, 'session:interrupt', { sessionId: sid }),
      ])
      await waitUntil(() => results.frames.length === 1, 10000, 'single interrupted result')
      expect(results.frames[0].data?.interrupted).toBe(true)
      expect(daemon.getCommandHistoryFor('sendRaw').filter((c) =>
        c.payload.sid === sid && String(c.payload.raw).includes('"subtype":"interrupt"'))).toHaveLength(1)
      expect(daemonCmds(sid, 'stop')).toBe(0)
      results.stop()
    } finally { ws.close() }
  }, 30000)

  it('a send arriving during Stop waits for the delayed result and is delivered exactly once', async () => {
    const ws = await connectWs()
    try {
      const sid = await startLongTurn(ws, 'int-alive-009', 'snapshot-long-turn:60000:text:800')
      const results = collectWsEvents(ws, 'session:result', sid)
      await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })
      await waitUntil(() => daemon.getCommandHistoryFor('sendRaw').some((c) =>
        c.payload.sid === sid && String(c.payload.raw).includes('"subtype":"interrupt"')), 5000, 'interrupt delivered')
      await sendWsRpc(ws, 'session:send', { sessionId: sid, message: 'snapshot-clean-turn:concurrent follow-up' })
      await waitUntil(() => results.frames.length === 2, 10000, 'interrupted result and replacement answer')
      expect(results.frames.map((f) => f.data?.interrupted === true)).toEqual([true, false])
      expect(String(results.frames[1].data?.result)).toContain('concurrent follow-up')
      expect(daemonCmds(sid, 'send')).toBe(1)
      expect(daemonCmds(sid, 'stop')).toBe(0)
      expect(daemonCmds(sid, 'start')).toBe(1)
      results.stop()
    } finally { ws.close() }
  }, 30000)

  it('an ACK without a result falls back to a process stop before any replacement turn', async () => {
    const ws = await connectWs()
    try {
      // `:sticky` — the CLI ACKs but the turn never ends (a tool ignoring its abort).
      const sid = await startLongTurn(ws, 'int-alive-007', 'snapshot-long-turn:60000:text:sticky')
      await waitForStreamedText(sid, 1)

      const firstAt = Date.now()
      expect((await sendWsRpc(ws, 'session:interrupt', { sessionId: sid })).ok).toBe(true)
      await waitUntil(() => daemonCmds(sid, 'stop') >= 1, 10000, 'daemon stop after missing result')
      expect(Date.now() - firstAt).toBeGreaterThanOrEqual(3000)
      const interrupts = daemon.getCommandHistoryFor('sendRaw')
        .filter((c) => c.payload.sid === sid && String(c.payload.raw).includes('"subtype":"interrupt"'))
      // Exactly one control_request: the escalation did not ask the CLI again.
      expect(interrupts).toHaveLength(1)
    } finally {
      ws.close()
    }
  }, 40000)
})
