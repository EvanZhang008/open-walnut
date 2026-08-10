/**
 * SessionPill — renders session status for a task.
 *
 * Prefers the new single-slot model (sessionId + sessionStatus).
 * Falls back to legacy 2-slot props (planSessionId/execSessionId + statuses) for backward compat.
 *
 * Three-layer badge format: "Session · {Mode} · {PhaseLabel} / {ProcessLabel}"
 * Examples:
 *   Session · Plan · In Progress / Running
 *   Session · Bypass · Agent Complete / Stopped
 *   Session · Plan · Awaiting Human / Stopped
 */
import { PHASE_LABELS, PROCESS_LABELS, pillPhaseClassSuffix } from '@/utils/session-status';
import type { TaskPhase, ProcessStatus } from '@/types/session';
import { SESSION_MODE_LABELS } from '@open-walnut/core';
import type { SessionMode } from '@open-walnut/core';
import type { Task } from '@open-walnut/core';
import { ICON_ROBOT } from '@/components/common/Icons';
import { useCanonicalSessionId, useSessionStatus } from '@/hooks/useSessionStatus';
import { resolveTaskSessionId } from '@/utils/session-status';

/** Registry label for a mode id that arrives as a loose string off the wire. */
function modeLabelFor(mode: string | undefined, fallback: string): string {
  if (!mode) return fallback;
  return SESSION_MODE_LABELS[mode as SessionMode] ?? mode;
}

interface SessionStatus {
  process_status: string;
  activity?: string | null;
  provider?: string | null;
  planCompleted?: boolean;
  mode?: string | null;
}

interface SessionPillProps {
  /** New single-slot session ID. */
  sessionId?: string;
  /** New single-slot session status (enriched from backend). */
  sessionStatus?: SessionStatus;
  /** Task phase — used for display label and CSS class. */
  phase?: TaskPhase;
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
  /** Whether this session is currently open in a session column. */
  isActive?: boolean;
}

/** Human-readable phase label from central constants. */
function phaseLabel(phase: TaskPhase | undefined): string {
  if (!phase) return '?';
  return PHASE_LABELS[phase] || phase || '?';
}

/** Human-readable process_status label from central constants. */
function processLabel(status: SessionStatus | undefined): string {
  if (!status) return '?';
  return PROCESS_LABELS[status.process_status as ProcessStatus] || status.process_status || '?';
}

/** CSS class suffix from phase via central utility. */
function stateClassFromPhase(phase: TaskPhase | undefined): string {
  return pillPhaseClassSuffix(phase);
}

function stateClass(status: SessionStatus | undefined, phase: TaskPhase | undefined): string {
  if (status?.process_status === 'running') return 'running';
  if (status?.process_status === 'error') return 'error';
  return stateClassFromPhase(phase);
}

/** CSS class suffix from two legacy statuses — picks the most important. */
function stateClassLegacy(plan: SessionStatus | undefined, exec: SessionStatus | undefined, phase: TaskPhase | undefined): string {
  const ps = (s: SessionStatus | undefined) => s?.process_status;
  if (ps(plan) === 'running' || ps(exec) === 'running') return 'running';
  if (ps(plan) === 'error' || ps(exec) === 'error') return 'error';
  return pillPhaseClassSuffix(phase);
}

export function SessionPill({ sessionId, sessionStatus, phase, planSessionId, execSessionId, planStatus, execStatus, sessionIds, mode, onClick, isActive }: SessionPillProps) {
  const storedSessionStatus = useSessionStatus(sessionId);
  const storedPlanStatus = useSessionStatus(planSessionId);
  const storedExecStatus = useSessionStatus(execSessionId);
  const resolvedSessionStatus = storedSessionStatus ?? sessionStatus;
  const resolvedPlanStatus = storedPlanStatus ?? planStatus;
  const resolvedExecStatus = storedExecStatus ?? execStatus;
  const clickable = !!onClick;
  const clickClass = clickable ? ' task-session-pill-clickable' : '';
  const activeClass = isActive ? ' task-session-pill-active' : '';
  const handleClick = clickable ? (e: React.MouseEvent) => { e.stopPropagation(); onClick!(e); } : undefined;

  // Mode label comes from the registry (core/types.ts) — this used to be a
  // binary `isPlanSession ? 'Plan' : 'Bypass'`, which labelled a 'dontAsk'
  // session (the STRICTEST non-plan mode) as "Bypass" (the loosest).
  // planCompleted means a plan was produced even if mode !== 'plan'.
  const resolvedMode = resolvedSessionStatus?.mode ?? resolvedPlanStatus?.mode ?? mode;
  const isPlanSession = resolvedMode === 'plan'
    || !!resolvedSessionStatus?.planCompleted
    || !!resolvedPlanStatus?.planCompleted;
  const modeLabel = isPlanSession
    ? 'Plan'
    : modeLabelFor(resolvedMode, 'Bypass');

  // New single-slot model: prefer sessionId + sessionStatus
  if (sessionId || sessionStatus) {
    const status = resolvedSessionStatus;
    const cls = stateClass(status, phase);
    const wl = phaseLabel(phase);
    const pl = processLabel(status);
    const isEmbedded = status?.provider === 'embedded';
    const title = status
      ? `Session · ${modeLabel}: ${phase ?? 'unknown'} / ${status.process_status}${isEmbedded ? ' (embedded)' : ''}`
      : 'Session';

    return (
      <span className={`task-session-pill task-session-pill-${cls}${clickClass}${activeClass}`} title={title} onClick={handleClick}>
        <span className={`task-session-dot task-session-dot-${cls}`} />
        {isEmbedded ? <>{ICON_ROBOT}{' '}</> : ''}Session · {modeLabel} · {wl} / {pl}
      </span>
    );
  }

  // Legacy 2-slot fallback
  const hasPlan = !!(planSessionId || resolvedPlanStatus);
  const hasExec = !!(execSessionId || resolvedExecStatus);

  // No active slots — fall back to historical session count
  if (!hasPlan && !hasExec) {
    if (sessionIds && sessionIds.length > 0) {
      return (
        <span className={`task-session-pill task-session-pill-history${clickClass}${activeClass}`} title={`${sessionIds.length} past session(s)`} onClick={handleClick}>
          {sessionIds.length} session{sessionIds.length !== 1 ? 's' : ''}
        </span>
      );
    }
    return null;
  }

  const cls = stateClassLegacy(resolvedPlanStatus, resolvedExecStatus, phase);

  // Pick the primary session for the process label (prefer exec over plan)
  const primary = hasExec ? resolvedExecStatus : resolvedPlanStatus;
  const wl = phaseLabel(phase);
  const pl = processLabel(primary);

  // Detect embedded provider
  const isEmbedded = primary?.provider === 'embedded';

  // Resolve legacy mode label from slot presence (registry-backed — see above)
  const legacyMode = hasPlan ? 'plan' : resolvedMode;
  const legacyModeLabel = legacyMode === 'plan'
    ? 'Plan'
    : modeLabelFor(legacyMode, 'Bypass');

  // Build title with full details for both slots
  const titleParts: string[] = [];
  if (hasPlan && resolvedPlanStatus) titleParts.push(`plan: ${phase ?? 'unknown'} / ${resolvedPlanStatus.process_status}${resolvedPlanStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  if (hasExec && resolvedExecStatus) titleParts.push(`exec: ${phase ?? 'unknown'} / ${resolvedExecStatus.process_status}${resolvedExecStatus.provider === 'embedded' ? ' (embedded)' : ''}`);
  const title = titleParts.join('  |  ') || 'Session';

  return (
    <span className={`task-session-pill task-session-pill-${cls}${clickClass}`} title={title} onClick={handleClick}>
      <span className={`task-session-dot task-session-dot-${cls}`} />
      {isEmbedded ? <>{ICON_ROBOT}{' '}</> : ''}Session · {legacyModeLabel} · {wl} / {pl}
    </span>
  );
}

interface TaskSessionPillProps {
  task: Task;
  onOpenSession?: (sessionId: string) => void;
  isActive?: boolean;
}

/**
 * Task-aware adapter used by every task surface. It keeps session-link fallback
 * and provider-ID alias handling in one place while SessionPill owns display.
 */
export function TaskSessionPill({ task, onOpenSession, isActive }: TaskSessionPillProps) {
  const sessionId = resolveTaskSessionId(task);
  const canonicalSessionId = useCanonicalSessionId(sessionId);
  if (!sessionId) return null;

  const displaySessionId = canonicalSessionId ?? sessionId;
  const sessionStatus = task.session_id === sessionId
    ? task.session_status
    : task.exec_session_id === sessionId
      ? task.exec_session_status
      : task.plan_session_id === sessionId
        ? task.plan_session_status
        : undefined;

  return (
    <SessionPill
      sessionId={displaySessionId}
      sessionStatus={sessionStatus}
      phase={task.phase}
      mode={sessionStatus?.mode
        ?? task.session_status?.mode
        ?? task.exec_session_status?.mode
        ?? task.plan_session_status?.mode}
      onClick={onOpenSession ? () => onOpenSession(displaySessionId) : undefined}
      isActive={isActive}
    />
  );
}
