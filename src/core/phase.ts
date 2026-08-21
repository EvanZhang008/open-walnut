/**
 * Task Phase — Unconditional State Machine + applySessionPhase()
 * ==============================================================
 *
 * Two-layer phase management (K8s-style push + reconcile):
 *
 * Layer 1: Push (ms-level, reliable with retry)
 *   session:result     → AGENT_COMPLETE      unconditional, EXCEPT when the event's
 *                        turnGen is older than the live session's current turnGen
 *                        (a newer turn already started — the late flip would
 *                        repaint a streaming session as completed)
 *   session:input      → IN_PROGRESS         unconditional (fires at SEND time)
 *   session:turn-start → IN_PROGRESS         unconditional (fires when the CLI
 *                        actually STARTS the turn — session_state_changed{running},
 *                        or an `init` arriving after this turn's result when the CLI
 *                        never went idle; covers queued/mid-turn sends whose input
 *                        transition was a no-op and whose phase was then flipped by
 *                        the previous turn's result)
 *   session:error      → AGENT_COMPLETE      unconditional (the turn is over —
 *                        possibly badly — and the ball is back with the human;
 *                        the session's own Error badge carries the "it failed"
 *                        signal, the phase only says "handed back, look at it")
 *   session:streaming  → (retired 2026-08-18 with the WAIT phase) it existed
 *                        only to undo a stale error→WAIT repaint; error now
 *                        lands on AGENT_COMPLETE and session:turn-start already
 *                        pulls any new turn back to IN_PROGRESS.
 *   triage-sync        → (retired 2026-08-17) was AGENT_COMPLETE → WAIT on a
 *                        debounce after every normal turn — pure noise.
 *
 *   All go through applySessionPhase() — unified retry + logging + error handling.
 *
 * Layer 2: Reconciler (30s, catches rare failures)
 *   Health monitor derives expected phase from session facts.
 *   Only Rule A: all primary sessions dead + task IN_PROGRESS → AGENT_COMPLETE.
 *   No Rule B: never infer phase from session status (could propagate stale data).
 *
 * Terminal phase: COMPLETE — the session machine never overwrites it.
 *
 * Task Phases (4) — WAIT was removed 2026-08-18 (user call: "blocked on
 * something external" IS just TODO — a separate parked state confused both
 * humans and agents; the Focus Bar's 'wait' PIN TIER still exists for parking
 * and is a different axis entirely):
 *   TODO → IN_PROGRESS → AGENT_COMPLETE → COMPLETE
 *
 * Read/unread lifecycle (task.unread — see readMarkerForPhase):
 *   AGENT_COMPLETE                      → unread   (agent handed work back)
 *   IN_PROGRESS                         → read     (new turn supersedes it)
 *   COMPLETE                            → read     (applyPhase clears it)
 *   opening the task in the UI          → read     (the actual "read" event)
 * The marker is written in the SAME row update as the phase, so no surface can
 * see a handed-back task without its unread dot.
 */

import { log } from '../logging/index.js'
import type { TaskPhase, TaskStatus, Task } from './types.js';

// ── Phase → Status (4 → 3) ──

export const PHASE_TO_STATUS: Record<TaskPhase, TaskStatus> = {
  TODO: 'todo',
  IN_PROGRESS: 'in_progress',
  AGENT_COMPLETE: 'in_progress',
  COMPLETE: 'done',
};

// ── Status → Default Phase (3 → 4, for migration) ──

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
  'COMPLETE',
];

export const VALID_PHASES = new Set<string>(PHASE_ORDER);

/** Phases the BACKGROUND session machine must never overwrite.
 *  COMPLETE is terminal because it is a deliberate statement that the work is
 *  done — whoever made it, human or agent. If a background event could
 *  overwrite it (e.g. session:input → IN_PROGRESS, a late session:result →
 *  AGENT_COMPLETE), a finished task would silently reopen itself the next time
 *  anything touched its session.
 *  This gates ONLY applySessionPhase (the event-driven machine) and the sync-pull
 *  path in updateTaskRaw. A deliberate write through updateTask — from a human in
 *  the UI or from an agent tool call — may both set COMPLETE and move a task back
 *  out of it. */
export const TERMINAL_PHASES = new Set<TaskPhase>(['COMPLETE']);

// ── Core functions ──

/** Derive the 3-state status from a 4-state phase. */
export function deriveStatusFromPhase(phase: TaskPhase): TaskStatus {
  return PHASE_TO_STATUS[phase] ?? 'todo';
}

/** Get the default phase for a legacy status (migration). */
export function phaseFromStatus(status: TaskStatus): TaskPhase {
  return STATUS_TO_DEFAULT_PHASE[status] ?? 'TODO';
}

/**
 * The read-marker patch a phase implies, or `{}` when the phase says nothing
 * about read state. THE single definition of "what does this phase mean for the
 * unread dot" — both write paths (applyPhase for updateTask, applySessionPhase
 * for the session machine) derive from this one function.
 *
 * UNREAD (the agent handed work back and the human hasn't looked):
 *   - AGENT_COMPLETE — the turn finished (successfully OR with an error) and
 *     the ball is back with the human. Errors ride the same phase since the
 *     WAIT removal (2026-08-18); the session's own Error badge distinguishes.
 *
 * READ (nothing new to look at):
 *   - IN_PROGRESS — a fresh turn started; whatever was pending is superseded.
 *   - COMPLETE    — finishing a task is itself an act of reading it.
 *
 * TODO leaves the marker untouched: it says nothing about whether the last
 * output was seen, so neither setting nor clearing is implied.
 */
export function readMarkerForPhase(phase: TaskPhase): Partial<Task> {
  if (phase === 'AGENT_COMPLETE') return { unread: true }
  if (phase === 'IN_PROGRESS' || phase === 'COMPLETE') return { unread: false }
  return {}
}

/**
 * Apply a phase to a task, updating phase + derived status + metadata.
 * Mutates the task in place.
 *
 * This is the base every NON-session phase write goes through (updateTask — the
 * REST phase picker, the agent's task_update, plugin sync). The session machine
 * has its own O(1) row-patch path (applySessionPhase) that derives the marker
 * from the same readMarkerForPhase, so both agree by construction. Setting the
 * marker in only one of the two is what let a task hand-dragged to
 * AGENT_COMPLETE stay dot-less while a session-driven one lit up.
 */
export function applyPhase(task: Task, phase: TaskPhase): void {
  task.phase = phase;
  task.status = deriveStatusFromPhase(phase);

  // Read marker implied by the phase. Object.assign (not a ternary per key) so
  // phases that imply nothing leave whatever the caller set untouched.
  Object.assign(task, readMarkerForPhase(phase));

  if (phase === 'COMPLETE') {
    if (!task.completed_at) task.completed_at = new Date().toISOString();
    task.session_id = undefined;          // new 1-slot
    task.plan_session_id = undefined;     // legacy 2-slot (backward compat)
    task.exec_session_id = undefined;     // legacy 2-slot (backward compat)
  } else {
    task.completed_at = undefined;
  }
}

// ── Phase migration (legacy data) ──

/**
 * Migrate legacy phase values to current ones.
 * Returns the migrated phase, or the original if no migration needed.
 *
 * WAIT was removed 2026-08-18 ("blocked/parked" is just TODO — the row stays
 * visible and actionable, and the 'wait' PIN TIER covers deliberate parking).
 * Its ancestors (AWAIT_HUMAN_ACTION, HUMAN_VERIFICATION) follow it to TODO.
 * PEER_CODE_REVIEW / RELEASE_IN_PIPELINE pointed at the deleted
 * HUMAN_VERIFIED / POST_WORK_COMPLETED, so they land on AGENT_COMPLETE.
 */
export function migratePhase(phase: string): TaskPhase {
  if (phase === 'INVESTIGATION') return 'TODO';
  if (phase === 'WAIT') return 'TODO';
  if (phase === 'AWAIT_HUMAN_ACTION') return 'TODO';
  if (phase === 'HUMAN_VERIFICATION') return 'TODO';
  if (phase === 'PEER_CODE_REVIEW') return 'AGENT_COMPLETE';
  if (phase === 'RELEASE_IN_PIPELINE') return 'AGENT_COMPLETE';
  if (phase === 'HUMAN_VERIFIED') return 'AGENT_COMPLETE';
  if (phase === 'POST_WORK_COMPLETED') return 'AGENT_COMPLETE';
  if (VALID_PHASES.has(phase)) return phase as TaskPhase;
  return 'TODO';
}

// WHY unconditional: The old computeSessionCompletionPhase only advanced forward
// (phase < AGENT_COMPLETE), which blocked self-healing — if a task drifted to
// WAIT, the next session:result couldn't correct it back to AGENT_COMPLETE.
// Unconditional transitions ensure any event always sets the correct phase
// regardless of current state.

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
 * Two triggers feed this: session_state_changed{running} (the CLI's explicit
 * turn-start signal) and an `init` that arrives after this turn's result was
 * already emitted. The second exists because the CLI can start a queued
 * mid-turn send WITHOUT ever going idle — no running state event is emitted at
 * all, and the init is the only evidence (incident ed347bde, 2026-08-05).
 *
 * The missing half of the result↔turn symmetry: turn-END has an authoritative
 * phase driver (session:result → AGENT_COMPLETE) but turn-START only had
 * session:input, which fires at SEND time. Interactive chat sends the next
 * message while the previous turn is still running (queued / mid-turn inject),
 * so that input transition is a no-op (phase already IN_PROGRESS) — then the
 * PREVIOUS turn's result flips the phase to AGENT_COMPLETE (triage may push it
 * on to WAIT), and when the queued message finally starts
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

/** Session errored → AGENT_COMPLETE. Unconditional. The turn is over (badly)
 *  and the ball is back with the human — same handed-back semantics as a
 *  normal result. The "it failed" signal lives on the SESSION (error badge /
 *  red pill), not the task phase; a dedicated WAIT phase for this was removed
 *  2026-08-18. */
export function sessionErrorPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'AGENT_COMPLETE') return null
  return 'AGENT_COMPLETE'
}

/**
 * session:streaming — RETIRED with the WAIT phase (2026-08-18). It existed
 * only to undo a stale error→WAIT repaint; error now lands on AGENT_COMPLETE
 * and session:turn-start already pulls any newly-running turn back to
 * IN_PROGRESS. Kept as an explicit no-op so replayed events from old servers
 * parse cleanly.
 */
export function sessionStreamingPhase(_current: TaskPhase): TaskPhase | null {
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
  /** For 'session:result': the emitting session's turn generation at EMIT time
   *  (SessionResultEvent.turnGen). Compared against the live session instance's
   *  current gen to detect a stale result — see the gate below. */
  turnGen?: number
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
    // triage-sync: RETIRED 2026-08-17 (incident inc-1786983019552). It auto-
    // upgraded AGENT_COMPLETE → WAIT a few minutes after every normal turn,
    // which added zero information (both render red+unread) and diluted WAIT —
    // the state is reserved for genuine blockage (session:error, idle-timeout
    // kill, reconciler all-dead). The trigger value stays parseable so a replayed
    // event from an old server is a no-op instead of a crash.
    case 'triage-sync':     newPhase = null; break
    case 'reconciler':      newPhase = opts?.newPhase ?? null; break
  }

  // (The old "triage gate" — skip triage-sync while the session runs the next
  // turn — was deleted with the trigger's retirement above: triage-sync now
  // never produces a phase, so the gate had nothing left to guard.)

  // Stale-result gate (incident ed347bde, 2026-08-05): SESSION_RESULT enrichment
  // adds latency (~800ms measured) between the CLI's result line and this flip.
  // In that window the CLI can already have STARTED the next turn — it picks up a
  // queued mid-turn send without ever going idle, so its only turn-start signal is
  // an `init` (no session_state_changed{running}). The runner's init-after-result
  // edge bumps _turnGen and pulls the phase back to IN_PROGRESS; then this late
  // result would flip it straight back to AGENT_COMPLETE and the task row reads
  // completed/attention while the CLI visibly streams. Compare generations: an
  // event stamped BEFORE the live instance's current gen belongs to a superseded
  // turn. Fails OPEN (no gen, no live instance, any error → proceed) so the normal
  // flow — where liveGen === eventGen — is untouched.
  if (newPhase && trigger === 'session:result' && opts?.turnGen !== undefined && opts.sessionId) {
    try {
      const { sessionRunner } = await import('../providers/claude-code-session.js')
      const live = sessionRunner.findSessionByClaudeId(opts.sessionId)
      const liveGen = live?.turnGen
      if (typeof liveGen === 'number' && liveGen > opts.turnGen) {
        log.session.info('applySessionPhase: session:result skipped — stale result (a newer turn already started)', {
          taskId, sessionId: opts.sessionId, eventGen: opts.turnGen, liveGen, source,
        })
        return { changed: false, oldPhase: task.phase }
      }
    } catch { /* runner not loaded / lookup failed — proceed (pre-gate behavior) */ }
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
      // AGENT_COMPLETE / WAIT) — applySessionPhase never targets
      // COMPLETE. If you ever add a COMPLETE transition here, route it through
      // updateTask or you'll bypass the active-children guard.
      await updateTaskRaw(taskId, {
        phase: newPhase,
        // Read/unread marker rides the SAME write as the phase — one atomic row
        // update, so a surface can never observe AGENT_COMPLETE without its dot.
        ...readMarkerForPhase(newPhase),
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
