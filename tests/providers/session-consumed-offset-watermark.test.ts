/**
 * P3 consumed-offset watermark — positional replay arbitration replacing the
 * resultEmitted boolean as the authoritative replay guard.
 *
 * The incident-C failure (10e7df54) this makes structurally impossible:
 *   1. phase-drift reconciler GUESSES the task phase during a disconnect
 *   2. attachToExisting seeds resultEmitted=true from that lying proxy
 *   3. daemon replays the turn — the REAL, never-processed result hits
 *      `if (resultEmitted)` and is swallowed forever → task wedged IN_PROGRESS
 *
 * With the watermark: every daemon event carries `v` (byte offset in the
 * append-only stream file). The server persists the position of the last
 * result it PROCESSED. Replay-vs-new becomes a comparison, not a boolean:
 *   v ≤ consumedOffset → replay, suppress (even if booleans were lost)
 *   v > consumedOffset → NEVER processed — process it, even if resultEmitted
 *                        was (wrongly) seeded true.
 *
 * Also covered: replayed idle at/below watermark can't complete a turn;
 * watermark monotonicity + sentinel rejection in the session tracker.
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

function makeResultEvent(sessionId: string, cost = 0.003, text = 'Done'): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 1500, num_turns: 1, result: text,
    session_id: sessionId, total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}
function makeStateEvent(sessionId: string, state: 'running' | 'idle'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sessionId, state })
}

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
}

function createMockTransport(overrides: Partial<MockTransport> = {}): MockTransport {
  return {
    isRemote: true, hasPipe: true, processName: 'claude', pid: null,
    outputFile: null, host: null, fileSize: 0,
    imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    ...overrides,
  }
}

interface SessionInternals {
  _transport: unknown
  _active: boolean
  _processStatus: string
  _consumedOffset: number
  _turnResultEmitted: boolean
  resultEmitted: boolean
  claudeSessionId: string | null
  handleStreamLine(line: string, v?: number): void
}

function makeSession(taskId: string, sid: string): SessionInternals {
  const session = new ClaudeCodeSession(taskId, 'test-project') as unknown as SessionInternals
  session._transport = createMockTransport()
  session._active = true
  session._processStatus = 'running'
  session.claudeSessionId = sid
  return session
}

function collectResults(): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = []
  bus.subscribe('main-ai', (e: BusEvent) => {
    if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
  })
  return results
}

beforeEach(async () => {
  bus.clear()
  await fsp.rm(tmpBase, { recursive: true, force: true })
  await fsp.mkdir(tmpBase, { recursive: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await new Promise(r => setTimeout(r, 100))
  await fsp.rm(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('consumed-offset watermark — positional replay arbitration', () => {
  it('suppresses a result at/below the watermark even with all booleans fresh', () => {
    const sid = 'wm-suppress'
    const session = makeSession('task-wm-1', sid)
    session._consumedOffset = 5000 // persisted watermark from a prior incarnation

    const results = collectResults()
    session.handleStreamLine(makeResultEvent(sid), 4000) // replay: v < watermark
    expect(results.length).toBe(0)
    expect(session._turnResultEmitted).toBe(true) // trailing idles won't re-complete
  })

  it('INCIDENT C: processes a result ABOVE the watermark even when resultEmitted was wrongly true', () => {
    const sid = 'wm-incident-c'
    const session = makeSession('task-wm-2', sid)
    session._consumedOffset = 5000
    session.resultEmitted = true // the lying proxy seed (phase-drift guess)

    const results = collectResults()
    session.handleStreamLine(makeResultEvent(sid, 0.01, 'the real turn-3 answer'), 6_799_186)
    // Positional evidence beats the boolean: the result must go through.
    expect(results.length).toBe(1)
    expect(results[0].result).toBe('the real turn-3 answer')
    // Watermark advanced to the processed result's position.
    expect(session._consumedOffset).toBe(6_799_186)
  })

  it('pre-watermark behavior preserved: resultEmitted suppresses when no v is available (old daemon)', () => {
    const sid = 'wm-no-v'
    const session = makeSession('task-wm-3', sid)
    session.resultEmitted = true

    const results = collectResults()
    session.handleStreamLine(makeResultEvent(sid)) // no v — boolean rules
    expect(results.length).toBe(0)
  })

  it('advances the watermark on normal turn completion and suppresses that turn\'s replay', () => {
    const sid = 'wm-advance'
    const session = makeSession('task-wm-4', sid)

    const results = collectResults()
    session.handleStreamLine(makeResultEvent(sid), 1000)
    expect(results.length).toBe(1)
    expect(session._consumedOffset).toBe(1000)

    // Daemon replays the same line (e.g. reattach catch-up) — positionally dead.
    session._turnResultEmitted = false // simulate the init-reset that lets replays through
    session.handleStreamLine(makeResultEvent(sid), 1000)
    expect(results.length).toBe(1)
  })

  it('replayed idle at/below the watermark cannot complete the current turn', () => {
    const sid = 'wm-idle-replay'
    const session = makeSession('task-wm-5', sid)
    session._consumedOffset = 5000
    session._processStatus = 'running' // a NEW turn is running right now

    const statusEvents: string[] = []
    bus.subscribe('main-ai', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_STATUS_CHANGED) {
        statusEvents.push((e.data as { phase?: string }).phase ?? '')
      }
    })
    session.handleStreamLine(makeStateEvent(sid, 'idle'), 4500) // replayed idle
    expect(statusEvents).not.toContain('AGENT_COMPLETE')
    expect(session._processStatus).toBe('running') // untouched — replay describes the past
  })

  it('a live idle above the watermark still completes a withheld turn and advances the watermark', () => {
    const sid = 'wm-idle-live'
    const session = makeSession('task-wm-6', sid)
    session._consumedOffset = 1000

    const results = collectResults()
    // Withheld-turn shape: no result processed yet, live idle arrives above watermark.
    session.handleStreamLine(makeStateEvent(sid, 'idle'), 2000)
    expect(results.length).toBe(1) // _completeTurnOnIdle fired
    expect(session._consumedOffset).toBe(2000)
  })
})

describe('consumedOffset persistence arbitration (session tracker)', () => {
  it('is monotonic: a lower write loses silently, a higher write wins', async () => {
    const { createSessionRecord, updateSessionRecord, getSessionByClaudeId } =
      await import('../../src/core/session-tracker.js')
    const sid = 'wm-monotonic'
    await createSessionRecord(sid, '', 'proj', '/tmp')

    await updateSessionRecord(sid, { consumedOffset: 5000 })
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(5000)

    // Stale writer with an older position — must lose.
    await updateSessionRecord(sid, { consumedOffset: 3000 })
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(5000)

    await updateSessionRecord(sid, { consumedOffset: 8000 })
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(8000)
  })

  it('rejects the MAX_SAFE_INTEGER sentinel and garbage values', async () => {
    const { createSessionRecord, updateSessionRecord, getSessionByClaudeId } =
      await import('../../src/core/session-tracker.js')
    const sid = 'wm-sentinel'
    await createSessionRecord(sid, '', 'proj', '/tmp')
    await updateSessionRecord(sid, { consumedOffset: 100 })

    await updateSessionRecord(sid, { consumedOffset: Number.MAX_SAFE_INTEGER })
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(100)

    await updateSessionRecord(sid, { consumedOffset: -5 })
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(100)

    await updateSessionRecord(sid, { consumedOffset: 3.7 })
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(100)
  })

  it('a rejected consumedOffset does not block other fields in the same update', async () => {
    const { createSessionRecord, updateSessionRecord, getSessionByClaudeId } =
      await import('../../src/core/session-tracker.js')
    const sid = 'wm-mixed'
    await createSessionRecord(sid, '', 'proj', '/tmp')
    await updateSessionRecord(sid, { consumedOffset: 100 })

    await updateSessionRecord(sid, { consumedOffset: 50, activity: 'still here' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.consumedOffset).toBe(100)     // stale position rejected
    expect(after?.activity).toBe('still here')  // sibling field applied
  })
})
