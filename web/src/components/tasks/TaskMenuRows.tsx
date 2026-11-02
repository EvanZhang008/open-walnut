/**
 * The task half of every task ⋮ menu, defined once (2026-11-02, the user: "make the drop
 * down consistent for both on the side bar or in session"). The board's row menu
 * (TaskKebabMenu: Home's task panel and its status sections, the Focus cards, the Tasks
 * table) and the session panel's menu (TaskQuickActions) both render THIS list, in this
 * order; tests/web/task-menu-one-definition.test.ts fails on a menu that renders these
 * rows itself.
 *
 * A row differs between the two only where its surface lacks the thing it acts on, and
 * each such row says so below: Start Session (a session menu's task already has one),
 * Select… and the list moves (only a list has a selection and an order), Quote in
 * session (pointless into the task's own session).
 *
 * Every move of the task's work sits under ONE row, Move & transfer (the user: "transfer
 * host or task don't matter all under same top tab"): its project, its host, a transfer
 * to another engine or host, its place in the list, and the service it syncs to. Team
 * (leading and adopting) is not a move and keeps its own row.
 */
import type { ReactNode, CSSProperties } from 'react';
import type { Task } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import * as ICONS from '../common/Icons';
import { getIntegrationMeta, useIntegrations } from '@/hooks/useIntegrations';
import { resolveTaskSessionId } from '@/utils/session-status';
import { useActiveSessionId } from '@/stores/active-session';
import { KebabGroup } from '@/components/sessions/KebabGroup';
import { datesHint } from '@/components/sessions/kebab-dates-hint';
import { MoveToProjectSection, TaskActionMenuItems, TaskSnoozeRow } from './TaskKebabMenu';
import { TaskStatusMenuSection } from './TaskStatusControl';
import { WatchMenuItem } from './WatchToggle';
import { QuoteInSessionItem } from './QuoteInSessionItem';
import { TeamMenuItems } from './TeamMenuItems';
import { TaskSyncMenuRows } from './TaskSyncMenuRows';
import { PluginFieldsSection } from './PluginFieldPicker';
import { MoveHostMenuItems } from '@/components/transfer/MoveHostMenuItems';
import { TransferMenuItem } from '@/components/transfer/TransferMenuItem';
import { WorkspaceMenuSection } from '@/components/workspaces/WorkspaceMenuSection';
import { hasMemoryAndInstructions } from '@/components/org/AgentMemoryPanel';

/** The list half: what only a task LIST can do with its row. */
export interface TaskMenuListActions {
  onStartSelect?: (id: string) => void;
  onUnparent?: (id: string) => void;
  onMoveUp?: (id: string) => void;
  onMoveDown?: (id: string) => void;
  onUngroup?: (id: string) => void;
  isGroupHidden?: boolean;
  onUnhideGroup?: (groupId: string) => void;
}

export interface TaskMenuRowsProps {
  task: Task & { has_synced?: boolean; ms_todo_id?: string };
  isPinned: boolean;
  pinnedTier?: FocusTier | null;
  /** The host's own reading of done; default the task's phase. */
  isDone?: boolean;
  /** Close the host menu. */
  close: () => void;
  onSetStartDate?: (date: string | null) => void;
  onSetDate?: (date: string | null) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onSetWaitUntil?: (id: string, waitUntil: string) => void;
  onSetPriority?: (priority: string) => void;
  onPinTask?: () => void;
  onUnpinTask?: () => void;
  onSetTier?: (tier: FocusTier) => void;
  onMoveToProject?: (project: string) => void;
  /** The task's details: open (or close, when `open`). */
  detail?: { open?: boolean; onToggle: () => void };
  /** Main's, a lead's or a VP's Memory & instructions. */
  onOpenMemory?: () => void;
  /** A task with no session yet. */
  onStartSession?: () => void;
  list?: TaskMenuListActions;
  onDelete?: () => void;
  /** The phone's short menu: snooze, watch, details and status only. */
  phoneMenu?: boolean;
}

function Item({ icon, children, onClick, className, testId }: {
  icon: ReactNode; children: ReactNode; onClick: () => void; className?: string; testId?: string;
}) {
  return (
    <button
      type="button"
      className={`task-kebab-item${className ? ` ${className}` : ''}`}
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >
      <span className="task-kebab-icon">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

export function TaskMenuRows(p: TaskMenuRowsProps) {
  const { task, close, list } = p;
  const integrations = useIntegrations();
  const activeSessionId = useActiveSessionId();
  const isDone = p.isDone ?? (task.status === 'done' || task.phase === 'COMPLETE');
  const ownSession = resolveTaskSessionId(task);
  const act = (fn: () => void) => () => { fn(); close(); };

  return (
    <>
      {p.onSetStartDate && <TaskSnoozeRow task={task} onSetStartDate={p.onSetStartDate} afterAction={close} />}
      <WatchMenuItem task={task} afterAction={close} />
      {/* A session menu's task already has its session: the row would launch a second one. */}
      {p.onStartSession && !isDone && !ownSession && (
        <Item icon="▶︎" onClick={act(p.onStartSession)}>Start Session</Item>
      )}
      {p.detail && (
        <Item icon={ICONS.ICON_INFO} onClick={act(p.detail.onToggle)} className={p.detail.open ? 'task-kebab-item-active' : undefined}>
          {p.detail.open ? 'Close details' : 'Details'}
        </Item>
      )}
      {p.onOpenMemory && hasMemoryAndInstructions(task) && (
        <Item icon={ICONS.ICON_NOTE} onClick={act(p.onOpenMemory)} testId="kebab-memory-instructions">Memory &amp; instructions</Item>
      )}
      {/* Quoting a task into its own session hands it what it already is. */}
      {!p.phoneMenu && !(activeSessionId && activeSessionId === ownSession) && <QuoteInSessionItem task={task} onDone={close} />}
      {/* Only a list has a selection to start. */}
      {!p.phoneMenu && list?.onStartSelect && (
        <Item icon="☑" onClick={act(() => list.onStartSelect!(task.id))}>Select…</Item>
      )}

      <TaskStatusMenuSection task={task} onSetPhase={p.onSetPhase} onSetWaitUntil={p.onSetWaitUntil} afterAction={close} />

      {!p.phoneMenu && (<>
        <TaskActionMenuItems
          task={task}
          part="pin"
          isPinned={p.isPinned}
          pinnedTier={p.pinnedTier}
          isDone={isDone}
          onSetPriority={p.onSetPriority}
          onPinTask={p.onPinTask}
          onUnpinTask={p.onUnpinTask}
          onSetTier={p.onSetTier}
          afterAction={close}
        />

        {(p.onSetStartDate || p.onSetDate) && (<>
          <div className="task-kebab-divider" />
          <KebabGroup label="Dates" hint={datesHint(task)} icon={ICONS.ICON_CALENDAR} testId="kebab-group-dates">
            <TaskActionMenuItems
              task={task}
              part="dates"
              isPinned={p.isPinned}
              pinnedTier={p.pinnedTier}
              isDone={isDone}
              onSetDate={p.onSetDate}
              onSetStartDate={p.onSetStartDate}
              afterAction={close}
              startLabel="Start"
            />
          </KebabGroup>
        </>)}

        <KebabGroup label="Move & transfer" hint="project · host · engine · source" icon={ICONS.ICON_FOLDER_OUTLINE} testId="kebab-group-move">
          {p.onMoveToProject && <MoveToProjectSection current={task.project || ''} onMove={p.onMoveToProject} afterAction={close} />}
          <MoveHostMenuItems task={task} afterAction={close} />
          <TransferMenuItem task={task} afterAction={close} />
          <ListMoves task={task} list={list} close={close} />
          <TaskSyncMenuRows task={task} afterAction={close} />
          <TaskSourceRow task={task} integrations={integrations} afterAction={close} />
        </KebabGroup>

        <TeamMenuItems task={task} afterAction={close} />

        {/* A sync that failed or has not happened yet needs to be seen, outside the group. */}
        <TaskSyncWarning task={task} integrations={integrations} />

        {list?.onUnhideGroup && task.group_id && list.isGroupHidden && (
          <Item icon="⊙" onClick={act(() => list.onUnhideGroup!(task.group_id!))}>Unhide folder in Focus</Item>
        )}

        {/* Plugin-declared task fields (manifest taskFields), e.g. a tracker's Sprint. */}
        <PluginFieldsSection task={task} afterAction={close} />
        {/* The task's isolated workspace: details, Retry, Remove workspace… */}
        <WorkspaceMenuSection task={task} afterAction={close} />

        {p.onDelete && (<>
          <div className="task-kebab-divider" />
          <Item icon={ICONS.ICON_TRASH} onClick={act(p.onDelete)} className="task-kebab-item-danger">Delete</Item>
        </>)}
      </>)}
    </>
  );
}

/** The list's own moves (only a list has an order and folders): left out of a parent, up, down, out of a folder. */
function ListMoves({ task, list, close }: { task: Task; list?: TaskMenuListActions; close: () => void }) {
  if (!list) return null;
  const row = (icon: string, label: string, fn: (id: string) => void) => (
    <Item key={label} icon={icon} onClick={() => { fn(task.id); close(); }}>{label}</Item>
  );
  return (
    <>
      {list.onUnparent && task.parent_task_id && row('←', 'Move left', list.onUnparent)}
      {list.onMoveUp && row('↑', 'Move up', list.onMoveUp)}
      {list.onMoveDown && row('↓', 'Move down', list.onMoveDown)}
      {list.onUngroup && task.group_id && row('⑂', 'Remove from folder', list.onUngroup)}
    </>
  );
}

type IntegrationList = ReturnType<typeof useIntegrations>;
type SourceTask = Task & { has_synced?: boolean; ms_todo_id?: string };

function sourceFacts(task: SourceTask, integrations: IntegrationList) {
  const sourceMeta = task.source ? getIntegrationMeta(integrations, task.source) : undefined;
  const local = task.source === 'local';
  // has_synced is the server-precomputed `!!task.ext?.[task.source]` for the minimal list
  // payload (ext is dropped there); ms_todo_id is the pre-ext marker of that one source.
  const synced = !!task.source && !local && (
    !!task.ext?.[task.source] || !!task.has_synced || (task.source === 'ms-todo' && !!task.ms_todo_id)
  );
  return {
    badge: local ? 'L' : (sourceMeta?.badge ?? task.source?.charAt(0).toUpperCase()),
    name: local ? 'Local' : (sourceMeta?.name ?? task.source ?? 'external'),
    badgeColor: sourceMeta?.badgeColor,
    status: task.sync_error ? 'sync error' : synced || local || !task.source ? '' : 'unsynced',
  };
}

/** The source badge's colours: the integration's own, grey for a local task, none on a sync error. */
function badgeStyle(task: Task, badgeColor: string | undefined): CSSProperties | undefined {
  if (task.sync_error) return undefined;
  if (badgeColor) return { background: badgeColor, color: 'white' };
  return task.source === 'local' ? { background: '#8E8E93', color: 'white' } : undefined;
}

/** Where the task comes from, inside Move & transfer (its sync trouble is TaskSyncWarning's): "Open in <service> ↗" when it mirrors
 *  a synced item with a link, else the source's name ("Local", the integration's). */
function TaskSourceRow({ task, integrations, afterAction }: { task: SourceTask; integrations: IntegrationList; afterAction: () => void }) {
  if (!task.source && !task.external_url) return null;
  const f = sourceFacts(task, integrations);
  if (!task.external_url) {
    return (
      <div className="task-kebab-item task-kebab-info" data-testid="kebab-source-row">
        <span className="task-source-badge" style={badgeStyle(task, f.badgeColor)}>{task.sync_error ? '!' : f.badge}</span>
        {/* A broken or pending sync says so on its own first-level row (TaskSyncWarning). */}
        <span>{f.name}</span>
      </div>
    );
  }
  return (
    <a
      className="task-kebab-item task-kebab-info"
      href={task.external_url}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="kebab-source-link"
      onClick={(e) => { e.stopPropagation(); afterAction(); }}
    >
      {task.source && <span className="task-source-badge" style={badgeStyle(task, f.badgeColor)}>{f.badge}</span>}
      <span>Open in {f.name}</span>
      <span className="task-kebab-external-arrow">↗</span>
    </a>
  );
}

/** The one source fact that earns a first-level row: the sync is broken or pending. */
function TaskSyncWarning({ task, integrations }: { task: SourceTask; integrations: IntegrationList }) {
  const f = sourceFacts(task, integrations);
  if (!f.status) return null;
  return (
    <div className="task-kebab-item task-kebab-info" data-testid="kebab-sync-warning">
      <span className="task-source-badge" style={badgeStyle(task, f.badgeColor)}>{task.sync_error ? '!' : f.badge}</span>
      <span>{f.name} ({f.status})</span>
    </div>
  );
}
