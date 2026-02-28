/**
 * SessionPill — renders session status for a task.
 *
 * Prefers the new single-slot model (sessionId + sessionStatus).
 * Falls back to legacy 2-slot props (planSessionId/execSessionId + statuses) for backward compat.
 *
 * Three-layer badge format: "Session · {Mode} · {WorkLabel} / {ProcessLabel}"
 * Examples:
 *   Session · Plan · In Progress / Running
 *   Session · Bypass · Agent Complete / Stopped
 *   Session · Plan · Awaiting Human / Stopped
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
  /** Click handler — when provided, pill becomes clickable (one-click to open session). */
  onClick?: (e: React.MouseEvent) => void;
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

export function SessionPill({ sessionId, sessionStatus, planSessionId, execSessionId, planStatus, execStatus, sessionIds, mode, onClick }: SessionPillProps) {
  const clickable = !!onClick;
  const clickClass = clickable ? ' task-session-pill-clickable' : '';
  const handleClick = clickable ? (e: React.MouseEvent) => { e.stopPropagation(); onClick!(e); } : undefined;

  // Resolve mode label: Plan or Bypass (only these two matter to the user)
  const modeLabel = mode === 'plan' ? 'Plan' : 'Bypass';

  // New single-slot model: prefer sessionId + sessionStatus
  if (sessionId || sessionStatus) {
    const status = sessionStatus;
    const cls = stateClassFromStatus(status);
    const wl = workLabel(status);
    const pl = processLabel(status);
    const isEmbedded = status?.provider === 'embedded';
    const title = status
      ? `Session · ${modeLabel}: ${status.work_status} / ${status.process_status}${isEmbedded ? ' (embedded)' : ''}`
      : 'Session';

    return (
      <span className={`task-session-pill task-session-pill-${cls}${clickClass}`} title={title} onClick={handleClick}>
        <span className={`task-session-dot task-session-dot-${cls}`} />
        {isEmbedded ? '\uD83E\uDD16 ' : ''}Session · {modeLabel} · {wl} / {pl}
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
        <span className={`task-session-pill task-session-pill-history${clickClass}`} title={`${sessionIds.length} past session(s)`} onClick={handleClick}>
          {sessionIds.length} session{sessionIds.length !== 1 ? 's' : ''}
        </span>
      );
    }
    return null;
  }

  const cls = stateClassLegacy(planStatus, execStatus);

  // Pick the primary session for the work/process labels (prefer exec over plan)
  const primary = hasExec ? execStatus : planStatus;
  const wl = workLabel(primary);
  const pl = processLabel(primary);

  // Detect embedded provider
  const isEmbedded = primary?.provider === 'embedded';

  // Resolve legacy mode label from slot presence
  const legacyMode = hasPlan ? 'plan' : mode;
  const legacyModeLabel = legacyMode === 'plan' ? 'Plan' : 'Bypass';

  // Build title with full details for both slots
  const titleParts: string[] = [];
  if (hasPlan && planStatus) titleParts.push(`plan: ${planStatus.work_status} / ${planStatus.process_status}${planStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  if (hasExec && execStatus) titleParts.push(`exec: ${execStatus.work_status} / ${execStatus.process_status}${execStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  const title = titleParts.join('  |  ') || 'Session';

  return (
    <span className={`task-session-pill task-session-pill-${cls}${clickClass}`} title={title} onClick={handleClick}>
      <span className={`task-session-dot task-session-dot-${cls}`} />
      {isEmbedded ? '\uD83E\uDD16 ' : ''}Session · {legacyModeLabel} · {wl} / {pl}
    </span>
  );
}
