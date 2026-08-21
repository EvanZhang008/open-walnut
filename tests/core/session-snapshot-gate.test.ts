/**
 * C2 session-snapshot-gate — pure unit tests (contract §5 category tables).
 *
 * The gate module is deliberately import-free (session-tracker consults it
 * synchronously inside applyUpdateToSession), so these tests are pure logic:
 * mode flag, covered registry, and the category-① pair table. The tracker-side
 * integration (a gated write actually being stripped) lives in
 * tests/core/session-snapshot-apply.test.ts.
 *
 * One exception at the bottom: a SOURCE-level guard on the capability-downgrade
 * call site in daemon-connection.ts. Driving the real
 * recoverDisconnectedSessions here would need an SSH tunnel, a live daemon and a
 * session DB — so the wiring is pinned by reading the source instead, which
 * keeps this file import-free and still fails if the call is removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import {
  getSnapshotStatusMode,
  setSnapshotModeForTests,
  markSnapshotCovered,
  isSnapshotCovered,
  unmarkSnapshotCovered,
  getAppliedV,
  isLegacyGatedStatusWrite,
  isUnstampedStatusWrite,
  noteSuppressedStatusWrite,
  getSuppressedStatusWriteCount,
  LEGACY_GATED_STATUS_PAIRS,
  SNAPSHOT_REGISTRY_CAP,
  _resetSnapshotGateForTests,
  _snapshotRegistrySizeForTests,
} from '../../src/core/session-snapshot-gate.js'

beforeEach(() => _resetSnapshotGateForTests())
afterEach(() => {
  delete process.env.WALNUT_SNAPSHOT_STATUS
  _resetSnapshotGateForTests()
})

describe('snapshot status mode flag', () => {
  it('defaults to enforce when the env var is unset or garbage (C4 flip, 2026-08-13)', () => {
    // Shadow soak evidence: 4 days, 1880 divergences across 28 sessions, the
    // snapshot side correct in every investigated incident. Shadow could see
    // stale records but never fix them ("finished but still Running" family).
    delete process.env.WALNUT_SNAPSHOT_STATUS
    _resetSnapshotGateForTests()
    expect(getSnapshotStatusMode()).toBe('enforce')
    process.env.WALNUT_SNAPSHOT_STATUS = 'bogus-value'
    _resetSnapshotGateForTests()
    expect(getSnapshotStatusMode()).toBe('enforce')
  })

  it('honors off and shadow from the environment (shadow = the revert switch)', () => {
    process.env.WALNUT_SNAPSHOT_STATUS = 'off'
    _resetSnapshotGateForTests()
    expect(getSnapshotStatusMode()).toBe('off')
    process.env.WALNUT_SNAPSHOT_STATUS = 'shadow'
    _resetSnapshotGateForTests()
    expect(getSnapshotStatusMode()).toBe('shadow')
  })

  it('setSnapshotModeForTests overrides and null re-derives from env', () => {
    setSnapshotModeForTests('shadow')
    expect(getSnapshotStatusMode()).toBe('shadow')
    delete process.env.WALNUT_SNAPSHOT_STATUS
    setSnapshotModeForTests(null)
    expect(getSnapshotStatusMode()).toBe('enforce')
  })
})

describe('snapshot-covered registry', () => {
  it('marks and reports coverage per sid', () => {
    expect(isSnapshotCovered('sid-a')).toBe(false)
    markSnapshotCovered('sid-a')
    expect(isSnapshotCovered('sid-a')).toBe(true)
    expect(isSnapshotCovered('sid-b')).toBe(false)
  })

  it('reset clears coverage', () => {
    markSnapshotCovered('sid-a')
    _resetSnapshotGateForTests()
    expect(isSnapshotCovered('sid-a')).toBe(false)
  })

  it('unmark drops coverage per sid and is safe on an unknown sid', () => {
    markSnapshotCovered('sid-a')
    markSnapshotCovered('sid-b')
    unmarkSnapshotCovered('sid-a')
    expect(isSnapshotCovered('sid-a')).toBe(false)
    expect(isSnapshotCovered('sid-b')).toBe(true) // per-sid, not a clear-all
    expect(() => unmarkSnapshotCovered('sid-never-seen')).not.toThrow()
    // Re-arming works: the next applySnapshot marks it again.
    markSnapshotCovered('sid-a')
    expect(isSnapshotCovered('sid-a')).toBe(true)
  })

  it('CAPABILITY DOWNGRADE: unmark un-bricks a covered sid whose gate strips the legacy write', () => {
    // Simulates DaemonConnection.recoverDisconnectedSessions on a daemon that
    // was redeployed WITHOUT snapshot-v1. The sid is still covered from the
    // previous snapshot-capable daemon, so in enforce mode the tracker gate
    // strips the legacy recovery patch ('daemon'/'daemon_reconnected' and
    // 'daemon'/'daemon_reported_exit' are both category-①) — and no snapshot
    // will ever arrive to correct the record. Unmarking BEFORE the legacy patch
    // is what keeps the record writable.
    //
    // This asserts the exact predicate the tracker's choke point evaluates
    // (session-tracker.applyUpdateToSession: enforce && covered && gated pair).
    // Keeping it here rather than through the tracker keeps the gate suite
    // import-free; the tracker-side strip is covered in
    // tests/core/session-snapshot-apply.test.ts.
    setSnapshotModeForTests('enforce')
    const sid = 'downgraded-sid'
    markSnapshotCovered(sid)

    const wouldStrip = (changedBy: string, reason: string): boolean =>
      getSnapshotStatusMode() === 'enforce'
      && isSnapshotCovered(sid)
      && isLegacyGatedStatusWrite(changedBy, reason)

    // BEFORE: both legacy recovery writes the downgrade path falls back to are
    // stripped → the record is status-bricked.
    expect(wouldStrip('daemon', 'daemon_reconnected')).toBe(true)
    expect(wouldStrip('daemon', 'daemon_reported_exit')).toBe(true)

    unmarkSnapshotCovered(sid)

    // AFTER: the SAME writes pass the gate.
    expect(wouldStrip('daemon', 'daemon_reconnected')).toBe(false)
    expect(wouldStrip('daemon', 'daemon_reported_exit')).toBe(false)
  })
})

// ── C23+C25: ONE bounded registry holds coverage AND the applied-v watermark ──
describe('snapshot registry — coverage + appliedV in one bounded map', () => {
  it('markSnapshotCovered stores the v watermark and is monotonic', () => {
    markSnapshotCovered('sid-v', 500)
    expect(getAppliedV('sid-v')).toBe(500)
    markSnapshotCovered('sid-v', 900)
    expect(getAppliedV('sid-v')).toBe(900)
    markSnapshotCovered('sid-v', 100) // never moves backwards
    expect(getAppliedV('sid-v')).toBe(900)
  })

  it('coverage without a v defaults the watermark to 0 and never lowers an existing one', () => {
    markSnapshotCovered('sid-novee')
    expect(isSnapshotCovered('sid-novee')).toBe(true)
    expect(getAppliedV('sid-novee')).toBe(0)
    markSnapshotCovered('sid-novee', 700)
    markSnapshotCovered('sid-novee') // bare mark must not reset to 0
    expect(getAppliedV('sid-novee')).toBe(700)
  })

  it('first sight reports undefined so callers can seed from the durable watermark', () => {
    expect(getAppliedV('sid-unseen')).toBeUndefined()
  })

  it('CAP EVICTION ACTUALLY FIRES — every entry path goes through the bounded setter', () => {
    // C25: the apply module used to seed "first sight" with a raw map.set(),
    // bypassing the evicting helper, so the cap could never trigger and the map
    // grew without bound for the process lifetime.
    for (let i = 0; i < SNAPSHOT_REGISTRY_CAP; i++) markSnapshotCovered(`cap-${i}`, i)
    expect(_snapshotRegistrySizeForTests()).toBe(SNAPSHOT_REGISTRY_CAP)
    expect(isSnapshotCovered('cap-0')).toBe(true)

    // One more sid → the OLDEST first-seen entry is evicted, size stays capped.
    markSnapshotCovered('cap-overflow', 1)
    expect(_snapshotRegistrySizeForTests()).toBe(SNAPSHOT_REGISTRY_CAP)
    expect(isSnapshotCovered('cap-0'), 'oldest entry evicted').toBe(false)
    expect(isSnapshotCovered('cap-overflow')).toBe(true)
    expect(isSnapshotCovered(`cap-${SNAPSHOT_REGISTRY_CAP - 1}`)).toBe(true)

    // Updating an EXISTING sid must not evict anything.
    markSnapshotCovered('cap-overflow', 2)
    expect(_snapshotRegistrySizeForTests()).toBe(SNAPSHOT_REGISTRY_CAP)
  })

  it('unmark drops the watermark with the coverage (re-arm starts fresh)', () => {
    markSnapshotCovered('sid-unmark', 400)
    unmarkSnapshotCovered('sid-unmark')
    expect(getAppliedV('sid-unmark')).toBeUndefined()
  })
})

// ── C17: suppressed-write counters ───────────────────────────────────────────
describe('suppressed status write counters', () => {
  it('counts per sid, starting at 1', () => {
    expect(getSuppressedStatusWriteCount('sup-a')).toBe(0)
    expect(noteSuppressedStatusWrite('sup-a')).toBe(1)
    expect(noteSuppressedStatusWrite('sup-a')).toBe(2)
    expect(noteSuppressedStatusWrite('sup-b')).toBe(1) // independent per sid
    expect(getSuppressedStatusWriteCount('sup-a')).toBe(2)
  })

  it('unmark clears a sid\'s counter (fresh coverage = fresh log budget)', () => {
    noteSuppressedStatusWrite('sup-c')
    unmarkSnapshotCovered('sup-c')
    expect(getSuppressedStatusWriteCount('sup-c')).toBe(0)
  })
})

// ── C30: the un-stamped runner projector is a gateable shape ──────────────────
describe('un-stamped status write predicate (C30)', () => {
  it('both labels missing → true (the runner stream projector)', () => {
    expect(isUnstampedStatusWrite(undefined, undefined)).toBe(true)
    expect(isUnstampedStatusWrite(null, null)).toBe(true)
    expect(isUnstampedStatusWrite(undefined, null)).toBe(true)
  })

  it('ANY label present → false (pass through; some other writer)', () => {
    expect(isUnstampedStatusWrite('user', undefined)).toBe(false)
    expect(isUnstampedStatusWrite(undefined, 'user_stopped')).toBe(false)
    expect(isUnstampedStatusWrite('health-monitor', 'idle_timeout')).toBe(false)
  })

  it('is DISJOINT from the category-① pair predicate (no double-classification)', () => {
    for (const [by, reason] of LEGACY_GATED_STATUS_PAIRS) {
      expect(isUnstampedStatusWrite(by, reason)).toBe(false)
    }
    expect(isLegacyGatedStatusWrite(undefined, undefined)).toBe(false)
  })
})

describe('category-① legacy writer table', () => {
  it('every category-① pair is gated', () => {
    // The table itself is the contract artifact — assert membership through the
    // public predicate so an inverted/broken check fails here (mutation guard).
    expect(LEGACY_GATED_STATUS_PAIRS.length).toBeGreaterThanOrEqual(15)
    for (const [changedBy, reason] of LEGACY_GATED_STATUS_PAIRS) {
      expect(isLegacyGatedStatusWrite(changedBy, reason), `${changedBy}/${reason} must be gated`).toBe(true)
    }
  })

  it('specific stream-event writers from the inventory are gated', () => {
    expect(isLegacyGatedStatusWrite('session-runner', 'turn_completed')).toBe(true)
    expect(isLegacyGatedStatusWrite('daemon', 'daemon_reported_exit')).toBe(true)
    expect(isLegacyGatedStatusWrite('health-monitor', 'idle_timeout')).toBe(true)
    expect(isLegacyGatedStatusWrite('health-monitor', 'remote_unreachable')).toBe(true)
    expect(isLegacyGatedStatusWrite('reconciler', 'reconciled_authoritative')).toBe(true)
    expect(isLegacyGatedStatusWrite('system', 'streaming_evidence_self_heal')).toBe(true)
    expect(isLegacyGatedStatusWrite('health-monitor', 'orphan_no_pid')).toBe(true)
  })

  it('category-② pairs (user intent, spawn seeds, send-path) pass through', () => {
    expect(isLegacyGatedStatusWrite('user', 'user_stopped')).toBe(false)
    expect(isLegacyGatedStatusWrite('user', 'user_terminated')).toBe(false)
    expect(isLegacyGatedStatusWrite('user', 'retry_reconnect')).toBe(false)
    expect(isLegacyGatedStatusWrite('user', 'restart_reinitialize')).toBe(false)
    // Ambiguous pair (both send-path and state-changed persist use it):
    // contract says default to PASS-THROUGH when unsure.
    expect(isLegacyGatedStatusWrite('session-runner', 'message_sent')).toBe(false)
    expect(isLegacyGatedStatusWrite('system', 'awaiting_spawn')).toBe(false)
  })

  it('pairs must match EXACTLY — cross-pairing changed_by and reason is not gated', () => {
    // 'user' never appears in the table with any reason.
    expect(isLegacyGatedStatusWrite('user', 'daemon_reported_exit')).toBe(false)
    // 'idle_timeout' is gated only for health-monitor.
    expect(isLegacyGatedStatusWrite('session-runner', 'idle_timeout')).toBe(false)
  })

  it('untyped/unknown input passes through (PASS-THROUGH when unsure)', () => {
    expect(isLegacyGatedStatusWrite(undefined, 'turn_completed')).toBe(false)
    expect(isLegacyGatedStatusWrite('session-runner', undefined)).toBe(false)
    expect(isLegacyGatedStatusWrite(42, 'turn_completed')).toBe(false)
    expect(isLegacyGatedStatusWrite('future-writer', 'future_reason')).toBe(false)
  })
})

describe('capability-downgrade call site (source guard)', () => {
  it('recoverDisconnectedSessions unmarks coverage on the non-snapshot branch, BEFORE legacy patching', async () => {
    // The unmark is only useful where the downgrade is DETECTED. Reaching the
    // real method needs an SSH tunnel + live daemon + session DB, so pin the
    // wiring at the source level: (1) the unmark exists inside
    // recoverDisconnectedSessions, (2) it sits on the `else` of
    // `if (this.supportsSnapshots)` — i.e. the branch taken when the daemon does
    // NOT advertise snapshot-v1, and (3) it precedes the legacy
    // updateSessionRecord patches. Order matters: unmarking AFTER the patch
    // leaves the record bricked for exactly the recovery write that mattered.
    const src = await fsp.readFile(
      new URL('../../src/providers/daemon-connection.ts', import.meta.url), 'utf-8',
    )
    const start = src.indexOf('private async recoverDisconnectedSessions(')
    expect(start, 'recoverDisconnectedSessions not found — was it renamed?').toBeGreaterThan(0)
    const body = src.slice(start, src.indexOf('\n  private startPing(', start))
    expect(body.length).toBeGreaterThan(0)

    const unmarkAt = body.indexOf('unmarkSnapshotCovered(')
    expect(
      unmarkAt,
      'CAPABILITY-DOWNGRADE REGRESSION: recoverDisconnectedSessions no longer calls '
      + 'unmarkSnapshotCovered(). A sid covered by a previously snapshot-capable daemon '
      + 'stays covered after the daemon is rolled back, so the enforce-mode gate strips '
      + "this method's legacy recovery patch and no snapshot ever arrives to fix it — the "
      + 'record is status-bricked. Restore the call on the non-snapshot branch.',
    ).toBeGreaterThan(0)

    // (2) it lives on the NON-snapshot branch: the capability check comes first,
    // and the unmark is not inside the `if (this.supportsSnapshots) {` block —
    // proven by it following that block's `} else {`.
    const capAt = body.indexOf('if (this.supportsSnapshots)')
    expect(capAt, 'the supportsSnapshots capability check disappeared').toBeGreaterThan(0)
    expect(capAt).toBeLessThan(unmarkAt)
    const elseAt = body.indexOf('} else {', capAt)
    expect(elseAt, 'the supportsSnapshots else-branch disappeared').toBeGreaterThan(0)
    expect(
      unmarkAt,
      'unmarkSnapshotCovered must sit on the ELSE (non-snapshot-v1) branch — unmarking a '
      + 'snapshot-capable host would disable the gate for healthy sessions',
    ).toBeGreaterThan(elseAt)

    // (3) BEFORE the legacy record patching this method falls back to.
    const legacyPatchAt = body.indexOf('await updateSessionRecord(s.claudeSessionId', elseAt)
    expect(legacyPatchAt, 'legacy updateSessionRecord patching not found after the else branch').toBeGreaterThan(0)
    expect(
      unmarkAt,
      'unmarkSnapshotCovered must run BEFORE the legacy record patch, or the very write it '
      + 'is meant to unblock is still stripped',
    ).toBeLessThan(legacyPatchAt)
  })
})
