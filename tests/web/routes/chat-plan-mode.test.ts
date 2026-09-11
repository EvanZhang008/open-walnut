/**
 * Tests for plan mode signal injection in the chat RPC handler.
 *
 * Verifies that:
 * - planModeOff: true  => [EXECUTION MODE] prefix
 * - mode: 'plan', planModeFirst: true => [PLAN MODE] prefix
 * - No mode flags => no prefix injected
 *
 * The signal rides the message TEXT delivered into the conversation's lane
 * session, so what is captured here is that message: the lane is the one thing a
 * turn reaches, and a prefix that never made it onto the wire never reached the
 * model either.
 *
 * What's real: Express server, WebSocket RPC, chat handler routing, the lane
 * modules. What's mocked: constants.js (temp dir) and the 'session-runner' bus
 * subscriber (a fake that records SESSION_START, answers with a synthetic
 * session:result, and NEVER spawns a `claude`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import type { Server as HttpServer } from 'node:http'
import WebSocket from 'ws'
import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import type { SessionStartEvent } from '../../../src/core/event-types.js'
import { markProcessing, removeProcessed } from '../../../src/core/session-message-queue.js'

let server: HttpServer
let port: number
/** SESSION_START events the fake runner saw — one per lane spawn. */
let started: SessionStartEvent[] = []

/** The message text the turn delivered into the lane. */
function laneMessage(): string {
  if (started.length === 0) throw new Error('the turn never reached a lane')
  return started[0].message ?? ''
}

/**
 * Consume a session's queued messages the way a real delivery would. Tracked so
 * teardown can await it: a message left 'pending' when the server goes down is
 * what the local daemon's reconnect redelivery would cold-`--resume` into a REAL
 * `claude` spawn.
 */
const inFlightDrains = new Set<Promise<void>>()

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId)
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id))
    } catch { /* the store may be torn down between tests */ }
  })()
  inFlightDrains.add(p)
  void p.finally(() => inFlightDrains.delete(p))
}

/**
 * Fake session-runner: records starts, drains sends, answers each turn with a
 * synthetic session:result (the chat RPC AWAITS the lane turn, so a runner that
 * never answers hangs the RPC to its timeout), and never spawns anything.
 * Replacing the subscriber by NAME displaces the real runner startServer added.
 */
function installFakeRunner(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    let sid: string | undefined
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent
      started.push(d)
      sid = d.preassignedSessionId
    } else if (event.name === EventNames.SESSION_SEND) {
      sid = (event.data as { sessionId: string }).sessionId
    }
    if (!sid) return
    drainQueue(sid)
    const sessionId = sid
    setTimeout(() => {
      bus.emit(EventNames.SESSION_RESULT, { sessionId, result: 'lane answer', isError: false },
        ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, 5)
  })
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendRpc(
  ws: WebSocket,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; payload?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error('RPC timed out')), 15_000)

    const handler = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>
      if (msg.type === 'res' && msg.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(msg as { ok: boolean; payload?: unknown; error?: string })
      }
    }

    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

// Expected constants from chat.ts
const EXECUTION_MODE_MESSAGE =
  '[EXECUTION MODE] Plan mode has been deactivated. You may now execute changes and take actions. Previous plan-mode restrictions no longer apply.'

const PLAN_MODE_REMINDER =
  '[Reminder: Plan mode is still active — discuss and explore only, do not execute or make changes.]'

describe('Chat RPC plan mode signal injection', () => {
  beforeEach(async () => {
    started = []
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    server = await startServer({ port: 0, dev: true })
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    installFakeRunner()
  })

  afterEach(async () => {
    // Let every fake delivery finish draining BEFORE the server goes down.
    await Promise.allSettled([...inFlightDrains])
    await stopServer()
    await new Promise((r) => setTimeout(r, 100))
    bus.clear()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('B1: planModeOff: true => agent message starts with [EXECUTION MODE]', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'do the thing',
        planModeOff: true,
      })

      const content = laneMessage()
      expect(content).toContain(EXECUTION_MODE_MESSAGE)
      expect(content.startsWith(EXECUTION_MODE_MESSAGE)).toBe(true)
      // The original message should follow after the prefix
      expect(content).toContain('do the thing')
      // Should NOT contain plan mode instructions
      expect(content).not.toContain('[PLAN MODE]')
      expect(content).not.toContain(PLAN_MODE_REMINDER)
    } finally {
      ws.close()
    }
  })

  it('B2: mode=plan, planModeFirst=true => agent message starts with [PLAN MODE]', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'think about this',
        mode: 'plan',
        planModeFirst: true,
      })

      const content = laneMessage()
      expect(content.startsWith('[PLAN MODE]')).toBe(true)
      // Should contain the original message
      expect(content).toContain('think about this')
      // Should NOT have the reminder suffix (planModeFirst uses full instruction, not reminder)
      expect(content).not.toContain(PLAN_MODE_REMINDER)
      // Should NOT have execution mode
      expect(content).not.toContain('[EXECUTION MODE]')
    } finally {
      ws.close()
    }
  })

  it('B2b: mode=plan without planModeFirst => reminder suffix appended', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'continue planning',
        mode: 'plan',
      })

      const content = laneMessage()
      // Should NOT start with [PLAN MODE] (that's only for planModeFirst)
      expect(content.startsWith('[PLAN MODE]')).toBe(false)
      // Should contain the original message
      expect(content).toContain('continue planning')
      // Should end with the plan mode reminder suffix
      expect(content).toContain(PLAN_MODE_REMINDER)
      expect(content.endsWith(PLAN_MODE_REMINDER)).toBe(true)
      // Should NOT have execution mode
      expect(content).not.toContain('[EXECUTION MODE]')
    } finally {
      ws.close()
    }
  })

  it('B3: no mode flags => no prefix injected', async () => {
    const ws = await connectWs()
    try {
      await sendRpc(ws, 'chat', {
        message: 'just a normal message',
      })

      const content = laneMessage()
      // Should be just the message, no prefixes or suffixes
      expect(content).toBe('just a normal message')
      expect(content).not.toContain('[PLAN MODE]')
      expect(content).not.toContain('[EXECUTION MODE]')
      expect(content).not.toContain(PLAN_MODE_REMINDER)
    } finally {
      ws.close()
    }
  })
})
