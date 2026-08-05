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
  AWAIT_HUMAN_ACTION: 'Awaiting Human',
  HUMAN_VERIFIED: 'Verified',
  POST_WORK_COMPLETED: 'Post Work',
  COMPLETE: 'Complete',
};

// ── Colors ──

export const PROCESS_COLORS: Record<ProcessStatus, string> = {
  running: 'var(--success)',
  idle: 'var(--warning)',
  stopped: 'var(--fg-muted)',
  error: 'var(--error)',
};

/** Amber for the derived "Waiting" display state: process_status 'running' +
 *  pendingPermission (CLI paused on requires_action). Distinct from idle's
 *  --warning by design tokens sharing is fine — but keep a dedicated constant
 *  so all surfaces (badge, composite dots) stay in sync if it ever diverges. */
export const WAITING_COLOR = 'var(--warning, #f59e0b)';

/** DERIVED display state for the status badge — the source of truth stays the
 *  4-value ProcessStatus (frozen /api/v1 contract; iOS parses it). 'waiting'
 *  exists only at the display layer: the CLI reported requires_action (paused
 *  on a permission / plan-approval prompt) — process_status stays 'running' in
 *  that state, so without this derivation the badge showed a green "Running"
 *  while the CLI sat blocked on a human click (incident 7e26389d: 15h of fake
 *  Running on an unapproved ExitPlanMode). 'running' only: a pendingPermission
 *  left on an errored/stopped record is stale and must not mask that state. */
export function deriveDisplayStatus(
  processStatus: ProcessStatus,
  pendingPermission?: { requestId?: string } | null,
): ProcessStatus | 'waiting' {
  return processStatus === 'running' && pendingPermission ? 'waiting' : processStatus;
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
  AWAIT_HUMAN_ACTION: '#a855f7',
  HUMAN_VERIFIED: '#10b981',
  POST_WORK_COMPLETED: '#06b6d4',
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
    case 'AWAIT_HUMAN_ACTION': return 'await-human';
    case 'COMPLETE': return 'completed';
    case 'TODO': return 'agent-complete';
    case 'HUMAN_VERIFIED': return 'completed';
    case 'POST_WORK_COMPLETED': return 'completed';
    default: return 'agent-complete';
  }
}
