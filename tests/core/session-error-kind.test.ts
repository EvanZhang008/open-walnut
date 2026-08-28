/**
 * Unit tests for session-error-kind — the structural replacement for the prose
 * match that stranded 51 sessions (inc-1787439819342, 2026-08-22).
 *
 * The single most important case in this file is `snapshotProjectedNoMessage`:
 * a session in 'error' with `errorMessage: null` written by the snapshot
 * projection. Both recovery paths used to test `errorMessage.includes('Connection
 * lost')`, so that exact shape read as "non-recoverable" and was skipped forever
 * — a remote host's weekly patch reboot left the session dead for 3.5 hours after
 * the host was healthy again. If a future refactor makes that shape
 * non-recoverable again, this file fails.
 */

import { describe, it, expect } from 'vitest'
import type { SessionRecord } from '../../src/core/types.js'
import {
  classifySessionError,
  classifyStatusReasonKind,
  isRecoverableSessionError,
  isInfraSessionError,
  isRescuableStoppedRecord,
  INFRA_STATUS_REASONS,
  TERMINAL_STATUS_REASONS,
} from '../../src/core/session-error-kind.js'

type ErrorFacts = Pick<SessionRecord, 'errorKind' | 'status_reason' | 'errorMessage'>

function facts(o: Partial<ErrorFacts> = {}): ErrorFacts {
  return { errorKind: undefined, status_reason: undefined, errorMessage: undefined, ...o }
}

describe('classifyStatusReasonKind', () => {
  it('maps every infra reason to infra and every terminal reason to terminal', () => {
    for (const reason of INFRA_STATUS_REASONS) {
      expect(classifyStatusReasonKind(reason), reason).toBe('infra')
    }
    for (const reason of TERMINAL_STATUS_REASONS) {
      expect(classifyStatusReasonKind(reason), reason).toBe('terminal')
    }
  })

  it('never classifies a reason as BOTH — the two sets must stay disjoint', () => {
    const overlap = [...INFRA_STATUS_REASONS].filter((r) => TERMINAL_STATUS_REASONS.has(r))
    expect(overlap).toEqual([])
  })

  it('returns undefined for unknown / non-string reasons', () => {
    expect(classifyStatusReasonKind('api_error')).toBeUndefined()
    expect(classifyStatusReasonKind('snapshot_projection')).toBeUndefined()
    expect(classifyStatusReasonKind(undefined)).toBeUndefined()
    expect(classifyStatusReasonKind(42)).toBeUndefined()
  })
})

describe('classifySessionError precedence', () => {
  it('the structured field outranks the reason', () => {
    // A terminal reason with an explicit infra stamp: the stamp wins. This is the
    // hand-off shape — the projection writes snapshot_projection + the kind the
    // gate stashed.
    expect(classifySessionError(facts({ errorKind: 'infra', status_reason: 'user_stopped' }))).toBe('infra')
    expect(classifySessionError(facts({ errorKind: 'terminal', status_reason: 'remote_unreachable' }))).toBe('terminal')
  })

  it('the reason outranks the prose', () => {
    expect(classifySessionError(facts({
      status_reason: 'user_stopped',
      errorMessage: 'Connection lost — unable to reach remote host',
    }))).toBe('terminal')
  })

  it('falls back to prose for records written before errorKind existed', () => {
    expect(classifySessionError(facts({
      errorMessage: 'Connection lost — unable to reach remote host',
    }))).toBe('infra')
    expect(classifySessionError(facts({
      errorMessage: 'Connection to clouddev failed 31s ago: ssh: Connection closed by UNKNOWN port 65535',
    }))).toBe('infra')
  })

  it('returns unknown when nothing identifies the cause', () => {
    expect(classifySessionError(facts())).toBe('unknown')
    expect(classifySessionError(facts({ status_reason: 'snapshot_projection' }))).toBe('unknown')
  })

  it('leaves api_error unknown — that bucket belongs to turn-retry / auto-continue', () => {
    // Half of it is transient and half is auth failures and model refusals, which
    // must never be auto-resumed. Owning it here would resume both.
    expect(classifySessionError(facts({
      status_reason: 'api_error',
      errorMessage: 'Error getting AWS credentials from awsCredentialExport',
    }))).toBe('unknown')
  })
})

describe('the incident shape', () => {
  const snapshotProjectedNoMessage = facts({
    status_reason: 'snapshot_projection',
    errorMessage: undefined,
    errorKind: undefined,
  })

  it('is RECOVERABLE — a message-less error must never be skipped by the recovery loops', () => {
    expect(isRecoverableSessionError(snapshotProjectedNoMessage)).toBe(true)
  })

  it('is NOT auto-resumable on its own — unknown must not spend tokens unattended', () => {
    expect(isInfraSessionError(snapshotProjectedNoMessage)).toBe(false)
  })

  it('becomes auto-resumable once the gate hand-off stamps the kind', () => {
    const afterHandoff = facts({
      status_reason: 'snapshot_projection',
      errorMessage: 'Connection lost — unable to reach remote host',
      errorKind: 'infra',
    })
    expect(isRecoverableSessionError(afterHandoff)).toBe(true)
    expect(isInfraSessionError(afterHandoff)).toBe(true)
  })
})

describe('the two tiers have different bars', () => {
  it('recoverable includes unknown; infra does not', () => {
    const unknown = facts()
    expect(isRecoverableSessionError(unknown)).toBe(true)
    expect(isInfraSessionError(unknown)).toBe(false)
  })

  it('a positively terminal cause fails both', () => {
    for (const reason of TERMINAL_STATUS_REASONS) {
      const f = facts({ status_reason: reason as SessionRecord['status_reason'] })
      expect(isRecoverableSessionError(f), reason).toBe(false)
      expect(isInfraSessionError(f), reason).toBe(false)
    }
  })

  it('idle_timeout is terminal — reviving it would fight our own reaper', () => {
    expect(classifySessionError(facts({
      status_reason: 'idle_timeout',
      errorMessage: 'No output for 31 min',
    }))).toBe('terminal')
  })
})

// ═══════════════════════════════════════════════════════════════════
//  isRescuableStoppedRecord — 'stopped' is no longer an unconditional
//  dead end (inc-1787511363340: a spawn whose daemon `start` timed out
//  was marked 'stopped'; the command executed 15s later anyway and the
//  live CLI ran 1.6h behind a record every recovery loop skipped).
// ═══════════════════════════════════════════════════════════════════

describe('isRescuableStoppedRecord', () => {
  const NOW = Date.parse('2026-08-23T18:50:00.000Z')
  const RECENT = new Date(NOW - 10 * 60 * 1000).toISOString() // 10 min ago
  const STALE = new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() // 3 days ago

  type StoppedFacts = Parameters<typeof isRescuableStoppedRecord>[0]
  function stopped(o: Partial<StoppedFacts> = {}): StoppedFacts {
    return {
      process_status: 'stopped',
      errorKind: undefined,
      status_reason: undefined,
      errorMessage: undefined,
      status_changed_by: undefined,
      last_status_change: RECENT,
      ...o,
    }
  }

  it('rescues the incident shape: recent bare stopped (un-stamped, no message)', () => {
    expect(isRescuableStoppedRecord(stopped(), NOW)).toBe(true)
  })

  it('rescues a recent stopped with an infra cause (spawn_outcome_unknown, liveness_check_failed)', () => {
    expect(isRescuableStoppedRecord(stopped({
      status_reason: 'spawn_outcome_unknown', status_changed_by: 'session-runner',
    }), NOW)).toBe(true)
    expect(isRescuableStoppedRecord(stopped({
      status_reason: 'liveness_check_failed', status_changed_by: 'system',
    }), NOW)).toBe(true)
  })

  it('never rescues a user-intentional stop, regardless of reason', () => {
    expect(isRescuableStoppedRecord(stopped({ status_changed_by: 'user' }), NOW)).toBe(false)
    expect(isRescuableStoppedRecord(stopped({
      status_changed_by: 'user', status_reason: 'remote_unreachable',
    }), NOW)).toBe(false)
  })

  it('never rescues a terminal-class reason (idle_timeout / user_stopped / expected_teardown / turn_completed)', () => {
    for (const reason of ['idle_timeout', 'user_stopped', 'expected_teardown', 'turn_completed'] as const) {
      expect(isRescuableStoppedRecord(stopped({ status_reason: reason }), NOW), reason).toBe(false)
    }
  })

  it('never rescues outside the recency window — old records are settled truth', () => {
    expect(isRescuableStoppedRecord(stopped({ last_status_change: STALE }), NOW)).toBe(false)
  })

  it('a missing or unparsable timestamp reads as settled history, not a fresh wedge', () => {
    expect(isRescuableStoppedRecord(stopped({ last_status_change: undefined }), NOW)).toBe(false)
    expect(isRescuableStoppedRecord(stopped({ last_status_change: 'not-a-date' }), NOW)).toBe(false)
  })

  it('only applies to stopped — running/idle/error records are other paths’ business', () => {
    for (const ps of ['running', 'idle', 'error'] as const) {
      expect(isRescuableStoppedRecord(stopped({ process_status: ps }), NOW), ps).toBe(false)
    }
  })

  it('spawn_outcome_unknown is an INFRA reason — recoverable AND auto-resumable', () => {
    const f = facts({ status_reason: 'spawn_outcome_unknown' })
    expect(classifySessionError(f)).toBe('infra')
    expect(isRecoverableSessionError(f)).toBe(true)
    expect(isInfraSessionError(f)).toBe(true)
  })
})
