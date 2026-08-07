/**
 * INCIDENT ed347bde (2026-08-05) — "Idle + completed while the CLI is streaming".
 *
 * Shape (5th of the status-mismatch family, production timeline, UTC):
 *   18:27:21  user sends            → phase IN_PROGRESS, process_status running
 *   18:27:48  user sends AGAIN      → mid-turn stdin injection into the live turn
 *   18:27:50.492 previous turn's `result` → runner sets _processStatus='idle'
 *   18:27:50.620 CLI IMMEDIATELY starts the queued turn — visible ONLY as a system
 *                `init` line. It never went idle, so NO
 *                session_state_changed{running} was emitted and the existing
 *                turn-start pullback (wired to the state-running branch) never fired.
 *   18:27:51.297 the server's SESSION_RESULT handler (≈800ms enrichment latency)
 *                flips the phase → AGENT_COMPLETE.
 *   ⇒ badge Idle + task row completed/attention for ~44s while the CLI streamed.
 *      185 same-shape divergences were logged that day; the snapshot shadow layer
 *      logged {projected:'running', actual:'idle'} — the projection knew the truth.
 *
 * Two coordinated fixes on the legacy event path, both exercised here through the
 * REAL handleStreamLine:
 *   Part 1 — EVERY observed turn-start edge bumps _turnGen, writes
 *            process_status='running', and fires the session:turn-start phase
 *            pullback. Three edges feed it (all covered below):
 *              (a) writeMessage on an idle→running delivery — the QUEUED-SEND shape,
 *              (b) session_state_changed{running} — the CLI's explicit signal,
 *              (c) an `init` after this turn's result — the only signal when the CLI
 *                  picks up a queued send without ever going idle.
 *            (b) and (c) are replay-guarded.
 *   Part 2 — the late AGENT_COMPLETE flip is staleness-aware: applySessionPhase
 *            compares the event's turnGen against the LIVE instance's turnGen and
 *            skips a superseded result.
 *
 * ⚠️ The QUEUED-SEND shape is why (a) exists and why (c) alone was not enough. When
 * WALNUT queues the message (processNext → writeMessage) and delivers it the instant
 * turn A's result lands, writeMessage resets _turnResultEmitted BEFORE the CLI's init
 * for turn B arrives — so branch (c), which is gated on that flag, never fires. With
 * no bump anywhere, turn A's late flip carries eventGen == liveGen, passes the strict
 * `liveGen > eventGen` gate, and repaints turn B as completed while it streams.
 *
 * What's real: ClaudeCodeSession.handleStreamLine + writeMessage + the real
 * applySessionPhase over a real task store (isolated tmp WALNUT_HOME). What's mocked:
 * the transport (no process) and the session-runner registry lookup used by the gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-init-turnstart'))

// The stale-result gate resolves the LIVE session via the runner registry. Point it
// at whichever ClaudeCodeSession the test registered, so the gate reads the real
// (post-init) turnGen straight off the instance under test.
let liveSession: { turnGen: number } | undefined
let liveSid: string | null = null
vi.mock('../../src/providers/claude-code-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/claude-code-session.js')>()
  return {
    ...actual,
    sessionRunner: {
      ...actual.sessionRunner,
      findSessionByClaudeId: (sid: string) => (sid === liveSid ? liveSession : undefined),
    },
  }
})

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { applySessionPhase } from '../../src/core/phase.js'
import { addTask, updateTaskRaw, getTask } from '../../src/core/task-manager.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { closeDb } from '../../src/core/session-db.js'
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR, TASKS_FILE } from '../../src/constants.js'

// ── JSONL builders (exact production line shapes) ──
function initLine(sessionId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: sessionId,
    cwd: '/tmp', model: 'mock-model', tools: [], mcp_servers: [],
    permissionMode: 'default',
  })
}
function resultLine(sessionId: string, text = 'previous turn answer', cost = 0.003): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    duration_ms: 1500, num_turns: 1, result: text,
    session_id: sessionId, total_cost_usd: cost,
    usage: { input_tokens: 100, output_tokens: 50 },
  })
}
function stateLine(sessionId: string, state: 'running' | 'idle'): string {
  return JSON.stringify({
    type: 'system', subtype: 'session_state_changed', session_id: sessionId, state,
  })
}

function mockTransport() {
  return {
    isRemote: true, hasPipe: true, processName: 'claude', pid: null,
    outputFile: null, host: null, fileSize: 0,
    imageCache: new Map<string, string>(), lastEventAt: 0, tailOffset: 0,
    writeMessage: () => true, writeRaw: () => true,
    writeSyntheticUserEvent: () => {}, deletePipe: () => {},
    renameForSession: () => {}, kill: () => {}, stop: async () => {},
  }
}

interface Internals {
  _transport: unknown
  _active: boolean
  _processStatus: string
  _consumedOffset: number
  _turnGen: number
  _turnResultEmitted: boolean
  claudeSessionId: string | null
  turnGen: number
  processStatus: string
  handleStreamLine(line: string, v?: number): void
  writeMessage(message: string): Promise<boolean>
}

function makeRunningSession(taskId: string, sid: string): Internals {
  const session = new ClaudeCodeSession(taskId, 'proj', '/bin/true') as unknown as Internals
  session._transport = mockTransport()
  session._active = true
  session._processStatus = 'running' // a turn is live
  session.claudeSessionId = sid
  return session
}

async function taskInPhase(phase: string): Promise<string> {
  const { task } = await addTask({ title: 'incident-shape', project: 'p' })
  await updateTaskRaw(task.id, { phase: phase as never })
  return task.id
}

/** Wait for the fire-and-forget phase pullback (dynamic import + task write). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 20))
}

beforeEach(async () => {
  bus.clear()
  liveSession = undefined
  liveSid = null
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  bus.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  await new Promise(r => setTimeout(r, 100))
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('init-after-result is a turn-start edge (incident ed347bde)', () => {
  it('INCIDENT SHAPE: result → init (no state-running) leaves the session RUNNING + task IN_PROGRESS, and the late result flip is skipped', async () => {
    const sid = 'sess-ed347bde'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    const results: Array<Record<string, unknown>> = []
    bus.subscribe('session-runner', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
    })

    const genBefore = session.turnGen

    // 18:27:50.492 — the PREVIOUS turn's result. Emits SESSION_RESULT (stamped
    // with the CURRENT gen) and sets _processStatus='idle' (FIFO-alive branch).
    session.handleStreamLine(resultLine(sid), 1000)
    expect(results.length).toBe(1)
    expect(session.processStatus).toBe('idle')
    const eventGen = results[0].turnGen as number
    expect(eventGen).toBe(genBefore)

    // 18:27:50.620 — the CLI starts the queued message's turn. ONLY an init line;
    // no session_state_changed{running} ever arrives for this shape.
    session.handleStreamLine(initLine(sid), 1100)

    // Part 1: the badge must read Running again and the generation must advance.
    expect(session.processStatus).toBe('running')
    expect(session.turnGen).toBe(genBefore + 1)

    // …and the phase pullback must have kept/put the task at IN_PROGRESS.
    await settle()
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')

    // 18:27:51.297 — the server's late SESSION_RESULT handler runs with the gen the
    // event was STAMPED with. Part 2: it is stale and must not flip AGENT_COMPLETE.
    const late = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: eventGen,
    })
    expect(late.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('the NEW turn\'s own result (current gen) still flips AGENT_COMPLETE normally', async () => {
    const sid = 'sess-ed347bde-2'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    const results: Array<Record<string, unknown>> = []
    bus.subscribe('session-runner', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
    })

    session.handleStreamLine(resultLine(sid), 1000)          // previous turn ends
    session.handleStreamLine(initLine(sid), 1100)            // queued turn starts (gen++)
    await settle()
    session.handleStreamLine(resultLine(sid, 'new answer'), 1200) // THIS turn ends

    expect(results.length).toBe(2)
    expect(results[1].turnGen).toBe(session.turnGen) // stamped with the live gen

    const flip = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: results[1].turnGen as number,
    })
    expect(flip.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })

  it('NORMAL FLOW: send → result with no intervening init → AGENT_COMPLETE (no regression)', async () => {
    const sid = 'sess-normal-flow'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    const results: Array<Record<string, unknown>> = []
    bus.subscribe('session-runner', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
    })

    session.handleStreamLine(resultLine(sid), 1000)
    expect(session.turnGen).toBe(0) // no init-after-result → no bump

    const flip = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: results[0].turnGen as number,
    })
    expect(flip.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })

  it('the FIRST init of a fresh spawn is not a turn-start edge (no gen bump)', async () => {
    const sid = 'sess-fresh-spawn'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid)
    session.claudeSessionId = null // pre-init, as on a real spawn

    session.handleStreamLine(initLine(sid))

    // _turnResultEmitted was false → the reset branch (and the whole edge) is skipped.
    expect(session.turnGen).toBe(0)
  })
})

describe('QUEUED-SEND shape: the writeMessage delivery is itself a turn-start edge', () => {
  it('result → queued delivery (writeMessage) → init: gen bumps at the DELIVERY, turn A\'s late flip is skipped, turn B\'s own result flips', async () => {
    const sid = 'sess-queued-send'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    const results: Array<Record<string, unknown>> = []
    bus.subscribe('session-runner', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
    })

    const genBefore = session.turnGen

    // Turn A's result. Emits SESSION_RESULT stamped with the CURRENT gen and
    // parks the session at 'idle' (FIFO-alive branch).
    session.handleStreamLine(resultLine(sid, 'turn A answer', 0.003), 1000)
    expect(results.length).toBe(1)
    expect(session.processStatus).toBe('idle')
    const turnAGen = results[0].turnGen as number
    expect(turnAGen).toBe(genBefore)

    // Walnut delivers the message it had QUEUED while turn A ran (processNext →
    // writeMessage). This is the real path — a genuine idle→running delivery —
    // and it is the FIRST evidence of turn B, arriving before ANY CLI event for
    // it. Note it also resets _turnResultEmitted, which is exactly why the
    // init-after-result edge cannot fire for this shape.
    expect(await session.writeMessage('the queued follow-up')).toBe(true)
    expect(session.processStatus).toBe('running')
    expect(session.turnGen).toBe(turnAGen + 1)
    expect(session._turnResultEmitted).toBe(false)

    // The CLI's init for turn B now lands. _turnResultEmitted is already false,
    // so the init-after-result branch is a no-op — proving the delivery bump is
    // the ONLY thing standing between turn A's late flip and a repainted turn B.
    session.handleStreamLine(initLine(sid), 1100)
    expect(session.turnGen).toBe(turnAGen + 1)
    expect(session.processStatus).toBe('running')

    await settle()
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')

    // Turn A's ~800ms-late AGENT_COMPLETE flip runs with the gen it was STAMPED
    // with. liveGen (G+1) > eventGen (G) → stale → skipped.
    const late = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: turnAGen,
    })
    expect(late.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')

    // Turn B's OWN result is stamped with the live gen → flips normally.
    session.handleStreamLine(resultLine(sid, 'turn B answer', 0.007), 1200)
    expect(results.length).toBe(2)
    expect(results[1].turnGen).toBe(session.turnGen)
    const flip = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: results[1].turnGen as number,
    })
    expect(flip.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })

  it('a MID-TURN injection (writeMessage while already running) does NOT bump — it joins the SAME turn', async () => {
    const sid = 'sess-midturn-inject'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid) // _processStatus='running'
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    const results: Array<Record<string, unknown>> = []
    bus.subscribe('session-runner', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
    })

    expect(await session.writeMessage('btw, one more thing')).toBe(true)
    expect(session.turnGen).toBe(0) // same turn — no edge

    // The turn's own result must therefore still flip (its gen == liveGen).
    session.handleStreamLine(resultLine(sid), 1000)
    const flip = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: results[0].turnGen as number,
    })
    expect(flip.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })

  it('state-running is also a turn-start edge: result → {running} → late flip skipped', async () => {
    const sid = 'sess-state-running-edge'
    const taskId = await taskInPhase('IN_PROGRESS')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    const results: Array<Record<string, unknown>> = []
    bus.subscribe('session-runner', (e: BusEvent) => {
      if (e.name === EventNames.SESSION_RESULT) results.push(e.data as Record<string, unknown>)
    })

    session.handleStreamLine(resultLine(sid), 1000)
    const turnAGen = results[0].turnGen as number
    expect(session.processStatus).toBe('idle')

    // A message injected straight into the daemon's FIFO (phone → bridge → daemon)
    // never touches writeMessage; the CLI's {running} is the only turn-start signal.
    session.handleStreamLine(stateLine(sid, 'running'), 1100)
    expect(session.processStatus).toBe('running')
    expect(session.turnGen).toBe(turnAGen + 1)

    await settle()
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')

    const late = await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', {
      sessionId: sid, turnGen: turnAGen,
    })
    expect(late.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('a REPLAYED state-running (at/below the watermark) bumps no gen and writes no status', async () => {
    const sid = 'sess-replayed-running'
    const taskId = await taskInPhase('AGENT_COMPLETE')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    session._consumedOffset = 5000
    session._processStatus = 'idle'

    session.handleStreamLine(stateLine(sid, 'running'), 4500) // v < watermark → replay

    expect(session.turnGen).toBe(0)
    expect(session.processStatus).toBe('idle')
    await settle()
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })
})

describe('replay guard on the init-after-result edge', () => {
  it('a REPLAYED init (at/below the consumed watermark) writes no status, bumps no gen, fires no phase call', async () => {
    const sid = 'sess-replayed-init'
    const taskId = await taskInPhase('AGENT_COMPLETE')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    // A prior incarnation already processed this stretch of the stream.
    session._consumedOffset = 5000
    session._turnResultEmitted = true // a result for the previous turn was emitted
    session._processStatus = 'idle'   // …and the session settled

    session.handleStreamLine(initLine(sid), 4500) // v < watermark → replay

    expect(session.turnGen).toBe(0)             // no generation bump
    expect(session.processStatus).toBe('idle')  // status untouched — replay is the past
    await settle()
    // No session:turn-start pullback: the phase stays where the settled turn left it.
    expect((await getTask(taskId)).phase).toBe('AGENT_COMPLETE')
  })

  it('a LIVE init above the watermark still takes the edge', async () => {
    const sid = 'sess-live-init'
    const taskId = await taskInPhase('AGENT_COMPLETE')
    const session = makeRunningSession(taskId, sid)
    liveSession = session as unknown as { turnGen: number }
    liveSid = sid

    session._consumedOffset = 1000
    session._turnResultEmitted = true
    session._processStatus = 'idle'

    session.handleStreamLine(initLine(sid), 2000) // v > watermark → live

    expect(session.turnGen).toBe(1)
    expect(session.processStatus).toBe('running')
    await settle()
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })
})
