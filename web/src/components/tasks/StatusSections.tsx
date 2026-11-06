/**
 * StatusSections: the home task panel's status headings and the rows under the
 * ones the panel draws itself (Watching, Needs you, Waiting, Completed). Working
 * is the view's own list (tiers, Recent, projects), so TodoPanel draws only its
 * heading from here. The model (which task goes where, order) is status-sections.ts; when a
 * section opens and folds is section-fold-rule.ts, read through useFoldStore by the drawer.
 *
 * The rows are plain cards: no drag, since a section's order is the state's own
 * (latest activity, soonest wake, latest completion), not a place the user keeps.
 */
import { memo, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { FocusTier } from '@/api/focus';
import { isBuiltinTier } from '@/api/focus';
import { useTaskCircle } from '@/hooks/useSessionStatus';
import { taskNeedsAction, taskUserState } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import * as ICONS from '../common/Icons';
import { NavigationChevron } from './NavigationSections';
import { TaskKebabMenu } from './TaskKebabMenu';
import { TaskStartButton } from './TaskStartButton';
import { useInlineTitleEdit } from './useInlineTitleEdit';
import { SubtaskPill } from './SubtaskPill';
import { LeaderPill } from './LeaderPill';
import { AwaySyncMark } from './AwaySyncMark';
import { PhoneRowExtras } from './PhoneRowExtras';
import { RowProjectName } from './RowProjectName';
import { isPhoneLayout, phonePhaseAttrs } from './phone-row-behavior';
import { formatWaitUntil } from './TaskStatusControl';
import { formatStartDateDisplay } from '../common/DatePicker';
import { recentActivityTime, recentActivityTitle } from './recent-activity-time';
import {
  STATUS_SECTION_BATCH,
  STATUS_SECTION_LABELS,
  statusFoldTooltip,
  type StatusSectionKey,
  type StatusSectionsModel,
  needsLine,
  waitingReason,
  waitingHover,
} from './status-sections';
import { ApprovalRows, usePendingApprovals } from '../approvals/ApprovalRow';
import { FOLD_KEY_ATTR } from './section-fold-rule';
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
    <div className={`navigation-heading navigation-heading-divider todo-pinned-header status-section-heading status-section-${sectionKey}`} data-testid={`status-section-${sectionKey}`}>
      <button
        type="button"
        className="navigation-heading-open"
        aria-expanded={open}
        title={statusFoldTooltip(sectionKey, open)}
        onClick={() => onToggle(sectionKey)}
      >
        {/* Each section's own mark (an eye, a red ring, an hourglass...), so Watching and
            Waiting never read alike (2026-10-31, the user: "watching vs waiting ... mixed"). */}
        <span className="status-section-heading-icon" aria-hidden="true">{SECTION_ICONS[sectionKey]}</span>
        <span className="navigation-label">{label}</span>
        <span className="navigation-heading-count status-section-count" data-testid={`status-section-${sectionKey}-count`}>{count}{more ? '+' : ''}</span>
        <span className="navigation-heading-rule" aria-hidden="true" />
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
  /** Flat's two-line rows (the project and its tags above the title); elsewhere one line. */
  twoLine?: boolean;
  isVanishing: (task: Task) => boolean;
  onClick: (task: Task, e?: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void;
  onSetPhase?: (id: string, phase: string) => void;
  /** Rename from the row (double-click the title), as on every other task row. */
  onUpdateTitle?: (id: string, title: string) => void;
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
  /** A click on a row's project name: show every task of that project (project-jump.ts). */
  onFilterProject?: (project: string) => void;
  /** Fetch rows not loaded yet (the completed archive), asked by "Show more". */
  onLoadMore?: () => void;
}

const SectionCard = memo(function SectionCard({ task, sectionKey, handlers, twoLine }: { task: Task; sectionKey: StatusSectionKey; handlers: SectionRowHandlers; twoLine: boolean }) {
  const circleClass = useTaskCircle(task);
  // On a phone a title tap opens the row, as on a list row (phone-row-behavior.ts).
  const edit = useInlineTitleEdit(task, handlers.onUpdateTitle, { doubleClick: !isPhoneLayout() });
  const isDone = task.status === 'done' || task.phase === 'COMPLETE';
  const needsAction = taskNeedsAction(task);
  const unread = !isDone && Boolean(task.unread);
  const isFocused = handlers.focusedTaskId === task.id;
  const isPinned = handlers.isPinned(task.id);
  const tier = isPinned ? handlers.tierOf(task.id) : undefined;
  const activity = recentActivityTime(task, 'updated');
  const ago = timeAgo(isDone && task.completed_at ? task.completed_at : activity.at);
  const vanishing = handlers.isVanishing(task);
  // Under Waiting / snoozed: the date the shared status says it sleeps until (its own start
  // date or an ancestor's); a task the server has not derived yet reads its own start date.
  const snoozeDate = sectionKey !== 'waiting' ? ''
    : task.user_status ? task.user_status.snoozed?.until ?? ''
    : task.phase !== 'WAITING' ? task.start_date ?? '' : '';
  const snoozedUntil = snoozeDate ? formatStartDateDisplay(snoozeDate) : '';
  // Under Waiting / snoozed: why it waits (not started, stopped, a watch, ...). Under Needs you:
  // what to do with it, then what it asks or has to read (2026-11-03, the user: "thridline cna
  // show what need u", "in one line").
  const need = isDone || sectionKey !== 'needs' ? null : needsLine(task);
  const reasonText = isDone ? '' : sectionKey === 'waiting' ? waitingReason(task, formatWaitUntil)
    : need ? [need.label, need.text].filter(Boolean).join(': ') : '';
  // Flat: the sentence of what it waits on is a third line under the title, so the top line
  // keeps only the project, its tags and the wake time (2026-11-02, the user: the sentence cut
  // the top line short). "Snoozed" is a label, not a sentence: it stays up top, no third line.
  const reasonBelow = twoLine && reasonText !== '' && reasonText !== 'Snoozed';
  const reason = need ? (
    <span className={`status-card-reason status-card-needs-line${reasonBelow ? ' status-card-wait-line' : ''}`} data-testid="status-card-needs-line" data-category={need.category} title={reasonText}>
      <span className={`needs-category needs-category-${need.category}`}>{need.label}{need.text ? ':' : ''}</span>
      {need.text ? <span className="needs-line-text">{need.text}</span> : null}
      {need.category === 'close' && handlers.onSetPhase ? (
        <button
          type="button"
          className="needs-close-btn"
          data-testid="needs-close"
          title="Mark it complete"
          onClick={(e) => { e.stopPropagation(); handlers.onSetPhase?.(task.id, 'COMPLETE'); }}
          onKeyDown={(e) => e.stopPropagation()}
        >Close</button>
      ) : null}
    </span>
  ) : reasonText ? (
    <span className={`status-card-reason${reasonBelow ? ' status-card-wait-line' : ''}`} data-testid="status-card-reason" title={sectionKey === 'waiting' ? waitingHover(task, formatWaitUntil) : reasonText}>{reasonText}</span>
  ) : null;
  // The same rename as every task row: double-click the title (useInlineTitleEdit).
  const title = (
    <span
      {...edit.titleProps}
      className={`todo-pinned-title${edit.isEditing ? ' editing' : ''}${task.walnut_agent ? ' walnut-task-title' : ''}`}
      title={task.title}
      onClick={edit.isEditing ? (e) => e.stopPropagation() : undefined}
    >{task.title}</span>
  );
  const pills = (
    <>
      <SubtaskPill task={task} />
      <LeaderPill task={task} />
      <AwaySyncMark item={task} />
    </>
  );
  const wake = snoozedUntil ? (
    <span className="todo-item-due-pill todo-item-start-pill" title={`Snoozed: starts ${snoozeDate}`}>▶︎ {snoozedUntil}</span>
  ) : task.phase === 'WAITING' && task.wait_until && !isDone ? (
    <span
      className="todo-item-due-pill todo-item-wait-pill"
      data-testid="task-row-wait-until"
      title={`${!twoLine && reasonText ? `${reasonText}. ` : ''}Waiting until ${new Date(task.wait_until).toLocaleString()}, or until something happens first`}
    >
      {/* One line (a project's folds) is narrow: a time today needs no "Today", the title keeps the room. */}
      until {twoLine ? formatWaitUntil(task.wait_until) : formatWaitUntil(task.wait_until).replace(/^Today /, '')}
    </span>
  ) : null;
  const inlineReason = twoLine || (wake && !need && reasonText !== 'Snoozed') ? null : reason;
  const agoEl = ago ? (
    <span className="todo-recent-ago" title={isDone && task.completed_at ? `Completed ${new Date(task.completed_at).toLocaleString()}` : recentActivityTitle(activity)}>{ago}</span>
  ) : null;
  return (
    <div
      data-task-id={task.id}
      className={`todo-pinned-card status-section-card${twoLine ? ' status-card-two-line' : inlineReason ? ' status-card-reason-inline' : ''}${isFocused ? ' todo-pinned-card-active' : ''}${needsAction ? ' todo-pinned-card-needs-action' : ''}${handlers.openSessionTaskIds?.has(task.id) ? ' todo-pinned-card-session-open' : ''}${isDone ? ' todo-pinned-card-done' : ''}${vanishing ? ' todo-card-vanishing' : ''}`}
      onClick={(e) => {
        if (edit.isEditing) return;
        if ((e.target as HTMLElement).closest('.pinned-phase-picker')) return;
        handlers.onClick(task, e);
      }}
      role="button"
      // Named by its task alone: from its contents the name would also carry its buttons'
      // ("Mark complete … More actions"), the same as the menu button inside it.
      aria-label={task.title}
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !edit.isEditing) { e.preventDefault(); handlers.onClick(task); } }}
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
        // Under Waiting / snoozed the unread dot is quiet: nothing there asks the user to act.
        <span className={`task-unread-dot${sectionKey === 'waiting' ? ' task-unread-dot-quiet' : ''}`} role="img" aria-label="Unread: agent output you haven't seen" title="Unread: click to open and mark read" />
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
        aria-label={isDone ? 'Reopen' : 'Mark complete'}
        title={isDone ? 'Done: click to reopen' : snoozeDate ? 'Snoozed: click to complete'
          : sectionKey === 'waiting' ? 'Waiting: click to complete' : 'Click to complete'}
        data-row-mark={isDone ? 'done' : sectionKey === 'waiting' ? (snoozeDate ? 'snoozed' : 'waiting') : need ? (taskUserState(task) === 'read' ? 'needs-read' : `needs-${need.category}`) : 'open'}
      >
        {ICONS.sectionRowIcon(sectionKey, isDone, task.phase, !!snoozeDate, taskUserState(task))}
      </button>
      {twoLine ? (
        // Flat: a small line with the project, its tags and the time, then the title alone,
        // then (a Waiting row) what it waits on.
        <span className="status-card-body">
          <span className="status-card-meta">
            <RowProjectName project={task.project || ''} className="status-card-project" onFilter={handlers.onFilterProject} />
            {pills}
            {reasonBelow ? null : reason}
            {wake}
            <span className="status-card-meta-fill" />
            {/* A Waiting row's time is when it wakes, as in the one-line rows. */}
            {wake ? null : agoEl}
          </span>
          {title}
          {reasonBelow ? reason : null}
        </span>
      ) : (
        // One line (a project's folds): with a wake time beside it, the sentence of what it waits
        // on would be squeezed to a sliver, so it moves into that time's tooltip.
        <>
          {title}
          {pills}
          {inlineReason}
          {wake ?? agoEl}
        </>
      )}
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

/**
 * One section's rows, then a "Show more" row. Flat (the panel's sections) draws each
 * row in two lines, its project on the small top line; a project's own fold (By
 * project) draws one-line rows, since the project heading above names it already.
 */
export function SectionRows({ sectionKey, tasks, total, handlers, archiveLeft, inProject = false }: {
  sectionKey: StatusSectionKey;
  tasks: readonly Task[];
  /** The section's full count (Completed includes tasks not loaded yet). */
  total: number;
  handlers: SectionRowHandlers;
  /** Completed only: older tasks not loaded and not counted (a chip narrows the view). */
  archiveLeft?: boolean;
  /** The rows sit under their project's heading (a By project fold). */
  inProject?: boolean;
}) {
  const [asked, setAsked] = useState(false);
  const [shown, setShown] = useState(STATUS_SECTION_BATCH);
  // A located (focused) row past the batch grows the batch to it, so Locate can scroll
  // there; the rows stay when the focus moves on (set during render: React redraws at once).
  const focusAt = handlers.focusedTaskId ? tasks.findIndex((t) => t.id === handlers.focusedTaskId) : -1;
  if (focusAt >= shown) setShown(Math.ceil((focusAt + 1) / STATUS_SECTION_BATCH) * STATUS_SECTION_BATCH);
  const head = tasks.slice(0, shown);
  const more = Math.max(0, total - head.length);
  // Every loaded row is out: the rest is the archive, fetched only now (not on open).
  const unloaded = head.length >= tasks.length;
  return (
    <div className="todo-pinned-list status-section-list" data-testid={`status-section-${sectionKey}-rows`}>
      {head.map((task) => <SectionCard key={task.id} task={task} sectionKey={sectionKey} handlers={handlers} twoLine={!inProject && !!handlers.twoLine} />)}
      {more > 0 && (
        <button
          type="button"
          className="status-section-more"
          data-testid={`status-section-${sectionKey}-more`}
          disabled={unloaded && !handlers.onLoadMore}
          onClick={() => { if (unloaded) handlers.onLoadMore?.(); setShown(shown + STATUS_SECTION_BATCH); }}
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
    default: return { tasks: model.working, count: model.workingCount };
  }
}

/**
 * Approvals a script waits on (`walnut approve`) are drawn first in Needs you: they need the
 * person as much as any task there. 'with-needs': the section the panel already draws; 'alone':
 * the panel does not draw Needs you (By project keeps those tasks in its list), so a Needs you
 * section holding only the approvals joins the run while one waits. The approvals show even
 * when the person folded Needs you (its tasks stay folded): each one blocks a script, for minutes.
 */
export type NeedsApprovals = 'with-needs' | 'alone';

/** A run of sections the panel draws itself; an empty one draws nothing. */
export function StatusSectionGroup({ keys, model, open, onToggle, handlers, approvals }: {
  keys: readonly StatusSectionKey[];
  model: StatusSectionsModel;
  open: Record<StatusSectionKey, boolean>;
  onToggle: (key: StatusSectionKey) => void;
  handlers: SectionRowHandlers;
  approvals?: NeedsApprovals;
}) {
  const pending = usePendingApprovals();
  const waiting = approvals ? pending : [];
  const alone = approvals === 'alone' && !keys.includes('needs');
  const shownKeys: readonly StatusSectionKey[] = alone && waiting.length > 0
    ? (keys[0] === 'watching' ? ['watching', 'needs', ...keys.slice(1)] : ['needs', ...keys])
    : keys;
  return (
    <>
      {shownKeys.map((key) => {
        const rows = sectionRowsOf(model, key);
        const extra = key === 'needs' && waiting.length > 0;
        const tasks = extra && alone ? [] : rows.tasks;
        const taskCount = extra && alone ? 0 : rows.count;
        const count = taskCount + (extra ? waiting.length : 0);
        // Every section has its heading, Needs you included (2026-10-31: its rows ran on
        // under Watching's heading and read as Watching's).
        // Completed with older tasks still unloaded stays reachable, even at 0 loaded.
        const archiveLeft = key === 'done' && model.archiveLeft;
        if (count === 0 && !archiveLeft) return null;
        return (
          <section key={key} className={`status-section status-section-block-${key}`} aria-label={STATUS_SECTION_LABELS[key]} {...{ [FOLD_KEY_ATTR]: key }}>
            <StatusSectionHeading sectionKey={key} count={count} open={open[key]} onToggle={onToggle} more={archiveLeft} />
            {/* A folded Needs you still shows its approvals: a script is blocked on each, for minutes. */}
            {extra && <ApprovalRows list={waiting} variant="home" />}
            {open[key] && (taskCount > 0 || archiveLeft) && <SectionRows sectionKey={key} tasks={tasks} total={taskCount} handlers={handlers} archiveLeft={archiveLeft} />}
          </section>
        );
      })}
    </>
  );
}
