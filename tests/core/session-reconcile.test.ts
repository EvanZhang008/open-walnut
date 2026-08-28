/**
 * Unit tests for session-reconcile.ts — foldSessionTail (the pure stream-tail
 * fold) + reconcileProcessStatus (the authoritative convergence primitive).
 *
 * Four incidents share the root cause (see the module header): a lost or
 * swallowed result event wedged process_status at 'running' — or the task at
 * IN_PROGRESS — with nothing to pull them back to truth.
 *
 * CRITICAL FIXTURE NOTE: the evidence source is the daemon STREAM file
 * (WALNUT_STREAMS_DIR/<sid>.jsonl), NOT the canonical ~/.claude/projects JSONL.
 * On real data the canonical file contains ZERO result/session_state/task_*
 * lines — a v1 of these tests wrote canonical fixtures and passed while the
 * production code path never fired. Fixtures here go to the stream dir.
 *
 * R1 evidence rule under test (all must hold to converge):
 *   real result after the last real user message  — turn provably ended
 *   trailing idle after that result               — CLI settled (error results exempt)
 *   gatingBgCount === 0                           — backgrounded tasks excluded (incident D)
 *   !teamActive                                   — no team poll loop
 * Target: error→'error'; alive→'idle'; dead→'stopped'. Task phase: IN_PROGRESS
 * → AGENT_COMPLETE, error or not (WAIT removed 2026-08-18 — the turn is over and
 * the ball is back with the human either way; the failure signal lives on the
 * session record, not the task phase); later phases never regressed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { foldSessionTail, fetchStreamTailFold, reconcileProcessStatus, daemonStreamPath, daemonStreamPathCandidates, isStaleWatermark } from '../../src/core/session-reconcile.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

const CWD = '/Users/test/reconcile-project'

// ── Stream-file fixture builders (shapes verified against real stream files) ──

function initEvent(sid: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'init', session_id: sid,
    cwd: CWD, model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default',
  })
}
function userEvent(sid: string, text = 'hello'): string {
  return JSON.stringify({
    type: 'user', session_id: sid,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}
/** Mid-turn tool_result echo — a `user` line that must NOT anchor the fold. */
function toolResultUserEvent(sid: string): string {
  return JSON.stringify({
    type: 'user', session_id: sid,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: 'ok' }] },
  })
}
/** Inline subagent turn — a `user` line the Task tool's own conversation
 *  emits into the SAME main stream file, carrying real text content but
 *  scoped to `parent_tool_use_id`. Must NOT anchor the fold (it is not the
 *  main-turn boundary — "inline subagent interleave" class of bug). */
function subagentUserEvent(sid: string, parentToolUseId: string, text = 'subagent prompt'): string {
  return JSON.stringify({
    type: 'user', session_id: sid, parent_tool_use_id: parentToolUseId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}
function resultEvent(sid: string, isError = false): string {
  return JSON.stringify({
    type: 'result', subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError, duration_ms: 1000, num_turns: 1, result: 'Done',
    session_id: sid, total_cost_usd: 0.01,
  })
}
function notificationOriginResult(sid: string): string {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'bg summary',
    session_id: sid, origin: { kind: 'task-notification' },
  })
}
function stateEvent(sid: string, state: 'running' | 'idle'): string {
  return JSON.stringify({ type: 'system', subtype: 'session_state_changed', session_id: sid, state })
}
function taskStarted(sid: string, taskId: string): string {
  return JSON.stringify({ type: 'system', subtype: 'task_started', session_id: sid, task_id: taskId, task_type: 'local_bash' })
}
function taskBackgrounded(sid: string, taskId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_updated', session_id: sid, task_id: taskId,
    patch: { is_backgrounded: true },
  })
}
function taskDone(sid: string, taskId: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'task_notification', session_id: sid, task_id: taskId, status: 'completed',
  })
}
function teamCreate(sid: string): string {
  return JSON.stringify({
    type: 'assistant', session_id: sid,
    message: {
      id: 'msg_team', role: 'assistant', model: 'mock-model',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'TeamCreate', input: {} }],
    },
  })
}
/** Daemon-appended delivery marker (appendUserMarker) — the ONLY trace a
 *  plain-text FIFO send leaves in the stream file. Must anchor the fold. */
function walnutInjectedEvent(sid: string, text = 'continue', messageId = 'qm-123-abc'): string {
  return JSON.stringify({
    type: 'user', subtype: 'walnut-injected', session_id: sid,
    message: { role: 'user', content: text },
    walnutMessageId: messageId, timestamp: new Date().toISOString(),
  })
}

let streamsDir: string

async function writeStream(sid: string, lines: string[]): Promise<void> {
  await fsp.mkdir(streamsDir, { recursive: true })
  await fsp.writeFile(path.join(streamsDir, `${sid}.jsonl`), lines.join('\n') + '\n')
}

/** Create a stuck-'running' record whose last_status_change is old enough to
 *  clear any minAgeMs guard. */
async function stuckRunningRecord(sid: string, opts: { pid?: number; taskId?: string } = {}) {
  await createSessionRecord(sid, opts.taskId ?? '', 'proj', CWD, { pid: opts.pid })
  return updateSessionRecord(sid, {
    process_status: 'running',
    last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  })
}

let tmpDir: string
let savedStreamsEnv: string | undefined

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  // Point daemonStreamPath's __local__ branch at an isolated tmp dir — NEVER
  // let unit tests read/write the production /tmp/open-walnut-streams.
  savedStreamsEnv = process.env.WALNUT_STREAMS_DIR
  streamsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-reconcile-streams-'))
  process.env.WALNUT_STREAMS_DIR = streamsDir
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.rm(streamsDir, { recursive: true, force: true })
  if (savedStreamsEnv === undefined) delete process.env.WALNUT_STREAMS_DIR
  else process.env.WALNUT_STREAMS_DIR = savedStreamsEnv
})

// ── foldSessionTail: the pure fold ──

describe('foldSessionTail — turn-end evidence semantics', () => {
  const sid = 'fold-sid'

  it('result + trailing idle after the last real user message → turnEnded/agent_complete', () => {
    const fold = foldSessionTail([
      initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(fold.foundTurnAnchor).toBe(true)
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('agent_complete')
  })

  it('result WITHOUT trailing idle → not ended (companion idle must arrive)', () => {
    const fold = foldSessionTail([initEvent(sid), userEvent(sid), resultEvent(sid)].join('\n'))
    expect(fold.turnEnded).toBe(false)
  })

  it('idle BEFORE the result does not count as trailing (ordering matters)', () => {
    const fold = foldSessionTail([
      initEvent(sid), userEvent(sid), stateEvent(sid, 'idle'), resultEvent(sid),
    ].join('\n'))
    expect(fold.turnEnded).toBe(false)
  })

  it('error result is terminal WITHOUT an idle (CLI may bail before emitting one)', () => {
    const fold = foldSessionTail([initEvent(sid), userEvent(sid), resultEvent(sid, true)].join('\n'))
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('error')
  })

  it('user message AFTER the result re-anchors the fold → no verdict (turn in progress)', () => {
    const fold = foldSessionTail([
      initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle'),
      userEvent(sid, 'follow-up'),
    ].join('\n'))
    expect(fold.foundTurnAnchor).toBe(true)
    expect(fold.turnEnded).toBe(false)
    expect(fold.lastResult).toBe(null)
  })

  it('tool_result user echoes do NOT re-anchor (mid-turn lines)', () => {
    const fold = foldSessionTail([
      initEvent(sid), userEvent(sid),
      taskStarted(sid, 'bg-A'),
      toolResultUserEvent(sid), // mid-turn echo AFTER task_started
      taskDone(sid, 'bg-A'),
      resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    // If the echo anchored, bg-A's start would be outside the window and the
    // fold would still converge — but the anchor must be the REAL user line.
    expect(fold.turnEnded).toBe(true)
    expect(Object.keys(fold.bgTasks)).toContain('bg-A')
  })

  it('subagent inline user lines do NOT re-anchor (parent_tool_use_id set)', () => {
    const fold = foldSessionTail([
      initEvent(sid), userEvent(sid),
      taskStarted(sid, 'bg-A'), // background work started BEFORE the inline subagent line
      subagentUserEvent(sid, 'tu_task_1'), // Task-tool subagent's own prompt, inlined mid-turn
      resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    // If the subagent line anchored, bg-A's start would fall outside the fold
    // window and gatingBgCount would wrongly read 0 — the fold must anchor on
    // the actual last REAL top-level user line (the one BEFORE bg-A started),
    // so bg-A stays visible/gating and the turn must NOT be reported ended.
    expect(fold.foundTurnAnchor).toBe(true)
    expect(Object.keys(fold.bgTasks)).toContain('bg-A')
    expect(fold.gatingBgCount).toBe(1)
    expect(fold.turnEnded).toBe(false)
  })

  it('running bg task gates the verdict; completing it un-gates', () => {
    const halfway = foldSessionTail([
      userEvent(sid), taskStarted(sid, 'bg-A'), resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(halfway.gatingBgCount).toBe(1)
    expect(halfway.turnEnded).toBe(false)

    const drained = foldSessionTail([
      userEvent(sid), taskStarted(sid, 'bg-A'), resultEvent(sid),
      taskDone(sid, 'bg-A'), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(drained.gatingBgCount).toBe(0)
    expect(drained.turnEnded).toBe(true)
  })

  it('INCIDENT D: is_backgrounded task does NOT gate (CLI turn-end does not wait for it)', () => {
    const fold = foldSessionTail([
      userEvent(sid),
      taskStarted(sid, 'b60h9ag3m'),          // the full-disk grep
      taskBackgrounded(sid, 'b60h9ag3m'),      // patch: {is_backgrounded: true} — NO terminal event ever
      resultEvent(sid), stateEvent(sid, 'idle'), // CLI ended the turn anyway
    ].join('\n'))
    expect(fold.bgTasks['b60h9ag3m']?.isBackgrounded).toBe(true)
    expect(fold.gatingBgCount).toBe(0)
    expect(fold.turnEnded).toBe(true)
  })

  it('task-notification-origin result IS a turn verdict — the followup turn settles (incident b07ee156)', () => {
    // The CLI's notification followup turn closes with a notification-origin
    // result; excluding it wedged turnActive forever (anchor accepted,
    // verdict refused). Mirrors daemon-fold.ts — the golden test pins the two
    // folds to identical verdicts. Walnut's LIVE handler keeps its own
    // exclusion (guards task-phase transitions, not cliState).
    const fold = foldSessionTail([
      userEvent(sid), notificationOriginResult(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(fold.lastResult).not.toBe(null)
    expect(fold.turnEnded).toBe(true)
  })

  it('TeamCreate without TeamDelete blocks the verdict', () => {
    const fold = foldSessionTail([
      userEvent(sid), teamCreate(sid), resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(fold.teamActive).toBe(true)
    expect(fold.turnEnded).toBe(false)
  })

  it('no real user line in the window → no anchor, no verdict', () => {
    const fold = foldSessionTail([initEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')].join('\n'))
    expect(fold.foundTurnAnchor).toBe(false)
    expect(fold.turnEnded).toBe(false)
  })

  it('CronCreate arms cronActive without blocking the verdict (/loop idles between fires)', () => {
    const cronCreate = JSON.stringify({
      type: 'assistant', session_id: sid,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_c1', name: 'CronCreate', input: { cron: '*/5 * * * *', prompt: '/status' } }] },
    })
    const fold = foldSessionTail([
      userEvent(sid), cronCreate, resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(fold.cronActive).toBe(true)
    expect(fold.turnEnded).toBe(true)

    const cronDelete = JSON.stringify({
      type: 'assistant', session_id: sid,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_c2', name: 'CronDelete', input: { id: 'job-1' } }] },
    })
    const disarmed = foldSessionTail([
      userEvent(sid), cronCreate, cronDelete, resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(disarmed.cronActive).toBe(false)
  })

  it('torn/partial lines are skipped without aborting the fold', () => {
    const fold = foldSessionTail([
      '{"type":"user","message":{"content":[{"ty', // torn line
      userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(fold.turnEnded).toBe(true)
  })
})

// ── reconcileProcessStatus: convergence + refusal ──

describe('reconcileProcessStatus — convergence (incidents B/D shape)', () => {
  it('running record + stream proves turn ended + dead process → stopped', async () => {
    const sid = 'conv-dead'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid)

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'stopped' })

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.status_reason).toBe('reconciled_authoritative')
    expect(after?.status_changed_by).toBe('reconciler')
    expect(after?.pid == null).toBe(true)
  })

  it('running record + turn ended + ALIVE process → idle (between-turns FIFO state)', async () => {
    const sid = 'conv-alive'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'idle' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('idle')
    // Alive process keeps its PID — the FIFO is still usable for the next turn.
    expect(after?.pid).toBe(process.pid)
  })

  it('error result → error, with errorMessage persisted', async () => {
    const sid = 'conv-error'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid, true)])
    const record = await stuckRunningRecord(sid)

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'error' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('error')
    expect(after?.errorMessage).toContain('reconciled')
  })

  // SEMANTICS REVERSED 2026-08-28 (inc-1787893885321, user decision: "如果是
  // Running Background 那当然应该是一个 Running 状态"). A live detached
  // (run_in_background) command means the session IS working — the 'running'
  // record is truthful, so the reconciler must refuse to converge it (it would
  // fight the snapshot lane, which projects detachedBgCount>0 as 'running').
  // The old expectation here (converge to idle) was the incident-D-era display
  // decision this reverses; turn-over gating (07fffbe5) is unchanged.
  it('backgrounded bash still running BLOCKS convergence (record running is truthful)', async () => {
    const sid = 'conv-backgrounded'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid),
      taskStarted(sid, 'bg-grep'), taskBackgrounded(sid, 'bg-grep'), // never terminal
      resultEvent(sid), stateEvent(sid, 'idle'),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'detached-bg-running' })
    // Once the command's terminal bookend lands, convergence proceeds as before.
    await writeStream(sid, [
      initEvent(sid), userEvent(sid),
      taskStarted(sid, 'bg-grep'), taskBackgrounded(sid, 'bg-grep'),
      resultEvent(sid), stateEvent(sid, 'idle'),
      taskDone(sid, 'bg-grep'),
    ])
    const drained = await reconcileProcessStatus(record, { isAlive: true })
    expect(drained).toEqual({ converged: true, from: 'running', to: 'idle' })
  })

  it('emits session:status-changed with the converged status', async () => {
    const sid = 'conv-event'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid)

    const events: BusEvent[] = []
    bus.subscribe('test-listener', (e) => {
      if (e.name === EventNames.SESSION_STATUS_CHANGED) events.push(e)
    })
    try {
      await reconcileProcessStatus(record, { isAlive: false })
    } finally {
      bus.unsubscribe('test-listener')
    }
    expect(events.length).toBe(1)
    expect((events[0].data as { process_status: string }).process_status).toBe('stopped')
  })

  it('is idempotent — second call is a no-op (record no longer has debt)', async () => {
    const sid = 'conv-idem'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid)

    const first = await reconcileProcessStatus(record, { isAlive: false })
    expect(first.converged).toBe(true)

    const fresh = await getSessionByClaudeId(sid)
    const second = await reconcileProcessStatus(fresh!, { isAlive: false })
    expect(second).toEqual({ converged: false, reason: 'not-running' })
  })

  it('accepts pre-fetched evidence (attach path) without re-reading the stream', async () => {
    const sid = 'conv-prefetched'
    // NO stream file on disk — proves the evidence input is used as-is.
    const record = await stuckRunningRecord(sid)

    const fold = foldSessionTail([userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')].join('\n'))
    const outcome = await reconcileProcessStatus(record, {
      evidence: { fold, fileSize: 1 },
      isAlive: false,
    })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'stopped' })
  })
})

describe('reconcileProcessStatus — refusal guards (must NOT converge)', () => {
  it('no-op when record is settled and no task linked (idle is the normal state)', async () => {
    const sid = 'guard-idle'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    await createSessionRecord(sid, '', 'proj', CWD)
    const record = await updateSessionRecord(sid, { process_status: 'idle' })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'not-running' })
  })

  it('no-op when turn is genuinely still in progress (user message after last result)', async () => {
    const sid = 'guard-live-turn'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle'),
      userEvent(sid, 'follow-up'),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'turn-not-terminal' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('no-op while non-backgrounded background tasks are in flight', async () => {
    const sid = 'guard-bg'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid),
      taskStarted(sid, 'bg-A'), taskStarted(sid, 'bg-B'),
      resultEvent(sid),          // "launched in background" result
      taskDone(sid, 'bg-A'),     // bg-B still running
      stateEvent(sid, 'idle'),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome.converged).toBe(false)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('converges once ALL background tasks are terminal', async () => {
    const sid = 'guard-bg-done'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid),
      taskStarted(sid, 'bg-A'), taskStarted(sid, 'bg-B'),
      resultEvent(sid),
      taskDone(sid, 'bg-A'), taskDone(sid, 'bg-B'),
      stateEvent(sid, 'idle'),
    ])
    const record = await stuckRunningRecord(sid)

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'stopped' })
  })

  it('no-op while team mode is active (fold detection)', async () => {
    const sid = 'guard-team'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid), teamCreate(sid), resultEvent(sid), stateEvent(sid, 'idle'),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'turn-not-terminal' })
  })

  it('no-op on teamActiveHint even when the tail window itself shows no team', async () => {
    const sid = 'guard-team-hint'
    // Team was created in an EARLIER turn — outside this tail window.
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true, teamActiveHint: true })
    expect(outcome).toEqual({ converged: false, reason: 'team-active' })
  })

  it('no-op when the stream file is missing (no evidence — never guess)', async () => {
    const sid = 'guard-no-stream'
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'no-stream-file' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('no-op when the record changed too recently (minAgeMs guard)', async () => {
    const sid = 'guard-young'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    await createSessionRecord(sid, '', 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date().toISOString(), // just flipped — likely a fresh send
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true, minAgeMs: 3 * 60 * 1000 })
    expect(outcome).toEqual({ converged: false, reason: 'too-young' })
  })

  it('no-op on archived records', async () => {
    const sid = 'guard-archived'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    await createSessionRecord(sid, '', 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'running', archived: true,
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome).toEqual({ converged: false, reason: 'archived' })
  })

  it('skips the write when the record changed concurrently (conditional update race)', async () => {
    const sid = 'guard-race'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid)

    // Simulate a concurrent writer flipping the record AFTER our snapshot was taken:
    // the stale snapshot still says 'running', but the DB row has moved on.
    await updateSessionRecord(sid, { process_status: 'idle' })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome.converged).toBe(false)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle')
  })
})

describe('reconcileProcessStatus — task phase sync (incident C shape)', () => {
  it('advances a stuck IN_PROGRESS task to AGENT_COMPLETE on record convergence', async () => {
    const { addTaskFull, getTask } = await import('../../src/core/task-manager.js')
    const task = await addTaskFull({
      title: 'stuck task', type: 'task', status: 'in_progress', phase: 'IN_PROGRESS',
      project: 'proj', source: 'local', created_at: new Date().toISOString(),
    } as any)

    const sid = 'phase-sync'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid, { taskId: task.id })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome.converged).toBe(true)
    expect((await getTask(task.id)).phase).toBe('AGENT_COMPLETE')
  })

  it('PHASE DEBT: settled record + task stuck IN_PROGRESS → phase synced without touching the record', async () => {
    const { addTaskFull, getTask } = await import('../../src/core/task-manager.js')
    const task = await addTaskFull({
      title: 'incident-C task', type: 'task', status: 'in_progress', phase: 'IN_PROGRESS',
      project: 'proj', source: 'local', created_at: new Date().toISOString(),
    } as any)

    const sid = 'phase-debt'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    await createSessionRecord(sid, task.id, 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'idle', // record already settled — the incident-C wedge
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome.converged).toBe(true)
    expect((outcome as { phaseSynced?: boolean }).phaseSynced).toBe(true)
    expect((await getTask(task.id)).phase).toBe('AGENT_COMPLETE')
    // Record untouched — it was already correct.
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle')
  })

  // (WAIT removed 2026-08-18 — the "already past IN_PROGRESS" fixture phase was
  // WAIT; COMPLETE is now the phase past AGENT_COMPLETE, and the gate is still
  // "only sync when the task is exactly IN_PROGRESS".)
  it('never regresses a task already past IN_PROGRESS', async () => {
    const { addTaskFull, getTask } = await import('../../src/core/task-manager.js')
    const task = await addTaskFull({
      title: 'already handled', type: 'task', status: 'done', phase: 'COMPLETE',
      project: 'proj', source: 'local', created_at: new Date().toISOString(),
    } as any)

    const sid = 'phase-keep'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid, { taskId: task.id })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome.converged).toBe(true)
    expect((await getTask(task.id)).phase).toBe('COMPLETE')
  })

  // The error branch used to land on WAIT; since the removal (2026-08-18) an
  // errored turn reconciles to the SAME AGENT_COMPLETE as a clean one — the
  // failure signal is the session record's 'error' process_status.
  it('an errored turn also syncs the phase to AGENT_COMPLETE (no separate blocked phase)', async () => {
    const { addTaskFull, getTask } = await import('../../src/core/task-manager.js')
    const task = await addTaskFull({
      title: 'errored turn', type: 'task', status: 'in_progress', phase: 'IN_PROGRESS',
      project: 'proj', source: 'local', created_at: new Date().toISOString(),
    } as any)

    const sid = 'phase-error'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid, true)])
    const record = await stuckRunningRecord(sid, { taskId: task.id })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome.converged).toBe(true)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('error')
    expect((await getTask(task.id)).phase).toBe('AGENT_COMPLETE')
  })
})

// ── Incident inc-1783644415695: stale result adopted as current turn's verdict ──
// The CLI never echoes stdin user messages, so a turn started by a plain-text
// FIFO send has NO anchor in the stream file. The fold anchored on a PREVIOUS
// turn's user line and adopted that turn's error result as the current turn's
// verdict — converging a working session to a day-old error, 3× in one day.

describe('foldSessionTail — turn-start visibility (incident inc-1783644415695)', () => {
  const sid = 'anchor-sid'

  it('walnut-injected delivery marker anchors the fold (turn started by plain-text send)', () => {
    // Previous turn: user → error result. Current turn: marker only, no result yet.
    const fold = foldSessionTail([
      userEvent(sid, 'previous turn'), resultEvent(sid, true),
      walnutInjectedEvent(sid, 'continue'),
    ].join('\n'))
    expect(fold.foundTurnAnchor).toBe(true)
    // Anchored on the marker → the old error is BEFORE the anchor → no verdict.
    expect(fold.lastResult).toBe(null)
    expect(fold.turnEnded).toBe(false)
  })

  it('marker anchor + new result + idle → converges normally (reconciler keeps its job)', () => {
    const fold = foldSessionTail([
      userEvent(sid, 'previous turn'), resultEvent(sid, true),
      walnutInjectedEvent(sid, 'continue'),
      resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'))
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('agent_complete')
  })

  it('INIT after a result invalidates it — a new turn began, the result is stale', () => {
    // Legacy shape (no marker): old anchor, old error result, then the CLI
    // started a new turn (init + running) — exactly the incident window.
    const fold = foldSessionTail([
      userEvent(sid, 'old turn'), resultEvent(sid, true),
      stateEvent(sid, 'running'), initEvent(sid),
    ].join('\n'))
    expect(fold.foundTurnAnchor).toBe(true)
    expect(fold.lastResult).toBe(null)
    expect(fold.turnEnded).toBe(false)
  })

  it('state:running after a result invalidates it the same way', () => {
    const fold = foldSessionTail([
      userEvent(sid, 'old turn'), resultEvent(sid), stateEvent(sid, 'idle'),
      stateEvent(sid, 'running'),
    ].join('\n'))
    expect(fold.lastResult).toBe(null)
    expect(fold.turnEnded).toBe(false)
  })

  it('records lastResult.endOffset in the daemon v coordinate when baseOffset given', () => {
    const lines = [userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')]
    const content = lines.join('\n')
    const base = 1000
    const fold = foldSessionTail(content, base)
    // endOffset = base + bytes of user line + \n + result line + \n
    const expected = base
      + Buffer.byteLength(lines[0], 'utf8') + 1
      + Buffer.byteLength(lines[1], 'utf8') + 1
    expect(fold.lastResult?.endOffset).toBe(expected)
    expect(fold.turnEnded).toBe(true)
  })
})

describe('reconcileProcessStatus — stale-evidence vetoes (incident inc-1783644415695)', () => {
  it('INCIDENT REPLAY: old error + new init + no new result → turn-not-terminal, record stays running', async () => {
    const sid = 'inc-stale-error'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid, 'yesterday'),
      resultEvent(sid, true),           // 23:51 — previous turn's real error
      stateEvent(sid, 'idle'),
      stateEvent(sid, 'running'),        // 00:12 — new turn (send not echoed)
      initEvent(sid),
      // ... turn still working, silent > 3min — reconciler tick fires here
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'turn-not-terminal' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('POSITIONAL VETO: result at/below consumedOffset → result-already-consumed', async () => {
    const sid = 'inc-consumed'
    // Marker-less legacy shape AND no init after the error (tailer never saw
    // the new turn start) — only the positional watermark can save us here.
    const lines = [initEvent(sid), userEvent(sid, 'yesterday'), resultEvent(sid, true)]
    await writeStream(sid, lines)
    const fileSize = lines.join('\n').length + 1
    await createSessionRecord(sid, '', 'proj', CWD, { pid: process.pid })
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      consumedOffset: fileSize, // live path already consumed everything incl. the error
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'result-already-consumed' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('positional veto does NOT block a genuinely unconsumed result (reconciler keeps its job)', async () => {
    const sid = 'inc-unconsumed'
    const lines = [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')]
    await writeStream(sid, lines)
    await createSessionRecord(sid, '', 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      consumedOffset: 10, // watermark far below the result — the result was LOST, not consumed
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'stopped' })
  })

  it('error verdict with ALIVE process keeps the pid (no cold-resume split-brain)', async () => {
    const sid = 'inc-keep-pid'
    await writeStream(sid, [
      initEvent(sid), walnutInjectedEvent(sid, 'go'), resultEvent(sid, true),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'error' })
    // NOTE: the tracker's terminal-state clear (applyUpdateToSession) still
    // clears pid on 'error' records — this asserts reconcile itself no longer
    // FORCES the clear. If the tracker policy changes, the pid survives.
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('error')
  })
})

describe('daemonStreamPath', () => {
  it('remote host → HOME primary with legacy /tmp fallback', () => {
    expect(daemonStreamPathCandidates('sid-1', 'clouddev')).toEqual([
      '~/.open-walnut/tmp/streams/sid-1.jsonl',
      '/tmp/open-walnut-streams/sid-1.jsonl',
    ])
    expect(daemonStreamPath('sid-1', 'clouddev')).toBe('~/.open-walnut/tmp/streams/sid-1.jsonl')
  })
  it('local → honors WALNUT_STREAMS_DIR isolation (single candidate)', () => {
    expect(daemonStreamPath('sid-1', null)).toBe(path.join(streamsDir, 'sid-1.jsonl'))
    expect(daemonStreamPath('sid-1', '__local__')).toBe(path.join(streamsDir, 'sid-1.jsonl'))
    expect(daemonStreamPathCandidates('sid-1', null)).toHaveLength(1)
  })
  it('local prod (no env overrides) → HOME primary with legacy fallback', () => {
    const savedStreams = process.env.WALNUT_STREAMS_DIR
    const savedDaemon = process.env.WALNUT_DAEMON_DIR
    delete process.env.WALNUT_STREAMS_DIR
    delete process.env.WALNUT_DAEMON_DIR
    try {
      expect(daemonStreamPathCandidates('sid-1', null)).toEqual([
        path.join(os.homedir(), '.open-walnut', 'tmp', 'streams', 'sid-1.jsonl'),
        '/tmp/open-walnut-streams/sid-1.jsonl',
      ])
    } finally {
      process.env.WALNUT_STREAMS_DIR = savedStreams
      if (savedDaemon === undefined) delete process.env.WALNUT_DAEMON_DIR
      else process.env.WALNUT_DAEMON_DIR = savedDaemon
    }
  })
})

// ── Whale-turn watermark fallback (incident 57b125ab) ──
// A 37-min turn streamed >2 MB after its user line, so the anchor scan always
// returned 'tail-window-exhausted' and the stuck-'running' record was
// unreconcilable for 15h — while the 19 KB after record.consumedOffset held a
// clean companion idle. The fallback folds from the watermark with a synthetic
// anchor instead of requiring the (unreachable) user line.

describe('foldSessionTail — synthetic anchor (watermark fold)', () => {
  const sid = 'whale-sid'

  it('INCIDENT 57b125ab shape: only post-turn bookkeeping after the watermark → agent_complete', () => {
    // Exact post-watermark line sequence from the real incident stream file.
    const fold = foldSessionTail([
      stateEvent(sid, 'idle'),
      JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } }),
      JSON.stringify({ type: 'system', subtype: 'control_request_progress', session_id: sid }),
      JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r2' } }),
    ].join('\n'), 1000, { syntheticAnchor: true })
    expect(fold.foundTurnAnchor).toBe(true)
    expect(fold.anchorSynthetic).toBe(true)
    expect(fold.sawTurnActivity).toBe(false)
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('agent_complete')
  })

  it('turn activity after the watermark withholds the no-result verdict (live turn safe)', () => {
    // Real continuation shape from the same file later: marker → running → init → assistant…
    const fold = foldSessionTail([
      stateEvent(sid, 'idle'),
      walnutInjectedEvent(sid, 'next message'),
      stateEvent(sid, 'running'),
      initEvent(sid),
    ].join('\n'), 1000, { syntheticAnchor: true })
    expect(fold.sawTurnActivity).toBe(true)
    expect(fold.turnEnded).toBe(false)
  })

  it('assistant/stream output alone counts as activity (marker-less legacy send)', () => {
    const fold = foldSessionTail([
      stateEvent(sid, 'idle'),
      JSON.stringify({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n'), 1000, { syntheticAnchor: true })
    expect(fold.sawTurnActivity).toBe(true)
    expect(fold.turnEnded).toBe(false)
  })

  it('a REAL result + idle in the synthetic window converges via the normal R1 path', () => {
    const fold = foldSessionTail([
      walnutInjectedEvent(sid, 'go'),
      resultEvent(sid), stateEvent(sid, 'idle'),
    ].join('\n'), 1000, { syntheticAnchor: true })
    expect(fold.turnEnded).toBe(true)
    expect(fold.workStatus).toBe('agent_complete')
    expect(fold.lastResult).not.toBe(null)
  })

  it('running bg task in the synthetic window gates the verdict', () => {
    const fold = foldSessionTail([
      stateEvent(sid, 'idle'),
      taskStarted(sid, 'bg-1'),
    ].join('\n'), 1000, { syntheticAnchor: true })
    expect(fold.gatingBgCount).toBe(1)
    expect(fold.turnEnded).toBe(false)
  })

  it('idle WITHOUT a watermark-anchored window never fires (anchored mode unchanged)', () => {
    // Same bookkeeping-only content WITHOUT syntheticAnchor: no user line → no
    // anchor → no verdict. Pins that the new verdict is opt-in.
    const fold = foldSessionTail([
      stateEvent(sid, 'idle'),
    ].join('\n'), 1000)
    expect(fold.foundTurnAnchor).toBe(false)
    expect(fold.turnEnded).toBe(false)
  })
})

describe('fetchStreamTailFold — whale-turn watermark fallback (incident 57b125ab)', () => {
  /** Build a whale stream: anchor + huge filler beyond the 2 MB window cap,
   *  then a turn end, then bookkeeping-only tail. Returns the byte offset of
   *  the turn-end (what _advanceConsumedOffset would have persisted). */
  async function writeWhaleStream(sid: string, tail: string[]): Promise<number> {
    const filler = JSON.stringify({
      type: 'system', subtype: 'thinking_tokens', session_id: sid, pad: 'x'.repeat(4000),
    })
    const head = [initEvent(sid), userEvent(sid, 'the whale turn message')]
    const fillers = Array.from({ length: 600 }, () => filler) // ~2.4 MB > cap
    const consumed = [resultEvent(sid), stateEvent(sid, 'idle')]
    const pre = [...head, ...fillers, ...consumed]
    const preContent = pre.join('\n') + '\n'
    const watermark = Buffer.byteLength(preContent, 'utf8')
    await writeStream(sid, [...pre, ...tail])
    return watermark
  }

  it('INCIDENT E2E: whale turn + clean post-watermark idle → stuck running converges to idle', async () => {
    const sid = 'whale-converge'
    const watermark = await writeWhaleStream(sid, [
      stateEvent(sid, 'idle'),
      JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } }),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })
    await updateSessionRecord(sid, { consumedOffset: watermark })
    const fresh = (await getSessionByClaudeId(sid))!

    const outcome = await reconcileProcessStatus(fresh, { isAlive: true })
    expect(outcome).toEqual({ converged: true, from: 'running', to: 'idle' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle')
  })

  it('whale turn + LIVE next turn after the watermark → no convergence', async () => {
    const sid = 'whale-live'
    const watermark = await writeWhaleStream(sid, [
      stateEvent(sid, 'idle'),
      walnutInjectedEvent(sid, 'next message'),
      stateEvent(sid, 'running'),
    ])
    const record = await stuckRunningRecord(sid, { pid: process.pid })
    await updateSessionRecord(sid, { consumedOffset: watermark })
    const fresh = (await getSessionByClaudeId(sid))!

    const outcome = await reconcileProcessStatus(fresh, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'turn-not-terminal' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('whale turn WITHOUT a watermark → still tail-window-exhausted (fallback needs the offset)', async () => {
    const sid = 'whale-no-mark'
    await writeWhaleStream(sid, [stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid, { pid: process.pid })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'tail-window-exhausted' })
  })

  it('stale watermark past EOF (sid reuse / truncation) is rejected', async () => {
    const sid = 'whale-stale-mark'
    await writeWhaleStream(sid, [stateEvent(sid, 'idle')])
    const record = await stuckRunningRecord(sid, { pid: process.pid })
    await updateSessionRecord(sid, { consumedOffset: 999_999_999 })
    const fresh = (await getSessionByClaudeId(sid))!

    const outcome = await reconcileProcessStatus(fresh, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'tail-window-exhausted' })
  })

  it('anchored fold still wins when the anchor IS reachable (fallback never preempts)', async () => {
    const sid = 'whale-not-needed'
    await writeStream(sid, [
      initEvent(sid), userEvent(sid, 'normal turn'),
      resultEvent(sid), stateEvent(sid, 'idle'),
    ])
    const result = await fetchStreamTailFold(sid, null, { consumedOffset: 1 })
    expect(typeof result).not.toBe('string')
    if (typeof result !== 'string') {
      expect(result.fold.anchorSynthetic).toBeUndefined()
      expect(result.fold.turnEnded).toBe(true)
    }
  })
})

// ── Incident inc-1786428350008: dead-incarnation watermark suppresses the real result ──
// A session spawned before the /tmp→HOME streams-dir move carried a
// consumedOffset measured in the LEGACY file (37.9 MB). Its respawn wrote a
// fresh HOME file starting at offset ~0; every event in the new (6 MB) file
// sat "below" the stale watermark, so the live path suppressed the real
// end-of-turn result as a replay and the task never reached AGENT_COMPLETE.
// The positional veto in reconcileProcessStatus had the same blindness — the
// reconciler could never heal what the live path suppressed.

describe('isStaleWatermark — dead-incarnation detection', () => {
  it('offset beyond EOF proves a different file', () => {
    expect(isStaleWatermark(
      { consumedOffset: 37_982_175 },
      { fileSize: 6_030_794 },
    )).toBe(true)
  })

  it('epoch mismatch proves a recreated file even when the offset fits', () => {
    expect(isStaleWatermark(
      { consumedOffset: 100, streamEpoch: '1:111:1000' },
      { fileSize: 5_000, streamEpoch: '1:222:2000' },
    )).toBe(true)
  })

  it('same epoch + in-range offset is NOT stale', () => {
    expect(isStaleWatermark(
      { consumedOffset: 100, streamEpoch: '1:111:1000' },
      { fileSize: 5_000, streamEpoch: '1:111:1000' },
    )).toBe(false)
  })

  it('missing epochs + in-range offset is NOT stale (no proof)', () => {
    expect(isStaleWatermark({ consumedOffset: 100 }, { fileSize: 5_000 })).toBe(false)
  })

  it('no watermark → never stale', () => {
    expect(isStaleWatermark({}, { fileSize: 5_000, streamEpoch: '1:2:3' })).toBe(false)
    expect(isStaleWatermark({ consumedOffset: 0 }, { fileSize: 5_000 })).toBe(false)
  })
})

describe('reconcileProcessStatus — stale watermark from a dead file incarnation (incident inc-1786428350008)', () => {
  it('INCIDENT REPLAY: watermark > fileSize → positional veto yields, record converges + phase syncs + epoch stamped', async () => {
    const { addTaskFull, getTask } = await import('../../src/core/task-manager.js')
    const task = await addTaskFull({
      title: 'incident task', type: 'task', status: 'in_progress', phase: 'IN_PROGRESS',
      project: 'proj', source: 'local', created_at: new Date().toISOString(),
    } as any)

    const sid = 'inc-dead-incarnation'
    // The NEW (recreated) stream file: a full clean turn, ~small.
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid), stateEvent(sid, 'idle')])
    await createSessionRecord(sid, task.id, 'proj', CWD)
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      // Watermark measured in the DEAD legacy file — far beyond the new file's EOF.
      consumedOffset: 37_982_175,
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: false })
    expect(outcome.converged).toBe(true)
    expect((outcome as { to?: string }).to).toBe('stopped')
    expect((await getTask(task.id)).phase).toBe('AGENT_COMPLETE')

    // The record must be durably healed: new-epoch stamp + watermark now a
    // coordinate of the NEW file (tracker accepted the regression because the
    // epoch changed in the same patch).
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(typeof after?.streamEpoch).toBe('string')
    expect(after!.consumedOffset!).toBeLessThan(37_982_175)
  })

  it('same-incarnation consumed result still vetoes (the fix must not break inc-1783644415695)', async () => {
    const sid = 'inc-still-vetoes'
    const lines = [initEvent(sid), userEvent(sid, 'yesterday'), resultEvent(sid, true)]
    await writeStream(sid, lines)
    const fileSize = lines.join('\n').length + 1
    // Record carries the CURRENT file's epoch → watermark is same-incarnation.
    const streamFile = path.join(streamsDir, `${sid}.jsonl`)
    const st = await fsp.stat(streamFile)
    await createSessionRecord(sid, '', 'proj', CWD, { pid: process.pid })
    const record = await updateSessionRecord(sid, {
      process_status: 'running',
      last_status_change: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      consumedOffset: fileSize,
      streamEpoch: `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`,
    })

    const outcome = await reconcileProcessStatus(record, { isAlive: true })
    expect(outcome).toEqual({ converged: false, reason: 'result-already-consumed' })
  })

  it('fetchStreamTailFold reports the stream file epoch', async () => {
    const sid = 'inc-epoch-reported'
    await writeStream(sid, [initEvent(sid), userEvent(sid), resultEvent(sid)])
    const result = await fetchStreamTailFold(sid, null)
    expect(typeof result).not.toBe('string')
    if (typeof result !== 'string') {
      const st = await fsp.stat(path.join(streamsDir, `${sid}.jsonl`))
      expect(result.streamEpoch).toBe(`${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`)
    }
  })
})
