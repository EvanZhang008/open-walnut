import { useState } from 'react';
import type { Routine } from '@/api/routines';
import { describeRoutineTiming, describeExecutorBadge, describeCheck, describeFireTally, describeLastCheck } from '@/utils/routine-format';

interface RoutineCardProps {
  routine: Routine;
  executorLabels: Record<string, string>;
  onToggle: (id: string) => void;
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

function getStatusLabel(r: Routine): string {
  if (!r.enabled) return 'Disabled';
  if (r.state.runningAtMs) return 'Running';
  if (r.state.lastStatus === 'error' || r.state.lastCheck?.outcome === 'error') return 'Error';
  if (r.state.lastStatus === 'ok') return 'OK';
  return 'Idle';
}

export function RoutineCard({ routine, executorLabels, onToggle, onRunNow, onEdit, onDelete }: RoutineCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className={`cron-job-card card routine-card${!routine.enabled ? ' cron-job-disabled' : ''}`}>
      <div className="cron-job-header">
        <div className="cron-job-status">
          <span className={`cron-status-dot ${getStatusClass(routine)}`} title={getStatusLabel(routine)} />
        </div>
        <div className="cron-job-info">
          <span className="cron-job-name">{routine.name}</span>
          <span className="cron-job-desc text-sm text-muted">
            {describeRoutineTiming(routine.schedule, routine.state, routine.wake)}
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
            onClick={() => onToggle(routine.id)}
            title={routine.enabled ? 'Disable' : 'Enable'}
          >
            {routine.enabled ? 'On' : 'Off'}
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
                <button className="cron-menu-item" onClick={() => { onRunNow(routine.id); setMenuOpen(false); }}>
                  Run now
                </button>
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
