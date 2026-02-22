/**
 * SessionPill — renders session status for a task.
 *
 * Prefers the new single-slot model (sessionId + sessionStatus).
 * Falls back to legacy 2-slot props (planSessionId/execSessionId + statuses) for backward compat.
 *
 * Format: "{label} · {WorkLabel} / {ProcessLabel}"
 * Examples:
 *   session · In Progress / Running
 *   session · Agent Complete / Stopped
 *   plan · Awaiting Human / Stopped
 */
import { WORK_LABELS, PROCESS_LABELS, pillClassSuffix } from '@/utils/session-status';
import type { WorkStatus, ProcessStatus } from '@/types/session';

interface SessionStatus {
  work_status: string;
  process_status: string;
  activity?: string;
  provider?: string;
  planCompleted?: boolean;
  mode?: string;
}

interface SessionPillProps {
  /** New single-slot session ID. */
  sessionId?: string;
  /** New single-slot session status (enriched from backend). */
  sessionStatus?: SessionStatus;
  /** @deprecated Legacy 2-slot prop. */
  planSessionId?: string;
  /** @deprecated Legacy 2-slot prop. */
  execSessionId?: string;
  /** @deprecated Legacy 2-slot prop. */
  planStatus?: SessionStatus;
  /** @deprecated Legacy 2-slot prop. */
  execStatus?: SessionStatus;
  /** Historical session IDs for "N sessions" fallback. */
  sessionIds?: string[];
  /** Session mode — used to show "Plan" label. */
  mode?: string;
}

/** Human-readable work_status label from central constants. */
function workLabel(status: SessionStatus | undefined): string {
  if (!status) return '?';
  return WORK_LABELS[status.work_status as WorkStatus] || status.work_status || '?';
}

/** Human-readable process_status label from central constants. */
function processLabel(status: SessionStatus | undefined): string {
  if (!status) return '?';
  return PROCESS_LABELS[status.process_status as ProcessStatus] || status.process_status || '?';
}

/** CSS class suffix from work_status via central utility. */
function stateClassFromStatus(status: SessionStatus | undefined): string {
  return pillClassSuffix(status?.work_status || '');
}

/** CSS class suffix from two legacy statuses — picks the most important. */
function stateClassLegacy(plan: SessionStatus | undefined, exec: SessionStatus | undefined): string {
  const ws = (s: SessionStatus | undefined) => s?.work_status;
  if (ws(plan) === 'in_progress' || ws(exec) === 'in_progress') return 'running';
  if (ws(plan) === 'error' || ws(exec) === 'error') return 'error';
  if (ws(plan) === 'await_human_action' || ws(exec) === 'await_human_action') return 'await-human';
  if (ws(plan) === 'completed' || ws(exec) === 'completed') return 'completed';
  return 'agent-complete';
}

export function SessionPill({ sessionId, sessionStatus, planSessionId, execSessionId, planStatus, execStatus, sessionIds, mode }: SessionPillProps) {
  // New single-slot model: prefer sessionId + sessionStatus
  if (sessionId || sessionStatus) {
    const status = sessionStatus;
    const cls = stateClassFromStatus(status);
    const isPlan = mode === 'plan';
    const slotLabel = isPlan ? 'plan' : 'session';
    const wl = workLabel(status);
    const pl = processLabel(status);
    const isEmbedded = status?.provider === 'embedded';
    const title = status
      ? `${slotLabel}: ${status.work_status} / ${status.process_status}${isEmbedded ? ' (embedded)' : ''}`
      : `${slotLabel} session`;

    return (
      <span className={`task-session-pill task-session-pill-${cls}`} title={title}>
        <span className={`task-session-dot task-session-dot-${cls}`} />
        {isEmbedded ? '\uD83E\uDD16 ' : ''}{slotLabel} · {wl} / {pl}
      </span>
    );
  }

  // Legacy 2-slot fallback
  const hasPlan = !!(planSessionId || planStatus);
  const hasExec = !!(execSessionId || execStatus);

  // No active slots — fall back to historical session count
  if (!hasPlan && !hasExec) {
    if (sessionIds && sessionIds.length > 0) {
      return (
        <span className="task-session-pill task-session-pill-history" title={`${sessionIds.length} past session(s)`}>
          {sessionIds.length} session{sessionIds.length !== 1 ? 's' : ''}
        </span>
      );
    }
    return null;
  }

  const cls = stateClassLegacy(planStatus, execStatus);
  // When only the exec slot is present, respect the mode prop so that a session
  // entering plan mode (EnterPlanMode) shows "plan" instead of staying "exec".
  const slotLabel = hasPlan && hasExec ? 'plan + exec' : hasPlan ? 'plan' : (mode === 'plan' ? 'plan' : 'exec');

  // Pick the primary session for the work/process labels (prefer exec over plan)
  const primary = hasExec ? execStatus : planStatus;
  const wl = workLabel(primary);
  const pl = processLabel(primary);

  // Detect embedded provider
  const isEmbedded = primary?.provider === 'embedded';

  // Build title with full details for both slots
  const titleParts: string[] = [];
  if (hasPlan && planStatus) titleParts.push(`plan: ${planStatus.work_status} / ${planStatus.process_status}${planStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  if (hasExec && execStatus) titleParts.push(`exec: ${execStatus.work_status} / ${execStatus.process_status}${execStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  const title = titleParts.join('  |  ') || `${slotLabel} session`;

  return (
    <span className={`task-session-pill task-session-pill-${cls}`} title={title}>
      <span className={`task-session-dot task-session-dot-${cls}`} />
      {isEmbedded ? '\uD83E\uDD16 ' : ''}{slotLabel} · {wl} / {pl}
    </span>
  );
}
