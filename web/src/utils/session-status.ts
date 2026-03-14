/**
 * Canonical session status labels, colors, and CSS class mappings.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH for all session status display.
 * Every component that shows session status must import from here.
 * Do NOT define local label/color maps in individual components.
 */
import type { Task } from '@open-walnut/core';
import type { ProcessStatus, WorkStatus } from '@/types/session';

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
};

export const WORK_LABELS: Record<WorkStatus, string> = {
  in_progress: 'In Progress',
  agent_complete: 'Agent Complete',
  await_human_action: 'Awaiting Human',
  completed: 'Completed',
  error: 'Error',
};

// ── Colors ──

export const PROCESS_COLORS: Record<ProcessStatus, string> = {
  running: 'var(--success)',
  idle: 'var(--warning)',
  stopped: 'var(--fg-muted)',
};

export const WORK_COLORS: Record<WorkStatus, string> = {
  in_progress: 'var(--accent)',
  agent_complete: 'var(--error)',
  await_human_action: 'var(--error)',
  completed: 'var(--fg-muted)',
  error: 'var(--error)',
};

// ── Composite helpers ──

/** Single color for indicators that can only show one color (e.g. SessionPill dot).
 *  Running = green, idle = amber/warning, stopped = fall back to work_status color. */
export function compositeColor(ps: ProcessStatus, ws: WorkStatus): string {
  if (ps === 'running') return PROCESS_COLORS.running;
  if (ps === 'idle') return PROCESS_COLORS.idle;
  return WORK_COLORS[ws] ?? 'var(--fg-muted)';
}

// ── CSS class suffix for SessionPill ──

/** Maps work_status to the CSS class suffix used by .task-session-pill-{suffix}.
 *  These match the renamed CSS classes in globals.css. */
export function pillClassSuffix(ws: WorkStatus | string): string {
  switch (ws) {
    case 'in_progress': return 'running';
    case 'agent_complete': return 'agent-complete';
    case 'await_human_action': return 'await-human';
    case 'completed': return 'completed';
    case 'error': return 'error';
    default: return 'agent-complete';
  }
}
