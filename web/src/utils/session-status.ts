/**
 * Canonical session status labels, colors, and CSS class mappings.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for all session status display.
 * Every component that shows session status must import from here.
 * Do NOT define local label/color maps in individual components.
 */
import type { Task } from '@open-walnut/core';
import type { ProcessStatus, TaskPhase } from '@/types/session';

// ── Session ID resolution ──

/** Resolve the best session ID for a task, falling back through all available slots.
 *  Used by FocusDock and TodoPanel to find a displayable session. */
export function resolveTaskSessionId(task: Task): string | null {
  return task.session_id
    || task.exec_session_id
    || task.plan_session_id
    || (task.session_ids?.length ? task.session_ids[task.session_ids.length - 1] : null)
    || null;
}

/** "Human action needed" — the task-level red treatment (whole row/card tint).
 *
 *  PHASE-driven, deliberately NOT the `unread` marker (2026-08-14 user report:
 *  "任务是 Agent Complete 为什么没有提醒" — the red tint had been switched to the
 *  unread marker, which clears the moment the task is OPENED, so a task that
 *  still needed action went quiet after one glance). Two distinct semantics,
 *  two distinct affordances:
 *    - red tint  = needs action (this fn) — clears only when the human ACTS
 *      (complete the task, or a new turn pulls the phase back to IN_PROGRESS)
 *    - red dot   = unread output (task.unread) — clears on open
 */
export function taskNeedsAction(task: Task): boolean {
  if (task.status === 'done' || task.phase === 'COMPLETE') return false;
  return task.phase === 'AGENT_COMPLETE';
}

/** Color class for the task circle (the clickable To Do ↔ Complete toggle).
 *
 *  THREE colors, deliberately (2026-08-14 user request — the short-lived
 *  5-state version with red/green circles was "过于复杂"):
 *    grey        = plain task, no session attached
 *    blue        = session attached, not actively working
 *    blue, pulse = session actively running a turn
 *  (done keeps its green check — that's the complete toggle, not a live state.)
 *
 *  Error and waiting are NOT circle states: a session error drives the task
 *  phase to AGENT_COMPLETE which turns the whole row red (taskNeedsAction),
 *  and a permission wait shows as the SessionPill's red "Waiting". The circle
 *  only answers "is anything attached / is it working right now".
 *
 *  `liveStatus` comes from the session-status store (see useTaskCircle) so
 *  the circle updates in real time; callers without a store subscription can
 *  pass the task's enrichment snapshot (`session_status`) instead. */
export function taskCircleClass(
  task: Task,
  liveStatus?: {
    process_status?: string;
    errorMessage?: string | null;
    pendingPermissionTool?: string | null;
  } | null,
): string {
  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
  if (isDone) return 'task-circle-done';
  const sessionId = resolveTaskSessionId(task);
  if (!sessionId) return 'task-circle-todo';
  const s = liveStatus ?? task.session_status ?? null;
  if (s?.process_status === 'running') return 'task-circle-running';
  return 'task-circle-session';
}

// ── Labels ──

export const PROCESS_LABELS: Record<ProcessStatus, string> = {
  running: 'Running',
  idle: 'Idle',
  stopped: 'Stopped',
  error: 'Error',
};

export const PHASE_LABELS: Record<TaskPhase, string> = {
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  AGENT_COMPLETE: 'Agent Complete',
  COMPLETE: 'Complete',
};

// ── Colors ──

export const PROCESS_COLORS: Record<ProcessStatus, string> = {
  running: 'var(--success)',
  idle: 'var(--warning)',
  stopped: 'var(--fg-muted)',
  error: 'var(--error)',
};

/** RED for the derived "Waiting" display state: a pendingPermission
 *  (permission prompt / AskUserQuestion) means the CLI is BLOCKED on a human
 *  click — that is the single most actionable state a session can be in, so it
 *  must be unmissable. Was amber (--warning), which read as "background hum"
 *  next to idle's identical amber; user feedback 2026-08-13: "ask 的时候应该变红".
 *  Keep a dedicated constant so all surfaces stay in sync if it diverges. */
export const WAITING_COLOR = 'var(--error, #ef4444)';

/** DERIVED display state for the status badge — the source of truth stays the
 *  4-value ProcessStatus (frozen /api/v1 contract; iOS parses it). 'waiting'
 *  exists only at the display layer: the CLI reported requires_action (paused
 *  on a permission / plan-approval prompt) — without this derivation the badge
 *  showed a green "Running" while the CLI sat blocked on a human click
 *  (incident 7e26389d: 15h of fake Running on an unapproved ExitPlanMode).
 *  'running' AND 'idle' both derive to waiting: turn-lifecycle races routinely
 *  leave the record 'idle' while a question sits unanswered (incident 67b22d72:
 *  a 2h-pending AskUserQuestion showed a calm amber "Idle"). Staleness is now
 *  handled at the SOURCE (control_cancel_request handler + attach cross-check
 *  + startup heal), so a pendingPermission on a live record is trustworthy.
 *  stopped/error still win: a prompt cannot outlive its process, and those
 *  states must never be masked. */
export function deriveDisplayStatus(
  processStatus: ProcessStatus,
  pendingPermission?: { requestId?: string } | null,
): ProcessStatus | 'waiting' {
  return (processStatus === 'running' || processStatus === 'idle') && pendingPermission
    ? 'waiting'
    : processStatus;
}

/** Hover title for the derived 'waiting' badge: which tool + how long. */
export function waitingBadgeTitle(pp: { toolName?: string; receivedAt?: string }, now = Date.now()): string {
  const tool = pp.toolName || 'a tool';
  const since = pp.receivedAt ? Date.parse(pp.receivedAt) : NaN;
  if (!Number.isNaN(since)) {
    const mins = Math.max(0, Math.round((now - since) / 60000));
    const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    return `Waiting for approval: ${tool} (${dur})`;
  }
  return `Waiting for approval: ${tool}`;
}

export const PHASE_COLORS: Record<TaskPhase, string> = {
  TODO: '#6b7280',
  IN_PROGRESS: '#f59e0b',
  AGENT_COMPLETE: '#3b82f6',
  COMPLETE: '#22c55e',
};

// ── Phase picker choices (simplified) ──

/**
 * Phases offered in ALL phase-picker menus: just To Do and Complete.
 * The full lifecycle (IN_PROGRESS → AGENT_COMPLETE → …) still exists in the
 * data model and is set by agents/automation; it's only hidden from manual
 * pickers. If the task currently sits in a hidden phase, that phase is
 * included (between the two) so the active state stays visible and escapable.
 */
export function phasePickerChoices(current?: TaskPhase | string | null): string[] {
  if (current && current !== 'TODO' && current !== 'COMPLETE') {
    return ['TODO', current, 'COMPLETE'];
  }
  return ['TODO', 'COMPLETE'];
}

/**
 * Phase-filter matching for the simplified two-state UI:
 * 'TODO' means "not complete" (any phase except COMPLETE), 'COMPLETE' matches
 * exactly. Other filter values (deep links, saved prefs) still match exactly.
 */
export function matchesPhaseFilter(filter: string, phase: TaskPhase | string | undefined): boolean {
  if (!filter) return true;
  if (filter === 'TODO') return phase !== 'COMPLETE';
  return phase === filter;
}

// ── Composite helpers ──

/** Single color for indicators that combine process status and task phase.
 *  Running = IN_PROGRESS color, error = red, otherwise = PHASE_COLORS[phase]. */
export function compositePhaseColor(ps: ProcessStatus, phase: TaskPhase | undefined): string {
  if (ps === 'running') return PHASE_COLORS.IN_PROGRESS;
  if (ps === 'error') return PROCESS_COLORS.error;
  return phase ? (PHASE_COLORS[phase] ?? '#6b7280') : '#6b7280';
}

// ── CSS class suffix for SessionPill ──

/** Maps phase to the CSS class suffix used by .task-session-pill-{suffix}.
 *  These match the renamed CSS classes in globals.css. */
export function pillPhaseClassSuffix(phase: TaskPhase | string | undefined): string {
  switch (phase) {
    case 'IN_PROGRESS': return 'running';
    case 'AGENT_COMPLETE': return 'agent-complete';
    case 'COMPLETE': return 'completed';
    case 'TODO': return 'agent-complete';
    default: return 'agent-complete';
  }
}
