/**
 * A budget for Walnut's own share of a send.
 *
 * 2026-11-09, the user: messages must send instantly, so Walnut's own share of a send
 * (everything between the person pressing Send and the line reaching the CLI's stdin)
 * must be near zero. Production logs that day (35 person sends): RPC received ->
 * 'message enqueued' p50 12 ms, p90 27 ms; 'session send requested' -> 'message
 * delivered' p50 74 ms. This test pins that share so a new slow step on the path (an
 * awaited host read, a model call, a lock held across the network) fails here, named
 * by the stage that grew, instead of reaching the user as a slow send.
 *
 * Path measured, per send to an idle live session (warmed by a first send):
 *   request  the client writes the `session:send` RPC (same process, same clock)
 *   emit     SESSION_SEND on the bus: the RPC handler, the hint pipeline and
 *            sendMessageToSession, up to the row being stored and the runner told
 *   fifo     the daemon writes the line into the CLI's stdin FIFO: the runner's
 *            drain (markProcessing, the batch) and the daemon round trip
 *
 * What's real: server, WebSocket RPC, event bus, queue store, session runner,
 * RemoteSessionManager, the daemon protocol. What's mocked: the daemon (MockDaemon,
 * in this process) and the Claude CLI (mock-claude.mjs).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { waitForWsEvent } from '../helpers/ws-event-wait.js'

// Measured on this Mac (2026-11-09, 10 sends after a warm one each run):
//   at load 30 to 50, two runs:
//     request -> emit  median 23 / 28 ms, max 72 / 109 ms
//     emit -> fifo     median 17 / 13 ms, max 145 / 134 ms
//     request -> fifo  median 53 / 46 ms, max 172 / 243 ms
//   at load 120 to 170 (other agents' test runs): request -> emit median 56 ms,
//   emit -> fifo median 83 ms, request -> fifo median 125 ms, max 692 ms
// The median budgets keep over 5x headroom on the normal-load medians (and pass at
// load 170); a step that waits on a host, the network or a model costs hundreds of ms
// on every send and still fails them. The per-send cap catches one send that hangs.
const BUDGET = {
  emitMedianMs: 150,
  fifoMedianMs: 300,
  everyFifoMs: 2000,
}
const MEASURED_SENDS = 10
const TASK_ID = 'send-budget'

let server: HttpServer
let port: number
let daemon: MockDaemon | undefined

interface WsFrame { type: string; id?: string; ok?: boolean; error?: unknown; data?: Record<string, unknown> }

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
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10_000)
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

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: [{
      id: TASK_ID, title: 'A budget for a send', status: 'todo', priority: 'none',
      category: 'Work', project: 'Walnut', session_ids: [], active_session_ids: [],
      created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [],
    }],
  }))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  bus.unsubscribe('send-budget-probe')
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  daemon = undefined
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe("Walnut's own share of a send", () => {
  it('a person send to an idle live session reaches the CLI stdin within budget, stage by stage', async () => {
    const ws = await connectWs()

    const firstAnswer = waitForWsEvent(ws, 'session:result', { taskId: TASK_ID, resultIncludes: 'first answer' })
    await sendWsRpc(ws, 'session:start', { taskId: TASK_ID, message: 'snapshot-clean-turn:first answer', project: 'Walnut' })
    const sessionId = ((await firstAnswer).data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // When SESSION_SEND left for the runner, per session.
    const emits: Array<{ sessionId: string; at: number }> = []
    bus.subscribe('send-budget-probe', (event) => {
      const sid = (event.data as { sessionId?: unknown })?.sessionId
      if (event.name === EventNames.SESSION_SEND && sid === sessionId) emits.push({ sessionId: sid, at: event.timestamp })
    }, { global: true, interest: [EventNames.SESSION_SEND] })

    const idle = () => vi.waitFor(() => {
      expect(sessionRunner.findSessionByClaudeId(sessionId)?.processStatus).toBe('idle')
    }, { timeout: 10_000, interval: 10 })

    /** One person send, measured: request -> SESSION_SEND emit -> the line in the CLI's FIFO. */
    const timedSend = async (label: string) => {
      await idle()
      const emitsBefore = emits.length
      const answered = waitForWsEvent(ws, 'session:result', { sessionId, resultIncludes: label })
      const requestAt = Date.now()
      const res = await sendWsRpc(ws, 'session:send', { sessionId, message: `snapshot-clean-turn:${label}` })
      expect(res.ok, `session:send failed: ${JSON.stringify(res.error)}`).toBe(true)
      await vi.waitFor(() => {
        expect(daemon!.getFifoWrites().some((w) => w.sid === sessionId && w.message.includes(label))).toBe(true)
      }, { timeout: 10_000, interval: 2 })
      const fifoAt = daemon!.getFifoWrites().find((w) => w.sid === sessionId && w.message.includes(label))!.timestamp
      const emitAt = emits.slice(emitsBefore)[0]?.at
      expect(emitAt, `no SESSION_SEND for ${label}`).toBeDefined()
      await answered
      return { label, emit: emitAt! - requestAt, fifo: fifoAt - requestAt, drain: fifoAt - emitAt! }
    }

    // Warm the path: the first send after a spawn pays one-time imports and cache fills.
    await timedSend('warm send')

    const runs: Array<{ label: string; emit: number; fifo: number; drain: number }> = []
    for (let i = 0; i < MEASURED_SENDS; i++) runs.push(await timedSend(`measured send ${i}`))

    const table = runs.map((r) => `  ${r.label}: request->emit ${r.emit} ms, emit->fifo ${r.drain} ms, request->fifo ${r.fifo} ms`).join('\n')
    const emitMedian = median(runs.map((r) => r.emit))
    const drainMedian = median(runs.map((r) => r.drain))
    const fifoMedian = median(runs.map((r) => r.fifo))
    const summary = `medians: request->emit ${emitMedian} ms, emit->fifo ${drainMedian} ms, request->fifo ${fifoMedian} ms\n${table}`
    console.log(`[send-budget] ${summary}`)

    const slow = runs.filter((r) => r.fifo >= BUDGET.everyFifoMs)
    expect(emitMedian, `stage "request -> SESSION_SEND emit" (RPC handler, hints, sendMessageToSession) grew past ${BUDGET.emitMedianMs} ms median\n${summary}`)
      .toBeLessThan(BUDGET.emitMedianMs)
    expect(fifoMedian, `stage "request -> CLI stdin" grew past ${BUDGET.fifoMedianMs} ms median; emit->fifo (runner drain + daemon write) median ${drainMedian} ms\n${summary}`)
      .toBeLessThan(BUDGET.fifoMedianMs)
    expect(slow, `sends over ${BUDGET.everyFifoMs} ms from request to CLI stdin\n${summary}`).toEqual([])

    ws.close()
  })
})
