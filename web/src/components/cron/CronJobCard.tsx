import { useState } from 'react';
import type { CronJob, CronSchedule } from '@/api/cron';

interface CronJobCardProps {
  job: CronJob;
  onToggle: (id: string) => void;
  onRunNow: (id: string) => void;
  onEdit: (job: CronJob) => void;
  onDelete: (id: string) => void;
}

/** Format a CronSchedule into a human-readable string. */
function formatSchedule(schedule: CronSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `Once at ${new Date(schedule.at).toLocaleString()}`;
    case 'every': {
      const ms = schedule.everyMs;
      if (ms < 60_000) return `Every ${Math.round(ms / 1000)}s`;
      if (ms < 3_600_000) {
        const mins = Math.round(ms / 60_000);
        return `Every ${mins} minute${mins !== 1 ? 's' : ''}`;
      }
      const hrs = Math.round(ms / 3_600_000);
      return `Every ${hrs} hour${hrs !== 1 ? 's' : ''}`;
    }
    case 'cron':
      return schedule.tz ? `${schedule.expr} (${schedule.tz})` : schedule.expr;
    default:
      return 'Unknown schedule';
  }
}

/** Format a timestamp (ms) as a relative time string like "2m ago" or "in 8m". */
function formatRelativeTime(ms: number): string {
  const now = Date.now();
  const diff = ms - now;
  const absDiff = Math.abs(diff);

  if (absDiff < 60_000) {
    const secs = Math.round(absDiff / 1000);
    return diff < 0 ? `${secs}s ago` : `in ${secs}s`;
  }
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    return diff < 0 ? `${mins}m ago` : `in ${mins}m`;
  }
  if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    return diff < 0 ? `${hrs}h ago` : `in ${hrs}h`;
  }
  const days = Math.round(absDiff / 86_400_000);
  return diff < 0 ? `${days}d ago` : `in ${days}d`;
}

function getStatusClass(job: CronJob): string {
  if (!job.enabled) return 'disabled';
  if (job.state.runningAtMs) return 'running';
  if (job.state.lastStatus === 'error') return 'error';
  return 'ok';
}

function getStatusLabel(job: CronJob): string {
  if (!job.enabled) return 'Disabled';
  if (job.state.runningAtMs) return 'Running';
  if (job.state.lastStatus === 'error') return 'Error';
  if (job.state.lastStatus === 'ok') return 'OK';
  if (job.state.lastStatus === 'skipped') return 'Skipped';
  return 'Idle';
}

export function CronJobCard({ job, onToggle, onRunNow, onEdit, onDelete }: CronJobCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const statusClass = getStatusClass(job);

  return (
    <div className={`cron-job-card card${!job.enabled ? ' cron-job-disabled' : ''}`}>
      <div className="cron-job-header">
        <div className="cron-job-status">
          <span className={`cron-status-dot ${statusClass}`} title={getStatusLabel(job)} />
        </div>
        <div className="cron-job-info">
          <span className="cron-job-name">{job.name}</span>
          {job.description && <span className="cron-job-desc text-sm text-muted">{job.description}</span>}
        </div>
        <div className="cron-job-actions">
          <button
            className={`btn btn-sm cron-toggle-btn${job.enabled ? ' cron-toggle-on' : ''}`}
            onClick={() => onToggle(job.id)}
            title={job.enabled ? 'Disable' : 'Enable'}
          >
            {job.enabled ? 'On' : 'Off'}
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
                <button className="cron-menu-item" onClick={() => { onRunNow(job.id); setMenuOpen(false); }}>
                  Run now
                </button>
                <button className="cron-menu-item" onClick={() => { onEdit(job); setMenuOpen(false); }}>
                  Edit
                </button>
                <button className="cron-menu-item cron-menu-danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              </div>
            )}
            {confirmDelete && (
              <div className="cron-confirm-popover" onMouseLeave={() => { setConfirmDelete(false); setMenuOpen(false); }}>
                <p className="cron-confirm-text">Delete this job?</p>
                <div className="cron-confirm-actions">
                  <button className="btn btn-sm cron-confirm-cancel" onClick={() => { setConfirmDelete(false); setMenuOpen(false); }}>
                    Cancel
                  </button>
                  <button className="btn btn-sm cron-confirm-delete" onClick={() => { onDelete(job.id); setConfirmDelete(false); setMenuOpen(false); }}>
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="cron-job-schedule text-sm text-muted">
        {formatSchedule(job.schedule)}
        {job.initProcessor && (
          <span className="cron-processor-badge" title={`Init processor: ${job.initProcessor.actionId}`}>
            {job.initProcessor.actionId}
            {job.initProcessor.targetAgent ? ` \u2192 ${job.initProcessor.targetAgent}` : ''}
          </span>
        )}
      </div>
      <div className="cron-job-meta text-xs text-muted">
        {job.state.lastRunAtMs && (
          <span>Last: {formatRelativeTime(job.state.lastRunAtMs)}{job.state.lastStatus ? ` \u00b7 ${job.state.lastStatus.toUpperCase()}` : ''}</span>
        )}
        {job.state.nextRunAtMs && (
          <span>Next: {formatRelativeTime(job.state.nextRunAtMs)}</span>
        )}
        {job.state.consecutiveErrors != null && job.state.consecutiveErrors > 0 && (
          <span className="cron-error-count">{job.state.consecutiveErrors} consecutive error{job.state.consecutiveErrors !== 1 ? 's' : ''}</span>
        )}
        {!job.state.lastRunAtMs && !job.state.nextRunAtMs && (
          <span>Never run</span>
        )}
      </div>
      {job.state.lastError && (
        <div className="cron-job-error text-xs">
          {job.state.lastError}
        </div>
      )}
    </div>
  );
}
