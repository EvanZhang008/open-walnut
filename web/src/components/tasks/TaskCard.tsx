import type { MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { PriorityBadge } from '../common/PriorityBadge';
import { StarButton } from '../common/StarButton';
import { TagChip } from './TagChip';
import { TaskSessionPill } from './SessionPill';
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { useConfirm } from '@/hooks/useConfirm';
import { ICON_TRASH } from '../common/Icons';

type TaskListProjection = Task & {
  /** Precomputed by fields=list because that projection intentionally omits ext. */
  has_synced?: boolean;
  /** Legacy MS To-Do sync marker retained for pre-ext task records. */
  ms_todo_id?: string;
};

/** Virtual-group render metadata for a card (mirrors TodoPanel's GroupRenderInfo). */
export interface CardGroupInfo {
  groupId: string;
  label: string;
  isLead: boolean;
  isLast: boolean;
}

interface TaskCardProps {
  task: TaskListProjection;
  onComplete: (id: string) => void;
  onStar: (id: string) => void;
  onDelete?: (id: string) => void;
  childStats?: { done: number; total: number };
  /** Virtual-group treatment: tinted rail on every member, chip above the lead. */
  groupInfo?: CardGroupInfo;
  /** True while this card is part of an in-progress multi-select. */
  isSelected?: boolean;
  /** Modifier-click toggles selection instead of navigating. */
  onSelectToggle?: (taskId: string) => void;
  /** Rename the whole group (chip click). */
  onRenameGroup?: (groupId: string, currentLabel: string) => void;
  /** Remove this task from its group (kebab/affordance). */
  onUngroup?: (taskId: string) => void;
}

/** Check if a task is synced to its integration (ext first, then legacy fields). */
function isSynced(task: TaskListProjection): boolean {
  const source = task.source;
  if (task.has_synced) return true;
  // Check ext (new plugin system)
  if (task.ext?.[source]) return true;
  // Backward compat: check the legacy field from before ext migration.
  return source === 'ms-todo' && Boolean(task.ms_todo_id);
}

function SyncIndicator({ task }: { task: TaskListProjection }) {
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

  const badge = meta?.badge ?? (source ? source.charAt(0).toUpperCase() : '?');
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

export function TaskCard({ task, onComplete, onStar, onDelete, childStats, groupInfo, isSelected, onSelectToggle, onRenameGroup, onUngroup }: TaskCardProps) {
  const navigate = useNavigate();
  const confirm = useConfirm();

  const className = [
    'task-card',
    task.phase === 'COMPLETE' ? 'task-card-done' : '',
    groupInfo ? 'task-grouped' : '',
    groupInfo?.isLead ? 'task-group-lead' : '',
    groupInfo?.isLast ? 'task-group-last' : '',
    isSelected ? 'task-multi-selected' : '',
  ].filter(Boolean).join(' ');

  // Modifier-click builds a multi-selection; a plain click opens the task.
  const handleCardClick = (e: MouseEvent) => {
    if (onSelectToggle && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      e.preventDefault();
      onSelectToggle(task.id);
      return;
    }
    navigate(`/tasks/${task.id}`);
  };

  return (
    <>
    {/* Group header chip — only above the lead member; names the whole cluster. */}
    {groupInfo?.isLead && (
      <div
        className="task-group-chip"
        title="Forked / grouped tasks — independent tasks shown together"
      >
        <span className="task-group-chip-icon" aria-hidden="true">⑂</span>
        <span
          className="task-group-chip-label"
          onClick={(e) => { e.stopPropagation(); onRenameGroup?.(groupInfo.groupId, groupInfo.label); }}
          title="Rename group"
        >
          {groupInfo.label}
        </span>
      </div>
    )}
    <div
      className={className}
      data-task-id={task.id}
      data-group-id={groupInfo?.groupId}
      onClick={handleCardClick}
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

      {groupInfo && onUngroup && (
        <button
          className="task-ungroup-btn"
          onClick={(e) => { e.stopPropagation(); onUngroup(task.id); }}
          aria-label="Remove from group"
          title="Remove from group"
        >
          ⑂
        </button>
      )}

      {onDelete && (
        <button
          className="task-delete-btn"
          onClick={async (e) => {
            e.stopPropagation();
            if (await confirm({ title: `Delete task “${task.title}”?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) {
              onDelete(task.id);
            }
          }}
          aria-label="Delete task"
          title="Delete task"
        >
          {ICON_TRASH}
        </button>
      )}

      <div className="task-card-body">
        <span className="task-card-title">
          {task.title}
          <SyncIndicator task={task} />
        </span>
        <div className="task-card-meta">
          <PriorityBadge priority={task.priority} />
          <TaskSessionPill task={task} />
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
          {!!childStats?.total && (
            <span className="task-card-subtasks text-xs text-muted">
              {childStats.done}/{childStats.total}
            </span>
          )}
        </div>
      </div>
    </div>
    </>
  );
}

function formatDue(iso: string): string {
  const d = new Date(iso);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}/${day}`;
}
