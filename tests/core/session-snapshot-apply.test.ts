/**
 * C2 session-snapshot-apply — projection + v-gate + shadow/enforce semantics
 * (docs/plan/session-snapshot-source-of-truth.md §5, acceptance layer 4).
 *
 * Uses the REAL session-tracker over an isolated SQLite (mock-constants tmp
 * home) — the conditional write, consumedOffset arbitration, status_history
 * and the enforce-mode legacy-writer gate all execute production code. Only
 * the session runner (live in-memory sync) is mocked.
 *
 * MACHINE SAFETY: isolated tmp WALNUT_HOME via createMockConstants; no
 * daemons, no ports, no ~/.open-walnut.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-snap-apply'))

// Live runner registry: applySnapshot (enforce) syncs the in-memory status of
// a live ClaudeCodeSession via setProcessStatusFromReconciler.
const liveRunnerSync = vi.fn()
const liveWatermarkReset = vi.fn()
let liveSessionId: string | null = null
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    findSessionByClaudeId: (sid: string) =>
      sid === liveSessionId
        ? { setProcessStatusFromReconciler: liveRunnerSync, resetConsumedOffsetFromSnapshot: liveWatermarkReset }
        : undefined,
  },
}))

import type { SessionSnapshot } from '../../src/providers/daemon-fold.js'
import {
  projectProcessStatus,
  applySnapshot,
  setSnapshotModeForTests,
  isSnapshotCovered,
  markSnapshotCovered,
  getAppliedV,
  getDivergenceCounters,
  _resetSnapshotGateForTests,
  _resetSnapshotApplyForTests,
} from '../../src/core/session-snapshot-apply.js'
import {
  createSessionRecord,
  updateSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js'
import { addTask, updateTaskRaw, getTask } from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/session-db.js'
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import { log } from '../../src/logging/index.js'
import { WALNUT_HOME } from '../../src/constants.js'

// ── snapshot factory ──
function snap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    v: 100,
    cliState: 'running',
    turnActive: true,
    pendingPermission: null,
    gatingBgCount: 0,
    teamActive: false,
    lastResult: null,
    pid: 4242,
    exitCode: null,
    ...overrides,
  }
}

async function seedSession(sid: string, extra: Record<string, unknown> = {}): Promise<void> {
  await createSessionRecord(sid, '', 'proj', '/tmp/snap-apply', { pid: process.pid })
  if (Object.keys(extra).length > 0) await updateSessionRecord(sid, extra as never)
}

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  _resetSnapshotGateForTests()
  _resetSnapshotApplyForTests()
  bus.clear()
  liveSessionId = null
  liveRunnerSync.mockClear()
  liveWatermarkReset.mockClear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
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

// ── projection table (contract §5, exact order) ──
describe('projectProcessStatus — projection table', () => {
  it('dead + error result → error', () => {
    expect(projectProcessStatus(snap({
      cliState: 'dead', turnActive: false, exitCode: 0,
      lastResult: { isError: true, endOffset: 90 },
    }))).toBe('error')
  })

  it('dead + non-zero exit → error (even with clean lastResult)', () => {
    expect(projectProcessStatus(snap({
      cliState: 'dead', turnActive: false, exitCode: 137,
      lastResult: { isError: false, endOffset: 90 },
    }))).toBe('error')
  })

  it('dead + clean exit + clean result → stopped', () => {
    expect(projectProcessStatus(snap({
      cliState: 'dead', turnActive: false, exitCode: 0,
      lastResult: { isError: false, endOffset: 90 },
    }))).toBe('stopped')
  })

  it('dead + null exitCode + no result → stopped (exitCode ?? 0)', () => {
    expect(projectProcessStatus(snap({
      cliState: 'dead', turnActive: false, exitCode: null, lastResult: null,
    }))).toBe('stopped')
  })

  it('waiting → running (display-layer waiting; frozen v1 enum)', () => {
    expect(projectProcessStatus(snap({
      cliState: 'waiting', turnActive: true,
      pendingPermission: { requestId: 'req-1', toolName: 'Bash' },
    }))).toBe('running')
    // waiting outranks a trailing error result — the turn is paused, not over.
    expect(projectProcessStatus(snap({
      cliState: 'waiting', turnActive: false,
      lastResult: { isError: true, endOffset: 50 },
    }))).toBe('running')
  })

  it('turnActive → running', () => {
    expect(projectProcessStatus(snap({ cliState: 'running', turnActive: true }))).toBe('running')
    // turnActive outranks a (stale) error result — running invalidates it.
    expect(projectProcessStatus(snap({
      cliState: 'running', turnActive: true,
      lastResult: { isError: true, endOffset: 50 },
    }))).toBe('running')
  })

  it('idle + error result → error', () => {
    expect(projectProcessStatus(snap({
      cliState: 'idle', turnActive: false,
      lastResult: { isError: true, endOffset: 90 },
    }))).toBe('error')
  })

  it('idle + clean result → idle', () => {
    expect(projectProcessStatus(snap({
      cliState: 'idle', turnActive: false,
      lastResult: { isError: false, numTurns: 1, endOffset: 90 },
    }))).toBe('idle')
  })

  it('idle + no result → idle', () => {
    expect(projectProcessStatus(snap({ cliState: 'idle', turnActive: false }))).toBe('idle')
  })
})

// ── v-gate ──
describe('applySnapshot — v-gate', () => {
  it('drops a snapshot older than the in-memory watermark (stale)', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'vgate-stale'
    await seedSession(sid, { process_status: 'running' })
    const first = await applySnapshot(sid, snap({ v: 500 }), 'test')
    expect(first.outcome).toBe('shadow')
    const stale = await applySnapshot(sid, snap({ v: 400 }), 'test')
    expect(stale.outcome).toBe('stale')
  })

  it('equal v with identical projection is a noop (idempotence)', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'vgate-idem'
    await seedSession(sid, { process_status: 'running' })
    await applySnapshot(sid, snap({ v: 500, turnActive: true }), 'test')
    const dup = await applySnapshot(sid, snap({ v: 500, turnActive: true }), 'test')
    expect(dup.outcome).toBe('noop')
  })

  it('seeds the watermark from record.consumedOffset on first sight', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'vgate-seed'
    await seedSession(sid, { process_status: 'running', consumedOffset: 1000 })
    // v below the durable watermark → stale on the VERY FIRST apply.
    const below = await applySnapshot(sid, snap({ v: 900 }), 'test')
    expect(below.outcome).toBe('stale')
    // v AT the watermark with an identical projection → pure duplicate (noop).
    const at = await applySnapshot(sid, snap({ v: 1000, turnActive: true }), 'test')
    expect(at.outcome).toBe('noop')
    // v beyond the watermark passes the gate and is evaluated.
    const beyond = await applySnapshot(sid, snap({ v: 1100 }), 'test')
    expect(beyond.outcome).toBe('shadow')
  })
})

// ── shadow mode ──
describe('applySnapshot — shadow mode', () => {
  it('logs divergence and does NOT write the record', async () => {
    setSnapshotModeForTests('shadow')
    const warnSpy = vi.spyOn(log.session, 'warn')
    const sid = 'shadow-diverge'
    await seedSession(sid, { process_status: 'running' })

    // Snapshot says the turn settled → projected 'idle' ≠ actual 'running'.
    const res = await applySnapshot(sid, snap({
      v: 800, cliState: 'idle', turnActive: false,
      lastResult: { isError: false, endOffset: 780 },
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'shadow', diverged: true, projected: 'idle' })

    const divergenceCall = warnSpy.mock.calls.find(([msg]) => msg === 'snapshot-shadow divergence')
    expect(divergenceCall, 'divergence must be logged').toBeTruthy()
    expect(divergenceCall![1]).toMatchObject({
      sessionId: sid, projected: 'idle', actual: 'running', v: 800, source: 'daemon-push',
    })

    // Record untouched.
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    expect(after?.status_changed_by).not.toBe('snapshot')
  })

  it('no divergence → no warn, still marks the session covered', async () => {
    setSnapshotModeForTests('shadow')
    const warnSpy = vi.spyOn(log.session, 'warn')
    const sid = 'shadow-agree'
    await seedSession(sid, { process_status: 'running' })
    const res = await applySnapshot(sid, snap({ v: 300, turnActive: true }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'shadow', diverged: false })
    expect(warnSpy.mock.calls.find(([msg]) => msg === 'snapshot-shadow divergence')).toBeUndefined()
    expect(isSnapshotCovered(sid)).toBe(true)
  })
})

// ── enforce mode ──
describe('applySnapshot — enforce mode', () => {
  it('writes the projection, adopts the watermark, and emits status-changed', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'enforce-write'
    await seedSession(sid, { process_status: 'running', errorMessage: 'stale error text' })

    const events: BusEvent[] = []
    bus.subscribe('snap-apply-test', (e) => {
      if (e.name === EventNames.SESSION_STATUS_CHANGED) events.push(e)
    })

    const res = await applySnapshot(sid, snap({
      v: 900, cliState: 'idle', turnActive: false,
      lastResult: { isError: false, endOffset: 880 },
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'idle' })

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('idle')
    expect(after?.consumedOffset).toBe(900)
    expect(after?.status_reason).toBe('snapshot_projection')
    expect(after?.status_changed_by).toBe('snapshot')
    expect(after?.errorMessage == null).toBe(true) // cleared on non-error

    const mine = events.filter((e) => (e.data as { sessionId?: string }).sessionId === sid)
    expect(mine.length).toBe(1)
    expect((mine[0].data as { process_status?: string }).process_status).toBe('idle')
  })

  it('projects dead+error → error and preserves the terminal PID clear', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'enforce-dead-error'
    await seedSession(sid, { process_status: 'running' })
    const res = await applySnapshot(sid, snap({
      v: 700, cliState: 'dead', turnActive: false, exitCode: 1,
      lastResult: { isError: true, endOffset: 680 },
    }), 'reconnect-pull')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'error' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('error')
    // applyUpdateToSession clears PID on terminal transition — reused, not reimplemented.
    expect(after?.pid == null).toBe(true)
  })

  it('is idempotent: re-applying the same snapshot is a noop (no second emit)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'enforce-idem'
    await seedSession(sid, { process_status: 'running' })
    const s = snap({ v: 600, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 580 } })
    expect((await applySnapshot(sid, s, 'test')).outcome).toBe('applied')

    const events: BusEvent[] = []
    bus.subscribe('snap-apply-idem', (e) => {
      if (e.name === EventNames.SESSION_STATUS_CHANGED) events.push(e)
    })
    const second = await applySnapshot(sid, s, 'test')
    expect(second.outcome).toBe('noop')
    expect(events.length).toBe(0)
  })

  it('syncs the live runner in-memory status when a live instance exists', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'enforce-runner-sync'
    liveSessionId = sid
    await seedSession(sid, { process_status: 'running' })
    await applySnapshot(sid, snap({
      v: 500, cliState: 'idle', turnActive: false,
      lastResult: { isError: false, endOffset: 480 },
    }), 'daemon-push')
    expect(liveRunnerSync).toHaveBeenCalledWith('idle')
  })

  it('no live runner instance → apply still succeeds without the sync', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'enforce-no-runner'
    liveSessionId = null
    await seedSession(sid, { process_status: 'running' })
    const res = await applySnapshot(sid, snap({
      v: 500, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 480 },
    }), 'daemon-push')
    expect(res.outcome).toBe('applied')
    expect(liveRunnerSync).not.toHaveBeenCalled()
  })
})

// ── exclusions ──
describe('applySnapshot — exclusions (contract §5 step 4)', () => {
  it('mode off → disabled, nothing runs', async () => {
    setSnapshotModeForTests('off')
    const sid = 'excl-off'
    await seedSession(sid, { process_status: 'running' })
    expect((await applySnapshot(sid, snap({ v: 100 }), 'test')).outcome).toBe('disabled')
  })

  it('unknown session → no-record', async () => {
    setSnapshotModeForTests('enforce')
    expect((await applySnapshot('excl-missing', snap(), 'test')).outcome).toBe('no-record')
  })

  it('codex engine is excluded', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'excl-codex'
    await seedSession(sid, { process_status: 'running', engine: 'codex' })
    const res = await applySnapshot(sid, snap({ v: 100, cliState: 'idle', turnActive: false }), 'test')
    expect(res).toMatchObject({ outcome: 'excluded', reason: 'engine-codex' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
    expect(isSnapshotCovered(sid)).toBe(false)
  })

  it('embedded provider is excluded', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'excl-embedded'
    await seedSession(sid, { process_status: 'running', provider: 'embedded' })
    const res = await applySnapshot(sid, snap({ v: 100 }), 'test')
    expect(res).toMatchObject({ outcome: 'excluded', reason: 'provider-embedded' })
  })

  it('awaiting_spawn pre-spawn record is excluded', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'excl-awaiting'
    await seedSession(sid, {
      process_status: 'running', status_reason: 'awaiting_spawn', status_changed_by: 'system',
    })
    const res = await applySnapshot(sid, snap({ v: 100 }), 'test')
    expect(res).toMatchObject({ outcome: 'excluded', reason: 'awaiting-spawn' })
  })

  it('user-terminal intent is not revived by a snapshot without new evidence', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'excl-user-terminal'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'user_stopped', status_changed_by: 'user',
      consumedOffset: 1000,
    })
    // Snapshot with v <= consumedOffset: no new evidence past the user's stop.
    const res = await applySnapshot(sid, snap({ v: 1000, cliState: 'running', turnActive: true }), 'test')
    expect(res).toMatchObject({ outcome: 'skipped', reason: 'user-terminal-intent' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')

    // NEW evidence (v beyond the watermark) may converge again.
    const fresh = await applySnapshot(sid, snap({ v: 2000, cliState: 'running', turnActive: true }), 'test')
    expect(fresh.outcome).toBe('applied')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })
})

// ── C4: user Stop must not be relabeled 'error' by the reap's death snapshot ──
describe('applySnapshot — user terminal intent outranks snapshot LABELING (C4)', () => {
  it('a death snapshot with v BEYOND the watermark cannot flip user_stopped → error', async () => {
    // The real incident shape: the user clicks Stop mid-turn → walnut records
    // ('user','user_stopped','stopped') and kills the CLI. The daemon reaps a
    // process that never wrote a clean result, so the death snapshot carries a
    // non-zero exitCode AND a v past the record's watermark (the kill appends
    // stream bytes). A v-only gate lets it through and the user sees a red
    // failure for the action they deliberately took.
    setSnapshotModeForTests('enforce')
    const sid = 'c4-stop-then-reap'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'user_stopped', status_changed_by: 'user',
      consumedOffset: 1000,
    })
    const res = await applySnapshot(sid, snap({
      v: 9999, // NEW evidence positionally — but it only carries a LABEL
      cliState: 'dead', turnActive: false, exitCode: 137, pid: null,
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'skipped', reason: 'user-terminal-intent' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.status_reason).toBe('user_stopped')
  })

  it('the same veto covers user_terminated and a user-written error record', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c4-terminated'
    await seedSession(sid, {
      process_status: 'error', status_reason: 'user_terminated', status_changed_by: 'user',
      consumedOffset: 10,
    })
    const res = await applySnapshot(sid, snap({
      v: 500, cliState: 'dead', turnActive: false, exitCode: 0, pid: null,
    }), 'daemon-push')
    // error → stopped is still only a relabel of a user-decided terminal state.
    expect(res).toMatchObject({ outcome: 'skipped', reason: 'user-terminal-intent' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('error')
  })

  it('OTHER DIRECTION: a projected running/idle beyond the watermark DOES supersede (the stop did not take)', async () => {
    // The veto is scoped to LABELING (terminal → terminal). A projection that
    // CONTRADICTS the terminal verdict is a real fact — the CLI is demonstrably
    // alive, so the stop failed and the record is lying to the user.
    setSnapshotModeForTests('enforce')
    const sid = 'c4-stop-did-not-take'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'user_stopped', status_changed_by: 'user',
      consumedOffset: 1000,
    })
    const res = await applySnapshot(sid, snap({ v: 4000, cliState: 'running', turnActive: true }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'running' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('a NON-user terminal record is still converged by a death snapshot (veto is user-scoped)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c4-system-terminal'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'daemon_reported_exit', status_changed_by: 'daemon',
      consumedOffset: 100,
    })
    const res = await applySnapshot(sid, snap({
      v: 900, cliState: 'dead', turnActive: false, exitCode: 137, pid: null,
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'error' })
  })

  it("walnut's OWN teardown (task completed) is not relabeled 'error' by the reap", async () => {
    // 2026-08-23 incident: a session completed its own task via the gateway;
    // completeTaskSessions stamped ('system','expected_teardown','stopped') and
    // SIGINTed the CLI mid-tool-call. The death snapshot had no clean result
    // tail → projected 'error' → the task sheet showed a red Error row for a
    // session that did exactly what it was asked to.
    setSnapshotModeForTests('enforce')
    const sid = 'c4-expected-teardown'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'expected_teardown', status_changed_by: 'system',
      consumedOffset: 1000,
    })
    const res = await applySnapshot(sid, snap({
      v: 9999, cliState: 'dead', turnActive: false, exitCode: 130, pid: null,
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'skipped', reason: 'user-terminal-intent' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('stopped')
    expect(after?.status_reason).toBe('expected_teardown')
  })

  it('expected_teardown still yields to live contradiction (the kill did not take)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c4-teardown-did-not-take'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'expected_teardown', status_changed_by: 'system',
      consumedOffset: 1000,
    })
    const res = await applySnapshot(sid, snap({ v: 4000, cliState: 'running', turnActive: true }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'running' })
  })

  it("a system record with a NON-teardown reason is still converged (veto needs the intent stamp)", async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c4-system-other-reason'
    await seedSession(sid, {
      process_status: 'stopped', status_reason: 'server_restart', status_changed_by: 'system',
      consumedOffset: 100,
    })
    const res = await applySnapshot(sid, snap({
      v: 900, cliState: 'dead', turnActive: false, exitCode: 137, pid: null,
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'error' })
  })
})

// ── C5+C16: the v-gate is enforced AT THE WRITE, and equal-v never resurrects ──
describe('applySnapshot — write-time v monotonicity + equal-v tiebreaker', () => {
  it('C5: a lower-v snapshot cannot overwrite a newer projection (predicate refuses under the lock)', async () => {
    // The check-then-act spans awaits (record read → project → conditional
    // write), so the durable watermark can advance in between. The write
    // predicate must REQUIRE monotonicity; it used to accept any snapshot whose
    // projection merely differed from the record.
    setSnapshotModeForTests('enforce')
    const sid = 'c5-lower-v'
    await seedSession(sid, { process_status: 'running' })
    // Settle at v=2000 (adopts the watermark).
    expect((await applySnapshot(sid, snap({
      v: 2000, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 1980 },
    }), 'test')).outcome).toBe('applied')
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(2000)

    // A lower-v snapshot arrives (racing push / replay). Simulate the in-memory
    // gate being lost (walnut restart) so ONLY the write predicate can stop it.
    _resetSnapshotApplyForTests()
    const stale = await applySnapshot(sid, snap({ v: 1000, cliState: 'running', turnActive: true }), 'test')
    expect(stale.outcome).toBe('stale') // durable watermark floors the gate
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('idle')
  })

  it('C16: an equal-v running snapshot does NOT resurrect a dead record', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c16-no-resurrect'
    await seedSession(sid, { process_status: 'running' })
    // Death at v=700 → record 'stopped', watermark 700.
    expect((await applySnapshot(sid, snap({
      v: 700, cliState: 'dead', turnActive: false, exitCode: 0, pid: null,
    }), 'test')).outcome).toBe('applied')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')

    // A stream-derived 'running' at the SAME v: no new bytes, so no new
    // evidence — refusing is what stops a dead session from flickering back to
    // Running (and, with the in-memory gate lost, from doing so permanently).
    _resetSnapshotApplyForTests()
    const resurrect = await applySnapshot(sid, snap({ v: 700, cliState: 'running', turnActive: true }), 'test')
    expect(resurrect).toMatchObject({ outcome: 'skipped', reason: 'predicate-false' })
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')
  })

  it('C16: equal-v running → dead IS allowed (process death is out-of-band evidence)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c16-death-allowed'
    await seedSession(sid, { process_status: 'idle' })
    // Settle at v=700 (turn over, watermark adopted).
    expect((await applySnapshot(sid, snap({
      v: 700, cliState: 'running', turnActive: true,
    }), 'test')).outcome).toBe('applied')
    expect((await applySnapshot(sid, snap({
      v: 700, cliState: 'dead', turnActive: true, exitCode: 137, pid: null,
    }), 'test')).outcome).toBe('applied')
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('error')
  })

  it('C16: a post-settle permission pause at equal v is allowed (waiting is out-of-band too)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c16-waiting-allowed'
    await seedSession(sid, { process_status: 'running' })
    expect((await applySnapshot(sid, snap({
      v: 800, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 780 },
    }), 'test')).outcome).toBe('applied')
    // The daemon intercepts a requires_action control request — no new stream
    // bytes, but genuinely new information.
    const paused = await applySnapshot(sid, snap({
      v: 800, cliState: 'waiting', turnActive: false,
      pendingPermission: { requestId: 'req-1', toolName: 'Read' },
      lastResult: { isError: false, endOffset: 780 },
    }), 'test')
    expect(paused).toMatchObject({ outcome: 'applied', projected: 'running' })
  })
})

// ── C15: consumedOffset is a TURN-END watermark, not a per-status cursor ──────
describe('applySnapshot — consumedOffset only moves at turn ends (C15)', () => {
  it('a mid-turn running snapshot writes the status WITHOUT touching consumedOffset', async () => {
    // consumedOffset is contractually a turn-END byte position:
    // foldSessionTail synthesizes its whale-turn anchor AT that offset and the
    // replay guards treat v <= consumedOffset as "already fully processed".
    // Adopting a mid-turn v plants that anchor inside an open turn.
    setSnapshotModeForTests('enforce')
    const sid = 'c15-running'
    await seedSession(sid, { process_status: 'idle', consumedOffset: 500 })
    const res = await applySnapshot(sid, snap({ v: 1500, cliState: 'running', turnActive: true }), 'test')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'running' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    expect(after?.consumedOffset, 'the turn-END watermark must NOT move mid-turn').toBe(500)
  })

  it('a waiting (mid-turn paused) snapshot also leaves the watermark alone', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c15-waiting'
    await seedSession(sid, { process_status: 'idle', consumedOffset: 500 })
    await applySnapshot(sid, snap({
      v: 1500, cliState: 'waiting', turnActive: true,
      pendingPermission: { requestId: 'r', toolName: 'Bash' },
    }), 'test')
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(500)
  })

  it('a SETTLED snapshot adopts it, and so does a DEAD one', async () => {
    setSnapshotModeForTests('enforce')
    const settled = 'c15-settled'
    await seedSession(settled, { process_status: 'running', consumedOffset: 500 })
    await applySnapshot(settled, snap({
      v: 1500, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 1480 },
    }), 'test')
    expect((await getSessionByClaudeId(settled))?.consumedOffset).toBe(1500)

    const dead = 'c15-dead'
    await seedSession(dead, { process_status: 'running', consumedOffset: 500 })
    // turnActive TRUE + dead: killed mid-turn. The process is gone, so there is
    // nothing left to append — the watermark is safe to adopt.
    await applySnapshot(dead, snap({
      v: 1600, cliState: 'dead', turnActive: true, exitCode: 137, pid: null,
    }), 'test')
    expect((await getSessionByClaudeId(dead))?.consumedOffset).toBe(1600)
  })

  it('running snapshots still ORDER correctly via the in-memory appliedV gate', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'c15-order'
    await seedSession(sid, { process_status: 'idle' })
    await applySnapshot(sid, snap({ v: 3000, cliState: 'running', turnActive: true }), 'test')
    expect(getAppliedV(sid)).toBe(3000)
    // An older running snapshot is dropped by appliedV even though the durable
    // watermark never moved.
    expect((await applySnapshot(sid, snap({ v: 2000, cliState: 'running', turnActive: true }), 'test')).outcome)
      .toBe('stale')
  })
})

// ── C28: shadow divergence log storm ─────────────────────────────────────────
describe('shadow divergence logging is rate limited but fully counted (C28)', () => {
  it('warns once per sid, then suppresses while still counting', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'c28-storm'
    await seedSession(sid, { process_status: 'running' })
    const warnSpy = vi.spyOn(log.session, 'warn')

    // 5 pushes+pulls of the SAME divergence (idle projected, running actual).
    for (let i = 1; i <= 5; i++) {
      const res = await applySnapshot(sid, snap({
        v: 1000 + i * 10, cliState: 'idle', turnActive: false,
        lastResult: { isError: false, endOffset: 990 + i * 10 },
      }), 'pull-30s')
      expect(res.diverged).toBe(true)
    }

    const warns = warnSpy.mock.calls.filter(([msg]) => msg === 'snapshot-shadow divergence')
    expect(warns.length, 'only the first sighting is logged inside the 10-min window').toBe(1)
    expect(getDivergenceCounters()).toMatchObject({ seen: 5, warned: 1 })
  })

  it('a CHANGED (projected, actual) pair logs again immediately', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'c28-state-change'
    await seedSession(sid, { process_status: 'running' })
    const warnSpy = vi.spyOn(log.session, 'warn')

    await applySnapshot(sid, snap({
      v: 1100, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 1080 },
    }), 'test') // idle<-running
    await applySnapshot(sid, snap({
      v: 1200, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 1180 },
    }), 'test') // same pair → suppressed
    await applySnapshot(sid, snap({
      v: 1300, cliState: 'dead', turnActive: false, exitCode: 1, pid: null,
    }), 'test') // error<-running → NEW pair, logs

    const warns = warnSpy.mock.calls.filter(([msg]) => msg === 'snapshot-shadow divergence')
    expect(warns.length).toBe(2)
    expect(warns[1][1]).toMatchObject({ projected: 'error', actual: 'running' })
    expect(getDivergenceCounters()).toMatchObject({ seen: 3, warned: 2 })
  })

  it('separate sids each get their own first warn', async () => {
    setSnapshotModeForTests('shadow')
    const warnSpy = vi.spyOn(log.session, 'warn')
    for (const sid of ['c28-a', 'c28-b']) {
      await seedSession(sid, { process_status: 'running' })
      await applySnapshot(sid, snap({
        v: 1500, cliState: 'idle', turnActive: false, lastResult: { isError: false, endOffset: 1480 },
      }), 'test')
    }
    expect(warnSpy.mock.calls.filter(([msg]) => msg === 'snapshot-shadow divergence').length).toBe(2)
  })
})

// ── enforce-mode legacy-writer gate through the REAL tracker choke point ──
describe('legacy-writer gate inside applyUpdateToSession', () => {
  it('strips a category-① status write for a covered session in enforce mode', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'gate-strip'
    await seedSession(sid, { process_status: 'running' })
    markSnapshotCovered(sid)

    const infoSpy = vi.spyOn(log.session, 'info')
    // A stream-event-driven legacy writer (health-monitor idle_timeout).
    const updated = await updateSessionRecord(sid, {
      process_status: 'stopped',
      errorMessage: 'No output for 90 min',
      activity: undefined,
      status_reason: 'idle_timeout',
      status_changed_by: 'health-monitor',
    } as never)
    // status trio stripped — record still 'running'.
    expect(updated.process_status).toBe('running')
    expect(updated.errorMessage == null).toBe(true)
    expect(infoSpy.mock.calls.find(([msg]) => msg === 'legacy status write suppressed')).toBeTruthy()
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('category-② user write passes through even when covered + enforce', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'gate-user-pass'
    await seedSession(sid, { process_status: 'running' })
    markSnapshotCovered(sid)
    await updateSessionRecord(sid, {
      process_status: 'stopped',
      status_reason: 'user_stopped',
      status_changed_by: 'user',
    } as never)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')
  })

  it('uncovered sid passes through (version-skew fallback)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'gate-uncovered'
    await seedSession(sid, { process_status: 'running' })
    // NOT covered — legacy writers stay authoritative.
    await updateSessionRecord(sid, {
      process_status: 'stopped',
      status_reason: 'idle_timeout',
      status_changed_by: 'health-monitor',
    } as never)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')
  })

  it('shadow and off modes never gate', async () => {
    for (const mode of ['shadow', 'off'] as const) {
      setSnapshotModeForTests(mode)
      const sid = `gate-mode-${mode}`
      await seedSession(sid, { process_status: 'running' })
      markSnapshotCovered(sid)
      await updateSessionRecord(sid, {
        process_status: 'stopped',
        status_reason: 'idle_timeout',
        status_changed_by: 'health-monitor',
      } as never)
      expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')
    }
  })

  it('a gated category-① patch is dropped ENTIRELY — no partial state lands', async () => {
    // C10: the gate used to strip only the status trio, letting the rest of a
    // category-① writer's patch land — `pid: undefined`, a turn-END
    // `consumedOffset`, `activity: undefined`, `last_status_change` — producing
    // a half-applied state NO writer intended (e.g. a cleared PID on a session
    // the snapshot still reports running, which forces the next send onto the
    // cold --resume path). These writers exist only to publish a status verdict,
    // so it is all-or-nothing.
    setSnapshotModeForTests('enforce')
    const sid = 'gate-whole-patch'
    await seedSession(sid, { process_status: 'running', activity: 'original activity', consumedOffset: 100 })
    markSnapshotCovered(sid)
    const before = await getSessionByClaudeId(sid)
    expect(before?.pid).toBe(process.pid) // seeded live pid

    await updateSessionRecord(sid, {
      process_status: 'stopped',
      status_reason: 'daemon_reported_exit',
      status_changed_by: 'daemon',
      activity: undefined,
      consumedOffset: 5000,
      pid: undefined,
      last_status_change: new Date().toISOString(),
    } as never)

    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running') // status suppressed
    expect(after?.activity).toBe('original activity') // NOT wiped
    expect(after?.consumedOffset).toBe(100) // turn-END watermark NOT advanced
    expect(after?.pid).toBe(process.pid) // PID NOT cleared
    expect(after?.last_status_change).toBe(before?.last_status_change)
  })

  it('C30: an UN-STAMPED status write (the runner stream projector) is gated when covered', async () => {
    // ClaudeCodeSession.emitStatusChanged pushes `this._processStatus` with NO
    // status_reason and NO status_changed_by — the highest-volume status writer
    // in the system, and previously un-gateable (isLegacyGatedStatusWrite
    // returns false for undefined/undefined), so 'sole writer' was unenforced
    // for exactly the writer that mattered most.
    setSnapshotModeForTests('enforce')
    const sid = 'gate-unstamped'
    await seedSession(sid, { process_status: 'running' })
    markSnapshotCovered(sid)
    await updateSessionRecord(sid, { process_status: 'stopped', activity: undefined } as never)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('running')
  })

  it('C30: the un-stamped patch keeps its transport facts (pid/host/outputFile)', async () => {
    // Narrower blast radius than the category-① drop on purpose: the runner's
    // turn-start persists carry load-bearing non-status facts (the pid+host that
    // fixed the orphan dead-pool, outputFile for history reads). Dropping the
    // whole patch would regress those.
    setSnapshotModeForTests('enforce')
    const sid = 'gate-unstamped-facts'
    await seedSession(sid, { process_status: 'idle' })
    markSnapshotCovered(sid)
    await updateSessionRecord(sid, {
      process_status: 'running',
      pid: 31337,
      host: 'devhost',
      outputFile: 'remote://devhost/stream.jsonl',
    } as never)
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('idle') // status suppressed
    expect(after?.pid).toBe(31337) // transport facts survived
    expect(after?.host).toBe('devhost')
    expect(after?.outputFile).toBe('remote://devhost/stream.jsonl')
  })

  it('C30: an un-stamped status write PASSES for an uncovered sid and in shadow mode', async () => {
    setSnapshotModeForTests('enforce')
    const uncovered = 'gate-unstamped-uncovered'
    await seedSession(uncovered, { process_status: 'running' })
    await updateSessionRecord(uncovered, { process_status: 'stopped' } as never)
    expect((await getSessionByClaudeId(uncovered))?.process_status).toBe('stopped')

    setSnapshotModeForTests('shadow')
    const shadowSid = 'gate-unstamped-shadow'
    await seedSession(shadowSid, { process_status: 'running' })
    markSnapshotCovered(shadowSid)
    await updateSessionRecord(shadowSid, { process_status: 'stopped' } as never)
    expect((await getSessionByClaudeId(shadowSid))?.process_status).toBe('stopped')
  })

  it('a PARTIALLY stamped write passes through (PASS-THROUGH when unsure)', async () => {
    // Only the fully un-stamped shape is the runner projector. A patch carrying
    // one of the two labels is some other writer we have not inventoried — the
    // contract's tiebreak is pass-through.
    setSnapshotModeForTests('enforce')
    const sid = 'gate-half-stamped'
    await seedSession(sid, { process_status: 'running' })
    markSnapshotCovered(sid)
    await updateSessionRecord(sid, {
      process_status: 'stopped', status_changed_by: 'user',
    } as never)
    expect((await getSessionByClaudeId(sid))?.process_status).toBe('stopped')
  })

  it('log churn: info on the FIRST suppression per sid, debug thereafter, with a count', async () => {
    // C17: a suppressed writer keeps refiring (the health monitor retries the
    // same gated write every 30s for as long as the divergence lasts). Info on
    // every one of those buried the log.
    setSnapshotModeForTests('enforce')
    const sid = 'gate-churn'
    await seedSession(sid, { process_status: 'running' })
    markSnapshotCovered(sid)
    const infoSpy = vi.spyOn(log.session, 'info')
    const debugSpy = vi.spyOn(log.session, 'debug')

    const gatedWrite = (): Promise<unknown> => updateSessionRecord(sid, {
      process_status: 'stopped', status_reason: 'idle_timeout', status_changed_by: 'health-monitor',
    } as never)
    await gatedWrite()
    await gatedWrite()
    await gatedWrite()

    const infos = infoSpy.mock.calls.filter(([msg]) => msg === 'legacy status write suppressed')
    const debugs = debugSpy.mock.calls.filter(([msg]) => msg === 'legacy status write suppressed')
    expect(infos.length, 'exactly ONE info per sid').toBe(1)
    expect(debugs.length, 'the repeats drop to debug').toBe(2)
    expect(infos[0][1]).toMatchObject({ sessionId: sid, suppressedCount: 1, shape: 'category-1-pair' })
    expect((debugs[1][1] as { suppressedCount?: number }).suppressedCount).toBe(3)
  })
})

// ── streamEpoch: file-identity watermark reset (incident 019a7fe5) ──────────
// The stream file was recreated (reboot wiped /tmp) → v restarted at 0 while
// the record kept the OLD incarnation's 85 MB consumedOffset. Every snapshot
// of the new file was silently 'stale' — the record showed Running for a CLI
// idle for a day, with ZERO divergence logs (drop happened before the compare).
describe('applySnapshot — streamEpoch reset (incident 019a7fe5)', () => {
  const OLD_EPOCH = '16777231:111:1754000000000'
  const NEW_EPOCH = '16777231:222:1754600000000'

  it('INCIDENT SHAPE (shadow): epoch change unblocks the v-gate so the divergence is finally VISIBLE', async () => {
    setSnapshotModeForTests('shadow')
    const warnSpy = vi.spyOn(log.session, 'warn')
    const sid = 'epoch-shadow'
    // The poisoned record: huge dead-file watermark, stuck 'running'.
    await seedSession(sid, {
      process_status: 'running', consumedOffset: 85_688_560, streamEpoch: OLD_EPOCH,
    })
    // New incarnation's settled snapshot: v far BELOW the stale watermark.
    const res = await applySnapshot(sid, snap({
      v: 16_225_380, cliState: 'idle', turnActive: false, streamEpoch: NEW_EPOCH,
      lastResult: { isError: false, endOffset: 16_225_000 },
    }), 'daemon-push')
    // Without the epoch reset this was outcome:'stale'. Now it reaches the compare.
    expect(res).toMatchObject({ outcome: 'shadow', diverged: true, projected: 'idle' })
    expect(warnSpy.mock.calls.find(([msg]) => msg === 'snapshot stream-epoch changed — resetting watermarks')).toBeTruthy()
    // Shadow never writes: record untouched (incl. the stale watermark + epoch).
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    expect(after?.consumedOffset).toBe(85_688_560)
    expect(after?.streamEpoch).toBe(OLD_EPOCH)
  })

  it('INCIDENT SHAPE (enforce): converges the record and RESETS the watermark to the new file', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epoch-enforce'
    await seedSession(sid, {
      process_status: 'running', consumedOffset: 85_688_560, streamEpoch: OLD_EPOCH,
    })
    const res = await applySnapshot(sid, snap({
      v: 16_225_380, cliState: 'idle', turnActive: false, streamEpoch: NEW_EPOCH,
      lastResult: { isError: false, endOffset: 16_225_000 },
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'idle' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('idle')
    expect(after?.streamEpoch).toBe(NEW_EPOCH)
    // Settled snapshot → watermark adopted at the NEW file's v (regression
    // 85 MB → 16 MB sanctioned by the epoch-reset arbitration in the tracker).
    expect(after?.consumedOffset).toBe(16_225_380)
  })

  it('enforce: epoch change on a MID-TURN snapshot resets consumedOffset to 0 (no mid-turn adoption)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epoch-midturn'
    await seedSession(sid, {
      process_status: 'idle', consumedOffset: 85_688_560, streamEpoch: OLD_EPOCH,
    })
    const res = await applySnapshot(sid, snap({
      v: 5_000, cliState: 'running', turnActive: true, streamEpoch: NEW_EPOCH,
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'running' })
    const after = await getSessionByClaudeId(sid)
    // consumedOffset is a TURN-END coordinate (C15): a running snapshot may not
    // plant it mid-turn, but the dead file's 85 MB floor must go — reset to 0.
    expect(after?.consumedOffset).toBe(0)
    expect(after?.streamEpoch).toBe(NEW_EPOCH)
  })

  it('enforce: first sight of an epoch (record has none) stamps it without resetting the watermark', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epoch-first-sight'
    await seedSession(sid, { process_status: 'running', consumedOffset: 1_000 })
    const res = await applySnapshot(sid, snap({
      v: 2_000, cliState: 'idle', turnActive: false, streamEpoch: NEW_EPOCH,
      lastResult: { isError: false, endOffset: 1_990 },
    }), 'test')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'idle' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.streamEpoch).toBe(NEW_EPOCH)
    expect(after?.consumedOffset).toBe(2_000) // normal monotonic adoption, not a reset
  })

  it('UNCHANGED epoch keeps the normal v-gate (a below-watermark snapshot is still stale)', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'epoch-same'
    await seedSession(sid, {
      process_status: 'running', consumedOffset: 85_688_560, streamEpoch: OLD_EPOCH,
    })
    const res = await applySnapshot(sid, snap({
      v: 16_225_380, cliState: 'idle', turnActive: false, streamEpoch: OLD_EPOCH,
      lastResult: { isError: false, endOffset: 16_225_000 },
    }), 'test')
    expect(res.outcome).toBe('stale')
  })

  it('epoch-less snapshot (old daemon, version skew) never triggers a reset', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'epoch-skew'
    await seedSession(sid, {
      process_status: 'running', consumedOffset: 85_688_560, streamEpoch: OLD_EPOCH,
    })
    const res = await applySnapshot(sid, snap({
      v: 16_225_380, cliState: 'idle', turnActive: false, streamEpoch: null,
      lastResult: { isError: false, endOffset: 16_225_000 },
    }), 'test')
    expect(res.outcome).toBe('stale')
  })

  it('user terminal intent still outranks a same-epoch snapshot, but an epoch change with live evidence supersedes', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epoch-user-intent'
    await seedSession(sid, {
      process_status: 'stopped', status_changed_by: 'user', status_reason: 'user_stopped',
      consumedOffset: 85_688_560, streamEpoch: OLD_EPOCH,
    })
    // Terminal-projecting snapshot of the NEW file: still just a label — user wins.
    const label = await applySnapshot(sid, snap({
      v: 100, cliState: 'dead', turnActive: false, exitCode: 0, streamEpoch: NEW_EPOCH,
    }), 'test')
    expect(label).toMatchObject({ outcome: 'skipped', reason: 'user-terminal-intent' })
    // Contradicting evidence (running) in the new incarnation: beyond-watermark
    // requirement collapses (all of the new file is "beyond" the dead file).
    const contradict = await applySnapshot(sid, snap({
      v: 100, cliState: 'running', turnActive: true, streamEpoch: NEW_EPOCH,
    }), 'test')
    expect(contradict).toMatchObject({ outcome: 'applied', projected: 'running' })
  })
})

// ── tracker arbitration: the epoch-gated consumedOffset regression ──────────
describe('applyUpdateToSession — epoch-gated consumedOffset arbitration', () => {
  it('rejects a watermark regression WITHOUT an epoch change', async () => {
    const sid = 'arb-no-epoch'
    await seedSession(sid, { consumedOffset: 10_000, streamEpoch: 'e1' })
    await updateSessionRecord(sid, { consumedOffset: 500 } as never)
    expect((await getSessionByClaudeId(sid))?.consumedOffset).toBe(10_000)
  })

  it('accepts a watermark regression WITH an epoch change (and logs it)', async () => {
    const warnSpy = vi.spyOn(log.session, 'warn')
    const sid = 'arb-epoch-reset'
    await seedSession(sid, { consumedOffset: 10_000, streamEpoch: 'e1' })
    await updateSessionRecord(sid, { consumedOffset: 500, streamEpoch: 'e2' } as never)
    const after = await getSessionByClaudeId(sid)
    expect(after?.consumedOffset).toBe(500)
    expect(after?.streamEpoch).toBe('e2')
    expect(warnSpy.mock.calls.find(([msg]) => msg === 'consumedOffset epoch reset accepted')).toBeTruthy()
  })

  it('an epoch change never excuses an INVALID offset (sentinel still rejected)', async () => {
    const sid = 'arb-epoch-invalid'
    await seedSession(sid, { consumedOffset: 10_000, streamEpoch: 'e1' })
    await updateSessionRecord(sid, { consumedOffset: Number.MAX_SAFE_INTEGER, streamEpoch: 'e2' } as never)
    const after = await getSessionByClaudeId(sid)
    expect(after?.consumedOffset).toBe(10_000) // poisoned sentinel dropped
    expect(after?.streamEpoch).toBe('e2') // the epoch stamp itself still lands
  })

  it('streamEpoch survives the SQL round-trip (payload-spilled field)', async () => {
    const sid = 'arb-epoch-persist'
    await seedSession(sid, { streamEpoch: 'dev:ino:birth' })
    closeDb() // force a re-read from disk
    expect((await getSessionByClaudeId(sid))?.streamEpoch).toBe('dev:ino:birth')
  })
})

describe('applySnapshot — epoch-less record with a provably-stale watermark (incident 267a4b68)', () => {
  const NEW_EPOCH = '16777231:1302716146:1786167189042'

  // The trap: records that predate epoch stamping (streamEpoch NULL) could
  // never take the epoch-reset path (two-sided compare needs both epochs), and
  // could never GET an epoch either (stamping requires an enforce write, which
  // the stale watermark's v-gate blocks). Meanwhile the live replay guards kept
  // swallowing real results ("suppressing replayed result", turn ended but the
  // record stayed Running until the next user message).

  it('INCIDENT SHAPE (enforce): settled snapshot below an over-EOF watermark converges + stamps the epoch', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epochless-stale'
    // No streamEpoch; watermark measured in the pre-move file (134 MB) while
    // the migrated file is only ~119 MB — offsets can never exceed the EOF of
    // the file they were measured in, so this watermark is provably foreign.
    await seedSession(sid, { process_status: 'running', consumedOffset: 134_248_535 })
    liveSessionId = sid

    const res = await applySnapshot(sid, snap({
      v: 115_135_073, cliState: 'idle', turnActive: false, streamEpoch: NEW_EPOCH,
      lastResult: { isError: false, endOffset: 115_134_908 },
    }), 'pull-30s')

    expect(res).toMatchObject({ outcome: 'applied', projected: 'idle' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('idle')
    expect(after?.streamEpoch).toBe(NEW_EPOCH)
    expect(after?.consumedOffset).toBe(115_135_073)
    // The live instance's in-memory watermark must reset too — it is what the
    // replay guards read; healing only the record leaves the guards swallowing.
    expect(liveWatermarkReset).toHaveBeenCalledWith(115_135_073)
  })

  it('an epoch-less record whose watermark is BELOW the snapshot v is NOT treated as an epoch change', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epochless-fresh'
    // Same-file continuation: watermark < v is perfectly normal ordering.
    await seedSession(sid, { process_status: 'running', consumedOffset: 1_000 })
    const res = await applySnapshot(sid, snap({
      v: 2_000, cliState: 'idle', turnActive: false, streamEpoch: NEW_EPOCH,
      lastResult: { isError: false, endOffset: 1_900 },
    }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'idle' })
    // First-sight stamp rides the ordinary adoptWatermark write — no reset log needed.
    const after = await getSessionByClaudeId(sid)
    expect(after?.streamEpoch).toBe(NEW_EPOCH)
    expect(after?.consumedOffset).toBe(2_000)
  })

  it('a RUNNING snapshot below an over-EOF watermark does NOT trigger the reset (mid-turn v proves nothing)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epochless-running'
    await seedSession(sid, { process_status: 'running', consumedOffset: 134_248_535 })
    // Mid-turn: v < watermark could just be an early offset of a genuinely
    // huge file — only a settled/dead fold's v is an EOF position.
    const res = await applySnapshot(sid, snap({
      v: 115_000_000, cliState: 'running', turnActive: true, streamEpoch: NEW_EPOCH,
    }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'stale' })
  })

  it('a WAITING snapshot below an over-EOF watermark does NOT trigger the reset (same exclusion as adoptsWatermark)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'epochless-waiting'
    await seedSession(sid, { process_status: 'running', consumedOffset: 134_248_535 })
    const res = await applySnapshot(sid, snap({
      v: 115_000_000, cliState: 'waiting', turnActive: false,
      pendingPermission: { requestId: 'r1', toolName: 'Bash' }, streamEpoch: NEW_EPOCH,
    }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'stale' })
  })

  it('shadow mode: the epoch-less reset unblocks the v-gate so the divergence becomes VISIBLE (no write)', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'epochless-shadow'
    await seedSession(sid, { process_status: 'running', consumedOffset: 134_248_535 })
    const res = await applySnapshot(sid, snap({
      v: 115_135_073, cliState: 'idle', turnActive: false, streamEpoch: NEW_EPOCH,
      lastResult: { isError: false, endOffset: 115_134_908 },
    }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'shadow', diverged: true, projected: 'idle' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    expect(after?.consumedOffset).toBe(134_248_535)
    expect(after?.streamEpoch).toBeUndefined()
  })
})

// ── turn-start phase pullback (inc-1787512825254) ────────────────────────────
// A CLI self-woken turn (background task-notification dequeued from its
// internal queue) emits NO session_state_changed{running}, so the event-lane
// turn-start edges never fire and the task stays on the previous turn's
// AGENT_COMPLETE while the snapshot lane paints the session green. The apply
// path is the one place that observes the new turn, so it must pull the phase
// back — except when the 'running' projection is really a permission pause
// (awaiting-human red row is by design).
describe('applySnapshot — turn-start phase pullback', () => {
  async function seedLinkedTask(phase: string): Promise<string> {
    const { task } = await addTask({ title: 'pullback', project: 'p' })
    await updateTaskRaw(task.id, { phase: phase as never })
    return task.id
  }

  async function seedSessionWithTask(sid: string, taskId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await createSessionRecord(sid, taskId, 'proj', '/tmp/snap-apply', { pid: process.pid })
    await updateSessionRecord(sid, { process_status: 'idle', ...extra } as never)
  }

  async function expectPhaseEventually(taskId: string, phase: string): Promise<void> {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if ((await getTask(taskId)).phase === phase) return
      await new Promise((r) => setTimeout(r, 25))
    }
    expect((await getTask(taskId)).phase).toBe(phase)
  }

  async function expectPhaseStays(taskId: string, phase: string): Promise<void> {
    await new Promise((r) => setTimeout(r, 200))
    expect((await getTask(taskId)).phase).toBe(phase)
  }

  it('INCIDENT SHAPE: idle record + red task + running snapshot → IN_PROGRESS', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'pullback-incident'
    const taskId = await seedLinkedTask('AGENT_COMPLETE')
    await seedSessionWithTask(sid, taskId)

    const res = await applySnapshot(sid, snap({ v: 300, cliState: 'running', turnActive: true }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'running' })
    await expectPhaseEventually(taskId, 'IN_PROGRESS')
  })

  it('heals a boot-adopted mismatch: record already running (predicate-false write) still pulls the phase', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'pullback-boot-adopt'
    const taskId = await seedLinkedTask('AGENT_COMPLETE')
    await seedSessionWithTask(sid, taskId, { process_status: 'running' })

    const res = await applySnapshot(sid, snap({ v: 300, cliState: 'running', turnActive: true }), 'pull-30s')
    expect(res).toMatchObject({ outcome: 'skipped', reason: 'predicate-false' })
    await expectPhaseEventually(taskId, 'IN_PROGRESS')
  })

  it("permission pause ('waiting' + pendingPermission) keeps the awaiting-human red row", async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'pullback-waiting'
    const taskId = await seedLinkedTask('AGENT_COMPLETE')
    await seedSessionWithTask(sid, taskId)

    const res = await applySnapshot(sid, snap({
      v: 300, cliState: 'waiting', turnActive: true,
      pendingPermission: { requestId: 'req-1', toolName: 'Bash' },
    }), 'daemon-push')
    expect(res.projected).toBe('running') // waiting projects running for the frozen enum…
    await expectPhaseStays(taskId, 'AGENT_COMPLETE') // …but the phase must NOT be pulled back
  })

  it('record-side pendingPermission also blocks the pullback (out-of-band prompt the fold missed)', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'pullback-record-pending'
    const taskId = await seedLinkedTask('AGENT_COMPLETE')
    await seedSessionWithTask(sid, taskId, {
      pendingPermission: { requestId: 'req-2', toolName: 'AskUserQuestion', receivedAt: new Date().toISOString() },
    })

    await applySnapshot(sid, snap({ v: 300, cliState: 'running', turnActive: true }), 'daemon-push')
    await expectPhaseStays(taskId, 'AGENT_COMPLETE')
  })

  it('never overwrites a terminal phase', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'pullback-terminal'
    const taskId = await seedLinkedTask('COMPLETE')
    await seedSessionWithTask(sid, taskId)

    await applySnapshot(sid, snap({ v: 300, cliState: 'running', turnActive: true }), 'daemon-push')
    await expectPhaseStays(taskId, 'COMPLETE')
  })

  it('shadow mode never touches the phase', async () => {
    setSnapshotModeForTests('shadow')
    const sid = 'pullback-shadow'
    const taskId = await seedLinkedTask('AGENT_COMPLETE')
    await seedSessionWithTask(sid, taskId)

    const res = await applySnapshot(sid, snap({ v: 300, cliState: 'running', turnActive: true }), 'daemon-push')
    expect(res.outcome).toBe('shadow')
    await expectPhaseStays(taskId, 'AGENT_COMPLETE')
  })
})

// ── detachedBgCount projection (user decision 2026-08-28, inc-1787893885321):
// a live run_in_background command means the session is RUNNING even though
// the CLI's turn settled around it. Absent field (pre-field daemon) = idle. ──
describe('projectProcessStatus — detached background work', () => {
  it('idle cliState + detachedBgCount>0 → running', () => {
    expect(projectProcessStatus(snap({
      cliState: 'idle', turnActive: false, detachedBgCount: 1,
      lastResult: { isError: false, numTurns: 1, endOffset: 90 },
    }))).toBe('running')
  })

  it('detached work outranks a trailing error result (work continues; error re-surfaces at drain)', () => {
    expect(projectProcessStatus(snap({
      cliState: 'idle', turnActive: false, detachedBgCount: 2,
      lastResult: { isError: true, endOffset: 90 },
    }))).toBe('running')
  })

  it('dead still wins over detached work', () => {
    expect(projectProcessStatus(snap({
      cliState: 'dead', turnActive: false, exitCode: 0, detachedBgCount: 1,
      lastResult: { isError: false, endOffset: 90 },
    }))).toBe('stopped')
  })

  it('absent field (pre-field daemon) keeps the old idle projection', () => {
    expect(projectProcessStatus(snap({
      cliState: 'idle', turnActive: false,
      lastResult: { isError: false, numTurns: 1, endOffset: 90 },
    }))).toBe('idle')
  })

  it('detachedBgCount:0 explicitly → idle', () => {
    expect(projectProcessStatus(snap({
      cliState: 'idle', turnActive: false, detachedBgCount: 0,
    }))).toBe('idle')
  })

  it('enforce apply: detached-running snapshot converges an idle record to running AND pulls the phase back', async () => {
    setSnapshotModeForTests('enforce')
    const sid = 'detached-running'
    const { task } = await addTask({ title: 'bg', project: 'p' })
    await updateTaskRaw(task.id, { phase: 'AGENT_COMPLETE' as never })
    await createSessionRecord(sid, task.id, 'proj', '/tmp/snap-apply', { pid: process.pid })
    await updateSessionRecord(sid, { process_status: 'idle' } as never)

    const res = await applySnapshot(sid, snap({
      v: 400, cliState: 'idle', turnActive: false, detachedBgCount: 1,
      lastResult: { isError: false, numTurns: 1, endOffset: 380 },
    }), 'daemon-push')
    expect(res).toMatchObject({ outcome: 'applied', projected: 'running' })
    const after = await getSessionByClaudeId(sid)
    expect(after?.process_status).toBe('running')
    // Phase pullback rides the same running projection (fire-and-forget).
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if ((await getTask(task.id)).phase === 'IN_PROGRESS') break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect((await getTask(task.id)).phase).toBe('IN_PROGRESS')
  })
})
