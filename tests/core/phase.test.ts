/**
 * Unit tests for phase utilities (src/core/phase.ts).
 *
 * Tests:
 * - PHASE_ORDER: correct ordering and count
 * - PHASE_TO_STATUS: phase-to-status mapping
 * - migratePhase: legacy phase migration
 * - deriveStatusFromPhase: status derivation
 */
import { describe, it, expect } from 'vitest';
import {
  migratePhase,
  PHASE_ORDER,
  VALID_PHASES,
  deriveStatusFromPhase,
  PHASE_TO_STATUS,
  sessionStreamingPhase,
  sessionTurnStartPhase,
} from '../../src/core/phase.js';

describe('PHASE_ORDER', () => {
  it('has exactly 7 phases', () => {
    expect(PHASE_ORDER).toHaveLength(7);
  });

  it('starts with TODO and ends with COMPLETE', () => {
    expect(PHASE_ORDER[0]).toBe('TODO');
    expect(PHASE_ORDER[PHASE_ORDER.length - 1]).toBe('COMPLETE');
  });

  it('does not include INVESTIGATION or HUMAN_VERIFICATION', () => {
    expect(PHASE_ORDER).not.toContain('INVESTIGATION');
    expect(PHASE_ORDER).not.toContain('HUMAN_VERIFICATION');
  });

  it('includes AWAIT_HUMAN_ACTION', () => {
    expect(PHASE_ORDER).toContain('AWAIT_HUMAN_ACTION');
  });
});

describe('VALID_PHASES', () => {
  it('matches PHASE_ORDER', () => {
    expect(VALID_PHASES.size).toBe(PHASE_ORDER.length);
    for (const p of PHASE_ORDER) {
      expect(VALID_PHASES.has(p)).toBe(true);
    }
  });

  it('does not include removed phases', () => {
    expect(VALID_PHASES.has('INVESTIGATION')).toBe(false);
    expect(VALID_PHASES.has('HUMAN_VERIFICATION')).toBe(false);
  });
});

describe('PHASE_TO_STATUS', () => {
  it('maps all 7 phases to correct statuses', () => {
    expect(PHASE_TO_STATUS.TODO).toBe('todo');
    expect(PHASE_TO_STATUS.IN_PROGRESS).toBe('in_progress');
    expect(PHASE_TO_STATUS.AGENT_COMPLETE).toBe('in_progress');
    expect(PHASE_TO_STATUS.AWAIT_HUMAN_ACTION).toBe('in_progress');
    expect(PHASE_TO_STATUS.HUMAN_VERIFIED).toBe('in_progress');
    expect(PHASE_TO_STATUS.POST_WORK_COMPLETED).toBe('in_progress');
    expect(PHASE_TO_STATUS.COMPLETE).toBe('done');
  });
});


describe('migratePhase', () => {
  it('INVESTIGATION → TODO', () => {
    expect(migratePhase('INVESTIGATION')).toBe('TODO');
  });

  it('HUMAN_VERIFICATION → AWAIT_HUMAN_ACTION', () => {
    expect(migratePhase('HUMAN_VERIFICATION')).toBe('AWAIT_HUMAN_ACTION');
  });

  it('PEER_CODE_REVIEW → HUMAN_VERIFIED', () => {
    expect(migratePhase('PEER_CODE_REVIEW')).toBe('HUMAN_VERIFIED');
  });

  it('RELEASE_IN_PIPELINE → POST_WORK_COMPLETED', () => {
    expect(migratePhase('RELEASE_IN_PIPELINE')).toBe('POST_WORK_COMPLETED');
  });

  it('valid phases pass through unchanged', () => {
    for (const phase of PHASE_ORDER) {
      expect(migratePhase(phase)).toBe(phase);
    }
  });

  it('unknown phase → TODO', () => {
    expect(migratePhase('GARBAGE')).toBe('TODO');
    expect(migratePhase('')).toBe('TODO');
  });
});


describe('deriveStatusFromPhase', () => {
  it('derives correct status for all phases', () => {
    expect(deriveStatusFromPhase('TODO')).toBe('todo');
    expect(deriveStatusFromPhase('IN_PROGRESS')).toBe('in_progress');
    expect(deriveStatusFromPhase('AGENT_COMPLETE')).toBe('in_progress');
    expect(deriveStatusFromPhase('AWAIT_HUMAN_ACTION')).toBe('in_progress');
    expect(deriveStatusFromPhase('HUMAN_VERIFIED')).toBe('in_progress');
    expect(deriveStatusFromPhase('POST_WORK_COMPLETED')).toBe('in_progress');
    expect(deriveStatusFromPhase('COMPLETE')).toBe('done');
  });
});

describe('sessionStreamingPhase', () => {
  it('undoes a stale AWAIT_HUMAN_ACTION (streaming session cannot be awaiting human)', () => {
    expect(sessionStreamingPhase('AWAIT_HUMAN_ACTION')).toBe('IN_PROGRESS');
  });

  it('does NOT disturb any non-await phase (returns null = no transition)', () => {
    expect(sessionStreamingPhase('TODO')).toBeNull();
    expect(sessionStreamingPhase('IN_PROGRESS')).toBeNull();
    expect(sessionStreamingPhase('AGENT_COMPLETE')).toBeNull();
  });

  it('never overwrites terminal phases', () => {
    expect(sessionStreamingPhase('HUMAN_VERIFIED')).toBeNull();
    expect(sessionStreamingPhase('POST_WORK_COMPLETED')).toBeNull();
    expect(sessionStreamingPhase('COMPLETE')).toBeNull();
  });
});

describe('sessionTurnStartPhase (incidents 46f42871 + 1f11596b)', () => {
  it('INCIDENT SHAPE: pulls AGENT_COMPLETE back to IN_PROGRESS when the CLI starts the queued turn', () => {
    // The queued-send race: input fired while phase was already IN_PROGRESS
    // (no-op), the previous turn's result flipped it to AGENT_COMPLETE, and the
    // task showed completed while the CLI streamed the next turn.
    // session:streaming can NOT fix this (it only acts on AWAIT_HUMAN_ACTION) —
    // that gap is exactly why this trigger exists.
    expect(sessionTurnStartPhase('AGENT_COMPLETE')).toBe('IN_PROGRESS');
  });

  it('also undoes a triage push to AWAIT_HUMAN_ACTION (red row while running)', () => {
    expect(sessionTurnStartPhase('AWAIT_HUMAN_ACTION')).toBe('IN_PROGRESS');
  });

  it('is idempotent on IN_PROGRESS and starts TODO tasks', () => {
    expect(sessionTurnStartPhase('IN_PROGRESS')).toBeNull();
    expect(sessionTurnStartPhase('TODO')).toBe('IN_PROGRESS');
  });

  it('never overwrites terminal phases (human decisions win)', () => {
    expect(sessionTurnStartPhase('HUMAN_VERIFIED')).toBeNull();
    expect(sessionTurnStartPhase('COMPLETE')).toBeNull();
  });
});
