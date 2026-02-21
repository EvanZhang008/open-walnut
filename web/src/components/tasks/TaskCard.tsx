import { useNavigate } from 'react-router-dom';
import type { Task } from '@walnut/core';
import { PriorityBadge } from '../common/PriorityBadge';
import { StarButton } from '../common/StarButton';
import { TagChip } from './TagChip';
import { SessionPill } from './SessionPill';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';

interface TaskCardProps {
  task: Task;
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
}

/** Legacy field lookup for backward compat before ext migration. */
const LEGACY_SYNC_FIELDS: Record<string, string> = {
  'ms-todo': 'ms_todo_id',
};

/** Check if a task is synced to its integration (ext first, then legacy fields). */
function isSynced(task: Task): boolean {
  const source = task.source;
  // Check ext (new plugin system)
  if (task.ext?.[source]) return true;
  // Backward compat: check legacy dynamic fields
  const legacyField = LEGACY_SYNC_FIELDS[source];
  if (legacyField && (task as unknown as Record<string, unknown>)[legacyField]) return true;
  return false;
}

function SyncIndicator({ task }: { task: Task }) {
  const integrations = useIntegrations();
  const source = task.source;
  const meta = getIntegrationMeta(integrations, source);

  // Local tasks — no sync
  if (source === 'local') {
    return (
      <span
        className="sync-indicator sync-local"
        title="Local only — not synced to any service"
      >
        L
      </span>
    );
  }

  const badge = meta?.badge ?? source.charAt(0).toUpperCase();
  const badgeColor = meta?.badgeColor;
  const integrationName = meta?.name ?? source;

  // Sync error state
  if (task.sync_error) {
    return (
      <span
        className="sync-indicator sync-error"
        title={`Sync error: ${task.sync_error}`}
      >
        {badge}
      </span>
    );
  }

  const synced = isSynced(task);
  return (
    <span
      className={`sync-indicator ${synced ? 'sync-synced' : 'sync-unsynced'}`}
      style={synced && badgeColor ? { background: badgeColor } : undefined}
      title={synced ? `Synced to ${integrationName}` : `Not synced to ${integrationName} — will retry`}
    >
      {synced ? badge : '\u23F3'}
    </span>
  );
}

export function TaskCard({ task, onComplete, onStar }: TaskCardProps) {
  const navigate = useNavigate();
  const subtasksDone = task.subtasks?.filter((s) => s.done).length ?? 0;
  const subtasksTotal = task.subtasks?.length ?? 0;

  return (
    <div
      className={`task-card${task.phase === 'COMPLETE' ? ' task-card-done' : ''}`}
      onClick={() => navigate(`/tasks/${task.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/tasks/${task.id}`); }}
    >
      <button
        className="task-checkbox"
        onClick={(e) => {
          e.stopPropagation();
          onComplete(task.id);
        }}
        aria-label={task.phase === 'COMPLETE' ? 'Reopen' : 'Complete'}
      >
        {task.phase === 'COMPLETE' ? '\u25CF' : '\u25CB'}
      </button>

      <StarButton starred={!!task.starred} onClick={() => onStar(task.id)} />

      <div className="task-card-body">
        <span className="task-card-title">
          {task.title}
          <SyncIndicator task={task} />
        </span>
        <div className="task-card-meta">
          <PriorityBadge priority={task.priority} />
          <SessionPill
            sessionId={task.session_id}
            sessionStatus={task.session_status}
            planSessionId={task.plan_session_id}
            execSessionId={task.exec_session_id}
            planStatus={task.plan_session_status}
            execStatus={task.exec_session_status}
            sessionIds={task.session_ids}
            mode={task.session_status?.mode ?? task.plan_session_status?.mode}
          />
          <span className="task-card-project text-xs text-muted">{task.project}</span>
          {task.tags && task.tags.length > 0 && (
            <span className="task-card-tags">
              {task.tags.slice(0, 2).map(tag => (
                <TagChip key={tag} tag={tag} inline />
              ))}
              {task.tags.length > 2 && (
                <span className="tag-chip tag-chip-overflow">+{task.tags.length - 2}</span>
              )}
            </span>
          )}
          {task.due_date && (
            <span className="task-card-due text-xs text-muted">{formatDue(task.due_date)}</span>
          )}
          {subtasksTotal > 0 && (
            <span className="task-card-subtasks text-xs text-muted">
              {subtasksDone}/{subtasksTotal}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}
