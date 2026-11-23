/**
 * The Org node's Task rail (2026-10-31, the user picked design 10 of ten: "10, but kind of make the
 * space more effective used, and also make the answer layout if there are space so user can just
 * click ... show the summay of the issue veyr clear, with potentially a more secino"). Beside the
 * chat on a wide page, so the chat keeps its full height; above it on a narrow one.
 *
 *   head     Tasks | Brief | Threads (a lead or Main keeps a Brief and Threads), each with its count or
 *            news dot; Fold on the Brief; widen (beside the chat) and close (2026-11-02, the user picked
 *            design 1 of the side-bar round: "1")
 *   Tasks    All tasks | Board: every task of the node's work in one list (below), or the Board its
 *            lead keeps (when it keeps one). 2026-11-12, the user: "under tasks, just show all taks, and
 *            then board"; the Status and Team views it replaces drew the same work twice.
 *   sections Watching (the tasks the user watches, Home's own list, of this node's work), then the home
 *            panel's names with counts: Needs you, Working, Waiting / snoozed, Not started, Completed;
 *            each folds on its heading, kept per node (only Needs you and Watching start open)
 *   Needs you  one row per ask, and per result or answer to look at (To read is no tab of its own,
 *              2026-11-03): what to do with it (Decide, Take a look, Review, Can close) and its summary
 *              first, its task and when it was checked, More for the detail, and the answer right
 *              in the row (OrgInlineAnswer); Quote and Snooze small
 *   others   one row per task, its state's circle and its name (no line under it, no time,
 *            2026-11-23); Watching's rows wear their own state's circle, and each row's eye
 *            watches it or stops (Home's eye)
 *   Brief    the letter its lead or Main keeps (OrgBrief)
 *   Threads  the user's own requests to it, one per subject (OrgThreads)
 *
 * A row in Needs you always says what it asks (askSummary is never empty); a node is never a bare
 * row of its own (the user: "u need to show what are actually waiting"). The node's own ask is a row
 * too, the first, named for the node: every Needs you count has its rows (2026-10-31). Each row is
 * the one ask card (AskCard.tsx): its task, what it asks, a line of why, the box to type in and its
 * buttons; no category word and no "Checked ..." line (2026-11-20, the user: "this is too
 * complcaited, just thread"). Any action that takes a row off (an answer, a snooze) takes it off on
 * the click. No title tooltips: they drew over the row's own menus.
 */
import '@/styles/org-rail.css';
import '@/styles/notice-card.css';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { useTasksContext } from '@/contexts/TasksContext';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { useFullscreen, useSheetPlace } from '@/hooks/useFullscreen';
import { OrgBrief } from './OrgBrief';
import { OrgThreads } from './OrgThreads';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgInlineAnswer, type AnswerFailure, type AnswerSettle } from './OrgInlineAnswer';
import { OrgAlertSnooze } from './OrgAlertSnooze';
import { usePointerHold } from './hold-order';
import { isBoolean, usePageView } from '@/utils/view-memory';
import { writeBriefFolded, type OrgTopView } from './org-brief-model';
import type { BriefFreshness } from '@open-walnut/brief-fresh';
import { WithdrawAnswerButton } from '@/components/tasks/AnsweredForLine';
import { ORG_RAIL_TAB_LABELS, TAB_DOT, allTasksSections, sectionCount, sectionOpen, stateTab, type OrgRailTab, type OrgTaskTab, type OrgTaskTabs } from './org-task-tabs';
import { useTaskCircle } from '@/hooks/useSessionStatus';
import { taskUserState } from '@/utils/session-status';
import { useWatchToggle } from '@/components/tasks/WatchToggle';
import * as ICONS from '@/components/common/Icons';
import { snoozeTakesOff } from '@open-walnut/user-status';
import { askSummary } from './org-ask-form';
import { isAsk, type ChannelRow, type OrgAlertView } from './org-channels-model';
import { taskPath } from '@/utils/task-path';
import type { Approval } from '@/api/approvals';
import { ApprovalRows } from '@/components/approvals/ApprovalRow';
import { AskCardFrame } from '@/components/actions/AskCard';
import type { ImageAttachment } from '@/api/chat';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';
import { useOpenTask } from '@/hooks/useOpenTask';
import { threadCountLabel } from '@open-walnut/thread-view';
import { DisclosureButton, Tab, TabList, SegmentedControl, DisclosureChevron } from '@/components/controls';
import { EmptyState } from '@/components/common/EmptyState';

/** What the rows need from the page to answer in place. */
export interface OrgAnswers {
  /** An answer leaves now: the page counts it answered (the row goes), and the settle says how it went. */
  start: (taskId: string) => AnswerSettle;
  /** The last try that failed, by task: its row is back with the reason. */
  failed: ReadonlyMap<string, AnswerFailure>;
  /** The user saw the failure. */
  seen: (taskId: string) => void;
}

export { TAB_DOT };

/** How the Tasks view draws the node's work: every task in one list, or as its lead's Board. A
 *  'status' or 'team' an older build kept is no mode now, so that node opens on All tasks (and an
 *  older build reading 'all' opens on its own default, Status). */
export const ORG_TASK_MODES = ['all', 'board'] as const;
export type OrgTaskMode = typeof ORG_TASK_MODES[number];
const MODE_LABELS: Record<OrgTaskMode, string> = { all: 'All tasks', board: 'Board' };

function ModeSwitch({ mode, modes, onPick }: { mode: OrgTaskMode; modes: readonly OrgTaskMode[]; onPick: (m: OrgTaskMode) => void }) {
  return (
    <SegmentedControl
      className="org-task-modes"
      data-testid="org-task-modes"
      aria-label="Show the tasks by"
      value={mode}
      onChange={onPick}
      options={modes.map((m) => ({ value: m, label: MODE_LABELS[m], testId: `org-task-mode-${m}` }))}
    />
  );
}

/** A section's heading: its dot, name and count; a click folds it or opens it. */
function SectionHead({ tab, count, open, onFlip }: { tab: OrgRailTab; count: number; open: boolean; onFlip: () => void }) {
  return (
    <button type="button" className="org-task-section-head" data-testid="org-task-section-head" data-tab={tab} aria-expanded={open} onClick={onFlip}>
      {tab === 'watching' ? <span className="org-task-section-icon" aria-hidden="true">{ICONS.ICON_EYE}</span>
        : tab === 'notstarted' ? <span className="org-task-section-icon" aria-hidden="true">{ICONS.ICON_NOT_STARTED}</span>
        : <i style={{ background: TAB_DOT[tab] }} />}
      {ORG_RAIL_TAB_LABELS[tab]}<span className="org-task-section-count">{count}</span>
    </button>
  );
}

/** The eye on a row: Home's Watch (WatchToggle), lit while the task is watched; a click watches it
 *  or stops, on Home and on every Org node at once. */
export function OrgWatchToggle({ task, className = '' }: { task: Task; className?: string }) {
  const { watched, toggle } = useWatchToggle(task);
  return (
    <button
      type="button"
      className={`org-watch-toggle${watched ? ' is-on' : ''}${className ? ` ${className}` : ''}`}
      data-testid="org-watch-toggle"
      data-task-id={task.id}
      aria-pressed={watched}
      aria-label={watched ? `Stop watching ${task.title}` : `Watch ${task.title}`}
      onClick={(e) => { e.stopPropagation(); toggle(); }}
    >{ICONS.ICON_EYE}</button>
  );
}

/** A section other than Needs you: one row per task, drawn as a Home task row reads (2026-11-23, the
 *  user: "显示名字 ... 和这个正常的这个啊 task 都要 align ... 就显示一个名字"): the circle Home's row
 *  wears for its state, the name and its eye. No line under the name, no time (2026-11-23, the
 *  user: "remve the time also"), no avatar, no hover card. On Watching each row wears the circle of its own state. */
function TaskTabList({ tasks, tab }: { tasks: readonly Task[]; tab: Exclude<OrgRailTab, 'needs'> }) {
  // A row is a task reference: it opens where the rail is (useOpenTask: beside the page on Org).
  const onOpen = useOpenTask();
  return (
    <ul className="org-task-list" data-testid="org-task-list" data-tab={tab}>
      {tasks.map((t) => <TaskTabRow key={t.id} task={t} own={tab === 'watching' ? stateTab(t) : tab} onOpen={onOpen} />)}
    </ul>
  );
}

const TaskTabRow = memo(function TaskTabRow({ task: t, own, onOpen }: { task: Task; own: OrgTaskTab; onOpen: (id: string) => void }) {
  // Home's circle and its colour (grey plain, blue with a session, green done): the same shape a
  // Home row of that section wears (sectionRowIcon), a span here since the row is the button.
  const circle = useTaskCircle(t);
  const isDone = own === 'done';
  const snoozed = !!t.user_status?.snoozed;
  const state = taskUserState(t);
  return (
    <li className="org-task-item">
      <div role="button" tabIndex={0} className="org-task-row" data-testid="org-task-row" data-peek-row="" data-task-id={t.id} data-state={own} aria-label={orgDisplayTitle(t)} onClick={() => onOpen(t.id)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(t.id); } }}>
        <span className={`task-phase-icon-btn org-task-circle ${circle}`} data-row-mark={rowMark(own, snoozed, state)} aria-hidden="true">
          {ICONS.sectionRowIcon(own, isDone, t.phase, snoozed, state)}
        </span>
        <span className={`org-task-title wn-title${isDone ? ' is-done' : ''}`}>{orgDisplayTitle(t)}</span>
      </div>
      <OrgWatchToggle task={t} />
      {own === 'waiting' && t.user_status?.answeredFor && t.phase !== 'COMPLETE' && <WithdrawAnswerButton taskId={t.id} compact />}
    </li>
  );
});

/** The circle's mark, in the words a Home row uses (StatusSections.tsx data-row-mark), so it takes
 *  the same tone: what waits, sleeps or never started is muted, a result to read is the accent. */
function rowMark(own: OrgTaskTab, snoozed: boolean, state: string | undefined): string {
  if (own === 'done') return 'done';
  if (own === 'waiting') return snoozed ? 'snoozed' : 'waiting';
  if (own === 'notstarted') return 'not-started';
  if (own === 'needs') return state === 'read' ? 'needs-read' : 'needs';
  return 'open';
}

function AskRow({ a, task, vp, own, onOpen, onQuote, canQuote, answers }: {
  a: OrgAlertView;
  task: Task | undefined;
  vp: string | undefined;
  /** The node's own ask: the row is named for the node. */
  own: string | undefined;
  onOpen: (a: OrgAlertView) => void;
  onQuote: (a: OrgAlertView) => void;
  canQuote: boolean;
  answers: OrgAnswers;
}) {
  const { complete } = useTasksContext();
  const { summary, more } = askSummary(a);
  // The ask's words: their recorded writer (a letter's or a choice's is not on the task: unknown).
  const askSource = taskTextSource(task, 'needs');
  const failure = answers.failed.get(a.taskId);
  // A failure belongs to the ask it answered: a new ask of the task drops it.
  const askKey = `${a.kind}|${a.source ?? ''}|${a.ask ?? ''}|${a.form?.summary ?? ''}`;
  const [failedFor, setFailedFor] = useState(failure ? askKey : '');
  useEffect(() => {
    if (!failure) return;
    if (!failedFor) { setFailedFor(askKey); return; }
    if (failedFor !== askKey) { setFailedFor(''); answers.seen(a.taskId); }
  }, [failure, failedFor, askKey, answers, a.taskId]);
  // The one ask card (AskCard.tsx): which task, what it asks, a line of why, the box to type in, its
  // buttons and the card's tools (2026-11-20, the user: "this is too complcaited, just thread").
  const link = (
    <a
      className="org-alert-link"
      data-testid="org-alert-link"
      href={taskPath(a.taskId)}
      aria-label={`Open ${a.title}`}
      onClick={(e) => { e.preventDefault(); onOpen(a); }}
    >{a.title}</a>
  );
  return (
    <AskCardFrame
      testId="org-alert"
      className={`org-alert org-ask${own ? ' is-own' : ''}`}
      data={{ 'data-task-id': a.taskId, 'data-kind': a.kind, 'data-own': own ? '1' : undefined, 'data-source': a.source, 'data-category': a.category, 'data-vp': vp }}
      title={<><span className="org-ask-mark" data-tone="error" aria-hidden="true"><span className="wn-dot" /></span>{a.via ? (<>
        {/* The top-level task itself, opened as a task: the subtask's letter or Board choice is not its. */}
        <a
          className="org-ask-via"
          data-testid="org-ask-via"
          href={taskPath(a.via.id)}
          aria-label={`Part of ${a.via.title}`}
          onClick={(e) => { e.preventDefault(); onOpen({ ...a, taskId: a.via!.id, title: a.via!.title, source: undefined }); }}
        >{a.via.title} ›</a>{' '}{link}
      </>) : own ? <>{link} <span className="org-ask-own" data-testid="org-ask-own">asks you</span></> : link}</>}
      question={<AgentText compact inline {...askSource} text={summary} shortLinks testId="org-ask-summary" />}
      detail={more ? <AgentText compact inline {...askSource} text={more} shortLinks testId="org-ask-more" /> : undefined}
      status={failure?.of === 'snooze' ? <div className="org-answer-error" role="alert" data-testid="org-answer-error">{failure.message}</div> : null}
      answer={<OrgInlineAnswer alert={a} task={task} summary={summary} onAnswer={answers.start} {...(failure && failure.of !== 'snooze' ? { failure } : {})} />}
      tools={<>
        <button
          type="button"
          className="btn btn-sm btn-ghost org-ask-tool"
          data-testid="org-alert-quote"
          disabled={!canQuote}
          aria-label={canQuote ? 'Quote it in this chat, to talk it over here' : 'Start a chat here first'}
          onClick={() => onQuote(a)}
        >Quote</button>
        {task && <OrgWatchToggle task={task} className="btn btn-sm btn-ghost org-ask-tool" />}
        {/* Done and asking nothing: close it from the card (2026-11-03, the user: "see if can closed"). */}
        {a.category === 'close' && (
          <button
            type="button"
            className="btn btn-sm btn-ghost org-ask-tool org-ask-close"
            data-testid="org-ask-close"
            onClick={() => {
              const settle = answers.start(a.taskId);
              // Through the store: Home, the board and every count see it closed on the click.
              void complete(a.taskId).then((ok) => settle(ok ? undefined : { of: 'answer', message: 'Could not close it: the server refused. Try again.' }));
            }}
          >Close</button>
        )}
        {/* Only where a snooze takes the ask off the user (never a live prompt, never Main's own). */}
        {snoozeTakesOff({ state: 'needs', source: a.kind === 'question' || a.kind === 'permission' ? 'prompt' : a.source }, task?.org_role === 'main') && (
          <OrgAlertSnooze alert={a} current={task?.start_date ?? undefined} onStart={() => answers.start(a.taskId)} />
        )}
      </>}
    />
  );
}

/** The asks, one row each. Under the pointer the rows keep their order and a new ask joins at the
 *  end, so a click lands on the row aimed at (as the VP list does). */
function AskList({ alerts, tasks, vpOf, ownId, ownName, onOpen, onQuote, canQuote, answers }: {
  ownId: string | undefined;
  ownName: string;
  alerts: readonly OrgAlertView[];
  tasks: readonly Task[];
  vpOf: (taskId: string) => string | undefined;
  onOpen: (a: OrgAlertView) => void;
  onQuote: (a: OrgAlertView) => void;
  canQuote: boolean;
  answers: OrgAnswers;
}) {
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const keyed = useMemo(() => alerts.map((a) => ({ key: a.taskId, a })), [alerts]);
  const hold = usePointerHold(keyed);
  const shown = hold.shown.map((x) => x.a);
  // The cards with only something to read ask nothing: one row counts them, a click lists them.
  const looks = shown.filter((a) => !isAsk(a));
  const [looksOpen, setLooksOpen] = usePageView('org', 'to-look-open', false, isBoolean);
  const row = (a: OrgAlertView) => (
    <AskRow key={a.taskId} a={a} task={byId.get(a.taskId)} vp={a.taskId === ownId ? undefined : vpOf(a.taskId)} own={a.taskId === ownId ? ownName : undefined} onOpen={onOpen} onQuote={onQuote} canQuote={canQuote} answers={answers} />
  );
  return (
    <div className="org-alerts" data-testid="org-alerts" role="region" aria-label="Needs you"
      onPointerEnter={hold.onPointerEnter} onPointerLeave={hold.onPointerLeave}>
      {shown.filter(isAsk).map(row)}
      {looks.length > 0 && (
        <button type="button" className="org-to-look" data-testid="org-to-look" aria-expanded={looksOpen} onClick={() => setLooksOpen(!looksOpen)}>
          <DisclosureChevron open={looksOpen} className="org-to-look-chev" />
          {looks.length} only to look at <span className="org-to-look-note">· nothing to decide</span>
        </button>
      )}
      {looksOpen && looks.map(row)}
    </div>
  );
}

/** Every task of the node's work in one list, a section per state (allTasksSections). */
function AllTasks({ tabs, alerts, approvals, flipped, onFlip, focus, onFocused, renderAsks }: {
  tabs: OrgTaskTabs;
  alerts: readonly OrgAlertView[];
  approvals: readonly Approval[];
  flipped: readonly string[];
  onFlip: (tab: OrgRailTab) => void;
  focus: { tab: OrgRailTab; n: number } | null;
  onFocused: () => void;
  renderAsks: () => ReactNode;
}) {
  const sections = useMemo(() => allTasksSections(tabs, alerts, approvals.length), [tabs, alerts, approvals.length]);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A count clicked in the header: its section comes to the top of the list (the page opened it).
  useEffect(() => {
    if (!focus) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-testid="org-task-section"][data-tab="${focus.tab}"]`);
    if (el && bodyRef.current) bodyRef.current.scrollTop += el.getBoundingClientRect().top - bodyRef.current.getBoundingClientRect().top;
    onFocused();
  }, [focus, onFocused]);
  return (
    <div ref={bodyRef} className="org-rail-body org-task-sections" data-testid="org-task-sections">
      {sections.length === 0 && <EmptyState size="section" title="Nothing open here" testId="org-task-empty" />}
      {sections.map((sec) => {
        const open = sectionOpen(sec.tab, flipped);
        // Needs you counts what asks the user, as the header does (sectionCount, headerPills).
        const count = sectionCount(sec, approvals.length);
        return (
          <section key={sec.tab} className="org-task-section" data-testid="org-task-section" data-tab={sec.tab} data-open={open ? '1' : '0'}>
            <SectionHead tab={sec.tab} count={count} open={open} onFlip={() => onFlip(sec.tab)} />
            {open && (sec.tab === 'needs' ? (<>
              <ApprovalRows list={approvals} variant="org" />
              {sec.alerts.length > 0 && renderAsks()}
            </>) : (
              <TaskTabList tasks={sec.tasks} tab={sec.tab} />
            ))}
          </section>
        );
      })}
      {/* The eye was explained by an empty Watching tab; with no Watching section it is said here. */}
      {sections.length > 0 && !sections.some((x) => x.tab === 'watching') && (
        <p className="org-task-empty org-task-watch-hint" data-testid="org-task-watch-hint">Watch a task with the eye on its row to keep it at the top, here and on Home.</p>
      )}
    </div>
  );
}

export function OrgTaskRail({ row, rows, tasks, tabs, alerts, approvals, flipped, onFlip, focus, onFocused, view, onView, keepsBrief, briefOff = false, briefNew, threadsNew, threadsCount, onClose, mode, onMode, renderBoard, briefFolded, onBriefFolded, briefFresh, briefUpdating, threads, onThreadFollowUp, contact, title, onOpenAlert, onQuote, canQuote, answers, now, placement, width }: {
  row: ChannelRow;
  rows: readonly ChannelRow[];
  tasks: readonly Task[];
  tabs: OrgTaskTabs;
  /** The asks, the node's own first. */
  alerts: readonly OrgAlertView[];
  /** Approvals a script waits on that this node lists (approvalsForNode): first in Needs you. */
  approvals: readonly Approval[];
  /** The sections the user folded or opened against their default, on this node. */
  flipped: readonly string[];
  onFlip: (tab: OrgRailTab) => void;
  /** A section to bring into view (a count in the node's header was clicked); n tells clicks apart. */
  focus: { tab: OrgRailTab; n: number } | null;
  /** The section was brought into view: the request is spent (a later mount does not jump to it). */
  onFocused: () => void;
  view: OrgTopView;
  onView: (view: OrgTopView) => void;
  keepsBrief: boolean;
  /** The Brief is off (experiment brief_off): no Brief tab, and Threads read grouped by state. */
  briefOff?: boolean;
  briefNew: boolean;
  /** A thread he would see has news since he last looked at Threads. */
  threadsNew: boolean;
  /** The threads his view shows (OrgThreads), for the tab's count. */
  threadsCount: number;
  /** How Tasks draws the work, and the Board it draws (null when the node keeps no Board). */
  mode: OrgTaskMode;
  onMode: (mode: OrgTaskMode) => void;
  renderBoard: (() => ReactNode) | null;
  /** Close this panel (the chat takes its room; the header brings it back). */
  onClose: () => void;
  briefFolded: boolean;
  onBriefFolded: (folded: boolean) => void;
  /** What moved since the Brief was written, and whether its refresh turn is on its way. */
  briefFresh: BriefFreshness | null;
  briefUpdating: boolean;
  /** The node's Threads (useOrgThreads), and a send filed under one of them (null: no chat yet). */
  threads: OrgThreadsState;
  onThreadFollowUp: ((threadId: string, text: string, images?: ImageAttachment[]) => Promise<boolean>) | null;
  contact: Task | undefined;
  title: string;
  onOpenAlert: (a: OrgAlertView) => void;
  onQuote: (a: OrgAlertView) => void;
  canQuote: boolean;
  answers: OrgAnswers;
  now: number;
  /** Beside the chat (a wide page), or above it. */
  placement: 'side' | 'top';
  /** The side rail's width (the user's, OrgNodeDetail); the CSS default otherwise. */
  width?: string;
}) {
  // On the CEO's rail each ask names the VP it is under (a VP is a label over its asks, never a row).
  const vpByTask = useMemo(() => {
    const m = new Map<string, string>();
    if (row.kind === 'main') for (const r of rows) for (const a of r.alerts) if (!m.has(a.taskId)) m.set(a.taskId, `${r.name} VP`);
    return m;
  }, [row.kind, rows]);
  const brief = keepsBrief && !briefOff ? contact?.brief : undefined;
  // A Board picked on a node that keeps none (any more) shows all its tasks.
  const shownMode: OrgTaskMode = mode === 'board' && !renderBoard ? 'all' : mode;
  // Brief picked on a node whose Brief is off shows the tasks: the Tasks tab reads picked (and so
  // keeps a tab in the Tab order), and a click on it writes Tasks back as the choice.
  const shownView: OrgTopView = view === 'brief' && briefOff ? 'task' : view;
  // Full screen is the same pop-up sheet a session panel opens into, and the same one state of the
  // tab (2026-11-02, the user: "that thread ... all full screens are that pop-up window"; it was a
  // widen beside the chat before): entering it here leaves a session's, a reload keeps it.
  const sheetAt = useSheetPlace('org-rail', row.key);
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen({ keepAcrossRoutes: true, place: sheetAt });
  return (<>
    {FullscreenBackdrop}
    <aside className={`org-rail is-${placement}${isFullscreen ? ' is-wide' : ''}${fullscreenClass}`} data-testid="org-rail" data-placement={placement} {...(isFullscreen ? { 'data-fullscreen': '1' } : {})} {...(width && !isFullscreen ? { style: { width } } : {})}>
      <div className="org-top has-switch" data-choice-exempt="the header row that holds the tabs, not a switch" data-testid="org-top" data-view={view}>
        {/* Threads first (2026-11-04, the user: "this thread shoudl also be the first"), then Tasks and Brief. */}
        <TabList flush className="org-top-tabs" aria-label={keepsBrief ? (briefOff ? 'Threads or Tasks' : 'Threads, Tasks or Brief') : 'Tasks'}>
          {keepsBrief && (
            <Tab selected={shownView === 'threads'} className="org-top-tab" data-testid="org-top-threads" onClick={() => onView('threads')}
              count={threadsCount > 0 ? <span className="org-top-count" title={`${threadCountLabel(threadsCount)} for you`}>{threadsCount}</span> : undefined}
              trailing={threadsNew ? <i className="org-top-new" data-testid="org-top-threads-new"><span className="org-sr-only">, news since you looked</span></i> : undefined}>
              Threads
            </Tab>
          )}
          <Tab selected={shownView === 'task'} className="org-top-tab" data-testid="org-top-task" onClick={() => onView('task')}
            count={<span className="org-top-count">{row.counts.open}</span>}>
            Tasks
          </Tab>
          {keepsBrief && !briefOff && (
            <Tab selected={shownView === 'brief'} className="org-top-tab" data-testid="org-top-brief" onClick={() => onView('brief')}
              trailing={briefNew ? <i className="org-top-new" data-testid="org-top-brief-new"><span className="org-sr-only">, rewritten since you read it</span></i> : undefined}>
              Brief
            </Tab>
          )}
        </TabList>
        {/* Its refresh turn is on its way (core/sessions/brief-refresh.ts): the chat and the Brief are being brought up to date. */}
        {view === 'task' && briefUpdating && <span className="org-top-updating" data-testid="org-top-updating">Updating…</span>}
        {view === 'brief' && brief?.text && (
          <DisclosureButton expanded={!briefFolded} className="org-top-fold" data-testid="org-brief-fold" onClick={() => { onBriefFolded(!briefFolded); writeBriefFolded(!briefFolded); }}>
            {briefFolded ? 'Show all' : 'Fold'}
          </DisclosureButton>
        )}
        <span className="org-top-acts">
          <button type="button" className="btn btn-icon btn-sm btn-ghost" data-testid="org-rail-fullscreen" aria-pressed={isFullscreen}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            onClick={isFullscreen ? exitFullscreen : enterFullscreen}>{isFullscreen ? ICONS.ICON_COLLAPSE : ICONS.ICON_EXPAND}</button>
          <button type="button" className="btn btn-icon btn-sm btn-ghost org-rail-close" data-testid="org-rail-close" aria-label="Close this panel" title="Close this panel" onClick={() => { exitFullscreen(); onClose(); }}>
            {ICONS.ICON_CLOSE}
          </button>
        </span>
      </div>
      {view === 'brief' && !briefOff ? (
        <div className="org-rail-body">
          <OrgBrief owner={contact} tasks={tasks} name={title} now={now} folded={briefFolded} fresh={briefFresh} updating={briefUpdating} />
        </div>
      ) : view === 'threads' ? (
        <div className="org-rail-body">
          <OrgThreads name={title} owner={contact} state={threads} tasks={tasks} onFollowUp={onThreadFollowUp} now={now} byState={briefOff} />
        </div>
      ) : (
        <div className="org-task-view" data-testid="org-task-view" data-mode={shownMode}>
          {/* A node with no Board has one way to draw its work: no switch. */}
          {renderBoard && <ModeSwitch mode={shownMode} modes={ORG_TASK_MODES} onPick={onMode} />}
          {shownMode === 'board' && renderBoard ? (
            <div className="org-rail-board" data-testid="org-rail-board">{renderBoard()}</div>
          ) : (
            <AllTasks
              tabs={tabs} alerts={alerts} approvals={approvals} flipped={flipped} onFlip={onFlip} focus={focus} onFocused={onFocused}
              renderAsks={() => <AskList alerts={alerts} tasks={tasks} vpOf={(id) => vpByTask.get(id)} ownId={contact?.id} ownName={title} onOpen={onOpenAlert} onQuote={onQuote} canQuote={canQuote} answers={answers} />}
            />
          )}
        </div>
      )}
    </aside>
  </>);
}
