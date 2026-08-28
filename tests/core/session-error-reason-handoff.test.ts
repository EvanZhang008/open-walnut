/**
 * Integration test for the gate → stash → projection hand-off that fixes
 * inc-1787439819342 (2026-08-22).
 *
 * THE INCIDENT, in three modules. A remote dev host took its weekly patch reboot
 * mid-build:
 *   1. session-health-monitor wrote `error` + `remote_unreachable` + "Connection
 *      lost — unable to reach remote host". It was the ONLY writer that knew why.
 *   2. session-tracker's C2 enforce gate dropped that write WHOLE, because
 *      ('health-monitor','remote_unreachable') is a category-① pair and the
 *      snapshot projection is the sole status writer for covered sessions.
 *   3. session-snapshot-apply then projected `error` with NO message, because the
 *      snapshot has no text to offer and is not allowed to invent one.
 * Result: `errorMessage: null`, which both recovery paths read as "a real
 * user-visible error, don't auto-recover". The session stayed dead for 3.5 hours
 * after the host was healthy, and 51 sessions were in that state.
 *
 * These tests run the REAL tracker (isolated SQLite) and the REAL projection, so
 * they fail if any of the three links is broken again.
 *
 * MACHINE SAFETY: isolated tmp WALNUT_HOME via createMockConstants; no daemons,
 * no ports, no ~/.open-walnut.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-reason-handoff'))

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
  takeSuppressedErrorReason,
  _suppressedReasonSizeForTests,
  SUPPRESSED_REASON_TTL_MS,
} from '../../src/core/session-snapshot-gate.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus } from '../../src/core/event-bus.js'
import { isRecoverableSessionError, isInfraSessionError } from '../../src/core/session-error-kind.js'
import { WALNUT_HOME } from '../../src/constants.js'

/** The daemon's verdict after the host came back: process gone, dirty exit. */
function deadSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    v: 200,
    cliState: 'dead',
    turnActive: false,
    pendingPermission: null,
    gatingBgCount: 0,
    teamActive: false,
    lastResult: { isError: true, endOffset: 190 },
    pid: null,
    exitCode: -1,
    ...overrides,
  } as SessionSnapshot
}

const SID = 'sess-reboot'

async function seed(): Promise<void> {
  await createSessionRecord(SID, 'task-1', 'proj', '/tmp/handoff', { pid: process.pid })
  await updateSessionRecord(SID, { host: 'clouddev', process_status: 'running' } as never)
  // Covered = a snapshot has been applied this process lifetime, which is what
  // arms the enforce-mode gate for this sid.
  markSnapshotCovered(SID, 100)
}

/** Exactly the write session-health-monitor makes when a remote host stops
 *  answering (see the `if (session.host)` branch of its liveness loop). */
async function healthMonitorUnreachableWrite(): Promise<void> {
  await updateSessionRecord(SID, {
    process_status: 'error',
    errorMessage: 'Connection lost — unable to reach remote host',
    errorKind: 'infra',
    activity: undefined,
    last_status_change: new Date().toISOString(),
    status_reason: 'remote_unreachable',
    status_changed_by: 'health-monitor',
  } as never)
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  setSnapshotModeForTests('enforce')
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  setSnapshotModeForTests(null)
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the gate still drops the write (the contract is unchanged)', () => {
  it('a category-① error write does not change process_status on a covered session', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    const rec = await getSessionByClaudeId(SID)
    // Status verdict still belongs to the snapshot alone.
    expect(rec?.process_status).toBe('running')
    expect(rec?.errorMessage).toBeFalsy()
  })

  it('but the diagnosis is stashed instead of thrown away', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    const stashed = takeSuppressedErrorReason(SID)
    expect(stashed).not.toBeNull()
    expect(stashed!.reason).toBe('remote_unreachable')
    expect(stashed!.kind).toBe('infra')
    expect(stashed!.message).toContain('Connection lost')
  })
})

describe('the projection adopts the stashed diagnosis', () => {
  it('an error projection is labelled instead of blank — the incident, fixed', async () => {
    await seed()
    await healthMonitorUnreachableWrite()

    const applied = await applySnapshot(SID, deadSnapshot(), 'reconnect-pull')
    expect(applied.outcome).toBe('applied')

    const rec = await getSessionByClaudeId(SID)
    expect(rec?.process_status).toBe('error')
    // The status_reason still records WHO wrote the status (the projection)...
    expect(rec?.status_reason).toBe('snapshot_projection')
    // ...while the human-readable cause and the machine-readable class survive.
    expect(rec?.errorMessage).toContain('Connection lost')
    expect(rec?.errorKind).toBe('infra')
  })

  it('the resulting record is BOTH recoverable and auto-resumable', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    await applySnapshot(SID, deadSnapshot(), 'reconnect-pull')

    const rec = (await getSessionByClaudeId(SID))!
    // This is the assertion the incident failed on: with a blank message both
    // recovery paths skipped the session forever.
    expect(isRecoverableSessionError(rec)).toBe(true)
    expect(isInfraSessionError(rec)).toBe(true)
  })

  it('consumes the stash — one diagnosis explains ONE transition', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    expect(_suppressedReasonSizeForTests()).toBe(1)
    await applySnapshot(SID, deadSnapshot(), 'reconnect-pull')
    expect(_suppressedReasonSizeForTests()).toBe(0)
  })

  it('never overwrites a message the record already has', async () => {
    await seed()
    // A writer with first-hand knowledge (not gated) already labelled the record.
    await updateSessionRecord(SID, {
      errorMessage: 'Remote session exited with code -1 — out of disk',
      status_reason: 'user_terminated',
      status_changed_by: 'user',
    } as never)
    await healthMonitorUnreachableWrite()
    await applySnapshot(SID, deadSnapshot(), 'reconnect-pull')

    const rec = await getSessionByClaudeId(SID)
    expect(rec?.errorMessage).toContain('out of disk')
  })

  it('a stale diagnosis does not label a much later, unrelated error', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    // Simulate the projection arriving long after the outage the stash describes.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SUPPRESSED_REASON_TTL_MS + 1_000)
    await applySnapshot(SID, deadSnapshot(), 'reconnect-pull')
    vi.restoreAllMocks()

    const rec = await getSessionByClaudeId(SID)
    expect(rec?.process_status).toBe('error')
    expect(rec?.errorMessage).toBeFalsy()
  })
})

describe('non-error convergence', () => {
  it('clears both the message and the kind so an old outage cannot label a new one', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    await applySnapshot(SID, deadSnapshot(), 'reconnect-pull')
    expect((await getSessionByClaudeId(SID))?.errorKind).toBe('infra')

    // The session comes back (auto-recover resumed it, or the user did).
    await applySnapshot(SID, {
      ...deadSnapshot({ v: 300 }), cliState: 'running', turnActive: true,
      lastResult: null, pid: 5555, exitCode: null,
    } as SessionSnapshot, 'event')

    const rec = await getSessionByClaudeId(SID)
    expect(rec?.process_status).toBe('running')
    expect(rec?.errorMessage).toBeFalsy()
    expect(rec?.errorKind).toBeFalsy()
  })

  it('drops any pending stash on a healthy convergence', async () => {
    await seed()
    await healthMonitorUnreachableWrite()
    expect(_suppressedReasonSizeForTests()).toBe(1)
    await applySnapshot(SID, {
      ...deadSnapshot({ v: 300 }), cliState: 'running', turnActive: true,
      lastResult: null, pid: 5555, exitCode: null,
    } as SessionSnapshot, 'event')
    expect(_suppressedReasonSizeForTests()).toBe(0)
  })
})
