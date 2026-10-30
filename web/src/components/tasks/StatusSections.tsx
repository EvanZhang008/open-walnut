/**
 * StatusSections: the home task panel's status headings and the rows under the
 * ones the panel draws itself (Watching, Needs you, Waiting, Completed). Working
 * is the view's own list (tiers, Recent, projects), so TodoPanel draws only its
 * heading from here. The model (which task goes where, order, stored open state)
 * is status-sections.ts.
 *
 * The rows are plain cards: no drag, since a section's order is the state's own
 * (latest activity, soonest wake, latest completion), not a place the user keeps.
 */
import { memo, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { isBuiltinTier } from '@/api/focus';
import { useTaskCircle } from '@/hooks/useSessionStatus';
import { taskNeedsAction } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import * as ICONS from '../common/Icons';
import { NavigationChevron } from './NavigationSections';
import { TaskKebabMenu } from './TaskKebabMenu';
import { TaskStartButton } from './TaskStartButton';
import { SubtaskPill } from './SubtaskPill';
import { LeaderPill } from './LeaderPill';
import { AwaySyncMark } from './AwaySyncMark';
import { PhoneRowExtras } from './PhoneRowExtras';
import { phonePhaseAttrs } from './phone-row-behavior';
import { formatWaitUntil } from './TaskStatusControl';
import { formatStartDateDisplay } from '../common/DatePicker';
import { recentActivityTime, recentActivityTitle } from './recent-activity-time';
import {
  STATUS_SECTION_BATCH,
  STATUS_SECTION_LABELS,
  STATUS_SECTION_TITLES,
  projectRuns,
  type StateCounts,
  type StatusSectionKey,
  type StatusSectionsModel,
} from './status-sections';
import '@/styles/status-sections.css';

export const SECTION_ICONS: Record<StatusSectionKey, ReactNode> = {
  watching: ICONS.ICON_EYE,
  needs: ICONS.ICON_ATTENTION,
  working: ICONS.ICON_PHASE_IN_PROGRESS,
  waiting: ICONS.ICON_PHASE_WAITING,
  done: ICONS.ICON_PHASE_COMPLETE,
};

export function StatusSectionHeading({ sectionKey, count, open, onToggle, more }: {
  sectionKey: StatusSectionKey;
  count: number;
  /** More not counted yet (the unloaded archive under a chip): the count reads "N+". */
  more?: boolean;
  open: boolean;
  onToggle: (key: StatusSectionKey) => void;
}) {
  const label = STATUS_SECTION_LABELS[sectionKey];
  return (
    <div className={`navigation-heading todo-pinned-header status-section-heading status-section-${sectionKey}`} data-testid={`status-section-${sectionKey}`}>
      <button
        type="button"
        className="navigation-heading-open"
        aria-expanded={open}
        title={`${STATUS_SECTION_TITLES[sectionKey]}. Click to ${open ? 'collapse' : 'expand'}.`}
        onClick={() => onToggle(sectionKey)}
      >
        <span className="navigation-icon status-section-icon" aria-hidden="true">{SECTION_ICONS[sectionKey]}</span>
        <span className="navigation-label">{label}</span>
        <span className="status-section-count" data-testid={`status-section-${sectionKey}-count`}>{count}{more ? '+' : ''}</span>
        <NavigationChevron collapsed={!open} />
      </button>
    </div>
  );
}

/** The row callbacks a section card needs: the same handlers TodoPanel gives its own rows. */
export interface SectionRowHandlers {
  focusedTaskId?: string | null;
  suppressDetail?: boolean;
  openSessionTaskIds?: Set<string>;
  isPinned: (id: string) => boolean;
  tierOf: (id: string) => FocusTier | undefined;
  tierLabel: (tier: FocusTier) => string;
  /** The panel's view: a tier tab names the tier already, so its cards draw no tier glyph. */
  viewSection?: string;
  isVanishing: (task: Task) => boolean;
  onClick: (task: Task, e?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onSetPhase?: (id: string, phase: string) => void;
  onSetPriority?: (id: string, priority: string) => void;
  onSetDate?: (id: string, date: string | null) => void;
  onSetStartDate?: (id: string, date: string | null) => void;
  onPinTask?: (id: string) => void;
  onUnpinTask?: (id: string) => void;
  onSetTier?: (id: string, tier: FocusTier) => void;
  onExpandDetail?: (task: Task) => void;
  onClearFocus?: () => void;
  onOpenSession?: (sessionId: string) => void;
  onStartSession?: (task: Task) => void;
  onMoveToProject?: (taskId: string, project: string) => void;
  onDelete?: (id: string) => void;
  /** Fetch rows not loaded yet (the completed archive), asked by "Show more". */
  onLoadMore?: () => void;
}

const SectionCard = memo(function SectionCard({ task, sectionKey, handlers }: { task: Task; sectionKey: StatusSectionKey; handlers: SectionRowHandlers }) {
  const circleClass = useTaskCircle(task);
  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
  const needsAction = taskNeedsAction(task);
  const unread = !isDone && Boolean(task.unread);
  const isFocused = handlers.focusedTaskId === task.id;
  const isPinned = handlers.isPinned(task.id);
  const tier = isPinned ? handlers.tierOf(task.id) : undefined;
  const activity = recentActivityTime(task, 'updated');
  const ago = timeAgo(isDone && task.completed_at ? task.completed_at : activity.at);
  const vanishing = handlers.isVanishing(task);
  // Under Waiting / snoozed, a task that is not parked sleeps until its start date.
  const snoozedUntil = sectionKey === 'waiting' && task.phase !== 'WAITING' && task.start_date ? formatStartDateDisplay(task.start_date) : '';
  return (
    <div
      data-task-id={task.id}
      className={`todo-pinned-card status-section-card${isFocused ? ' todo-pinned-card-active' : ''}${needsAction ? ' todo-pinned-card-needs-action' : ''}${handlers.openSessionTaskIds?.has(task.id) ? ' todo-pinned-card-session-open' : ''}${isDone ? ' todo-pinned-card-done' : ''}${vanishing ? ' todo-card-vanishing' : ''}`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('.pinned-phase-picker')) return;
        handlers.onClick(task, e);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlers.onClick(task); } }}
    >
      {tier && tier !== handlers.viewSection && (
        <span
          className={`todo-recent-tier-dot todo-tier-icon-${isBuiltinTier(tier) ? tier : 'custom'}`}
          title={`Pinned in ${handlers.tierLabel(tier)}`}
        >
          {ICONS.tierIcon(tier)}
        </span>
      )}
      {unread ? (
        <span className="task-unread-dot" role="img" aria-label="Unread: agent output you haven't seen" title="Unread: click to open and mark read" />
      ) : needsAction && !isDone && (
        <span className="task-unread-dot task-attention-dot" role="img" aria-label="Needs your action" title="Needs your action" />
      )}
      {!isDone && <PhoneRowExtras task={task} needsAction={needsAction} />}
      <button
        className={`task-phase-icon-btn pinned-phase-picker ${circleClass}`}
        {...phonePhaseAttrs()}
        onClick={(e) => {
          e.stopPropagation();
          handlers.onSetPhase?.(task.id, isDone ? 'TODO' : 'COMPLETE');
        }}
        aria-label={isDone ? 'Reopen (mark To Do)' : 'Mark complete'}
        title={isDone ? 'Done: click to reopen' : task.phase === 'WAITING' ? 'Waiting: click to complete' : 'Click to complete'}
      >
        {ICONS.binaryPhaseIcon(isDone, task.phase)}
      </button>
      <span className={`todo-pinned-title${task.walnut_agent ? ' walnut-task-title' : ''}`} title={task.title}>{task.title}</span>
      <SubtaskPill task={task} />
      <LeaderPill task={task} />
      <AwaySyncMark item={task} />
      {snoozedUntil ? (
        <span className="todo-item-due-pill todo-item-start-pill" title={`Snoozed: starts ${task.start_date}`}>▶︎ {snoozedUntil}</span>
      ) : task.phase === 'WAITING' && task.wait_until && !isDone ? (
        <span
          className="todo-item-due-pill todo-item-wait-pill"
          data-testid="task-row-wait-until"
          title={`Waiting until ${new Date(task.wait_until).toLocaleString()}, or until something happens first`}
        >
          until {formatWaitUntil(task.wait_until)}
        </span>
      ) : ago ? (
        <span className="todo-recent-ago" title={isDone && task.completed_at ? `Completed ${new Date(task.completed_at).toLocaleString()}` : recentActivityTitle(activity)}>{ago}</span>
      ) : null}
      <TaskStartButton task={task} isDone={isDone} onStartSession={handlers.onStartSession} />
      <TaskKebabMenu
        task={task}
        isFocused={isFocused}
        isDetailOpen={isFocused && !handlers.suppressDetail}
        isPinned={isPinned}
        pinnedTier={tier}
        isDone={isDone}
        onExpandDetail={handlers.onExpandDetail}
        onClearFocus={handlers.onClearFocus}
        onSetPriority={handlers.onSetPriority}
        onSetDate={handlers.onSetDate}
        onSetStartDate={handlers.onSetStartDate}
        onPinTask={handlers.onPinTask}
        onUnpinTask={handlers.onUnpinTask}
        onSetTier={handlers.onSetTier}
        onOpenSession={handlers.onOpenSession}
        onStartSession={handlers.onStartSession}
        onMoveToProject={handlers.onMoveToProject}
        onDelete={handlers.onDelete}
        onSetPhase={handlers.onSetPhase}
      />
    </div>
  );
});

/** One section's rows: project labels when it spans two or more projects, then a "Show more" row. */
export function SectionRows({ sectionKey, tasks, total, handlers, archiveLeft }: {
  sectionKey: StatusSectionKey;
  tasks: readonly Task[];
  /** The section's full count (Completed includes tasks not loaded yet). */
  total: number;
  handlers: SectionRowHandlers;
  /** Completed only: older tasks not loaded and not counted (a chip narrows the view). */
  archiveLeft?: boolean;
}) {
  const [asked, setAsked] = useState(false);
  const [shown, setShown] = useState(STATUS_SECTION_BATCH);
  const head = tasks.slice(0, shown);
  const runs = projectRuns(head);
  const labelled = runs.length > 1;
  const more = Math.max(0, total - head.length);
  // Every loaded row is out: the rest is the archive, fetched only now (not on open).
  const unloaded = head.length >= tasks.length;
  return (
    <div className="todo-pinned-list status-section-list" data-testid={`status-section-${sectionKey}-rows`}>
      {runs.map((run) => (
        <div key={run.project} className="status-section-run">
          {labelled && (
            <div className="tier-project-label recent-project-label status-section-project" data-project={run.project}>
              <span className="tier-project-label-name">{run.project || 'Inbox'}</span>
              <span className="tier-project-label-count" aria-hidden="true">{run.tasks.length}</span>
            </div>
          )}
          {run.tasks.map((task) => <SectionCard key={task.id} task={task} sectionKey={sectionKey} handlers={handlers} />)}
        </div>
      ))}
      {more > 0 && (
        <button
          type="button"
          className="status-section-more"
          data-testid={`status-section-${sectionKey}-more`}
          disabled={unloaded && !handlers.onLoadMore}
          onClick={() => { if (unloaded) handlers.onLoadMore?.(); setShown((n) => n + STATUS_SECTION_BATCH); }}
        >
          {`Show ${Math.min(more, STATUS_SECTION_BATCH)} more`}
        </button>
      )}
      {archiveLeft && handlers.onLoadMore && (
        <button
          type="button"
          className="status-section-more"
          data-testid={`status-section-${sectionKey}-older`}
          disabled={asked}
          onClick={() => { setAsked(true); handlers.onLoadMore?.(); }}
        >
          {asked ? 'Loading older completed tasks…' : 'Show older completed tasks'}
        </button>
      )}
    </div>
  );
}

/** Rows a section holds in the model, and the count its heading shows. */
export function sectionRowsOf(model: StatusSectionsModel, key: StatusSectionKey): { tasks: Task[]; count: number } {
  switch (key) {
    case 'watching': return { tasks: model.watching, count: model.watching.length };
    case 'needs': return { tasks: model.needs, count: model.needs.length };
    case 'waiting': return { tasks: model.waiting, count: model.waiting.length };
    case 'done': return { tasks: model.done, count: model.done.length + model.doneUnloaded };
    default: return { tasks: [], count: model.workingCount };
  }
}

/** A run of sections the panel draws itself; an empty one draws nothing. */
export function StatusSectionGroup({ keys, model, open, onToggle, handlers }: {
  keys: readonly StatusSectionKey[];
  model: StatusSectionsModel;
  open: Record<StatusSectionKey, boolean>;
  onToggle: (key: StatusSectionKey) => void;
  handlers: SectionRowHandlers;
}) {
  return (
    <>
      {keys.map((key) => {
        const { tasks, count } = sectionRowsOf(model, key);
        // Completed with older tasks still unloaded stays reachable, even at 0 loaded.
        const archiveLeft = key === 'done' && model.archiveLeft;
        if (count === 0 && !archiveLeft) return null;
        return (
          <section key={key} className={`status-section status-section-block-${key}`} aria-label={STATUS_SECTION_LABELS[key]}>
            <StatusSectionHeading sectionKey={key} count={count} open={open[key]} onToggle={onToggle} more={archiveLeft} />
            {open[key] && <SectionRows sectionKey={key} tasks={tasks} total={count} handlers={handlers} archiveLeft={archiveLeft} />}
          </section>
        );
      })}
    </>
  );
}

const COUNT_WORDS: Record<'needs' | 'waiting' | 'done', [string, string]> = {
  needs: ['needs you', 'need you'],
  waiting: ['waiting or snoozed', 'waiting or snoozed'],
  done: ['completed', 'completed'],
};

/**
 * A project heading's status counts, after its own number (the rows the list draws
 * under Working): the project's tasks in the other sections, with the sections'
 * own glyphs. Zero counts draw nothing, so a project with only working rows reads
 * as before.
 */
export function ProjectStatusCounts({ counts }: { counts: StateCounts | undefined }) {
  if (!counts) return null;
  const parts = (['needs', 'waiting', 'done'] as const).filter((k) => counts[k] > 0);
  if (parts.length === 0) return null;
  const title = [`${counts.working} working`, ...parts.map((k) => `${counts[k]} ${COUNT_WORDS[k][counts[k] === 1 ? 0 : 1]}`)].join(', ');
  return (
    <span className="project-status-counts" title={title} aria-label={title} data-testid="project-status-counts">
      {parts.map((k) => (
        <span key={k} className={`project-status-count project-status-count-${k}`}>
          <span className="project-status-count-icon" aria-hidden="true">{SECTION_ICONS[k]}</span>
          {counts[k]}
        </span>
      ))}
    </span>
  );
}
