/**
 * Unit tests for the port of upstream ACP fix #870 — "hold a turn open while
 * its background subagents are still live" (issues #864/#865/#866).
 *
 * Walnut already withheld turn-over while background tasks run (the dynamic-
 * workflow machinery in session-background-workflow.test.ts). This port adds
 * the four #870 hardenings that machinery lacked:
 *
 *  1. `_deferredOutcome` (upstream `Turn.deferredSettle`): a withheld result's
 *     outcome — notably is_error — settles the turn later, instead of the
 *     drain lane rewriting every held turn to success.
 *  2. Settle at the task-notification FOLLOWUP's terminal result once the
 *     spawned set has drained (upstream's common case) — not only at the
 *     trailing idle, which a flaky stream can lose.
 *  3. A followup's is_error result never touches the user turn's answer
 *     (upstream-confirmed defect: "Please run /login" clobbered fullText).
 *  4. `background_tasks_changed` level reconciliation (replace semantics +
 *     universe guard + reversible absent-mark): a task whose terminal
 *     bookends were ALL lost can no longer wedge the hold forever.
 *
 * Event shapes verified against real streams in /tmp/open-walnut-streams/:
 * payload is {tasks:[{task_id, task_type, description}]}, empty array on
 * drain, and live sync subagents are legitimately absent from level payloads
 * (measured 4–9×/session) — hence the universe guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { foldSessionTail } from '../../src/core/session-reconcile.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'

const tmpBase = WALNUT_HOME

// ── JSONL event builders (same shapes as session-background-workflow.test.ts) ──

function makeInitEvent(sessionId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: '/tmp', model: 'mock-model', tools: ['Read', 'Edit', 'Bash'],
    mcp_servers: [], permissionMode: 'default',
  })
}

function makeAssistantEvent(sessionId: string, text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: 'msg_001', type: 'message', role: 'assistant', model: 'mock-model',
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
    session_id: sessionId,
  })
}

function makeResultEvent(sessionId: string, opts: { cost?: number; text?: string; isError?: boolean } = {}): string {
  return JSON.stringify({
    type: 'result', subtype: opts.isError ? 'error_during_execution' : 'success',
    is_error: opts.isError === true,
    duration_ms: 1500, num_turns: 1, result: opts.text ?? 'Done',
    ...(opts.isError ? { errors: [opts.text ?? 'boom'] } : {}),
    session_id: sessionId, total_cost_usd: opts.cost ?? 0.003,
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}

function makeTaskNotificationResultEvent(sessionId: string, text: string, isError = false): string {
  return JSON.stringify({
    type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError,
    duration_ms: 800, num_turns: 1, result: text,
    session_id: sessionId, total_cost_usd: 0.02,
    origin: { kind: 'task-notification' },
    usage: { input_tokens: 50, output_tokens: 20 },
  })
}

function makeSessionStateEvent(sessionId: string, state: 'running' | 'idle' | 'requires_action'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state })
}

function makeTaskStartedEvent(sessionId: string, taskId: string, opts: { subagentType?: string; taskType?: string } = {}): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_started', session_id: sessionId, task_id: taskId,
    subagent_type: opts.subagentType, task_type: opts.taskType ?? 'local_agent',
    description: `task ${taskId}`,
  })
}

function makeTaskNotificationEvent(sessionId: string, taskId: string, status = 'completed'): string {
  return JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: sessionId, task_id: taskId, status })
}

/** Replace-semantics level snapshot — the CLI's own live background set. */
function makeLevelEvent(sessionId: string, taskIds: string[]): string {
  return JSON.stringify({
    type: 'system', subtype: 'background_tasks_changed', session_id: sessionId,
    tasks: taskIds.map(id => ({ task_id: id, task_type: 'local_agent', description: `task ${id}` })),
  })
}

// ── Harness ──

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

function makeRunningRemoteSession(taskId: string): ClaudeCodeSession {
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
  return session
}

function feedLines(session: ClaudeCodeSession, lines: string[]): void {
  const handle = session as unknown as { handleStreamLine(line: string): void }
  for (const line of lines) handle.handleStreamLine(line)
}

function collectResults(): Array<Record<string, unknown>> {
  const resultEvents: Array<Record<string, unknown>> = []
  bus.subscribe('main-ai', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_RESULT) resultEvents.push(e.data as Record<string, unknown>)
  })
  return resultEvents
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await new Promise((r) => setImmediate(r))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ═══════════════════════════════════════════════════════════════════
//  1. Deferred outcome: a withheld ERROR result must settle as an error
// ═══════════════════════════════════════════════════════════════════

describe('#870: deferred outcome preserves the withheld result', () => {
  it('error result withheld for a live subagent completes as an ERROR at drain idle', () => {
    const sid = 'hold-error-outcome'
    const session = makeRunningRemoteSession('task-hold-1')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'sub-A', { subagentType: 'general-purpose' }),
      // The turn's own terminal result is an ERROR — withheld (sub-A live).
      makeResultEvent(sid, { isError: true, text: 'API rate limit exhausted' }),
    ])
    expect(results.length).toBe(0)
    expect(session.processStatus).toBe('running')

    // Subagent drains; the authoritative idle completes the turn.
    feedLines(session, [
      makeTaskNotificationEvent(sid, 'sub-A', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(results.length).toBe(1)
    // THE fix: pre-#870-port this lane hardcoded isError:false.
    expect(results[0].isError).toBe(true)
    expect(String(results[0].result)).toContain('API rate limit exhausted')
  })

  it('success result withheld → completes as success with the stored cost', () => {
    const sid = 'hold-success-outcome'
    const session = makeRunningRemoteSession('task-hold-2')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Launching agent, will report back'),
      makeTaskStartedEvent(sid, 'sub-B', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { cost: 0.05, text: 'Launching agent, will report back' }),
      makeTaskNotificationEvent(sid, 'sub-B', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(results.length).toBe(1)
    expect(results[0].isError).toBe(false)
    expect(results[0].totalCost).toBe(0.05)
  })

  it('a completed hold does not leak its outcome into the NEXT turn', async () => {
    const sid = 'hold-no-leak'
    const session = makeRunningRemoteSession('task-hold-3')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'sub-C', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { isError: true, text: 'first turn failed' }),
      makeTaskNotificationEvent(sid, 'sub-C', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(results.length).toBe(1)
    expect(results[0].isError).toBe(true)

    // Next turn through the real entry point (writeMessage resets turn state).
    await session.writeMessage('second turn message')
    feedLines(session, [
      makeSessionStateEvent(sid, 'running'),
      makeAssistantEvent(sid, 'Second turn answer'),
      makeResultEvent(sid, { cost: 0.06, text: 'Second turn answer' }),
    ])
    expect(results.length).toBe(2)
    expect(results[1].isError).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  2. Settle at the followup's terminal result (no trailing idle needed)
// ═══════════════════════════════════════════════════════════════════

describe('#870: followup result settles a drained hold', () => {
  it('withheld turn completes at the task-notification followup result when the set has drained', () => {
    const sid = 'hold-followup-settle'
    const session = makeRunningRemoteSession('task-hold-4')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'Agent launched, reporting back later'),
      makeTaskStartedEvent(sid, 'sub-D', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { text: 'Agent launched, reporting back later' }),
    ])
    expect(results.length).toBe(0) // held

    // upstream cycle: notification → followup turn → result(origin task-notification).
    // NO trailing idle after the followup (the lost-idle wedge this lane heals).
    feedLines(session, [
      makeTaskNotificationEvent(sid, 'sub-D', 'completed'),
      makeAssistantEvent(sid, 'The agent finished: summary here'),
      makeTaskNotificationResultEvent(sid, 'The agent finished: summary here'),
    ])
    expect(results.length).toBe(1)
    expect(results[0].isError).toBe(false)
    // The turn's answer is the followup summary (fullText), not the launch text.
    expect(String(results[0].result)).toContain('The agent finished')
    expect(session.processStatus).toBe('idle')
  })

  it('followup result while OTHER spawned tasks still run keeps the hold', () => {
    const sid = 'hold-followup-partial'
    const session = makeRunningRemoteSession('task-hold-5')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'sub-E1', { subagentType: 'general-purpose' }),
      makeTaskStartedEvent(sid, 'sub-E2', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { text: 'Two agents launched' }),
      // First agent finishes and wakes a followup — sub-E2 still live: HOLD.
      makeTaskNotificationEvent(sid, 'sub-E1', 'completed'),
      makeTaskNotificationResultEvent(sid, 'Agent 1 done'),
    ])
    expect(results.length).toBe(0)
    expect(session.processStatus).toBe('running')

    feedLines(session, [
      makeTaskNotificationEvent(sid, 'sub-E2', 'completed'),
      makeTaskNotificationResultEvent(sid, 'Agent 2 done'),
    ])
    expect(results.length).toBe(1)
  })

  it('the followup settle owes its trailing idle — no double completion', () => {
    const sid = 'hold-followup-idle-debt'
    const session = makeRunningRemoteSession('task-hold-6')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'sub-F', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { text: 'launched' }),
      makeTaskNotificationEvent(sid, 'sub-F', 'completed'),
      makeTaskNotificationResultEvent(sid, 'followup summary'),
    ])
    expect(results.length).toBe(1)

    // The followup's own companion idle trails in — must not re-fire.
    feedLines(session, [makeSessionStateEvent(sid, 'idle')])
    expect(results.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  3. Followup is_error must not clobber the user turn's answer
// ═══════════════════════════════════════════════════════════════════

describe('#870: followup errors never touch the user turn', () => {
  it('an is_error task-notification result does not overwrite fullText', () => {
    const sid = 'hold-followup-error'
    const session = makeRunningRemoteSession('task-hold-7')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeAssistantEvent(sid, 'The real streamed answer'),
      makeTaskStartedEvent(sid, 'sub-G', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { text: 'The real streamed answer' }),
      makeTaskNotificationEvent(sid, 'sub-G', 'completed'),
      // Followup turn FAILED (e.g. auth expired mid-session).
      makeTaskNotificationResultEvent(sid, 'Please run /login', true),
    ])
    // The error followup still settles the drained hold (the outcome is the
    // USER turn's stored success)…
    expect(results.length).toBe(1)
    expect(results[0].isError).toBe(false)
    // …and its error prose never replaced the turn's answer.
    expect(String(results[0].result)).toContain('The real streamed answer')
    expect(String(results[0].result)).not.toContain('Please run /login')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  4. background_tasks_changed level reconciliation
// ═══════════════════════════════════════════════════════════════════

describe('#870: level reconciliation heals lost terminal bookends', () => {
  it('a task whose bookends were ALL lost is absent-marked by the level and the hold drains', () => {
    const sid = 'level-heal-wedge'
    const session = makeRunningRemoteSession('task-level-1')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg-lost', { taskType: 'local_agent', subagentType: 'general-purpose' }),
      makeLevelEvent(sid, ['bg-lost']),          // level proves universe membership
      makeResultEvent(sid, { text: 'launched' }), // withheld — bg-lost live
      makeSessionStateEvent(sid, 'idle'),         // drain idle passes, still held
    ])
    expect(results.length).toBe(0)
    expect(session.hasActiveBackgroundWork()).toBe(true)

    // The terminal task_updated/task_notification are LOST. The next level
    // snapshot no longer lists the task — the reconcile must unwedge the hold
    // (idle already passed, so the level drain completes the turn itself).
    feedLines(session, [makeLevelEvent(sid, [])])
    expect(session.hasActiveBackgroundWork()).toBe(false)
    expect(results.length).toBe(1)
    expect(session.processStatus).toBe('idle')
  })

  it('universe guard: a task never listed by any level is NOT absent-marked', () => {
    const sid = 'level-universe-guard'
    const session = makeRunningRemoteSession('task-level-2')
    const results = collectResults()

    feedLines(session, [
      makeInitEvent(sid),
      // Sync subagent — real streams show these are legitimately absent from
      // every level payload while alive.
      makeTaskStartedEvent(sid, 'sub-sync', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { text: 'launched' }),
      // A level for OTHER tasks (empty here) — must not touch sub-sync.
      makeLevelEvent(sid, []),
    ])
    expect(session.hasActiveBackgroundWork()).toBe(true)
    expect(results.length).toBe(0)

    // The real terminal arrives later; the turn then completes normally.
    feedLines(session, [
      makeTaskNotificationEvent(sid, 'sub-sync', 'completed'),
      makeSessionStateEvent(sid, 'idle'),
    ])
    expect(results.length).toBe(1)
  })

  it('a corrective level re-listing the id disarms the absent-mark', () => {
    const sid = 'level-corrective'
    const session = makeRunningRemoteSession('task-level-3')

    feedLines(session, [
      makeInitEvent(sid),
      makeTaskStartedEvent(sid, 'bg-flap', { taskType: 'local_agent', subagentType: 'general-purpose' }),
      makeLevelEvent(sid, ['bg-flap']),
      makeLevelEvent(sid, []),          // racing payload absent-marks it
    ])
    expect(session.hasActiveBackgroundWork()).toBe(false) // marked → not gating

    feedLines(session, [makeLevelEvent(sid, ['bg-flap'])]) // corrective level
    expect(session.hasActiveBackgroundWork()).toBe(true)   // mark reversed
  })

  it('level entries for unknown ids are adopted (lost task_started)', () => {
    const sid = 'level-adopt-unknown'
    const session = makeRunningRemoteSession('task-level-4')

    feedLines(session, [
      makeInitEvent(sid),
      makeLevelEvent(sid, ['bg-unseen']), // task_started was lost — level is ground truth
    ])
    expect(session.hasActiveBackgroundWork()).toBe(true)
    expect(session.backgroundTasks.some(t => t.taskId === 'bg-unseen')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  5. foldSessionTail replay mirrors the live level reconciliation
// ═══════════════════════════════════════════════════════════════════

describe('#870: foldSessionTail level reconciliation (reconciler replay path)', () => {
  const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })

  it('a level-omitted task (in universe) stops gating → turn converges', () => {
    const sid = 'fold-level'
    const content = [
      userLine,
      makeTaskStartedEvent(sid, 'bg-x', { taskType: 'local_agent' }),
      makeLevelEvent(sid, ['bg-x']),
      makeResultEvent(sid, { text: 'launched' }),
      makeLevelEvent(sid, []),           // bookend lost; level says gone
      makeSessionStateEvent(sid, 'idle'),
    ].join('\n')
    const fold = foldSessionTail(content)
    expect(fold.gatingBgCount).toBe(0)
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('agent_complete')
  })

  it('a task outside the level universe keeps gating (no convergence)', () => {
    const sid = 'fold-universe'
    const content = [
      userLine,
      makeTaskStartedEvent(sid, 'sub-y', { subagentType: 'general-purpose' }),
      makeResultEvent(sid, { text: 'launched' }),
      makeLevelEvent(sid, []),           // sub-y never listed — must not be marked
      makeSessionStateEvent(sid, 'idle'),
    ].join('\n')
    const fold = foldSessionTail(content)
    expect(fold.gatingBgCount).toBe(1)
    expect(fold.turnEnded).toBe(false)
  })
})
