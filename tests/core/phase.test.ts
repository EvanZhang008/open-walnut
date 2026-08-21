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
  sessionErrorPhase,
  readMarkerForPhase,
  TERMINAL_PHASES,
} from '../../src/core/phase.js';

describe('PHASE_ORDER', () => {
  // WAIT removed 2026-08-18 — 5 phases became 4.
  it('has exactly 4 phases', () => {
    expect(PHASE_ORDER).toHaveLength(4);
  });

  it('starts with TODO and ends with COMPLETE', () => {
    expect(PHASE_ORDER[0]).toBe('TODO');
    expect(PHASE_ORDER[PHASE_ORDER.length - 1]).toBe('COMPLETE');
  });

  it('is exactly the 4-phase lifecycle, in order', () => {
    expect(PHASE_ORDER).toEqual(['TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'COMPLETE']);
  });

  it('does not include INVESTIGATION or HUMAN_VERIFICATION', () => {
    expect(PHASE_ORDER).not.toContain('INVESTIGATION');
    expect(PHASE_ORDER).not.toContain('HUMAN_VERIFICATION');
  });

  // (WAIT removed 2026-08-18) — a blocked/parked task is just TODO; the
  // Focus Bar's lowercase 'wait' PIN TIER is a different axis and still exists.
  it('does not include WAIT', () => {
    expect(PHASE_ORDER).not.toContain('WAIT');
  });

  it('does not include the deleted human-only phases', () => {
    expect(PHASE_ORDER).not.toContain('AWAIT_HUMAN_ACTION');
    expect(PHASE_ORDER).not.toContain('HUMAN_VERIFIED');
    expect(PHASE_ORDER).not.toContain('POST_WORK_COMPLETED');
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
    expect(VALID_PHASES.has('AWAIT_HUMAN_ACTION')).toBe(false);
    expect(VALID_PHASES.has('HUMAN_VERIFIED')).toBe(false);
    expect(VALID_PHASES.has('POST_WORK_COMPLETED')).toBe(false);
    // (WAIT removed 2026-08-18)
    expect(VALID_PHASES.has('WAIT')).toBe(false);
  });
});

describe('PHASE_TO_STATUS', () => {
  it('maps all 4 phases to correct statuses', () => {
    expect(PHASE_TO_STATUS.TODO).toBe('todo');
    expect(PHASE_TO_STATUS.IN_PROGRESS).toBe('in_progress');
    expect(PHASE_TO_STATUS.AGENT_COMPLETE).toBe('in_progress');
    expect(PHASE_TO_STATUS.COMPLETE).toBe('done');
    // (WAIT removed 2026-08-18) — no entry left for it.
    expect(Object.keys(PHASE_TO_STATUS)).not.toContain('WAIT');
  });
});

describe('TERMINAL_PHASES', () => {
  it('is exactly COMPLETE — the only phase background events must not overwrite', () => {
    expect([...TERMINAL_PHASES]).toEqual(['COMPLETE']);
  });
});


describe('migratePhase', () => {
  it('INVESTIGATION → TODO', () => {
    expect(migratePhase('INVESTIGATION')).toBe('TODO');
  });

  // 99 real tasks carry AWAIT_HUMAN_ACTION — the rename must not drop them on the
  // floor. It used to land on WAIT; WAIT removed 2026-08-18, so it follows WAIT to TODO.
  it('AWAIT_HUMAN_ACTION → TODO (WAIT removed 2026-08-18)', () => {
    expect(migratePhase('AWAIT_HUMAN_ACTION')).toBe('TODO');
  });

  it('HUMAN_VERIFICATION → TODO (WAIT removed 2026-08-18)', () => {
    expect(migratePhase('HUMAN_VERIFICATION')).toBe('TODO');
  });

  // The removal itself: existing WAIT rows are "waiting on something external",
  // i.e. work NOT done — TODO, not AGENT_COMPLETE (which would flag them all
  // red+unread on upgrade). (WAIT removed 2026-08-18)
  it('WAIT → TODO', () => {
    expect(migratePhase('WAIT')).toBe('TODO');
  });

  it('PEER_CODE_REVIEW → AGENT_COMPLETE', () => {
    expect(migratePhase('PEER_CODE_REVIEW')).toBe('AGENT_COMPLETE');
  });

  it('RELEASE_IN_PIPELINE → AGENT_COMPLETE', () => {
    expect(migratePhase('RELEASE_IN_PIPELINE')).toBe('AGENT_COMPLETE');
  });

  it('the deleted 7-phase values land on AGENT_COMPLETE, not TODO', () => {
    expect(migratePhase('HUMAN_VERIFIED')).toBe('AGENT_COMPLETE');
    expect(migratePhase('POST_WORK_COMPLETED')).toBe('AGENT_COMPLETE');
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
    expect(deriveStatusFromPhase('COMPLETE')).toBe('done');
  });
});

// session:streaming existed ONLY to undo a stale error→WAIT repaint. With WAIT
// removed (2026-08-18) error lands on AGENT_COMPLETE and session:turn-start
// already pulls a newly-running turn back to IN_PROGRESS, so this is now an
// unconditional no-op — kept parseable so replayed events from old servers don't crash.
describe('sessionStreamingPhase (retired with WAIT, 2026-08-18)', () => {
  it('is an unconditional no-op for every phase', () => {
    for (const phase of PHASE_ORDER) {
      expect(sessionStreamingPhase(phase)).toBeNull();
    }
  });
});

// session:error used to land on WAIT ("blocked, look at it"). WAIT removed
// 2026-08-18: the turn is over and the ball is back with the human, which is
// exactly AGENT_COMPLETE. The "it failed" signal lives on the SESSION's error
// badge, not on the task phase.
describe('sessionErrorPhase (WAIT removed 2026-08-18)', () => {
  it('lands on AGENT_COMPLETE, not a dedicated blocked phase', () => {
    expect(sessionErrorPhase('TODO')).toBe('AGENT_COMPLETE');
    expect(sessionErrorPhase('IN_PROGRESS')).toBe('AGENT_COMPLETE');
  });

  it('is idempotent on AGENT_COMPLETE and never overwrites COMPLETE', () => {
    expect(sessionErrorPhase('AGENT_COMPLETE')).toBeNull();
    expect(sessionErrorPhase('COMPLETE')).toBeNull();
  });
});

// The unread dot used to light on WAIT (the error path) as well as
// AGENT_COMPLETE. With both collapsed onto AGENT_COMPLETE, that phase is the
// only one that sets it. (WAIT removed 2026-08-18)
describe('readMarkerForPhase', () => {
  it('AGENT_COMPLETE is the only phase that marks unread', () => {
    expect(readMarkerForPhase('AGENT_COMPLETE')).toEqual({ unread: true });
    expect(readMarkerForPhase('IN_PROGRESS')).toEqual({ unread: false });
    expect(readMarkerForPhase('COMPLETE')).toEqual({ unread: false });
    expect(readMarkerForPhase('TODO')).toEqual({});
  });
});

describe('sessionTurnStartPhase (incidents 46f42871 + 1f11596b)', () => {
  it('INCIDENT SHAPE: pulls AGENT_COMPLETE back to IN_PROGRESS when the CLI starts the queued turn', () => {
    // The queued-send race: input fired while phase was already IN_PROGRESS
    // (no-op), the previous turn's result flipped it to AGENT_COMPLETE, and the
    // task showed completed while the CLI streamed the next turn.
    // session:streaming could NOT fix this (it only ever acted on WAIT) — that
    // gap is exactly why this trigger exists, and it is why streaming could be
    // retired outright when WAIT went away (2026-08-18).
    expect(sessionTurnStartPhase('AGENT_COMPLETE')).toBe('IN_PROGRESS');
  });

  it('is idempotent on IN_PROGRESS and starts TODO tasks', () => {
    expect(sessionTurnStartPhase('IN_PROGRESS')).toBeNull();
    expect(sessionTurnStartPhase('TODO')).toBe('IN_PROGRESS');
  });

  it('never overwrites the terminal phase (a deliberate COMPLETE wins)', () => {
    expect(sessionTurnStartPhase('COMPLETE')).toBeNull();
  });
});
