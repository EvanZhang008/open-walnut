/**
 * Unit tests for phase utilities (src/core/phase.ts).
 *
 * Tests:
 * - computeSessionCompletionPhase: auto-progression logic
 * - migratePhase: legacy phase migration
 * - PHASE_ORDER: correct ordering
 * - shouldRollbackToInProgress: rollback set
 */
import { describe, it, expect } from 'vitest';
import {
  computeSessionCompletionPhase,
  migratePhase,
  PHASE_ORDER,
  VALID_PHASES,
  shouldRollbackToInProgress,
  deriveStatusFromPhase,
  PHASE_TO_STATUS,
} from '../../src/core/phase.js';

describe('PHASE_ORDER', () => {
  it('has exactly 9 phases', () => {
    expect(PHASE_ORDER).toHaveLength(9);
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
  it('maps all 9 phases to correct statuses', () => {
    expect(PHASE_TO_STATUS.TODO).toBe('todo');
    expect(PHASE_TO_STATUS.IN_PROGRESS).toBe('in_progress');
    expect(PHASE_TO_STATUS.AGENT_COMPLETE).toBe('in_progress');
    expect(PHASE_TO_STATUS.AWAIT_HUMAN_ACTION).toBe('in_progress');
    expect(PHASE_TO_STATUS.HUMAN_VERIFIED).toBe('in_progress');
    expect(PHASE_TO_STATUS.POST_WORK_COMPLETED).toBe('in_progress');
    expect(PHASE_TO_STATUS.PEER_CODE_REVIEW).toBe('in_progress');
    expect(PHASE_TO_STATUS.RELEASE_IN_PIPELINE).toBe('in_progress');
    expect(PHASE_TO_STATUS.COMPLETE).toBe('done');
  });
});

describe('computeSessionCompletionPhase', () => {
  it('TODO → AGENT_COMPLETE on success', () => {
    expect(computeSessionCompletionPhase('TODO', false)).toBe('AGENT_COMPLETE');
  });

  it('IN_PROGRESS → AGENT_COMPLETE on success', () => {
    expect(computeSessionCompletionPhase('IN_PROGRESS', false)).toBe('AGENT_COMPLETE');
  });

  it('AGENT_COMPLETE → null (no change, already there)', () => {
    expect(computeSessionCompletionPhase('AGENT_COMPLETE', false)).toBeNull();
  });

  it('AWAIT_HUMAN_ACTION → null (no regression)', () => {
    expect(computeSessionCompletionPhase('AWAIT_HUMAN_ACTION', false)).toBeNull();
  });

  it('HUMAN_VERIFIED → null (no regression)', () => {
    expect(computeSessionCompletionPhase('HUMAN_VERIFIED', false)).toBeNull();
  });

  it('POST_WORK_COMPLETED → null (no regression)', () => {
    expect(computeSessionCompletionPhase('POST_WORK_COMPLETED', false)).toBeNull();
  });

  it('PEER_CODE_REVIEW → null (no regression)', () => {
    expect(computeSessionCompletionPhase('PEER_CODE_REVIEW', false)).toBeNull();
  });

  it('RELEASE_IN_PIPELINE → null (no regression)', () => {
    expect(computeSessionCompletionPhase('RELEASE_IN_PIPELINE', false)).toBeNull();
  });

  it('COMPLETE → null (no regression)', () => {
    expect(computeSessionCompletionPhase('COMPLETE', false)).toBeNull();
  });

  it('TODO + error → null (no progression on error)', () => {
    expect(computeSessionCompletionPhase('TODO', true)).toBeNull();
  });

  it('IN_PROGRESS + error → null (no progression on error)', () => {
    expect(computeSessionCompletionPhase('IN_PROGRESS', true)).toBeNull();
  });

  it('AGENT_COMPLETE + error → null', () => {
    expect(computeSessionCompletionPhase('AGENT_COMPLETE', true)).toBeNull();
  });

  it('plan and exec sessions treated identically (both use same function)', () => {
    // No sessionMode parameter — plan/exec logic is identical
    expect(computeSessionCompletionPhase('TODO', false)).toBe('AGENT_COMPLETE');
    expect(computeSessionCompletionPhase('IN_PROGRESS', false)).toBe('AGENT_COMPLETE');
  });
});

describe('migratePhase', () => {
  it('INVESTIGATION → TODO', () => {
    expect(migratePhase('INVESTIGATION')).toBe('TODO');
  });

  it('HUMAN_VERIFICATION → AWAIT_HUMAN_ACTION', () => {
    expect(migratePhase('HUMAN_VERIFICATION')).toBe('AWAIT_HUMAN_ACTION');
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

describe('shouldRollbackToInProgress', () => {
  it('AGENT_COMPLETE → true', () => {
    expect(shouldRollbackToInProgress('AGENT_COMPLETE')).toBe(true);
  });

  it('AWAIT_HUMAN_ACTION → true', () => {
    expect(shouldRollbackToInProgress('AWAIT_HUMAN_ACTION')).toBe(true);
  });

  it('PEER_CODE_REVIEW → true', () => {
    expect(shouldRollbackToInProgress('PEER_CODE_REVIEW')).toBe(true);
  });

  it('POST_WORK_COMPLETED → true', () => {
    expect(shouldRollbackToInProgress('POST_WORK_COMPLETED')).toBe(true);
  });

  it('RELEASE_IN_PIPELINE → true', () => {
    expect(shouldRollbackToInProgress('RELEASE_IN_PIPELINE')).toBe(true);
  });

  it('HUMAN_VERIFIED → false (excluded: auto-push must preserve phase)', () => {
    expect(shouldRollbackToInProgress('HUMAN_VERIFIED')).toBe(false);
  });

  it('TODO → false', () => {
    expect(shouldRollbackToInProgress('TODO')).toBe(false);
  });

  it('IN_PROGRESS → false', () => {
    expect(shouldRollbackToInProgress('IN_PROGRESS')).toBe(false);
  });

  it('COMPLETE → false', () => {
    expect(shouldRollbackToInProgress('COMPLETE')).toBe(false);
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
    expect(deriveStatusFromPhase('PEER_CODE_REVIEW')).toBe('in_progress');
    expect(deriveStatusFromPhase('RELEASE_IN_PIPELINE')).toBe('in_progress');
    expect(deriveStatusFromPhase('COMPLETE')).toBe('done');
  });
});
