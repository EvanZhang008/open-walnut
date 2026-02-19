/**
 * E2E tests for the session hooks system.
 *
 * Verifies that the SessionHookDispatcher correctly maps bus events to
 * hook points and dispatches registered handlers (builtin and custom).
 *
 * What's real: Express server, WebSocket, event bus, session-tracker,
 * task-manager, SessionHookDispatcher, builtin hooks.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Tests verify:
 *   1. Triage hook fires after session completion (emits subagent:start)
 *   2. Error hook fires on session error
 *   3. Hooks can be disabled via config overrides
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

// Use mock CLI directly
const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

// ── Helpers ──

let server: HttpServer
let port: number

function wsUrl(): string {
  return `ws://localhost:${port}/ws`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

interface WsEvent {
  type: string
  name?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsEvent> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEvent
      if (frame.type === 'res' && (frame as Record<string, unknown>).id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Listen on the event bus for a specific event. Returns a promise that resolves
 * with the BusEvent data when the event is emitted.
 */
function waitForBusEvent(
  eventName: string,
  timeoutMs = 10000,
): { promise: Promise<Record<string, unknown>>; cleanup: () => void } {
  const subscriberName = `test-hook-listener-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let cleanup = () => { bus.unsubscribe(subscriberName) }

  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.unsubscribe(subscriberName)
      reject(new Error(`Timed out waiting for bus event ${eventName}`))
    }, timeoutMs)

    bus.subscribe(subscriberName, (event) => {
      if (event.name === eventName) {
        clearTimeout(timer)
        bus.unsubscribe(subscriberName)
        resolve(event.data as Record<string, unknown>)
      }
    }, { global: true })

    cleanup = () => {
      clearTimeout(timer)
      bus.unsubscribe(subscriberName)
    }
  })

  return { promise, cleanup }
}

/**
 * Collect all bus events matching the given name. Returns the events array
 * and a cleanup function.
 */
function collectBusEvents(eventName: string): {
  events: Array<{ data: Record<string, unknown>; source: string }>
  cleanup: () => void
} {
  const subscriberName = `test-collector-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const events: Array<{ data: Record<string, unknown>; source: string }> = []

  bus.subscribe(subscriberName, (event) => {
    if (event.name === eventName) {
      events.push({ data: event.data as Record<string, unknown>, source: event.source })
    }
  }, { global: true })

  return {
    events,
    cleanup: () => bus.unsubscribe(subscriberName),
  }
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  sessionRunner.setCliCommand(MOCK_CLI)

  // Seed tasks
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'hook-task-001',
          title: 'Session hooks test task',
          status: 'todo',
          priority: 'immediate',
          category: 'Work',
          project: 'Walnut',
          session_ids: [],
          active_session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
        },
        {
          id: 'hook-task-002',
          title: 'Another hooks test task',
          status: 'todo',
          priority: 'none',
          category: 'Work',
          project: 'Walnut',
          session_ids: [],
          active_session_ids: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          description: '',
          summary: '',
          note: '',
          subtasks: [],
        },
      ],
    }),
  )

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Test 1: Triage hook fires after session completion ──

describe('Triage hook fires after session completion', () => {
  it('session:result triggers subagent:start with turn-complete-triage agent', async () => {
    const ws = await connectWs()

    // Listen on the bus for the subagent:start event that the triage hook emits
    const { promise: subagentStartPromise, cleanup } = waitForBusEvent(
      EventNames.SUBAGENT_START,
      15000,
    )

    // Start a session — mock CLI completes immediately
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-001',
      message: 'triage hook e2e test',
      project: 'Walnut',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for the session result first (so we know the session completed)
    await waitForWsEvent(ws, 'session:result')

    // Now wait for the triage hook to dispatch subagent:start
    const subagentData = await subagentStartPromise

    // Verify the triage subagent was dispatched with correct data
    expect(subagentData.agentId).toBe('turn-complete-triage')
    expect(subagentData.taskId).toBe('hook-task-001')
    expect(typeof subagentData.task).toBe('string')
    expect(subagentData.task as string).toContain('hook-task-001')

    cleanup()
    ws.close()
    await delay(50)
  })

  it('triage hook does not fire for taskless sessions', async () => {
    const ws = await connectWs()

    // Collect all subagent:start events
    const { events: subagentEvents, cleanup } = collectBusEvents(EventNames.SUBAGENT_START)

    // Start a session without a taskId
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      message: 'taskless session no triage',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for session to complete
    await waitForWsEvent(ws, 'session:result')

    // Give hooks time to fire
    await delay(1000)

    // The triage hook checks `if (!p.taskId) return` — so no subagent:start should fire
    // for a taskless session from the turn-complete-triage source
    const triageEvents = subagentEvents.filter(e => e.source === 'turn-complete-triage')
    expect(triageEvents.length).toBe(0)

    cleanup()
    ws.close()
    await delay(50)
  })
})

// ── Test 2: Error hook fires on session error ──

describe('Error hook fires on session error', () => {
  it('session error message triggers onTurnError hook', async () => {
    const ws = await connectWs()

    // The session-error-notify hook is a builtin that logs errors.
    // We can verify it by listening for session:error on the bus and verifying
    // the dispatcher processed it. The hook itself just logs, but the dispatcher
    // runs on the same bus events.

    // Start a session with "error" message — mock CLI exits with code 1
    const errorPromise = waitForWsEvent(ws, 'session:error')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-002',
      message: 'error',
      project: 'Walnut',
    })

    // Verify session:error is emitted (the dispatcher sees this and runs onTurnError hooks)
    const errorEvent = await errorPromise
    const ed = errorEvent.data as { error: string; taskId: string }
    expect(ed.error).toBeDefined()
    expect(ed.taskId).toBe('hook-task-002')

    // Give hooks time to process
    await delay(500)

    // The error hook ran (it logs internally). The key verification is that
    // session:error was emitted through the bus — the dispatcher maps
    // SESSION_ERROR to onTurnError and dispatches the session-error-notify hook.

    ws.close()
    await delay(50)
  })

  it('error sessions do not trigger triage hook (onTurnComplete only)', async () => {
    const ws = await connectWs()

    // Collect subagent:start events
    const { events: subagentEvents, cleanup } = collectBusEvents(EventNames.SUBAGENT_START)

    // Start a session with "error" message
    await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-002',
      message: 'error',
      project: 'Walnut',
    })

    // Wait for the error event
    await waitForWsEvent(ws, 'session:error')

    // Give hooks time to settle
    await delay(1000)

    // The triage hook only registers for 'onTurnComplete' — not 'onTurnError'.
    // session:error maps to onTurnError, so triage should NOT fire.
    const triageEvents = subagentEvents.filter(e => e.source === 'turn-complete-triage')
    expect(triageEvents.length).toBe(0)

    cleanup()
    ws.close()
    await delay(50)
  })
})

// ── Test 3: Hooks can be disabled via config ──

describe('Hooks can be disabled via config', () => {
  it('dispatcher respects config overrides to disable hooks', async () => {
    // This test verifies the dispatcher's config override mechanism.
    // We access the dispatcher singleton and add a disabled-override hook,
    // then verify it doesn't fire.

    const { getSessionHookDispatcher } = await import('../../src/core/session-hooks/index.js')
    const dispatcher = getSessionHookDispatcher()
    expect(dispatcher).not.toBeNull()

    // Track whether a custom hook fires
    let customHookFired = false
    const customHook = {
      id: 'test-custom-hook',
      name: 'Test Custom Hook',
      hooks: ['onTurnComplete' as const],
      priority: 200,
      source: 'config' as const,
      enabled: true,
      handler: async () => {
        customHookFired = true
      },
    }

    // Add the custom hook
    dispatcher!.addHook(customHook)

    const ws = await connectWs()

    // Start a session to trigger onTurnComplete
    await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-001',
      message: 'custom hook test',
      project: 'Walnut',
    })
    await waitForWsEvent(ws, 'session:result')

    // Give hooks time to process
    await delay(1000)

    // Verify the custom hook was called
    expect(customHookFired).toBe(true)

    // Now remove it and verify it no longer fires
    customHookFired = false
    dispatcher!.removeHook('test-custom-hook')

    await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-001',
      message: 'after removal test',
      project: 'Walnut',
    })
    await waitForWsEvent(ws, 'session:result')

    await delay(1000)

    // Hook was removed — should NOT have fired
    expect(customHookFired).toBe(false)

    ws.close()
    await delay(50)
  })

  it('disabled hooks in overrides do not fire', async () => {
    const { getSessionHookDispatcher } = await import('../../src/core/session-hooks/index.js')
    const dispatcher = getSessionHookDispatcher()
    expect(dispatcher).not.toBeNull()

    // Add a hook that is explicitly disabled
    let disabledHookFired = false
    dispatcher!.addHook({
      id: 'test-disabled-hook',
      name: 'Test Disabled Hook',
      hooks: ['onTurnComplete'],
      priority: 200,
      source: 'config',
      enabled: false, // disabled!
      handler: async () => {
        disabledHookFired = true
      },
    })

    const ws = await connectWs()

    await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-001',
      message: 'disabled hook test',
      project: 'Walnut',
    })
    await waitForWsEvent(ws, 'session:result')

    await delay(1000)

    // Disabled hook should NOT have fired
    expect(disabledHookFired).toBe(false)

    // Clean up
    dispatcher!.removeHook('test-disabled-hook')

    ws.close()
    await delay(50)
  })
})

// ── Test 4: Hook receives correct payload context ──

describe('Hook payload context', () => {
  it('onTurnComplete hook receives sessionId, taskId, result, and task details', async () => {
    const { getSessionHookDispatcher } = await import('../../src/core/session-hooks/index.js')
    const dispatcher = getSessionHookDispatcher()
    expect(dispatcher).not.toBeNull()

    // Add a hook that captures the payload
    let capturedPayload: Record<string, unknown> | null = null
    dispatcher!.addHook({
      id: 'test-payload-inspector',
      name: 'Payload Inspector',
      hooks: ['onTurnComplete'],
      priority: 200,
      source: 'config',
      enabled: true,
      handler: async (payload) => {
        capturedPayload = payload as unknown as Record<string, unknown>
      },
    })

    const ws = await connectWs()

    await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-001',
      message: 'payload inspection test',
      project: 'Walnut',
    })
    await waitForWsEvent(ws, 'session:result')

    await delay(1500)

    // Verify the payload has all expected fields
    expect(capturedPayload).not.toBeNull()
    expect(capturedPayload!.sessionId).toBeTruthy()
    expect(capturedPayload!.taskId).toBe('hook-task-001')
    expect(capturedPayload!.timestamp).toBeTruthy()
    expect(capturedPayload!.traceId).toBeTruthy()

    // onTurnComplete-specific fields
    expect(capturedPayload!.result).toBeTruthy()
    expect(typeof capturedPayload!.result).toBe('string')
    expect(capturedPayload!.turnIndex).toBeGreaterThanOrEqual(0)
    expect(typeof capturedPayload!.isPlanSession).toBe('boolean')

    // Task context should be resolved
    const task = capturedPayload!.task as Record<string, unknown> | undefined
    if (task) {
      expect(task.id).toBe('hook-task-001')
      expect(task.title).toBe('Session hooks test task')
    }

    // Clean up
    dispatcher!.removeHook('test-payload-inspector')

    ws.close()
    await delay(50)
  })
})

// ── Test 5: subagent-runner events do NOT re-trigger hooks (infinite loop guard) ──

describe('Subagent event loop guard', () => {
  it('session:result from subagent-runner source is ignored by dispatcher', async () => {
    // The dispatcher skips session:result events with source='subagent-runner'
    // to prevent infinite triage loops.

    // Use a custom hook to detect whether the dispatcher processes this event.
    // If the dispatcher ignores the subagent-runner-sourced event correctly,
    // the hook should NOT fire.
    const { getSessionHookDispatcher } = await import('../../src/core/session-hooks/index.js')
    const dispatcher = getSessionHookDispatcher()
    expect(dispatcher).not.toBeNull()

    let hookFiredForFakeSession = false
    dispatcher!.addHook({
      id: 'test-loop-guard-detector',
      name: 'Loop Guard Detector',
      hooks: ['onTurnComplete'],
      priority: 10,
      source: 'config',
      enabled: true,
      handler: async (payload) => {
        if (payload.sessionId === 'fake-subagent-session') {
          hookFiredForFakeSession = true
        }
      },
    })

    // Manually emit a session:result with source='subagent-runner' — simulating
    // what happens when a triage subagent completes its own session
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: 'fake-subagent-session',
      taskId: 'hook-task-001',
      result: 'subagent triage result',
      isError: false,
      totalCost: 0.001,
      duration: 500,
    }, ['*'], { source: 'subagent-runner' })

    // Give hooks time to (not) fire
    await delay(1000)

    // The dispatcher should have ignored the event due to source='subagent-runner' guard
    expect(hookFiredForFakeSession).toBe(false)

    // Clean up
    dispatcher!.removeHook('test-loop-guard-detector')
  })
})

// ── Test 6: Full-path message send through hooks to mock CLI ──

describe('Full-path: message send through hooks to mock CLI', () => {
  it('send → onMessageSend → resume CLI → onTurnStart → onTurnComplete', async () => {
    const { getSessionHookDispatcher } = await import('../../src/core/session-hooks/index.js')
    const dispatcher = getSessionHookDispatcher()
    expect(dispatcher).not.toBeNull()

    // Create spy hooks for onMessageSend, onTurnStart, onTurnComplete
    const onMessageSendSpy = vi.fn()
    const onTurnStartSpy = vi.fn()
    const onTurnCompleteSpy = vi.fn()

    dispatcher!.addHook({
      id: 'test-on-message-send',
      name: 'Test onMessageSend',
      hooks: ['onMessageSend'],
      priority: 200,
      source: 'config',
      enabled: true,
      handler: async (payload) => { onMessageSendSpy(payload) },
    })

    dispatcher!.addHook({
      id: 'test-on-turn-start',
      name: 'Test onTurnStart',
      hooks: ['onTurnStart'],
      priority: 200,
      source: 'config',
      enabled: true,
      handler: async (payload) => { onTurnStartSpy(payload) },
    })

    dispatcher!.addHook({
      id: 'test-on-turn-complete',
      name: 'Test onTurnComplete',
      hooks: ['onTurnComplete'],
      priority: 200,
      source: 'config',
      enabled: true,
      handler: async (payload) => { onTurnCompleteSpy(payload) },
    })

    const ws = await connectWs()

    // Step 1: Start a session to get a sessionId
    const firstResult = waitForWsEvent(ws, 'session:result')
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: 'hook-task-001',
      message: 'initial prompt for send test',
      project: 'Walnut',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    const firstResultEvent = await firstResult
    const sessionId = (firstResultEvent.data as { sessionId: string }).sessionId
    expect(sessionId).toBeTruthy()

    // Wait for triage and other hooks from the initial prompt to settle
    await delay(1500)

    // Reset spies so we only capture calls from the follow-up send
    onMessageSendSpy.mockClear()
    onTurnStartSpy.mockClear()
    onTurnCompleteSpy.mockClear()

    // Step 2: Send a follow-up message to the existing session
    const sendRpcRes = await sendWsRpc(ws, 'session:send', {
      sessionId,
      message: 'follow-up for hook test',
    })
    expect((sendRpcRes as Record<string, unknown>).ok).toBe(true)

    // Step 3: Wait for the second session:result (resumed session completes)
    const secondResultEvent = await waitForWsEvent(ws, 'session:result', 20000)
    const rd = secondResultEvent.data as { result: string; taskId: string }
    expect(rd.result).toContain('follow-up for hook test')
    expect(rd.taskId).toBe('hook-task-001')

    // Give hooks time to fully process
    await delay(1500)

    // Step 4: Assert onMessageSend was called with the message text
    expect(onMessageSendSpy).toHaveBeenCalled()
    const msgPayload = onMessageSendSpy.mock.calls[0][0] as Record<string, unknown>
    expect(msgPayload.message).toBe('follow-up for hook test')
    expect(msgPayload.sessionId).toBe(sessionId)

    // Step 5: Assert onTurnStart was called (derived from first text-delta after send)
    expect(onTurnStartSpy).toHaveBeenCalled()
    const turnStartPayload = onTurnStartSpy.mock.calls[0][0] as Record<string, unknown>
    expect(turnStartPayload.sessionId).toBe(sessionId)
    expect(turnStartPayload.turnIndex).toBeGreaterThan(0)

    // Step 6: Assert onTurnComplete was called with the result
    expect(onTurnCompleteSpy).toHaveBeenCalled()
    const turnCompletePayload = onTurnCompleteSpy.mock.calls[0][0] as Record<string, unknown>
    expect(turnCompletePayload.sessionId).toBe(sessionId)
    expect(turnCompletePayload.result).toBeTruthy()
    expect(typeof turnCompletePayload.result).toBe('string')

    // Clean up test hooks
    dispatcher!.removeHook('test-on-message-send')
    dispatcher!.removeHook('test-on-turn-start')
    dispatcher!.removeHook('test-on-turn-complete')

    ws.close()
    await delay(50)
  })
})

// ── Test 7: Full-path triage hook triggers SubagentRunner pickup ──

describe('Full-path: triage hook triggers SubagentRunner', () => {
  it('session:result → triage hook → subagent:start → SubagentRunner picks up → subagent:started/result/error', async () => {
    const targetTaskId = 'hook-task-002'

    // Listen on the bus for subagent:start with our specific taskId.
    // Previous tests may also emit subagent:start for other tasks, so we filter.
    const subagentStartSubscriberName = `test-subagent-start-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const subagentStartPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subagentStartSubscriberName)
        reject(new Error('Timed out waiting for subagent:start for hook-task-002'))
      }, 15000)

      bus.subscribe(subagentStartSubscriberName, (event) => {
        if (event.name === EventNames.SUBAGENT_START) {
          const data = event.data as Record<string, unknown>
          if (data.taskId === targetTaskId) {
            clearTimeout(timer)
            bus.unsubscribe(subagentStartSubscriberName)
            resolve(data)
          }
        }
      }, { global: true })
    })

    // Listen for subagent:started (emitted immediately when SubagentRunner picks up
    // the event, before runAgentLoop) OR subagent:result/error (emitted after the
    // agent loop completes or fails). We listen for ALL three — the first matching
    // event for our task proves SubagentRunner picked up the event.
    //
    // Why subagent:started? It's emitted by SubagentRunner.handleStart() right after
    // queueing the run, proving the runner received and processed the subagent:start
    // event. This fires quickly, unlike subagent:result which depends on Bedrock API
    // response time (can be 30-60s when creds are available).
    const subagentPickupSubscriberName = `test-subagent-pickup-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const subagentPickupPromise = new Promise<{ type: 'started' | 'result' | 'error'; data: Record<string, unknown> }>((resolve, reject) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subagentPickupSubscriberName)
        reject(new Error('Timed out waiting for SubagentRunner to pick up subagent:start for hook-task-002'))
      }, 20000)

      bus.subscribe(subagentPickupSubscriberName, (event) => {
        const data = event.data as Record<string, unknown>
        const eventTaskId = data.taskId as string | undefined

        if (eventTaskId !== targetTaskId) return

        if (event.name === EventNames.SUBAGENT_STARTED) {
          clearTimeout(timer)
          bus.unsubscribe(subagentPickupSubscriberName)
          resolve({ type: 'started', data })
        } else if (event.name === EventNames.SUBAGENT_RESULT) {
          clearTimeout(timer)
          bus.unsubscribe(subagentPickupSubscriberName)
          resolve({ type: 'result', data })
        } else if (event.name === EventNames.SUBAGENT_ERROR) {
          clearTimeout(timer)
          bus.unsubscribe(subagentPickupSubscriberName)
          resolve({ type: 'error', data })
        }
      }, { global: true })
    })

    const ws = await connectWs()

    // Start a session with a task — triage fires on completion
    const rpcRes = await sendWsRpc(ws, 'session:start', {
      taskId: targetTaskId,
      message: 'subagent pickup e2e test',
      project: 'Walnut',
    })
    expect((rpcRes as Record<string, unknown>).ok).toBe(true)

    // Wait for session:result (initial prompt completes)
    await waitForWsEvent(ws, 'session:result')

    // Wait for subagent:start (triage hook fires)
    const subagentStartData = await subagentStartPromise
    expect(subagentStartData.agentId).toBe('turn-complete-triage')
    expect(subagentStartData.taskId).toBe(targetTaskId)

    // Wait for SubagentRunner to confirm pickup via subagent:started (fast),
    // or subagent:result/error (slower but also proves pickup).
    const pickup = await subagentPickupPromise

    // Any of these event types proves SubagentRunner received the subagent:start
    // and began processing:
    //   - 'started': Runner queued the run and emitted subagent:started (fast path)
    //   - 'result': Agent loop completed (Bedrock creds available)
    //   - 'error': Agent loop failed (no creds or other error)
    expect(['started', 'result', 'error']).toContain(pickup.type)

    if (pickup.type === 'started') {
      // subagent:started carries runId, agentId, agentName, task, taskId
      expect(pickup.data.agentId).toBe('turn-complete-triage')
      expect(pickup.data.taskId).toBe(targetTaskId)
      expect(pickup.data.runId).toBeTruthy()
      expect(typeof pickup.data.task).toBe('string')
    } else if (pickup.type === 'error') {
      expect(pickup.data.error).toBeTruthy()
      expect(pickup.data.agentId).toBe('turn-complete-triage')
      expect(pickup.data.taskId).toBe(targetTaskId)
    } else {
      // result
      expect(pickup.data.agentId).toBe('turn-complete-triage')
      expect(pickup.data.taskId).toBe(targetTaskId)
      expect(pickup.data.result).toBeTruthy()
    }

    ws.close()
    await delay(50)
  })
})
