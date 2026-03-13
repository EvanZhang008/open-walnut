/**
 * Task Phase + Session Status Lifecycle
 * ======================================
 *
 * Task and Session use aligned status names. Session work_status is a subset of Task phase.
 *
 * Task Phases (9):
 *   TODO → IN_PROGRESS → AGENT_COMPLETE → AWAIT_HUMAN_ACTION
 *        → HUMAN_VERIFIED → POST_WORK_COMPLETED
 *        → PEER_CODE_REVIEW → RELEASE_IN_PIPELINE → COMPLETE
 *
 * Session Work Status (5, subset of task phases):
 *   in_progress | agent_complete | await_human_action | completed | error
 *
 *
 * Automatic transitions (code-driven, plan/exec identical):
 * ─────────────────────────────────────────────────────────
 *
 *   Session starts        → task: TODO → IN_PROGRESS           [claude-code-session.ts]
 *   Session succeeds      → task: ≤IN_PROGRESS → AGENT_COMPLETE [server.ts auto-progress]
 *   Session resumes       → task: ≥AGENT_COMPLETE → IN_PROGRESS [rollback on send_to_session]
 *
 *
 * Triage agent (exactly 2 outcomes):
 * ────────────────────────────────────
 *
 *   AGENT_COMPLETE ──► send_to_session    → IN_PROGRESS        (continue work)
 *                  └─► AWAIT_HUMAN_ACTION + needs_attention     (default: wait for human)
 *
 *   AGENT_COMPLETE is transient — triage runs immediately after session completion.
 *   After triage, task is always IN_PROGRESS or AWAIT_HUMAN_ACTION.
 *
 *
 * Human actions:
 * ──────────────
 *
 *   AWAIT_HUMAN_ACTION → COMPLETE    (only humans can set COMPLETE)
 *   Any phase → any phase            (via UI phase picker)
 *
 *
 * Invariant: auto-progression only moves phase FORWARD, never backward.
 */

import type { TaskPhase, TaskStatus, Task } from './types.js';

// ── Phase → Status (9 → 3) ──

export const PHASE_TO_STATUS: Record<TaskPhase, TaskStatus> = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  AGENT_COMPLETE: 'in_progress',
  AWAIT_HUMAN_ACTION: 'in_progress',
  HUMAN_VERIFIED: 'in_progress',
  POST_WORK_COMPLETED: 'in_progress',
  PEER_CODE_REVIEW: 'in_progress',
  RELEASE_IN_PIPELINE: 'in_progress',
  COMPLETE: 'done',
};

// ── Status → Default Phase (3 → 7, for migration) ──

export const STATUS_TO_DEFAULT_PHASE: Record<TaskStatus, TaskPhase> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  done: 'COMPLETE',
};

// ── Ordered phases (for cycle) ──

export const PHASE_ORDER: TaskPhase[] = [
  'TODO',
  'IN_PROGRESS',
  'AGENT_COMPLETE',
  'AWAIT_HUMAN_ACTION',
  'HUMAN_VERIFIED',
  'POST_WORK_COMPLETED',
  'PEER_CODE_REVIEW',
  'RELEASE_IN_PIPELINE',
  'COMPLETE',
];

export const VALID_PHASES = new Set<string>(PHASE_ORDER);

// ── Core functions ──

/** Derive the 3-state status from a 9-state phase. */
export function deriveStatusFromPhase(phase: TaskPhase): TaskStatus {
  return PHASE_TO_STATUS[phase] ?? 'todo';
}

/** Get the default phase for a legacy status (migration). */
export function phaseFromStatus(status: TaskStatus): TaskPhase {
  return STATUS_TO_DEFAULT_PHASE[status] ?? 'TODO';
}

/**
 * Apply a phase to a task, updating phase + derived status + metadata.
 * Mutates the task in place.
 */
export function applyPhase(task: Task, phase: TaskPhase): void {
  task.phase = phase;
  task.status = deriveStatusFromPhase(phase);

  if (phase === 'COMPLETE') {
    if (!task.completed_at) task.completed_at = new Date().toISOString();
    task.session_id = undefined;          // new 1-slot
    task.plan_session_id = undefined;     // legacy 2-slot (backward compat)
    task.exec_session_id = undefined;     // legacy 2-slot (backward compat)
    task.needs_attention = undefined;
  } else {
    task.completed_at = undefined;
  }
}

// ── Auto-progression on session completion ──

/**
 * Compute the new task phase after a session completes.
 * Returns the new phase, or null if no change is needed.
 *
 * Rules:
 *   - Success + phase ≤ IN_PROGRESS → AGENT_COMPLETE (plan/exec identical)
 *   - Success + phase ≥ AGENT_COMPLETE → no change (don't regress)
 *   - Error → no change
 *
 * This is a pure function — no side effects.
 */
export function computeSessionCompletionPhase(
  currentPhase: TaskPhase,
  isError: boolean,
): TaskPhase | null {
  if (isError) return null;

  const currentIndex = PHASE_ORDER.indexOf(currentPhase);
  const targetIndex = PHASE_ORDER.indexOf('AGENT_COMPLETE');

  // Only advance forward — never regress
  if (currentIndex < targetIndex) {
    return 'AGENT_COMPLETE';
  }

  return null;
}

// ── Phase migration (legacy data) ──

/**
 * Migrate legacy phase values to current ones.
 * Returns the migrated phase, or the original if no migration needed.
 */
export function migratePhase(phase: string): TaskPhase {
  if (phase === 'INVESTIGATION') return 'TODO';
  if (phase === 'HUMAN_VERIFICATION') return 'AWAIT_HUMAN_ACTION';
  if (VALID_PHASES.has(phase)) return phase as TaskPhase;
  return 'TODO';
}

// ── Session-resume rollback ──

/** Phases that should auto-rollback to IN_PROGRESS when a session resumes work.
 *  HUMAN_VERIFIED is intentionally excluded — during auto-push the phase must stay
 *  so triage knows the user already verified the work. */
const ROLLBACK_PHASES = new Set<TaskPhase>([
  'AGENT_COMPLETE',
  'AWAIT_HUMAN_ACTION',
  'POST_WORK_COMPLETED',
  'PEER_CODE_REVIEW',
  'RELEASE_IN_PIPELINE',
]);

/** Returns true if the given phase should roll back to IN_PROGRESS when a session resumes. */
export function shouldRollbackToInProgress(phase: TaskPhase): boolean {
  return ROLLBACK_PHASES.has(phase);
}
