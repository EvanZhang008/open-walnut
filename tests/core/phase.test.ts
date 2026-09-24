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
  sessionInputPhase,
  sessionErrorPhase,
  readMarkerForPhase,
  TERMINAL_PHASES,
  sendSourceReopensTerminal,
  REOPENING_SEND_SOURCES,
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
    expect(PHASE_ORDER).toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE']);
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
    expect(PHASE_TO_STATUS.NEED_ACTION).toBe('in_progress');
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

  // The 2026-09-01 rename. Local rows are rewritten by the v11 DB migration, so
  // this line exists for everything that is NOT the local DB: plugin sync bodies,
  // replayed session events, and remote daemons still on an older build. Landing
  // on NEED_ACTION (not TODO, not COMPLETE) is the whole point — it is the SAME
  // state under a new name, so a task mid-handoff must not move.
  it('AGENT_COMPLETE → NEED_ACTION (renamed 2026-09-01, same state)', () => {
    expect(migratePhase('AGENT_COMPLETE')).toBe('NEED_ACTION');
  });

  it('NEED_ACTION survives migratePhase unchanged (already current)', () => {
    expect(migratePhase('NEED_ACTION')).toBe('NEED_ACTION');
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
  // i.e. work NOT done — TODO, not NEED_ACTION (which would flag them all
  // red+unread on upgrade). (WAIT removed 2026-08-18)
  it('WAIT → TODO', () => {
    expect(migratePhase('WAIT')).toBe('TODO');
  });

  it('PEER_CODE_REVIEW → NEED_ACTION', () => {
    expect(migratePhase('PEER_CODE_REVIEW')).toBe('NEED_ACTION');
  });

  it('RELEASE_IN_PIPELINE → NEED_ACTION', () => {
    expect(migratePhase('RELEASE_IN_PIPELINE')).toBe('NEED_ACTION');
  });

  it('the deleted 7-phase values land on NEED_ACTION, not TODO', () => {
    expect(migratePhase('HUMAN_VERIFIED')).toBe('NEED_ACTION');
    expect(migratePhase('POST_WORK_COMPLETED')).toBe('NEED_ACTION');
  });

  it('valid phases pass through unchanged', () => {
    for (const phase of PHASE_ORDER) {
      expect(migratePhase(phase)).toBe(phase);
    }
  });

  it('does not invent a phase for an unknown value', () => {
    expect(migratePhase('GARBAGE')).toBeUndefined();
    expect(migratePhase('')).toBeUndefined();
  });
});


describe('deriveStatusFromPhase', () => {
  it('derives correct status for all phases', () => {
    expect(deriveStatusFromPhase('TODO')).toBe('todo');
    expect(deriveStatusFromPhase('IN_PROGRESS')).toBe('in_progress');
    expect(deriveStatusFromPhase('NEED_ACTION')).toBe('in_progress');
    expect(deriveStatusFromPhase('COMPLETE')).toBe('done');
  });
});

// session:streaming existed ONLY to undo a stale error→WAIT repaint. With WAIT
// removed (2026-08-18) error lands on NEED_ACTION and session:turn-start
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
// exactly NEED_ACTION. The "it failed" signal lives on the SESSION's error
// badge, not on the task phase.
describe('sessionErrorPhase (WAIT removed 2026-08-18)', () => {
  it('lands on NEED_ACTION, not a dedicated blocked phase', () => {
    expect(sessionErrorPhase('TODO')).toBe('NEED_ACTION');
    expect(sessionErrorPhase('IN_PROGRESS')).toBe('NEED_ACTION');
  });

  it('is idempotent on NEED_ACTION and never overwrites COMPLETE', () => {
    expect(sessionErrorPhase('NEED_ACTION')).toBeNull();
    expect(sessionErrorPhase('COMPLETE')).toBeNull();
  });
});

// The unread dot used to light on WAIT (the error path) as well as
// NEED_ACTION. With both collapsed onto NEED_ACTION, that phase is the
// only one that sets it. (WAIT removed 2026-08-18)
describe('readMarkerForPhase', () => {
  it('NEED_ACTION is the only phase that marks unread', () => {
    expect(readMarkerForPhase('NEED_ACTION')).toEqual({ unread: true });
    expect(readMarkerForPhase('IN_PROGRESS')).toEqual({ unread: false });
    expect(readMarkerForPhase('COMPLETE')).toEqual({ unread: false });
    expect(readMarkerForPhase('TODO')).toEqual({});
  });
});

// A message delivered to a task's session is the ONE session event allowed to
// reopen a finished task (2026-09-23 user call). Marking a task done kills its
// CLI, so a later message can only be a human or a peer deliberately handing
// it more work — and then "completed" on the board would be a lie.
describe('sessionInputPhase (reopens COMPLETE, 2026-09-23)', () => {
  // The hand-back phase by construction (what an ended turn lands on), so this
  // file does not pin its spelling.
  const HANDBACK = sessionErrorPhase('IN_PROGRESS')!;

  it('pulls every non-running phase to IN_PROGRESS, COMPLETE included', () => {
    expect(sessionInputPhase('TODO')).toBe('IN_PROGRESS');
    expect(sessionInputPhase(HANDBACK)).toBe('IN_PROGRESS');
    expect(sessionInputPhase('COMPLETE')).toBe('IN_PROGRESS');
  });

  it('is idempotent on IN_PROGRESS (every send re-fires the trigger)', () => {
    expect(sessionInputPhase('IN_PROGRESS')).toBeNull();
  });

  it('only a human or peer send may reopen — automated provenance never does', () => {
    // Allowlist by design: a deliberate path missing here keeps the old behavior
    // (task stays done); a missed AUTOMATED path on a denylist would reopen a
    // finished task on every auto-continue nudge / routine tick.
    for (const source of ['ui', 'mobile', 'cli', 'peer', 'web-api', 'human-inbox']) {
      expect(sendSourceReopensTerminal(source), source).toBe(true);
    }
    for (const source of ['auto-continue', 'auto-recover', 'routine-trigger', 'routine-watcher',
      'hook:abc', 'side-thread', 'side-thread-digest', 'session-start', 'retry', 'restart', 'unknown', '']) {
      expect(sendSourceReopensTerminal(source), source).toBe(false);
    }
    expect(sendSourceReopensTerminal(undefined)).toBe(false);
    expect([...REOPENING_SEND_SOURCES].sort()).toEqual(['cli', 'human-inbox', 'mobile', 'peer', 'ui', 'web-api']);
  });

  it('is the ONLY session trigger that leaves the terminal phase', () => {
    // Background echoes of a turn that may predate the human's "done" click
    // must still lose to COMPLETE — only a new message reopens.
    expect(sessionTurnStartPhase('COMPLETE')).toBeNull();
    expect(sessionErrorPhase('COMPLETE')).toBeNull();
    expect(sessionStreamingPhase('COMPLETE')).toBeNull();
  });
});

describe('sessionTurnStartPhase (incidents 46f42871 + 1f11596b)', () => {
  it('INCIDENT SHAPE: pulls NEED_ACTION back to IN_PROGRESS when the CLI starts the queued turn', () => {
    // The queued-send race: input fired while phase was already IN_PROGRESS
    // (no-op), the previous turn's result flipped it to NEED_ACTION, and the
    // task showed completed while the CLI streamed the next turn.
    // session:streaming could NOT fix this (it only ever acted on WAIT) — that
    // gap is exactly why this trigger exists, and it is why streaming could be
    // retired outright when WAIT went away (2026-08-18).
    expect(sessionTurnStartPhase('NEED_ACTION')).toBe('IN_PROGRESS');
  });

  it('is idempotent on IN_PROGRESS and starts TODO tasks', () => {
    expect(sessionTurnStartPhase('IN_PROGRESS')).toBeNull();
    expect(sessionTurnStartPhase('TODO')).toBe('IN_PROGRESS');
  });

  it('never overwrites the terminal phase (a deliberate COMPLETE wins)', () => {
    expect(sessionTurnStartPhase('COMPLETE')).toBeNull();
  });
});
