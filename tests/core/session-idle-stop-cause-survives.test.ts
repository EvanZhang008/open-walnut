/**
 * An idle auto-stop keeps its explanation instead of becoming a cause-less row.
 *
 * The server's idle reaper writes ('health-monitor','idle_timeout') +
 * `process_status: 'stopped'` + "No output for N min". That pair is category-①,
 * so for a snapshot-covered session the gate drops the patch WHOLE. Two things
 * then went wrong at once (both observed on a real LOCAL session, 2026-09-03):
 *
 *   1. The gate only stashed the dropped explanation when the patch said
 *      'error'. For 'stopped' the one sentence that knew WHY was destroyed.
 *   2. applySnapshot cleared `errorMessage` on every non-error projection, so
 *      even a stashed cause could not reach the record.
 *
 * The visible result: the calm "Auto-stopped after N min idle" banner (which the
 * UI keys off exactly `No output for N min`) could never render for a covered
 * session, and once the exit code was ALSO mis-read the row went red with
 * "Session ended unexpectedly and no cause was recorded".
 *
 * What must stay true: a LIVE projection still adopts nothing (the session is
 * running, so any explanation is by definition about the past), and a real
 * first-hand message is never replaced by a stash.
 *
 * MACHINE SAFETY: isolated tmp WALNUT_HOME via createMockConstants. No daemons,
 * no ports, no signals, no ~/.open-walnut.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-idle-cause'))

vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findSessionByClaudeId: () => undefined },
}))

import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import {
  applySnapshot,
  setSnapshotModeForTests,
  markSnapshotCovered,
  _resetSnapshotGateForTests,
  _resetSnapshotApplyForTests,
} from '../../src/core/session-snapshot-apply.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'

/** A settled fold of a process the daemon reports as intentionally stopped:
 *  exitCode 0 (reapSession normalized it on the intentional-stop stamp) and a
 *  clean final result. projectProcessStatus maps this to 'stopped'. */
function stoppedSnap(v = 500): SessionSnapshot {
  return {
    v,
    cliState: 'dead',
    turnActive: false,
    pendingPermission: null,
    gatingBgCount: 0,
    teamActive: false,
    lastResult: { isError: false, endOffset: v },
    pid: null,
    exitCode: 0,
  }
}

function runningSnap(v = 500): SessionSnapshot {
  return {
    v,
    cliState: 'running',
    turnActive: true,
    pendingPermission: null,
    gatingBgCount: 0,
    teamActive: false,
    lastResult: null,
    pid: 4242,
    exitCode: null,
  }
}

async function seed(sid: string, extra: Record<string, unknown> = {}): Promise<void> {
  await createSessionRecord(sid, '', 'proj', '/tmp/idle-cause', { pid: process.pid })
  if (Object.keys(extra).length > 0) await updateSessionRecord(sid, extra as never)
}

/** The exact write the server's idle reaper issues. Category-① → gated. */
async function idleReaperWrite(sid: string, minutes: number): Promise<void> {
  await updateSessionRecord(sid, {
    process_status: 'stopped',
    errorMessage: `No output for ${minutes} min`,
    activity: undefined,
    last_status_change: new Date().toISOString(),
    status_reason: 'idle_timeout',
    status_changed_by: 'health-monitor',
  } as never)
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  setSnapshotModeForTests('enforce')
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('idle auto-stop on a snapshot-covered session', () => {
  it('the gate drops the reaper patch but the projection restores its sentence', async () => {
    const sid = 'idle-covered'
    await seed(sid, { process_status: 'idle' })
    markSnapshotCovered(sid, 100)

    await idleReaperWrite(sid, 120)
    // The gate dropped it whole: the record still says idle, no message.
    const gated = await getSessionByClaudeId(sid)
    expect(gated?.process_status).toBe('idle')
    expect(gated?.errorMessage ?? null).toBeNull()

    await applySnapshot(sid, stoppedSnap(), 'pull-30s')

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    // Exactly the string the calm idle banner matches on.
    expect(after?.errorMessage).toBe('No output for 120 min')
  })

  it('the adopted cause makes the record positively TERMINAL, so nothing re-probes it', async () => {
    const sid = 'idle-terminal'
    await seed(sid, { process_status: 'idle' })
    markSnapshotCovered(sid, 100)
    await idleReaperWrite(sid, 90)
    await applySnapshot(sid, stoppedSnap(), 'pull-30s')

    const after = await getSessionByClaudeId(sid)
    // 'idle_timeout' classifies terminal — carried over as errorKind so the
    // re-examination lane leaves a settled stop alone.
    expect(after?.errorKind).toBe('terminal')
    const { classifySessionError, isRescuableStoppedRecord } =
      await import('../../src/core/session-error-kind.js')
    expect(classifySessionError(after!)).toBe('terminal')
    expect(isRescuableStoppedRecord(after!)).toBe(false)
  })

  it('a LIVE projection adopts nothing — a running session has no cause to show', async () => {
    const sid = 'idle-then-live'
    await seed(sid, { process_status: 'idle' })
    markSnapshotCovered(sid, 100)
    await idleReaperWrite(sid, 120)

    await applySnapshot(sid, runningSnap(), 'pull-30s')

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    expect(after?.errorMessage ?? null).toBeNull()
    expect(after?.errorKind ?? null).toBeNull()
  })

  it('a stale message from an older episode is still cleared on a live projection', async () => {
    const sid = 'stale-cleared'
    await seed(sid, {
      process_status: 'error',
      errorMessage: 'Something broke two hours ago',
      errorKind: 'unknown',
    })
    markSnapshotCovered(sid, 100)

    await applySnapshot(sid, runningSnap(), 'pull-30s')

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    expect(after?.errorMessage ?? null).toBeNull()
  })

  it('with no stashed cause a stopped projection stays cause-less (nothing invented)', async () => {
    const sid = 'no-stash'
    await seed(sid, { process_status: 'idle' })
    markSnapshotCovered(sid, 100)

    await applySnapshot(sid, stoppedSnap(), 'pull-30s')

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.errorMessage ?? null).toBeNull()
  })

  it('a user stop is NOT gated, so its own labels land and no stash is involved', async () => {
    const sid = 'user-stop'
    await seed(sid, { process_status: 'running' })
    markSnapshotCovered(sid, 100)

    // Category-② user intent — the gate always passes this.
    await updateSessionRecord(sid, {
      process_status: 'stopped',
      status_reason: 'user_stopped',
      status_changed_by: 'user',
      last_status_change: new Date().toISOString(),
    } as never)

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.status_reason).toBe('user_stopped')
    expect(after?.errorMessage ?? null).toBeNull()
  })

  it('an UNcovered session never reaches the stash path — the reaper write just lands', async () => {
    const sid = 'uncovered'
    await seed(sid, { process_status: 'idle' })
    // deliberately NOT markSnapshotCovered

    await idleReaperWrite(sid, 150)

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.errorMessage).toBe('No output for 150 min')
    expect(after?.status_reason).toBe('idle_timeout')
  })
})
