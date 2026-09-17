/**
 * applySessionPhase integration tests for the 2026-08-03/04/05 status-mismatch
 * fixes that need real task + session records:
 *
 *  1. session:turn-start — the CLI's session_state_changed{running} pulls a
 *     task flipped to NEED_ACTION back to IN_PROGRESS (queued-send
 *     race, incidents 46f42871 + 1f11596b).
 *  2. triage-sync retired — it used to push NEED_ACTION → WAIT on a debounce
 *     after every turn. Retired 2026-08-17, and WAIT itself removed 2026-08-18;
 *     the trigger stays parseable and must be a no-op in every shape.
 *  3. session:result stale-result gate — a SESSION_RESULT whose turnGen is
 *     older than the live session's current turnGen belongs to a superseded
 *     turn and must not flip NEED_ACTION (incident ed347bde, 2026-08-05).
 *  4. read/unread marker — the phase write also carries task.unread, so a
 *     handed-back task can never be observed without its dot (2026-08-09).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

// Live-runner registry double for the stale-result gate: applySessionPhase
// dynamic-imports the session runner and reads the live instance's turnGen.
const liveTurnGens = new Map<string, number>()
const liveStatuses = new Map<string, string>()
const pendingPermissions = new Set<string>()
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    findSessionByClaudeId: (sid: string) => liveTurnGens.has(sid) ? {
      turnGen: liveTurnGens.get(sid)!,
      processStatus: liveStatuses.get(sid) ?? 'running',
      hasPendingPermission: pendingPermissions.has(sid),
    } : undefined,
  },
}))

import { applySessionPhase, sessionResultPhase } from '../../src/core/phase.js'
import { addTask, updateTaskRaw, getTask } from '../../src/core/task-manager.js'
import * as taskManager from '../../src/core/task-manager.js'
import {
  createSessionRecord,
  updateSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'

const HANDBACK_PHASE = sessionResultPhase('IN_PROGRESS')!
let tmpDir: string

beforeEach(async () => {
  tmpDir = WALNUT_HOME
  liveTurnGens.clear()
  liveStatuses.clear()
  pendingPermissions.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
  await fsp.mkdir(tmpDir, { recursive: true })
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

async function taskInPhase(phase: string): Promise<string> {
  const { task } = await addTask({ title: 't', project: 'p' })
  await updateTaskRaw(task.id, { phase: phase as never })
  return task.id
}

describe('applySessionPhase: session:turn-start', () => {
  it('INCIDENT SHAPE: NEED_ACTION → IN_PROGRESS when the queued turn actually starts', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    const res = await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('marks the task READ on the pullback (red row goes away)', async () => {
    // (WAIT removed 2026-08-18 — the unread/red phase this starts from is now
    // NEED_ACTION, which is where both a clean result and an error land.)
    const taskId = await taskInPhase(HANDBACK_PHASE)
    await updateTaskRaw(taskId, { unread: true })
    await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    const task = await getTask(taskId)
    expect(task.phase).toBe('IN_PROGRESS')
    expect(task.unread).toBe(false)
  })

  it('no-op on IN_PROGRESS (every turn re-fires the trigger)', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    expect(res.changed).toBe(false)
  })

  it('never overwrites a terminal phase', async () => {
    const taskId = await taskInPhase('COMPLETE')
    const res = await applySessionPhase(taskId, 'session:turn-start', 'test', { sessionId: 'sid-1' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('COMPLETE')
  })
})

describe('applySessionPhase: commit-time guards', () => {
  it('reads the committed answer phase while file-lock cleanup is still pending', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    liveTurnGens.set('sid-unlock', 3)
    await getTask(taskId)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reached!: () => void
    const unlocking = new Promise<void>((resolve) => { reached = resolve })
    const rm = fsp.rm
    const spy = vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === `${TASKS_FILE}.lock`) {
        reached()
        await gate
      }
      return rm(target, options)
    })
    const answer = applySessionPhase(taskId, 'session:human-answered', 'test', {
      sessionId: 'sid-unlock', turnGen: 3,
    })
    let completion: ReturnType<typeof applySessionPhase> | undefined
    try {
      await unlocking
      expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
      liveStatuses.set('sid-unlock', 'idle')
      let read!: () => void
      const readStarted = new Promise<void>((resolve) => { read = resolve })
      const get = taskManager.getTask
      vi.spyOn(taskManager, 'getTask').mockImplementationOnce(async (id) => {
        const task = await get(id)
        read()
        return task
      })
      completion = applySessionPhase(taskId, 'session:result', 'test', { sessionId: 'sid-unlock', turnGen: 3 })
      await readStarted
    } finally {
      release()
      await answer
      await completion
      spy.mockRestore()
    }
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it.each(['idle', 'stopped', 'error', 'permission', 'new-turn'])('rejects a turn-start superseded before the row write: %s', async (next) => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    liveTurnGens.set('sid-race', 3)
    const write = taskManager.updateTaskRaw
    const spy = vi.spyOn(taskManager, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      if (next === 'permission') pendingPermissions.add('sid-race')
      else if (next === 'new-turn') liveTurnGens.set('sid-race', 4)
      else liveStatuses.set('sid-race', next)
      return write(...args)
    })
    const result = await applySessionPhase(taskId, 'session:turn-start', 'test', {
      sessionId: 'sid-race', turnGen: 3,
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(result.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it.each(['idle', 'stopped', 'error', 'permission', 'new-turn'])('rejects a human answer superseded before the row write: %s', async (next) => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    await updateTaskRaw(taskId, { unread: true })
    liveTurnGens.set('sid-answer', 3)
    const write = taskManager.updateTaskRaw
    const spy = vi.spyOn(taskManager, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      if (next === 'permission') pendingPermissions.add('sid-answer')
      else if (next === 'new-turn') liveTurnGens.set('sid-answer', 4)
      else liveStatuses.set('sid-answer', next)
      return write(...args)
    })
    const result = await applySessionPhase(taskId, 'session:human-answered', 'test', {
      sessionId: 'sid-answer', turnGen: 3,
    })
    expect(spy).toHaveBeenCalledOnce()
    expect(result.changed).toBe(false)
    expect(await getTask(taskId)).toMatchObject({ phase: HANDBACK_PHASE, unread: true })
  })

  it('rejects an idle human-answer pullback even without a generation', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    liveTurnGens.set('sid-no-gen', 3)
    liveStatuses.set('sid-no-gen', 'idle')
    const result = await applySessionPhase(taskId, 'session:human-answered', 'test', { sessionId: 'sid-no-gen' })
    expect(result.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('lets authoritative snapshot evidence correct a stale idle runner', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    liveTurnGens.set('sid-snapshot', 3)
    liveStatuses.set('sid-snapshot', 'idle')
    const result = await applySessionPhase(taskId, 'session:turn-start', 'test', {
      sessionId: 'sid-snapshot', shouldApply: () => true,
    })
    expect(result.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('allows a human answer while the same turn is still running', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    liveTurnGens.set('sid-answer', 3)
    const result = await applySessionPhase(taskId, 'session:human-answered', 'test', {
      sessionId: 'sid-answer', turnGen: 3,
    })
    expect(result.changed).toBe(true)
    expect(await getTask(taskId)).toMatchObject({ phase: 'IN_PROGRESS', unread: false })
  })

  it('rejects a result when the next turn starts before the row write', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    liveTurnGens.set('sid-race', 3)
    const write = taskManager.updateTaskRaw
    vi.spyOn(taskManager, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      liveTurnGens.set('sid-race', 4)
      return write(...args)
    })
    const result = await applySessionPhase(taskId, 'session:result', 'test', {
      sessionId: 'sid-race', turnGen: 3,
    })
    expect(result.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it.each(['session:turn-start', 'session:result'] as const)('does not reopen a task completed before the row write: %s', async (trigger) => {
    const taskId = await taskInPhase(trigger === 'session:result' ? 'IN_PROGRESS' : HANDBACK_PHASE)
    const write = taskManager.updateTaskRaw
    vi.spyOn(taskManager, 'updateTaskRaw').mockImplementationOnce(async (...args) => {
      await write(taskId, { phase: 'COMPLETE' })
      return write(...args)
    })
    const result = await applySessionPhase(taskId, trigger, 'test')
    expect(result.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('COMPLETE')
  })
})

describe('applySessionPhase: triage-sync retired (inc-1786983019552, 2026-08-17)', () => {
  // The auto-upgrade NEED_ACTION → WAIT after every normal turn was pure
  // noise (both states render red+unread) and diluted WAIT. WAIT itself was
  // removed a day later (2026-08-18), so there is no longer any phase this
  // trigger could push to. The trigger stays parseable — a replayed event from
  // an old server must be a NO-OP in every shape, never a phase write.
  it('settled session (idle): triage-sync no longer pushes a phase', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    await createSessionRecord('sid-idle', taskId, 'proj')
    await updateSessionRecord('sid-idle', { process_status: 'idle' })

    const res = await applySessionPhase(taskId, 'triage-sync', 'test', { sessionId: 'sid-idle' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('running session: still a no-op (was the old gate, now unconditional)', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    await createSessionRecord('sid-running', taskId, 'proj')
    await updateSessionRecord('sid-running', { process_status: 'running' })

    const res = await applySessionPhase(taskId, 'triage-sync', 'test', { sessionId: 'sid-running' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('unknown session record: no-op (no fail-open write anymore)', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    const res = await applySessionPhase(taskId, 'triage-sync', 'test', { sessionId: 'sid-ghost' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })
})

describe('applySessionPhase: session:result stale-result gate (incident ed347bde)', () => {
  it('STALE: live turnGen ahead of the event → NEED_ACTION flip skipped', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    liveTurnGens.set('sid-gen', 4) // the init-after-result edge already bumped to 4

    const res = await applySessionPhase(taskId, 'session:result', 'test', {
      sessionId: 'sid-gen', turnGen: 3, // event was stamped during turn 3
    })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('IN_PROGRESS')
  })

  it('NORMAL FLOW: equal turnGen → flip proceeds to NEED_ACTION', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    liveTurnGens.set('sid-gen', 3)

    const res = await applySessionPhase(taskId, 'session:result', 'test', {
      sessionId: 'sid-gen', turnGen: 3,
    })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('no live session instance → gate fails open (pre-fix behavior)', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    // liveTurnGens empty → findSessionByClaudeId returns undefined
    const res = await applySessionPhase(taskId, 'session:result', 'test', {
      sessionId: 'sid-detached', turnGen: 1,
    })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })

  it('no turnGen in opts (non-CLI emitter / legacy payload) → gate fails open', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    liveTurnGens.set('sid-gen', 9) // even a far-ahead live gen cannot gate an unstamped event

    const res = await applySessionPhase(taskId, 'session:result', 'test', { sessionId: 'sid-gen' })
    expect(res.changed).toBe(true)
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)
  })
})

// ── Read/unread lifecycle ──────────────────────────────────────────────────
//
// THE BUG THIS LOCKS DOWN (2026-08-09): the marker was only ever set on
// WAIT, so the dot appeared when a session ERRORED and stayed dark
// when a session finished NORMALLY (NEED_ACTION) — which is the overwhelmingly
// common case. "Session finished, go look at it" was therefore invisible, and the
// feature read as "needs attention on failure" instead of "unread".
// (WAIT removed 2026-08-18: both paths now land on NEED_ACTION, so that phase
// is the ONE phase that sets the dot — see readMarkerForPhase.)
describe('applySessionPhase: read/unread marker rides the phase write', () => {
  it('NEED_ACTION marks the task UNREAD (the normal turn-finished path)', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    await applySessionPhase(taskId, 'session:result', 'test', { sessionId: 'sid-r' })
    const task = await getTask(taskId)
    expect(task.phase).toBe(HANDBACK_PHASE)
    expect(task.unread).toBe(true)
  })

  // (WAIT removed 2026-08-18 — the error path lands on the SAME NEED_ACTION
  // as a clean result; the "it failed" signal is the session's error badge.)
  it('the error path also lands on NEED_ACTION and marks the task UNREAD', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    await applySessionPhase(taskId, 'session:error', 'test', { sessionId: 'sid-e' })
    const task = await getTask(taskId)
    expect(task.phase).toBe(HANDBACK_PHASE)
    expect(task.unread).toBe(true)
  })

  // session:streaming is retired with WAIT (2026-08-18) — it only ever existed
  // to undo a stale error→WAIT repaint. It must now touch nothing.
  it('session:streaming is a no-op and leaves the phase + marker alone', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    await updateTaskRaw(taskId, { unread: true })

    const res = await applySessionPhase(taskId, 'session:streaming', 'test', { sessionId: 'sid-s' })
    expect(res.changed).toBe(false)
    const task = await getTask(taskId)
    expect(task.phase).toBe(HANDBACK_PHASE)
    expect(task.unread).toBe(true)
  })

  it('IN_PROGRESS marks it READ — a new turn supersedes the pending output', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    await applySessionPhase(taskId, 'session:input', 'test', { sessionId: 'sid-i' })
    const task = await getTask(taskId)
    expect(task.phase).toBe('IN_PROGRESS')
    expect(task.unread).toBe(false)
  })

  it('permission request (awaiting-human) → NEED_ACTION + UNREAD (agent blocked on a human)', async () => {
    // 2026-08-18 user call: permission / AskUserQuestion / plan approval all
    // mean the agent is done until a human acts — same red row as a result.
    const taskId = await taskInPhase('IN_PROGRESS')
    const res = await applySessionPhase(taskId, 'session:awaiting-human', 'test', { sessionId: 'sid-p' })
    expect(res.changed).toBe(true)
    const task = await getTask(taskId)
    expect(task.phase).toBe(HANDBACK_PHASE)
    expect(task.unread).toBe(true)
  })

  it('awaiting-human no-ops on NEED_ACTION (60s re-emit must not churn)', async () => {
    const taskId = await taskInPhase(HANDBACK_PHASE)
    const res = await applySessionPhase(taskId, 'session:awaiting-human', 'test', { sessionId: 'sid-p' })
    expect(res.changed).toBe(false)
  })

  it('awaiting-human never overwrites a terminal phase', async () => {
    const taskId = await taskInPhase('COMPLETE')
    const res = await applySessionPhase(taskId, 'session:awaiting-human', 'test', { sessionId: 'sid-p' })
    expect(res.changed).toBe(false)
    expect((await getTask(taskId)).phase).toBe('COMPLETE')
  })

  it('human answered → IN_PROGRESS + READ (the agent resumes, red clears)', async () => {
    const taskId = await taskInPhase('IN_PROGRESS')
    await applySessionPhase(taskId, 'session:awaiting-human', 'test', { sessionId: 'sid-p' })
    expect((await getTask(taskId)).phase).toBe(HANDBACK_PHASE)

    const res = await applySessionPhase(taskId, 'session:human-answered', 'test', { sessionId: 'sid-p' })
    expect(res.changed).toBe(true)
    const task = await getTask(taskId)
    expect(task.phase).toBe('IN_PROGRESS')
    expect(task.unread).toBe(false)
  })

  it('a task the user already read goes unread again on the NEXT turn end', async () => {
    // Full round trip: agent finishes → unread → user opens it (read) → agent
    // finishes another turn → unread again. The old code could not express the
    // second half, because a re-focus of an already-focused task was a no-op.
    const taskId = await taskInPhase('IN_PROGRESS')
    await applySessionPhase(taskId, 'session:result', 'test', { sessionId: 'sid-cycle' })
    expect((await getTask(taskId)).unread).toBe(true)

    await updateTaskRaw(taskId, { unread: false }) // the UI's read event
    expect((await getTask(taskId)).unread).toBe(false)

    await applySessionPhase(taskId, 'session:input', 'test', { sessionId: 'sid-cycle' })
    await applySessionPhase(taskId, 'session:result', 'test', { sessionId: 'sid-cycle' })
    expect((await getTask(taskId)).unread).toBe(true)
  })
})
