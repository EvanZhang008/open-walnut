import { useState } from 'react';
import type { Routine } from '@/api/routines';
import {
  describeRoutineTiming, describeExecutorBadge, describeCheck, describeFireTally, describeLastCheck,
  describeTriggerOff, triggerRunState,
} from '@/utils/routine-format';
import '@/styles/routine-description.css';

interface RoutineCardProps {
  routine: Routine;
  executorLabels: Record<string, string>;
  /** Pause (false) or Resume (true): the state the card asks for, never a flip. */
  onToggle: (id: string, enabled: boolean) => void;
  onRunNow: (id: string) => void;
  onEdit: (routine: Routine) => void;
  onDelete: (id: string) => void;
}

function getStatusClass(r: Routine): string {
  if (!r.enabled) return 'disabled';
  if (r.state.runningAtMs) return 'running';
  if (r.state.lastStatus === 'error' || r.state.lastCheck?.outcome === 'error') return 'error';
  return 'ok';
}

/**
 * What the switch of a routine that is off says. A trigger is Paused or Stopped
 * (the server gave up on its failing check). A plain routine is Paused when
 * someone paused it, and Off otherwise: a one-time routine switches itself off
 * once it has run.
 */
function offLabel(r: Routine): 'Paused' | 'Stopped' | 'Off' {
  if (r.check) return triggerRunState(r) === 'stopped' ? 'Stopped' : 'Paused';
  return typeof r.state.pausedAtMs === 'number' ? 'Paused' : 'Off';
}

/** "Paused 2h ago" / "Stopped after 5 failed checks", for the timing line. */
function describeOff(r: Routine): string | null {
  if (r.enabled) return null;
  if (r.check) return describeTriggerOff(r);
  return typeof r.state.pausedAtMs === 'number' ? describeTriggerOff({ enabled: false, state: { pausedAtMs: r.state.pausedAtMs } }) : null;
}

function getStatusLabel(r: Routine): string {
  if (!r.enabled) return offLabel(r);
  if (r.state.runningAtMs) return 'Running';
  if (r.state.lastStatus === 'error' || r.state.lastCheck?.outcome === 'error') return 'Error';
  if (r.state.lastStatus === 'ok') return 'OK';
  return 'Idle';
}

export function RoutineCard({ routine, executorLabels, onToggle, onRunNow, onEdit, onDelete }: RoutineCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const off = describeOff(routine);
  // A paused trigger is disarmed on its daemon, which answers a run with
  // "unknown trigger"; Resume is the way to check it again.
  const canRunNow = routine.enabled || !routine.check;

  return (
    <div className={`cron-job-card card routine-card${!routine.enabled ? ' cron-job-disabled' : ''}`}>
      <div className="cron-job-header">
        <div className="cron-job-status">
          <span className={`cron-status-dot ${getStatusClass(routine)}`} title={getStatusLabel(routine)} />
        </div>
        <div className="cron-job-info">
          <span className="cron-job-name">{routine.name}</span>
          <span className="cron-job-desc text-sm text-muted">
            {/* A switched-off routine has no next run: say why it is quiet instead. */}
            {describeRoutineTiming(routine.schedule, routine.enabled ? routine.state : undefined, routine.wake)}
            {off ? ` · ${off}` : ''}
          </span>
        </div>
        {routine.check && (
          <span className="routine-executor-badge routine-trigger-badge" title="A check script decides when this routine fires">
            Trigger
          </span>
        )}
        <span className="routine-executor-badge" title={routine.executor?.type ?? 'claude-code'}>
          {describeExecutorBadge(routine.executor, executorLabels)}
        </span>
        <div className="cron-job-actions">
          <button
            className={`btn btn-sm cron-toggle-btn${routine.enabled ? ' cron-toggle-on' : ''}`}
            onClick={() => onToggle(routine.id, !routine.enabled)}
            title={routine.enabled ? 'Pause' : offLabel(routine) === 'Off' ? 'Turn on' : 'Resume'}
            aria-label={`${routine.enabled ? 'Pause' : offLabel(routine) === 'Off' ? 'Turn on' : 'Resume'} ${routine.name}`}
          >
            {routine.enabled ? 'On' : offLabel(routine)}
          </button>
          <div className="cron-menu-wrapper">
            <button
              className="btn btn-sm cron-menu-btn"
              onClick={() => { setMenuOpen(!menuOpen); setConfirmDelete(false); }}
              title="Actions"
            >
              &#8942;
            </button>
            {menuOpen && !confirmDelete && (
              <div className="cron-menu" onMouseLeave={() => setMenuOpen(false)}>
                {canRunNow && (
                  <button className="cron-menu-item" onClick={() => { onRunNow(routine.id); setMenuOpen(false); }}>
                    Run now
                  </button>
                )}
                <button className="cron-menu-item" onClick={() => { onEdit(routine); setMenuOpen(false); }}>
                  Edit
                </button>
                <button className="cron-menu-item cron-menu-danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              </div>
            )}
            {confirmDelete && (
              <div className="cron-confirm-popover" onMouseLeave={() => { setConfirmDelete(false); setMenuOpen(false); }}>
                <p className="cron-confirm-text">Delete this routine?</p>
                <div className="cron-confirm-actions">
                  <button className="btn btn-sm cron-confirm-cancel" onClick={() => { setConfirmDelete(false); setMenuOpen(false); }}>
                    Cancel
                  </button>
                  <button className="btn btn-sm cron-confirm-delete" onClick={() => { onDelete(routine.id); setConfirmDelete(false); setMenuOpen(false); }}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      {routine.description && <p className="routine-description routine-card-description">{routine.description}</p>}
      {routine.check && (
        <div className="routine-check-line text-xs" title={routine.check.run}>
          <code className="routine-check-run">{describeCheck(routine.check)}</code>
          <span className={`routine-check-status ${routine.state.lastCheck?.outcome ?? 'pending'}`}>
            last check: {describeLastCheck(routine.state.lastCheck)}
          </span>
          {/* Whether it has ever actually fired — a card showing only the newest
              quiet check cannot be told apart from one that never ran. */}
          <span className="routine-check-tally" data-fired={(routine.state.fireCount ?? 0) > 0 ? 'true' : 'false'}>
            {describeFireTally(routine.state)}
          </span>
        </div>
      )}
      {routine.state.lastError && (
        <div className="cron-job-error text-xs">{routine.state.lastError}</div>
      )}
    </div>
  );
}
