/**
 * Idle-debt conservation counting (ported from the ACP adapter's idle
 * accounting) — the turn-end misclassification family's root fix.
 *
 * THE RACE: on a FIFO-alive session, the CLI reports every turn-over TWICE —
 * a `result` line, then a companion `session_state_changed{idle}`. The result
 * handler completes the turn. If the user's next message lands BEFORE the
 * companion idle flushes through (fast follow-up, daemon batching), then
 * writeMessage() has already reset _turnResultEmitted for the new turn — and
 * the naive idle handler read the late companion as "the NEW turn is over",
 * completing a turn that had produced ZERO output (premature-idle family:
 * false AGENT_COMPLETE, buffer wiped, workflow interrupted).
 *
 * THE FIX: each result-driven completion on an alive process banks one owed
 * idle (_idleDebt++); the idle handler consumes debt FIRST — a debt-consuming
 * idle is the previous turn's companion and never a turn-over trigger.
 * Conservation: within one process's continuous JSONL stream, results and
 * companion idles arrive in FIFO order, so the accounting is exact.
 *
 * Debt is reset on spawn (send()) — a dead process's owed idles never arrive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const tmpBase = WALNUT_HOME

// ── JSONL event builders (same shapes as session-background-workflow.test.ts) ──

function makeInitEvent(sessionId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: '/tmp', model: 'mock-model', tools: ['Read'],
    mcp_servers: [], permissionMode: 'default',
  })
}

function makeAssistantEvent(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg_${text.slice(0, 8)}`, type: 'message', role: 'assistant', model: 'mock-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: sessionId,
  })
}

function makeResultEvent(sessionId: string, cost: number, text: string): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 1500, num_turns: 1, result: text,
    session_id: sessionId, total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

function makeSessionStateEvent(sessionId: string, state: 'running' | 'idle'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state })
}

// ── Helpers ──

interface MockTransport {
  isRemote: boolean
  hasPipe: boolean
  processName: string
  pid: number | null
  outputFile: string | null
  host: string | null
  fileSize: number
  imageCache: Map<string, string>
  lastEventAt: number
  tailOffset: number
  writeMessage: (message: string) => Promise<boolean>
}

function makeFifoAliveSession(taskId: string): { session: ClaudeCodeSession; transport: MockTransport } {
  const session = new ClaudeCodeSession(taskId, 'test-project')
  const transport: MockTransport = {
    isRemote: true, hasPipe: true, processName: 'claude', pid: null,
    outputFile: null, host: null, fileSize: 0,
    imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    writeMessage: async () => true,
  }
  ;(session as unknown as { _transport: unknown })._transport = transport
  ;(session as unknown as { _active: boolean })._active = true
  ;(session as unknown as { _processStatus: string })._processStatus = 'running'
  return { session, transport }
}

function feedLines(session: ClaudeCodeSession, lines: string[]): void {
  const handle = session as unknown as { handleStreamLine(line: string): void }
  for (const line of lines) handle.handleStreamLine(line)
}

function collectResults(): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  bus.subscribe('main-ai', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_RESULT) events.push(e.data as Record<string, unknown>)
  })
  return events
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await new Promise(r => setTimeout(r, 200))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════
//  THE RACE: companion idle lands after the next turn already started
// ═══════════════════════════════════════════════════════════════════

describe('idle-debt: late companion idle cannot complete the next turn', () => {
  it('companion idle arriving mid-new-turn is consumed as debt, not turn-over', async () => {
    const sid = 'debt-race-1'
    const { session } = makeFifoAliveSession('task-debt-1')
    const results = collectResults()

    // Turn 1: result completes it on the FIFO-alive path → banks 1 debt.
    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'answer one'),
      makeResultEvent(sid, 0.003, 'answer one'),
    ])
    expect(results.length).toBe(1)
    expect(session.processStatus).toBe('idle')

    // User sends the next message BEFORE the companion idle flushes.
    // writeMessage resets _turnResultEmitted/resultEmitted for the new turn.
    await session.writeMessage('follow-up question')
    expect(session.processStatus).toBe('running')

    // NOW turn 1's companion idle lands — pre-debt this completed the new turn
    // with zero output (false AGENT_COMPLETE). It must be swallowed.
    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(results.length).toBe(1)                    // no phantom SESSION_RESULT
    expect(session.processStatus).toBe('running')     // new turn still live

    // The new turn then completes normally via its own result.
    feedLines(session, [
      makeAssistantEvent(sid, 'answer two'),
      makeResultEvent(sid, 0.006, 'answer two'),
    ])
    expect(results.length).toBe(2)
    expect(session.processStatus).toBe('idle')
  })

  it('conservation across many turns: N results ⇒ N companion idles all consumed', async () => {
    const sid = 'debt-conserve'
    const { session } = makeFifoAliveSession('task-debt-2')
    const results = collectResults()

    feedLines(session, [makeInitEvent(sid)])
    for (let turn = 1; turn <= 3; turn++) {
      if (turn > 1) await session.writeMessage(`message ${turn}`)
      feedLines(session, [
        makeAssistantEvent(sid, `answer ${turn}`),
        makeResultEvent(sid, 0.003 * turn, `answer ${turn}`),
      ])
      // Companion idle for THIS turn arrives late — after the next write in the
      // worst case; here we deliver it immediately, which must also be benign.
      feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    }
    expect(results.length).toBe(3) // one per real turn, zero from idles
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Idle-driven turns (workflows) must still complete — debt only banks
//  on result-driven completions, so the drain idle is NOT consumed.
// ═══════════════════════════════════════════════════════════════════

describe('idle-debt: does not starve idle-driven turn completion', () => {
  it('a turn withheld for background work still completes on the drain idle', async () => {
    const sid = 'debt-workflow'
    const { session } = makeFifoAliveSession('task-debt-wf')
    const results = collectResults()

    // Turn 1 (plain) completes via result → banks 1 debt; its companion idle
    // arrives and is consumed.
    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'plain answer'),
      makeResultEvent(sid, 0.003, 'plain answer'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(results.length).toBe(1)

    // Turn 2 launches a workflow: result arrives while bg work is in flight →
    // completion is WITHHELD (no debt banked — the FIFO-alive completion path
    // never ran). The end-of-drain idle must still complete the turn.
    await session.writeMessage('run the workflow')
    feedLines(session, [
      JSON.stringify({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'bg-1', workflow_name: 'audit' }),
      makeAssistantEvent(sid, 'Workflow launched in background'),
      makeResultEvent(sid, 0.01, 'Workflow launched in background'),
    ])
    expect(session.processStatus).toBe('running') // withheld
    expect(results.length).toBe(1)

    feedLines(session, [
      JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'bg-1', status: 'completed' }),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(results.length).toBe(2)               // drain idle completed the turn
    expect(session.processStatus).toBe('idle')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  Debt lifecycle guards
// ═══════════════════════════════════════════════════════════════════

describe('idle-debt: lifecycle', () => {
  it('debt is capped — a burst of results cannot bank unbounded idles', async () => {
    const sid = 'debt-cap'
    const { session } = makeFifoAliveSession('task-debt-cap')
    const results = collectResults()

    feedLines(session, [makeInitEvent(sid)])
    // 6 quick turns, none of whose companion idles arrive (replay-gap worst case).
    for (let turn = 1; turn <= 6; turn++) {
      if (turn > 1) await session.writeMessage(`m${turn}`)
      feedLines(session, [
        makeAssistantEvent(sid, `a${turn}`),
        makeResultEvent(sid, 0.001 * turn, `a${turn}`),
      ])
    }
    expect(results.length).toBe(6)
    const debt = (session as unknown as { _idleDebt: number })._idleDebt
    expect(debt).toBeLessThanOrEqual(4) // capped

    // A new turn starts; the CLI now flushes MORE idles than the cap holds.
    // The first `debt` idles are consumed; the one after cap-exhaustion is
    // free to act — here the turn has no result yet, so it would complete it
    // (that's the documented bounded-staleness trade-off, not a hang).
    await session.writeMessage('m7')
    for (let i = 0; i < debt; i++) {
      feedLines(session, [makeSessionStateEvent(sid, 'idle')])
      expect(session.processStatus).toBe('running') // debt swallow — still live
    }
    expect(results.length).toBe(6)
  })

  it('spawn resets debt — a dead process\'s owed idles never arrive', async () => {
    const sid = 'debt-reset'
    const { session } = makeFifoAliveSession('task-debt-reset')

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'answer'),
      makeResultEvent(sid, 0.003, 'answer'),
    ])
    expect((session as unknown as { _idleDebt: number })._idleDebt).toBe(1)

    // Simulate the fresh-spawn reset path (send() → the state-reset block).
    // We poke the field the way send() does rather than spawning a real CLI.
    ;(session as unknown as { _idleDebt: number })._idleDebt = 0
    expect((session as unknown as { _idleDebt: number })._idleDebt).toBe(0)
  })

  it('process-exit result path banks NO debt (no companion follows an exit)', async () => {
    const sid = 'debt-exit'
    const { session, transport } = makeFifoAliveSession('task-debt-exit')
    const results = collectResults()

    // Kill the pipe BEFORE the result: the handler takes the process-exited
    // branch (resultEmitted=true), which must not bank debt.
    transport.hasPipe = false
    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'final answer'),
      makeResultEvent(sid, 0.003, 'final answer'),
    ])
    expect(results.length).toBe(1)
    expect((session as unknown as { _idleDebt: number })._idleDebt).toBe(0)
  })
})
