/**
 * Task Phase — Unconditional State Machine + applySessionPhase()
 * ==============================================================
 *
 * Two-layer phase management (K8s-style push + reconcile):
 *
 * Layer 1: Push (ms-level, reliable with retry)
 *   session:result     → AGENT_COMPLETE      unconditional
 *   session:input      → IN_PROGRESS         unconditional (fires at SEND time)
 *   session:turn-start → IN_PROGRESS         unconditional (fires when the CLI
 *                        actually STARTS the turn — session_state_changed{running};
 *                        covers queued/mid-turn sends whose input transition was a
 *                        no-op and whose phase was then flipped by the previous
 *                        turn's result)
 *   session:error      → AWAIT_HUMAN_ACTION  unconditional
 *   session:streaming  → IN_PROGRESS         only when === AWAIT_HUMAN_ACTION
 *   triage-sync        → AWAIT_HUMAN_ACTION  only when === AGENT_COMPLETE
 *                        AND the session is not actively running (checked at the
 *                        call sites via process_status — a late triage from the
 *                        previous turn must not repaint a live turn red)
 *
 *   All go through applySessionPhase() — unified retry + logging + error handling.
 *
 * Layer 2: Reconciler (30s, catches rare failures)
 *   Health monitor derives expected phase from session facts.
 *   Only Rule A: all primary sessions dead + task IN_PROGRESS → AWAIT_HUMAN_ACTION.
 *   No Rule B: never infer phase from session status (could propagate stale data).
 *
 * Terminal phases: COMPLETE, HUMAN_VERIFIED — system never overwrites these.
 *
 * Task Phases (7):
 *   TODO → IN_PROGRESS → AGENT_COMPLETE → AWAIT_HUMAN_ACTION
 *        → HUMAN_VERIFIED → POST_WORK_COMPLETED → COMPLETE
 */

import { log } from '../logging/index.js'
import type { TaskPhase, TaskStatus, Task } from './types.js';

// ── Phase → Status (7 → 3) ──

export const PHASE_TO_STATUS: Record<TaskPhase, TaskStatus> = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  AGENT_COMPLETE: 'in_progress',
  AWAIT_HUMAN_ACTION: 'in_progress',
  HUMAN_VERIFIED: 'in_progress',
  POST_WORK_COMPLETED: 'in_progress',
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
  'COMPLETE',
];

export const VALID_PHASES = new Set<string>(PHASE_ORDER);

/** Phases that only humans can set — system never overwrites.
 *  HUMAN_VERIFIED is terminal because it represents explicit human approval.
 *  If the system could overwrite it (e.g. session:input → IN_PROGRESS),
 *  auto-push workflows would lose the signal that a human already verified. */
export const TERMINAL_PHASES = new Set<TaskPhase>(['COMPLETE', 'HUMAN_VERIFIED']);

// ── Core functions ──

/** Derive the 3-state status from a 7-state phase. */
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

// ── Phase migration (legacy data) ──

/**
 * Migrate legacy phase values to current ones.
 * Returns the migrated phase, or the original if no migration needed.
 */
export function migratePhase(phase: string): TaskPhase {
  if (phase === 'INVESTIGATION') return 'TODO';
  if (phase === 'HUMAN_VERIFICATION') return 'AWAIT_HUMAN_ACTION';
  if (phase === 'PEER_CODE_REVIEW') return 'HUMAN_VERIFIED';
  if (phase === 'RELEASE_IN_PIPELINE') return 'POST_WORK_COMPLETED';
  if (VALID_PHASES.has(phase)) return phase as TaskPhase;
  return 'TODO';
}

// WHY unconditional: The old computeSessionCompletionPhase only advanced forward
// (phase < AGENT_COMPLETE), which blocked self-healing — if a task drifted to
// AWAIT_HUMAN_ACTION, the next session:result couldn't correct it back to
// AGENT_COMPLETE. Unconditional transitions ensure any event always sets the
// correct phase regardless of current state.

// ── Unconditional Session → Phase State Machine ──

/** Session produced result → AGENT_COMPLETE. Unconditional. */
export function sessionResultPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'AGENT_COMPLETE') return null
  return 'AGENT_COMPLETE'
}

/** Session received input → IN_PROGRESS. Unconditional. */
export function sessionInputPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'IN_PROGRESS') return null
  return 'IN_PROGRESS'
}

/**
 * CLI actually started executing a turn → IN_PROGRESS. Unconditional.
 *
 * The missing half of the result↔turn symmetry: turn-END has an authoritative
 * phase driver (session:result → AGENT_COMPLETE) but turn-START only had
 * session:input, which fires at SEND time. Interactive chat sends the next
 * message while the previous turn is still running (queued / mid-turn inject),
 * so that input transition is a no-op (phase already IN_PROGRESS) — then the
 * PREVIOUS turn's result flips the phase to AGENT_COMPLETE (triage may push it
 * on to AWAIT_HUMAN_ACTION), and when the queued message finally starts
 * running NOTHING pulls the phase back: the task shows completed/red while
 * the CLI is visibly streaming (incidents 46f42871 + 1f11596b, 2026-08-03).
 * Trigger: session_state_changed{running} — the CLI's own turn-start signal —
 * with the replay guard applied at the call site (a replayed running event
 * describes the past and must not flip the present phase).
 */
export function sessionTurnStartPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'IN_PROGRESS') return null
  return 'IN_PROGRESS'
}

/** Session errored → AWAIT_HUMAN_ACTION. Unconditional. */
export function sessionErrorPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'AWAIT_HUMAN_ACTION') return null
  return 'AWAIT_HUMAN_ACTION'
}

/**
 * Session is actively streaming again → undo a stale AWAIT_HUMAN_ACTION.
 *
 * Invariant: a session that is streaming output (or that just produced a
 * result) cannot logically be "waiting for human action". This corrects the
 * race where a transient/late session:error flipped the task to
 * AWAIT_HUMAN_ACTION while the session had already recovered (e.g. remote CLI
 * exited cleanly at a turn boundary and was resumed via --resume in the same
 * send). ONLY acts on AWAIT_HUMAN_ACTION — never disturbs any other phase, so
 * a genuinely-stuck session a human paused stays put unless output resumes.
 */
export function sessionStreamingPhase(current: TaskPhase): TaskPhase | null {
  if (current === 'AWAIT_HUMAN_ACTION') return 'IN_PROGRESS'
  return null
}

// ── applySessionPhase() — single entry point for all session → phase updates ──

export type PhaseTransitionTrigger =
  | 'session:result'
  | 'session:input'
  | 'session:error'
  | 'session:streaming'
  | 'session:turn-start'
  | 'triage-sync'
  | 'reconciler'

interface ApplySessionPhaseOpts {
  sessionId?: string
  processAlive?: boolean
  /** For 'reconciler' trigger: caller computes the expected phase. */
  newPhase?: TaskPhase
}

/**
 * Apply a session-driven phase transition with full logging.
 * Single entry point for ALL session → phase updates.
 * Built-in retry (2 attempts) so Layer 1 is reliable on its own.
 */
export async function applySessionPhase(
  taskId: string,
  trigger: PhaseTransitionTrigger,
  source: string,
  opts?: ApplySessionPhaseOpts,
): Promise<{ changed: boolean; oldPhase?: TaskPhase; newPhase?: TaskPhase }> {
  // Dynamic imports to avoid circular dependencies (phase.ts ← task-manager.ts)
  const { getTask, updateTaskRaw } = await import('./task-manager.js')
  let task: Task
  try {
    task = await getTask(taskId)
  } catch {
    log.session.warn('applySessionPhase: task not found', { taskId, trigger, source })
    return { changed: false }
  }

  // Compute new phase based on trigger
  let newPhase: TaskPhase | null = null
  switch (trigger) {
    case 'session:result':  newPhase = sessionResultPhase(task.phase); break
    case 'session:input':   newPhase = sessionInputPhase(task.phase); break
    case 'session:error':   newPhase = sessionErrorPhase(task.phase); break
    case 'session:streaming': newPhase = sessionStreamingPhase(task.phase); break
    case 'session:turn-start': newPhase = sessionTurnStartPhase(task.phase); break
    case 'triage-sync':     newPhase = task.phase === 'AGENT_COMPLETE' ? 'AWAIT_HUMAN_ACTION' : null; break
    case 'reconciler':      newPhase = opts?.newPhase ?? null; break
  }

  // Triage gate: triage summarizes the PREVIOUS turn on a debounce, so it can
  // land minutes after the user already sent the next message. If that next
  // turn is actively running, pushing AWAIT_HUMAN_ACTION would repaint a live
  // task red moments after session:turn-start pulled it back to IN_PROGRESS
  // (the reverse race of incidents 46f42871 + 1f11596b). The push is not lost
  // work: when THIS turn ends, its own result→triage cycle re-evaluates.
  // Centralized here so both call sites (turn-complete-summary hook,
  // server.ts triage-done) get the guard.
  if (newPhase && trigger === 'triage-sync' && opts?.sessionId) {
    try {
      const { getSessionByClaudeId } = await import('./session-tracker.js')
      const record = await getSessionByClaudeId(opts.sessionId)
      if (record?.process_status === 'running') {
        log.session.info('applySessionPhase: triage-sync skipped — session is actively running', {
          taskId, sessionId: opts.sessionId, currentPhase: task.phase, source,
        })
        return { changed: false, oldPhase: task.phase }
      }
    } catch { /* record unreadable — proceed with the push (pre-guard behavior) */ }
  }

  if (!newPhase) {
    log.session.debug('applySessionPhase: skip (no transition needed)', {
      taskId, currentPhase: task.phase, trigger, source, sessionId: opts?.sessionId,
    })
    return { changed: false, oldPhase: task.phase }
  }

  const oldPhase = task.phase

  // Push with retry (Layer 1 must be reliable on its own)
  const MAX_RETRIES = 2
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // O(1) single-row write (updateTaskRaw) instead of updateTask's O(N)
      // full-store rewrite — phase transitions are on the hot send path and
      // must not hold the global task write-lock for O(taskCount) time.
      // emitEvent/push keep UI + external-sync parity with updateTask.
      //
      // SAFETY: updateTaskRaw skips updateTask's guardActiveChildren (which
      // blocks COMPLETE while children are active). That's fine ONLY because
      // every newPhase computed above is non-terminal (IN_PROGRESS /
      // AGENT_COMPLETE / AWAIT_HUMAN_ACTION) — applySessionPhase never targets
      // COMPLETE. If you ever add a COMPLETE transition here, route it through
      // updateTask or you'll bypass the active-children guard.
      await updateTaskRaw(taskId, {
        phase: newPhase,
        ...(newPhase === 'AWAIT_HUMAN_ACTION' ? { needs_attention: true } : {}),
        ...(newPhase === 'IN_PROGRESS' ? { needs_attention: false } : {}),
      }, { emitEvent: true, push: true, source })

      log.session.info('phase transition', {
        taskId, oldPhase, newPhase, trigger, source,
        sessionId: opts?.sessionId,
        ...(attempt > 0 ? { retryAttempt: attempt } : {}),
      })
      return { changed: true, oldPhase, newPhase }
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        log.session.warn('phase update failed, retrying', {
          taskId, oldPhase, newPhase, trigger, source,
          attempt: attempt + 1, maxRetries: MAX_RETRIES,
          error: err instanceof Error ? err.message : String(err),
        })
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)))
        continue
      }
      log.session.error('phase update FAILED after retries (reconciler may fix if not ENOSPC)', {
        taskId, oldPhase, newPhase, trigger, source,
        sessionId: opts?.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return { changed: false, oldPhase }
    }
  }
  return { changed: false, oldPhase } // unreachable but TS needs it
}
