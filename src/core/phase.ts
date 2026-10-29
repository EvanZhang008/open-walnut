/**
 * Task Phase — Unconditional State Machine + applySessionPhase()
 * ==============================================================
 *
 * Two-layer phase management (K8s-style push + reconcile):
 *
 * Layer 1: Push (ms-level, reliable with retry)
 *   session:result     → NEED_ACTION      unconditional, EXCEPT when the event's
 *                        turnGen is older than the live session's current turnGen
 *                        (a newer turn already started — the late flip would
 *                        repaint a streaming session as completed)
 *   session:input      → IN_PROGRESS         unconditional (fires at SEND time).
 *                        The ONE trigger that also reopens COMPLETE, and only
 *                        when the send came from a human or a peer task
 *                        (REOPENING_SEND_SOURCES): someone deliberately gave the
 *                        task more work and the agent is working again, so
 *                        "completed" would be a lie on the board (2026-09-23 user
 *                        call: "if a completed task gets re-messaged it should go
 *                        back to in progress"). Automated sends (auto-continue
 *                        nudges, routines, hook actions, side threads) never
 *                        reopen — a routine bound to a finished task would
 *                        otherwise reopen it on every tick and it could never
 *                        be closed.
 *   session:turn-start → IN_PROGRESS         unconditional (fires when the CLI
 *                        actually STARTS the turn — session_state_changed{running},
 *                        or an `init` arriving after this turn's result when the CLI
 *                        never went idle; covers queued/mid-turn sends whose input
 *                        transition was a no-op and whose phase was then flipped by
 *                        the previous turn's result)
 *   session:error      → NEED_ACTION      unconditional (the turn is over —
 *                        possibly badly — and the ball is back with the human;
 *                        the session's own Error badge carries the "it failed"
 *                        signal, the phase only says "handed back, look at it")
 *   session:awaiting-human → NEED_ACTION  unconditional (permission request /
 *                        AskUserQuestion / plan approval: the agent is BLOCKED
 *                        on a human decision — same handed-back semantics as a
 *                        finished turn, 2026-08-18 user call: "只要是 Agent 完事
 *                        要等,都是把它变成 Agent Complete". The red row is the
 *                        attention signal; the session's red Waiting badge says
 *                        WHY. Auto-approved prompts never emit the event.)
 *   session:human-answered → IN_PROGRESS     unconditional (the human decided —
 *                        allow/deny/answer — and the agent resumes the turn;
 *                        skipped for 'expired' resolutions, where nobody decided
 *                        and the session is dead)
 *   session:streaming  → (retired 2026-08-18 with the WAIT phase) it existed
 *                        only to undo a stale error→WAIT repaint; error now
 *                        lands on NEED_ACTION and session:turn-start already
 *                        pulls any new turn back to IN_PROGRESS.
 *   triage-sync        → (retired 2026-08-17) was NEED_ACTION → WAIT on a
 *                        debounce after every normal turn — pure noise.
 *
 *   All go through applySessionPhase() — unified retry + logging + error handling.
 *
 * Layer 2: Reconciler (30s, catches rare failures)
 *   Health monitor derives expected phase from session facts.
 *   Only Rule A: all primary sessions dead + task IN_PROGRESS → NEED_ACTION.
 *   No Rule B: never infer phase from session status (could propagate stale data).
 *
 * Terminal phase: COMPLETE — the session machine never overwrites it, with the
 * single exception of session:input above (a NEW MESSAGE from a human or a peer
 * reopens; a late result, a turn start, an error, a permission prompt or an
 * automated send never does).
 *
 * Held phase: WAITING — set on purpose (the status control, task_update, the
 * /walnut-trigger snooze), it means "nothing to do until something happens".
 * Nothing of the turn that SET it moves it, whoever set it: not that turn's
 * further output, a background agent coming back inside it, its end
 * (session:result), its error, or any reconcile (the snapshot pull, the
 * reconciler). The NEXT turn does: any message (session:input: a human, a peer,
 * a trigger fire, a Walnut notice) or a turn the CLI starts on its own
 * (session:turn-start) takes it to IN_PROGRESS. The one exit inside the turn is
 * a prompt that blocks on the human (session:awaiting-human → NEED_ACTION): a
 * hidden task could never show it. Its optional `wait_until` is a server
 * clock (task-wait-until.ts) that wakes the session the way a trigger would.
 * A turn that only interrupted the wait (a peer's message, a Walnut status
 * notice, the CLI's own follow-up for background work) ends back in WAITING with
 * the same clock while the task still has an armed trigger (task-wait-resume.ts);
 * the fire, the clock, a reply, a subtask's result and a person's message end it
 * for good.
 * Background writes (a sync pull echoing the TODO it was shown) may move it
 * only to COMPLETE; see the held-phase guard in task-manager.ts.
 *
 * Task Phases (5). WAIT (a parked state with no exit) was removed 2026-08-18;
 * WAITING came back 2026-09-30 as a status with exits, and it is a different
 * axis from the board's 'wait' PIN TIER (labelled Parked), which a Waiting task
 * never moves to:
 *   TODO → IN_PROGRESS → NEED_ACTION → COMPLETE, with WAITING beside TODO
 *
 * Read/unread lifecycle (task.unread — see readMarkerForPhase):
 *   NEED_ACTION                      → unread   (agent handed work back)
 *   IN_PROGRESS                         → read     (new turn supersedes it)
 *   WAITING                             → read     (set aside on purpose)
 *   COMPLETE                            → read     (applyPhase clears it)
 *   opening the task in the UI          → read     (the actual "read" event)
 * The marker is written in the SAME row update as the phase, so no surface can
 * see a handed-back task without its unread dot.
 */

import { log } from '../logging/index.js'
import type { TaskPhase, TaskStatus, Task } from './types.js';
import { isMainAgentTask } from './org/main-stays-active.js'
import {
  consumeInterruptedWait, dropInterruptedWait, hasInterruptedWait, interruptedWaitLeftAt, markInterruptedByMessage,
  dropFireTurn, noteInterruptedWait, noteTurnSend, resumableWait, takeFireTurn, triggersStanding, waitExitCause,
  type InjectedLineClass,
} from './task-wait-resume.js'

// ── Phase → Status (5 → 3) ──

export const PHASE_TO_STATUS: Record<TaskPhase, TaskStatus> = {
  TODO: 'todo',
  WAITING: 'todo',
  IN_PROGRESS: 'in_progress',
  NEED_ACTION: 'in_progress',
  COMPLETE: 'done',
};

// ── Status → Default Phase (3 → 5, for migration) ──

export const STATUS_TO_DEFAULT_PHASE: Record<TaskStatus, TaskPhase> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  done: 'COMPLETE',
};

// ── Ordered phases (for cycle) ──

export const PHASE_ORDER: TaskPhase[] = [
  'TODO',
  'WAITING',
  'IN_PROGRESS',
  'NEED_ACTION',
  'COMPLETE',
];

export const VALID_PHASES = new Set<string>(PHASE_ORDER);

/** Phases the BACKGROUND session machine must never overwrite.
 *  COMPLETE is terminal because it is a deliberate statement that the work is
 *  done — whoever made it, human or agent. If a background event could
 *  overwrite it (a late session:result → handback, a replayed turn-start →
 *  IN_PROGRESS), a finished task would silently reopen itself the next time
 *  anything touched its session.
 *  A NEW MESSAGE from a human or a peer is not background: session:input is
 *  the one session trigger that reopens COMPLETE (see sessionInputPhase and
 *  sendSourceReopensTerminal) — someone deliberately sent the task more work,
 *  and the agent is now running it.
 *  This gates ONLY applySessionPhase (the event-driven machine) and the sync-pull
 *  path in updateTaskRaw. A deliberate write through updateTask — from a human in
 *  the UI or from an agent tool call — may both set COMPLETE and move a task back
 *  out of it. */
export const TERMINAL_PHASES = new Set<TaskPhase>(['COMPLETE']);

/** Phases a BACKGROUND write (a sync pull, a plugin echo, an 'internal' default)
 *  may not move except to COMPLETE. WAITING is one: it was set on purpose, and
 *  a sync plugin that never heard of it is shown TODO (legacyPhase) and echoes
 *  that TODO back on the next pull. Deliberate edits (api/user/agent) and the
 *  session machine move it freely. Checked in updateTask and prepareRawUpdate. */
export const HELD_PHASES = new Set<TaskPhase>(['WAITING']);

/** A phase for a reader that predates the current set (plugins without a
 *  `phases` manifest declaration, old sync bodies): WAITING reads as TODO,
 *  which is also its `status`. */
export function legacyPhase(phase: TaskPhase): Exclude<TaskPhase, 'WAITING'> {
  return phase === 'WAITING' ? 'TODO' : phase;
}

// ── Core functions ──

/** Derive the 3-state status from a phase. */
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
 *   - NEED_ACTION — the turn finished (successfully OR with an error) and
 *     the ball is back with the human. Errors ride the same phase since the
 *     WAIT removal (2026-08-18); the session's own Error badge distinguishes.
 *
 * READ (nothing new to look at):
 *   - IN_PROGRESS — a fresh turn started; whatever was pending is superseded.
 *   - WAITING     — set aside on purpose; the red dot would ask for attention
 *                   the human just said is not needed yet.
 *   - COMPLETE    — finishing a task is itself an act of reading it.
 *
 * TODO leaves the marker untouched: it says nothing about whether the last
 * output was seen, so neither setting nor clearing is implied.
 */
export function readMarkerForPhase(phase: TaskPhase): Partial<Task> {
  if (phase === 'NEED_ACTION') return { unread: true }
  if (phase === 'IN_PROGRESS' || phase === 'WAITING' || phase === 'COMPLETE') return { unread: false }
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
 * NEED_ACTION stay dot-less while a session-driven one lit up.
 */
export function applyPhase(task: Task, phase: TaskPhase): void {
  // wait_until belongs to WAITING alone: any move out of it ends the clock.
  if (phase !== 'WAITING') task.wait_until = undefined;
  if (task.phase !== phase) {
    task.phase_changed_at = new Date(Math.max(Date.now(), (Date.parse(task.phase_changed_at ?? '') || 0) + 1)).toISOString();
  }
  task.phase = phase;
  task.status = deriveStatusFromPhase(phase);
  const derived = phaseDerivedFields(task, phase, new Date().toISOString());
  Object.assign(task, derived.set);
  for (const f of derived.clear) task[f] = undefined;
}

/** The fields a phase clears (completed_at and a Done user_status off COMPLETE; the session slots on it). */
export type PhaseClearedField = 'completed_at' | 'session_id' | 'plan_session_id' | 'exec_session_id' | 'user_status';

/**
 * What a phase write derives besides phase and status, THE one rule both write paths
 * use: applyPhase (updateTask) and the offline drain's raw row write
 * (offline-merge/apply-fields.ts), so an away task_update / task_complete ends as the
 * online call does. `set`: the read marker the phase implies (readMarkerForPhase), and
 * on COMPLETE a completed_at (`nowIso`) when the task has none and a Done user_status. `clear`: on COMPLETE the
 * session slots (new 1-slot, legacy 2-slot), off it completed_at and a Done user_status.
 */
export function phaseDerivedFields(
  task: Readonly<Partial<Task>>, phase: TaskPhase, nowIso: string,
): { set: Partial<Task>; clear: PhaseClearedField[] } {
  // Object.assign of the marker (not a ternary per key) so phases that imply
  // nothing leave whatever the caller set untouched.
  const set: Partial<Task> = { ...readMarkerForPhase(phase) };
  if (phase === 'COMPLETE') {
    if (!task.completed_at) set.completed_at = nowIso;
    // A completed task is verified (the user mostly closes it after checking): its stored
    // status reads Done in the same write, so no reader meets its last open words
    // ("waits on the user to install the build"). A reopen derives it again (user-status-sync).
    set.user_status = { state: 'done' };
    return { set, clear: ['session_id', 'plan_session_id', 'exec_session_id'] };
  }
  // Reopened: Done is no longer true; readers fall back to the phase until the sync derives it.
  return { set, clear: task.user_status?.state === 'done' ? ['completed_at', 'user_status'] : ['completed_at'] };
}

// ── Phase migration (legacy data) ──

/**
 * Migrate legacy phase values to current ones.
 *
 * WAIT was removed 2026-08-18 ("blocked/parked" is just TODO — the row stays
 * visible and actionable, and the 'wait' PIN TIER covers deliberate parking).
 * Its ancestors (AWAIT_HUMAN_ACTION, HUMAN_VERIFICATION) follow it to TODO.
 * It does NOT map to today's WAITING: a WAIT row meant "errored / needs a
 * decision", while WAITING is set on purpose and holds through turn ends.
 * PEER_CODE_REVIEW / RELEASE_IN_PIPELINE pointed at the deleted
 * HUMAN_VERIFIED / POST_WORK_COMPLETED, so they land on NEED_ACTION.
 *
 * AGENT_COMPLETE was renamed NEED_ACTION 2026-09-01 (user call: the name has to
 * say what the human must DO, not what the agent finished — "agent complete"
 * read as "done" to both humans and agents and the ball-is-with-you meaning was
 * lost). Pure rename, same semantics, same red+unread treatment. This line is
 * the read-side compat for any payload still carrying the old string: rows in
 * the local DB are rewritten by the v11 migration, but plugin sync, replayed
 * session events, and remote daemons on an older build all still send it.
 */
export function migratePhase(phase: string): TaskPhase | undefined {
  if (phase === 'AGENT_COMPLETE') return 'NEED_ACTION';
  if (phase === 'INVESTIGATION') return 'TODO';
  if (phase === 'WAIT') return 'TODO';
  if (phase === 'AWAIT_HUMAN_ACTION') return 'TODO';
  if (phase === 'HUMAN_VERIFICATION') return 'TODO';
  if (phase === 'PEER_CODE_REVIEW') return 'NEED_ACTION';
  if (phase === 'RELEASE_IN_PIPELINE') return 'NEED_ACTION';
  if (phase === 'HUMAN_VERIFIED') return 'NEED_ACTION';
  if (phase === 'POST_WORK_COMPLETED') return 'NEED_ACTION';
  if (VALID_PHASES.has(phase)) return phase as TaskPhase;
  // Unknown may mean newer data; guessing TODO corrupts it on the next whole-store write.
  return undefined;
}

// WHY unconditional: The old computeSessionCompletionPhase only advanced forward
// (phase < NEED_ACTION), which blocked self-healing — if a task drifted to
// WAIT, the next session:result couldn't correct it back to NEED_ACTION.
// Unconditional transitions ensure any event always sets the correct phase
// regardless of current state.

// ── Unconditional Session → Phase State Machine ──

/** Session produced result → NEED_ACTION. Unconditional, except on a held
 *  phase: the turn that set WAITING ends without handing the task back. */
export function sessionResultPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || HELD_PHASES.has(current) || current === 'NEED_ACTION') return null
  return 'NEED_ACTION'
}

/** Session received input → IN_PROGRESS. Unconditional, INCLUDING from COMPLETE.
 *
 *  This is the only session trigger allowed past the terminal guard, and
 *  applySessionPhase lets it through only for a send whose provenance says a
 *  human or a peer task wrote it (sendSourceReopensTerminal). Marking a task done
 *  kills its CLI and clears its slot (applyPhase / completeTaskSessions), so such
 *  a message reaching the session afterwards is someone deliberately resuming
 *  the work: a human typing in the still-visible session column, or a peer
 *  task's send. From then on the agent IS working, its result will hand the task
 *  back the normal way, and the human decides again whether it is done.
 *  Before 2026-09-23 the task stayed COMPLETE through all of that, so a reopened
 *  task never went red again and its new output was never announced. */
export function sessionInputPhase(current: TaskPhase): TaskPhase | null {
  if (current === 'IN_PROGRESS') return null
  return 'IN_PROGRESS'
}

/** Send provenance (the SESSION_SEND bus `source`) that means a human or a peer
 *  task deliberately addressed this task, so the send may reopen a COMPLETE one.
 *  An allowlist on purpose: a new deliberate path that is missing here merely
 *  keeps the old behavior (the task stays done), while a missed AUTOMATED path
 *  on a denylist would reopen finished tasks forever (auto-continue's "continue"
 *  nudge fires ~3 min after the human clicked done; a routine bound to a finished
 *  task would reopen it on every trigger). Not listed, deliberately: the retry /
 *  restart drain kicks (they re-deliver a message whose own send already ran
 *  this check), 'session-start' (a task being started is never COMPLETE),
 *  'auto-continue', 'auto-recover', 'routine-*', 'hook:*', 'side-thread*'. */
export const REOPENING_SEND_SOURCES: ReadonlySet<string> = new Set([
  'ui',          // console composer (web/routes/session-chat.ts)
  'mobile',      // iOS app (web/routes/session-stream-v1.ts)
  'cli',         // a human at the `walnut` CLI (session-send-core.ts)
  'peer',        // another task's send / task_start resume (session-send-core.ts)
  'web-api',     // Execute-continue button (session-lifecycle.ts)
  'human-inbox', // a letter delivered to the session (human-inbox/letter-ops.ts)
  // A person's chat turn into a chat that is an ask (sessions/lane-ask-link.ts):
  // the phone (routes/api-v1.ts) and the console's chat surfaces (routes/chat.ts).
  // The background turns into the same lanes ('cron', 'triage', 'heartbeat')
  // stay out, so they never reopen a finished ask.
  'api-v1',
  'chat',
])

export function sendSourceReopensTerminal(source: string | undefined): boolean {
  return source !== undefined && REOPENING_SEND_SOURCES.has(source)
}

/** A send a person made (the reopening sources but a peer's): it ends a wait for good. */
export function isPersonSendSource(source: string | undefined): boolean {
  return source !== 'peer' && sendSourceReopensTerminal(source)
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
 * phase driver (session:result → NEED_ACTION) but turn-START only had
 * session:input, which fires at SEND time. Interactive chat sends the next
 * message while the previous turn is still running (queued / mid-turn inject),
 * so that input transition is a no-op (phase already IN_PROGRESS) — then the
 * PREVIOUS turn's result flips the phase to NEED_ACTION (triage may push it
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

/** Session errored → NEED_ACTION. Unconditional. The turn is over (badly)
 *  and the ball is back with the human — same handed-back semantics as a
 *  normal result. The "it failed" signal lives on the SESSION (error badge /
 *  red pill), not the task phase; a dedicated WAIT phase for this was removed
 *  2026-08-18. */
export function sessionErrorPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || HELD_PHASES.has(current) || current === 'NEED_ACTION') return null
  return 'NEED_ACTION'
}

/**
 * session:streaming — RETIRED with the WAIT phase (2026-08-18). It existed
 * only to undo a stale error→WAIT repaint; error now lands on NEED_ACTION
 * and session:turn-start already pulls any newly-running turn back to
 * IN_PROGRESS. Kept as an explicit no-op so replayed events from old servers
 * parse cleanly.
 */
export function sessionStreamingPhase(_current: TaskPhase): TaskPhase | null {
  return null
}

/** Agent blocked on a human decision (permission / AskUserQuestion / plan
 *  approval) → NEED_ACTION. Unconditional. Same handed-back semantics as a
 *  finished turn: the agent cannot make progress until the human acts, so the
 *  row must go red NOW, not when the turn eventually ends (2026-08-18 user
 *  call). The session's red "Waiting" badge (pendingPermission-derived)
 *  carries the WHY; the phase only says "look at it". */
export function sessionAwaitingHumanPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'NEED_ACTION') return null
  return 'NEED_ACTION'
}

/** Human answered the prompt (allow / deny / AskUserQuestion answer) →
 *  IN_PROGRESS. Unconditional. The agent resumes the turn immediately; leaving
 *  the row red after the human already acted would be a stale attention signal.
 *  Callers must NOT fire this for 'expired' resolutions (session died with the
 *  prompt open — nobody decided, nothing resumes). */
export function sessionHumanAnsweredPhase(current: TaskPhase): TaskPhase | null {
  if (TERMINAL_PHASES.has(current) || current === 'IN_PROGRESS') return null
  return 'IN_PROGRESS'
}

// ── applySessionPhase() — single entry point for all session → phase updates ──

export type PhaseTransitionTrigger =
  | 'session:result'
  | 'session:input'
  | 'session:error'
  | 'session:streaming'
  | 'session:turn-start'
  | 'session:awaiting-human'
  | 'session:human-answered'
  | 'triage-sync'
  | 'reconciler'

interface ApplySessionPhaseOpts {
  sessionId?: string
  processAlive?: boolean
  /** For 'reconciler' trigger: caller computes the expected phase. */
  newPhase?: TaskPhase
  turnGen?: number
  shouldApply?: (current: Readonly<Task>) => boolean
  /** For 'session:input': the send came from a human or a peer
   *  (sendSourceReopensTerminal), so it may pull a COMPLETE task back to
   *  IN_PROGRESS. Every other trigger ignores it. */
  reopenTerminal?: boolean
  /** For 'session:input': the send's provenance (the SESSION_SEND bus source).
   *  A peer's or a notice's turn only interrupts a WAITING task, a person's ends
   *  the wait for good (task-wait-resume.ts). */
  sendSource?: string
  /** For 'session:input': the send is what a waiting task waited for (a reply,
   *  a finished subtask), so it ends the wait whatever its source. */
  sendEndsWait?: boolean
  /** For 'session:turn-start': what the stream's copy of the line that opened the turn is
   *  (task-wait-resume.ts classifyInjectedLine), for a turn the server did not send itself:
   *  a host's own delivery of a peer's note is an interruption, not the CLI's own turn. */
  lineSource?: InjectedLineClass
  /** For 'session:turn-start': the runner's count of the session's turns, the one this edge opens
   *  (a line that ended the wait inside it may have come in before the wait is noted). */
  waitTurn?: number
  /** For 'reconciler': this hand-back is a clean turn end (a settled snapshot,
   *  an ACP turn that ended), so an interrupted wait may come back instead, as
   *  on 'session:result'. Never for a process that died mid-turn. */
  turnEnd?: boolean
  /** Internal: the second pass after the task moved under a planned return. */
  noResume?: boolean
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
    case 'session:awaiting-human': newPhase = sessionAwaitingHumanPhase(task.phase); break
    case 'session:human-answered': newPhase = sessionHumanAnsweredPhase(task.phase); break
    // triage-sync: RETIRED 2026-08-17 (incident inc-1786983019552). It auto-
    // upgraded NEED_ACTION → WAIT a few minutes after every normal turn,
    // which added zero information (both render red+unread) and diluted WAIT —
    // the state is reserved for genuine blockage (session:error, idle-timeout
    // kill, reconciler all-dead). The trigger value stays parseable so a replayed
    // event from an old server is a no-op instead of a crash.
    case 'triage-sync':     newPhase = null; break
    case 'reconciler':      newPhase = opts?.newPhase ?? null; break
  }

  // The main agent's turn end is not a hand-back (org/main-stays-active.ts): it
  // stays In Progress, and needs the user only when it asks them (a prompt for
  // the human) or fails (an error, or a reconcile of a session that ended in one).
  if (newPhase === 'NEED_ACTION' && (trigger === 'session:result' || trigger === 'reconciler') && isMainAgentTask(task)
    && !(trigger === 'reconciler' && await sessionEndedInError(opts?.sessionId))) {
    log.session.debug('applySessionPhase: skip (the main agent stays active)', {
      taskId, currentPhase: task.phase, trigger, source, sessionId: opts?.sessionId,
    })
    return { changed: false, oldPhase: task.phase }
  }

  // (The old "triage gate" — skip triage-sync while the session runs the next
  // turn — was deleted with the trigger's retirement above: triage-sync now
  // never produces a phase, so the gate had nothing left to guard.)

  // A wait a turn only interrupted (task-wait-resume.ts). Any send that is not
  // an interruption (a person's, a fire, the clock, a reply), a prompt for the
  // human or an error ends it for good, whatever the phase is by then: the send's
  // own edge may land after the turn it started already began. The clean end of
  // that turn brings it back while the task still has an armed trigger.
  if (trigger === 'session:input') {
    noteTurnSend(taskId, opts?.sendSource === 'routine-trigger' || source === 'trigger-host-delivery', isPersonSendSource(opts?.sendSource), task.wait_until ?? null)
    const cause = waitExitCause(trigger, opts?.sendSource, opts?.sendEndsWait === true)
    if (!cause) dropInterruptedWait(taskId, isPersonSendSource(opts?.sendSource) ? 'person-input' : `send:${opts?.sendSource ?? 'unknown'}`)
    else markInterruptedByMessage(taskId, opts?.sendSource ?? source)
  } else if (trigger === 'session:awaiting-human' || trigger === 'session:error') {
    dropInterruptedWait(taskId, trigger)
    dropFireTurn(taskId)
  }
  let resume: { waitUntil: string | null } | null = null
  if (newPhase === 'NEED_ACTION' && !opts?.noResume && hasInterruptedWait(taskId)
    && (trigger === 'session:result' || (trigger === 'reconciler' && opts?.turnEnd))) {
    if (await sessionEndedInError(opts?.sessionId)) dropInterruptedWait(taskId, 'session-error')
    else resume = await resumableWait(task, opts?.sessionId)
    if (resume) newPhase = 'WAITING'
  }
  // A standing routine between fires: a turn its trigger's fire started ends cleanly, and that
  // trigger keeps firing (armed, none stopped, fired before), so the task waits on its next fire,
  // never on the user (2026-10-26, the user on a pipeline watch whose every fire read "needs
  // you": "put it as working"). It goes back to the clock it had when the fire came (the default
  // one when that has passed). Its own report can still say it needs the user
  // (sessions/report-phase.ts), and a person's message in the turn makes it theirs.
  let routine: { waitUntil: string | null } | null = null
  const fireTurn = (trigger === 'session:result' || (trigger === 'reconciler' && opts?.turnEnd)) ? takeFireTurn(taskId) : null
  if (newPhase === 'NEED_ACTION' && fireTurn && !resume && !opts?.noResume && !(await sessionEndedInError(opts?.sessionId))) {
    const { triggersWatching } = await import('./task-wait-until.js')
    if (triggersStanding(await triggersWatching(task.id))) { newPhase = 'WAITING'; routine = fireTurn }
  }

  const requiresRunning = trigger === 'session:turn-start' || trigger === 'session:human-answered'
  let phaseRunner: typeof import('../providers/claude-code-session.js')['sessionRunner'] | undefined
  if (newPhase && opts?.sessionId
    && (trigger === 'session:human-answered'
      || ((trigger === 'session:turn-start' || trigger === 'session:result') && opts.turnGen !== undefined))) {
    phaseRunner = (await import('../providers/claude-code-session.js')).sessionRunner
  }
  if (!newPhase) {
    log.session.debug('applySessionPhase: skip (no transition needed)', {
      taskId, currentPhase: task.phase, trigger, source, sessionId: opts?.sessionId,
    })
    return { changed: false, oldPhase: task.phase }
  }

  let oldPhase = task.phase
  let leftWait: { waitUntil: string | null } | undefined
  const reopensTerminal = trigger === 'session:input' && opts?.reopenTerminal === true
  // applyPhase(COMPLETE) cleared the task's session slot; a reopen re-points it
  // at the session that just received the message, so slot-driven paths (hook
  // actions, start/send-by-task) reuse the running session instead of reporting
  // "no session attached" or opening a second one.
  const restoreSlot = reopensTerminal && TERMINAL_PHASES.has(task.phase) && opts?.sessionId
    ? { session_id: opts.sessionId }
    : {}

  // Push with retry (Layer 1 must be reliable on its own)
  const MAX_RETRIES = 2
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // O(1) single-row write (updateTaskRaw) instead of updateTask's O(N)
      // full-store rewrite — phase transitions are on the hot send path and
      // must not hold the global task write-lock for O(taskCount) time.
      // emitEvent/push keep UI + external-sync parity with updateTask.
      let skipReason: string | undefined
      const updated = await updateTaskRaw(taskId, {
        phase: newPhase,
        ...readMarkerForPhase(newPhase),
        ...restoreSlot,
        // null keeps a wait that had no clock clock-free (prepareRawUpdate).
        ...(resume ? { wait_until: (resume.waitUntil ?? null) as never } : {}),
        // undefined = the default clock (prepareRawUpdate), never none: a routine whose trigger
        // went quiet still comes back to someone.
        ...(routine?.waitUntil ? { wait_until: routine.waitUntil } : {}),
      }, {
        emitEvent: true, push: true, source,
        // A reopen must also get past updateTaskRaw's own terminal guard (the
        // sync-pull one) and drop completed_at, which only that layer can do
        // consistently for both the phase and the timestamp.
        reopenTerminal: reopensTerminal,
        // The session machine is the one background writer allowed to end a
        // WAITING: a new turn or a prompt for the human is exactly its exit.
        leaveHeld: true,
        shouldUpdate: (current) => {
          oldPhase = current.phase
          leftWait = HELD_PHASES.has(current.phase) ? { waitUntil: current.wait_until ?? null } : undefined
          if (current.phase === newPhase) return false
          if (TERMINAL_PHASES.has(current.phase) && !reopensTerminal) return false
          // The return was planned on the row read above; anything that moved the
          // phase since (the session parking again, a person's pick) wins.
          if (resume && (current.phase !== 'IN_PROGRESS' || current.phase_changed_at !== task.phase_changed_at
            || interruptedWaitLeftAt(taskId) !== current.phase_changed_at)) {
            skipReason = 'wait-moved'
            return false
          }
          if (opts?.shouldApply && !opts.shouldApply(current)) {
            skipReason = 'superseded-snapshot'
            return false
          }
          // WAITING ends on the NEXT turn, never inside the one that set it,
          // whoever set it (the user's rule, 2026-10-04). A turn-start with no
          // generation is a reconcile (the 30s snapshot pull saw the CLI
          // running), never a new turn; an edge is a new turn only when its turn
          // began after the WAITING was stamped. That day a session armed its
          // trigger, the task parked, and six seconds later the snapshot pull
          // moved it to In Progress, so the turn's end handed it back.
          if (trigger === 'session:turn-start' && HELD_PHASES.has(current.phase)) {
            if (opts?.turnGen === undefined) skipReason = 'held-reconcile'
            else {
              const turnStartedAt = phaseRunner?.findSessionByClaudeId(opts.sessionId ?? '')?.turnStartedAt
              const heldAt = Date.parse(current.phase_changed_at ?? '')
              if (turnStartedAt !== undefined && Number.isFinite(heldAt) && heldAt >= turnStartedAt) skipReason = 'held-this-turn'
            }
            if (skipReason) return false
          }
          const live = opts?.sessionId ? phaseRunner?.findSessionByClaudeId(opts.sessionId) : undefined
          if (live) {
            if (opts?.turnGen !== undefined && live.turnGen > opts.turnGen) skipReason = 'superseded-turn'
            else if (requiresRunning && (live.processStatus !== 'running' || live.hasPendingPermission)) {
              skipReason = 'turn-not-running'
            }
          }
          return !skipReason
        },
      })
      if (!updated.changed) {
        if (skipReason) log.session.info('phase transition skipped', {
          taskId, trigger, source, sessionId: opts?.sessionId, reason: skipReason, turnGen: opts?.turnGen,
        })
        if (skipReason === 'wait-moved') {
          dropInterruptedWait(taskId, 'phase-moved', task.phase_changed_at)
          return applySessionPhase(taskId, trigger, source, { ...opts, noResume: true })
        }
        return { changed: false, oldPhase }
      }

      if (resume) consumeInterruptedWait(taskId, updated.task?.phase_changed_at)
      else if (leftWait && newPhase === 'IN_PROGRESS') {
        const cause = waitExitCause(trigger, opts?.sendSource, opts?.sendEndsWait === true, opts?.lineSource)
        const leftAt = updated.task?.phase_changed_at
        if (cause && leftAt) {
          const byLine = trigger === 'session:turn-start' && cause === 'message'
          noteInterruptedWait(taskId, {
            waitUntil: leftWait.waitUntil, leftAt, sessionId: opts?.sessionId, cause,
            source: opts?.sendSource ?? (byLine ? `stream:${opts?.lineSource}` : source),
            ...(byLine ? { byLine } : {}),
          }, trigger === 'session:turn-start' ? opts?.waitTurn : undefined)
        }
      }
      log.session.info('phase transition', {
        taskId, oldPhase, newPhase, trigger, source,
        sessionId: opts?.sessionId,
        ...(resume ? { waitResumed: true, waitUntil: resume.waitUntil } : {}),
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

/**
 * A standing routine (an armed trigger that keeps firing, task-wait-resume.ts) waits on its next
 * fire, so Walnut's idle reap of its quiet session parks it instead of handing it to the user
 * (2026-10-26: a watch reaped after hours of quiet read "needs you" until its lead parked it).
 * Any other stop (the user's, a crash, an error) still hands it back, and Main never parks.
 */
export async function standingRoutineWaits(taskId: string): Promise<boolean> {
  try {
    const { triggersWatching } = await import('./task-wait-until.js')
    return triggersStanding(await triggersWatching(taskId))
  } catch {
    return false
  }
}

/** Walnut's idle reap ended this session: the live process says so, else its record. */
async function endedByIdleReap(sessionId: string): Promise<boolean> {
  const { sessionRunner } = await import('../providers/claude-code-session.js')
  const live = sessionRunner.findSessionByClaudeId(sessionId)
  if (live) return live.teardownReason === 'idle_timeout'
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  return (await getSessionByClaudeId(sessionId).catch(() => null))?.status_reason === 'idle_timeout'
}

async function sessionEndedInError(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false
  const { getSessionByClaudeId } = await import('./session-tracker.js')
  return (await getSessionByClaudeId(sessionId).catch(() => null))?.process_status === 'error'
}

export async function handBackTaskOnSessionEnd(
  taskId: string | null | undefined,
  sessionId: string,
  source: string,
  /** `turnEnd`: the session's turn ended cleanly (not a process that died in it). */
  opts?: { shouldApply?: (current: Readonly<Task>) => boolean; turnEnd?: boolean },
): Promise<boolean> {
  if (!taskId) return false
  try {
    const { getTask } = await import('./task-manager.js')
    const task = await getTask(taskId)
    if (!task) return false
    const handback = sessionResultPhase(task.phase)
    if (task.status === 'done' || !handback) return false

    const { getSessionsForTask, getSessionsForTaskSync } = await import('./session-tracker.js')
    const { sessionRunner } = await import('../providers/claude-code-session.js')
    const { getSessionAutoRecover } = await import('./session-auto-recover.js')
    await getSessionsForTask(taskId)
    const parks = !isMainAgentTask(task) && await endedByIdleReap(sessionId)
      && !(await sessionEndedInError(sessionId)) && await standingRoutineWaits(taskId)
    const res = await applySessionPhase(taskId, 'reconciler', source, {
      sessionId,
      newPhase: parks ? 'WAITING' : handback,
      turnEnd: opts?.turnEnd === true,
      shouldApply: (current) => {
        if (opts?.shouldApply && !opts.shouldApply(current)) return false
        const sessions = getSessionsForTaskSync(taskId)
        const ending = sessions.find((s) => s.claudeSessionId === sessionId)
        if (!ending || ending.archived) return false
        if (sessions.some((s) => !s.archived && (s.process_status === 'running'
          || sessionRunner.findSessionByClaudeId(s.claudeSessionId)?.processStatus === 'running'))) return false
        // A restart killed this session's process and recovery has not decided
        // yet, or will resume it: the task is not waiting on the user. Its
        // verdict hands it back itself when it does not resume.
        const recovery = getSessionAutoRecover()
        if (recovery && (ending.process_status === 'stopped' || ending.process_status === 'error')
          && recovery.holdsHandBack(ending)) return false
        return true
      },
    })
    if (res.changed) {
      log.session.warn(parks ? 'standing routine parked after Walnut stopped its session'
        : res.newPhase === 'WAITING'
        ? 'interrupted wait restored after out-of-band session end'
        : 'task handed back after out-of-band session end', {
        taskId, sessionId, source, oldPhase: res.oldPhase,
      })
    }
    return res.changed
  } catch (err) {
    log.session.warn('hand-back after session end failed', {
      taskId, sessionId, source,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
