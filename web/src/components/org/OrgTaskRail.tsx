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
 *            each folds on its heading, kept per node (what waits and what is done start folded)
 *   Needs you  one row per ask, and per result or answer to look at (To read is no tab of its own,
 *              2026-11-03): what to do with it (Decide, Take a look, Review, Can close) and its summary
 *              first, its task and when it was checked, More for the detail, and the answer right
 *              in the row (OrgInlineAnswer); Quote and Snooze small
 *   others   one row per task: its own line (user_status.line, "set by <VP>" when its lead changed it);
 *            Watching's rows wear their own state's dot, and each row's eye watches it or stops (Home's eye)
 *   Brief    the letter its lead or Main keeps (OrgBrief)
 *   Threads  the user's own requests to it, one per subject (OrgThreads)
 *
 * A row in Needs you always says what it asks (askSummary is never empty); a node is never a bare
 * row of its own (the user: "u need to show what are actually waiting"). The node's own ask is a row
 * too, the first, named for the node: every Needs you count has its rows (2026-10-31). Each row says
 * when its ask was checked, or Not verified, on a line of its own (cardChecked), and any action that
 * takes a row off (an answer, a snooze) takes it off on the click. No title tooltips: they drew over
 * the row's own menus.
 */
import '@/styles/org-rail.css';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import { timeAgo } from '@/utils/time';
import { useFullscreen, useSheetPlace } from '@/hooks/useFullscreen';
import { OrgBrief } from './OrgBrief';
import { OrgThreads } from './OrgThreads';
import type { OrgThreadsState } from './useOrgThreads';
import { OrgInlineAnswer, type AnswerFailure, type AnswerSettle } from './OrgInlineAnswer';
import { OrgAlertSnooze } from './OrgAlertSnooze';
import { usePointerHold } from './hold-order';
import { writeBriefFolded, type OrgTopView } from './org-brief-model';
import type { BriefFreshness } from '@open-walnut/brief-fresh';
import { WithdrawAnswerButton } from '@/components/tasks/AnsweredForLine';
import { ORG_RAIL_TAB_LABELS, TAB_DOT, allTasksSections, sectionOpen, stateTab, taskTabNote, taskTabNoteField, type OrgRailTab, type OrgTaskTab, type OrgTaskTabs } from './org-task-tabs';
import { useWatchToggle } from '@/components/tasks/WatchToggle';
import * as ICONS from '@/components/common/Icons';
import { snoozeTakesOff } from '@open-walnut/user-status';
import { askSummary, lineSetBy, readStatusLine } from './org-ask-form';
import { alertCategoryLabel, cardChecked, type ChannelRow, type OrgAlertView } from './org-channels-model';
import { taskPath } from '@/utils/task-path';
import type { Approval } from '@/api/approvals';
import { ApprovalRows } from '@/components/approvals/ApprovalRow';
import type { ImageAttachment } from '@/api/chat';
import { completeTask } from '@/api/tasks';
import { AgentText } from '@/components/common/AgentText';
import { taskTextSource } from '@/utils/agent-text-source';

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
    <div className="org-task-modes" role="group" aria-label="Show the tasks by" data-testid="org-task-modes">
      {modes.map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} className={mode === m ? 'is-on' : ''} data-testid={`org-task-mode-${m}`} onClick={() => onPick(m)}>
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

const ICON_EXPAND = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);
const ICON_COLLAPSE = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
  </svg>
);

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

/** A section other than Needs you: one row per task, its own line, when it last moved, its eye. On
 *  Watching each row wears the dot and the line of its own state. */
function TaskTabList({ tasks, tab, onOpen, now }: { tasks: readonly Task[]; tab: Exclude<OrgRailTab, 'needs'>; onOpen: (id: string) => void; now: number }) {
  return (
    <ul className="org-task-list" data-testid="org-task-list" data-tab={tab}>
      {tasks.map((t) => {
        const own: OrgTaskTab = tab === 'watching' ? stateTab(t) : tab;
        const note = taskTabNote(t, own);
        const noteField = taskTabNoteField(t, own);
        const setBy = own === 'done' ? null : lineSetBy(readStatusLine(t.user_status));
        const at = own === 'done' ? t.completed_at ?? t.updated_at : t.updated_at;
        return (
          <li key={t.id} className="org-task-item">
            <div role="button" tabIndex={0} className="org-task-row" data-testid="org-task-row" data-task-id={t.id} data-state={own} onClick={() => onOpen(t.id)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(t.id); } }} title={note ? `${t.title}\n${note}` : t.title}>
              {own === 'notstarted'
                ? <span className="org-task-ring" aria-hidden="true">{ICONS.ICON_NOT_STARTED}</span>
                : <i style={{ background: TAB_DOT[own] }} aria-hidden="true" />}
              <span className="org-task-text">
                <span className="org-task-title">{orgDisplayTitle(t)}</span>
                {note && <AgentText compact inline {...(noteField ? taskTextSource(t, noteField) : { unknownSource: true })} text={note} className="org-task-note" testId="org-task-note" />}
              </span>
              <span className="org-task-side">
                {at && <span className="org-task-time">{timeAgo(at, { now })}</span>}
                {setBy && <span className="org-set-by" data-testid="org-set-by">{setBy}</span>}
              </span>
            </div>
            <OrgWatchToggle task={t} />
            {own === 'waiting' && t.user_status?.answeredFor && t.phase !== 'COMPLETE' && <WithdrawAnswerButton taskId={t.id} compact />}
          </li>
        );
      })}
    </ul>
  );
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
  const { summary, more } = askSummary(a);
  // The ask's words: their recorded writer (a letter's or a choice's is not on the task: unknown).
  const askSource = taskTextSource(task, 'needs');
  const checked = cardChecked(a);
  const category = alertCategoryLabel(a);
  const [open, setOpen] = useState(false);
  const failure = answers.failed.get(a.taskId);
  // A failure belongs to the ask it answered: a new ask of the task drops it.
  const askKey = `${a.kind}|${a.source ?? ''}|${a.ask ?? ''}|${a.form?.summary ?? ''}`;
  const [failedFor, setFailedFor] = useState(failure ? askKey : '');
  useEffect(() => {
    if (!failure) return;
    if (!failedFor) { setFailedFor(askKey); return; }
    if (failedFor !== askKey) { setFailedFor(''); answers.seen(a.taskId); }
  }, [failure, failedFor, askKey, answers, a.taskId]);
  return (
    <div className={`org-alert org-ask${own ? ' is-own' : ''}`} data-testid="org-alert" data-task-id={a.taskId} data-kind={a.kind} {...(own ? { 'data-own': '1' } : {})} {...(a.source ? { 'data-source': a.source } : {})}>
      {own && <div className="org-ask-own" data-testid="org-ask-own">{own} asks you</div>}
      {a.via && (
        // The top-level task itself, opened as a task: the subtask's letter or Board choice is not its.
        <div className="org-ask-via-line">
          <a
            className="org-ask-via"
            data-testid="org-ask-via"
            href={taskPath(a.via.id)}
            aria-label={`Part of ${a.via.title}`}
            onClick={(e) => { e.preventDefault(); onOpen({ ...a, taskId: a.via!.id, title: a.via!.title, source: undefined }); }}
          >{a.via.title} ›</a>
        </div>
      )}
      {/* One line: what to do with it, then what it asks or has to read (2026-11-03, the user: "in one line"). */}
      <div className="org-ask-summary" {...(a.category ? { 'data-category': a.category } : {})}>
        {category && <><span className={`org-ask-category org-ask-category-${a.category}`} data-testid="org-ask-category">{category}:</span>{' '}</>}
        <AgentText compact inline {...askSource} text={summary} testId="org-ask-summary" />
      </div>
      {checked && <div className={`org-alert-checked${checked.unverified ? ' is-unverified' : ''}`} data-testid="org-alert-checked" data-unverified={checked.unverified ? '1' : '0'}>{checked.text}</div>}
      <div className="org-ask-meta">
        <a
          className="org-alert-link"
          data-testid="org-alert-link"
          href={taskPath(a.taskId)}
          aria-label={`Open ${a.title}`}
          onClick={(e) => { e.preventDefault(); onOpen(a); }}
        >{a.title}</a>
        {vp && <span className="org-ask-vp" data-testid="org-ask-vp">{vp}</span>}
        <span className="org-ask-tools">
          {more && (
            <button type="button" className="org-ask-tool" data-testid="org-ask-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Less' : 'More'}</button>
          )}
          <button
            type="button"
            className="org-ask-tool"
            data-testid="org-alert-quote"
            disabled={!canQuote}
            aria-label={canQuote ? 'Quote it in this chat, to talk it over here' : 'Start a chat here first'}
            onClick={() => onQuote(a)}
          >Quote</button>
          {/* Only where a snooze takes the ask off the user (never a live prompt, never Main's own). */}
          {snoozeTakesOff({ state: 'needs', source: a.kind === 'question' || a.kind === 'permission' ? 'prompt' : a.source }, task?.org_role === 'main') && (
            <OrgAlertSnooze alert={a} current={task?.start_date ?? undefined} onStart={() => answers.start(a.taskId)} />
          )}
          {task && <OrgWatchToggle task={task} className="org-ask-tool" />}
          {/* Done and asking nothing: close it from the card (2026-11-03, the user: "see if can closed"). */}
          {a.category === 'close' && (
            <button
              type="button"
              className="org-ask-tool org-ask-close"
              data-testid="org-ask-close"
              onClick={() => {
                const settle = answers.start(a.taskId);
                completeTask(a.taskId).then(() => settle(), (err: unknown) => settle({ of: 'answer', message: `Could not close it: ${err instanceof Error ? err.message : String(err)}` }));
              }}
            >Close</button>
          )}
        </span>
      </div>
      {open && more && <AgentText compact {...askSource} text={more} className="org-ask-more" testId="org-ask-more" />}
      {/* A refused snooze says so on the row, whatever the answer form is (a task with no session has none). */}
      {failure?.of === 'snooze' && <div className="org-answer-error" role="alert" data-testid="org-answer-error">{failure.message}</div>}
      <OrgInlineAnswer alert={a} task={task} summary={summary} onAnswer={answers.start} {...(failure && failure.of !== 'snooze' ? { failure } : {})} />
    </div>
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
  return (
    <div className="org-alerts" data-testid="org-alerts" role="region" aria-label="Needs you"
      onPointerEnter={hold.onPointerEnter} onPointerLeave={hold.onPointerLeave}>
      {shown.map((a) => (
        <AskRow key={a.taskId} a={a} task={byId.get(a.taskId)} vp={a.taskId === ownId ? undefined : vpOf(a.taskId)} own={a.taskId === ownId ? ownName : undefined} onOpen={onOpen} onQuote={onQuote} canQuote={canQuote} answers={answers} />
      ))}
    </div>
  );
}

/** Every task of the node's work in one list, a section per state (allTasksSections). */
function AllTasks({ tabs, alerts, approvals, flipped, onFlip, focus, onFocused, renderAsks, onOpenTask, now }: {
  tabs: OrgTaskTabs;
  alerts: readonly OrgAlertView[];
  approvals: readonly Approval[];
  flipped: readonly string[];
  onFlip: (tab: OrgRailTab) => void;
  focus: { tab: OrgRailTab; n: number } | null;
  onFocused: () => void;
  renderAsks: () => ReactNode;
  onOpenTask: (id: string) => void;
  now: number;
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
      {sections.length === 0 && <p className="org-task-empty" data-testid="org-task-empty">Nothing open here.</p>}
      {sections.map((sec) => {
        const open = sectionOpen(sec.tab, flipped);
        const count = sec.tasks.length + sec.alerts.length + (sec.tab === 'needs' ? approvals.length : 0);
        return (
          <section key={sec.tab} className="org-task-section" data-testid="org-task-section" data-tab={sec.tab} data-open={open ? '1' : '0'}>
            <SectionHead tab={sec.tab} count={count} open={open} onFlip={() => onFlip(sec.tab)} />
            {open && (sec.tab === 'needs' ? (<>
              <ApprovalRows list={approvals} variant="org" />
              {sec.alerts.length > 0 && renderAsks()}
            </>) : (
              <TaskTabList tasks={sec.tasks} tab={sec.tab} onOpen={onOpenTask} now={now} />
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

export function OrgTaskRail({ row, rows, tasks, tabs, alerts, approvals, flipped, onFlip, focus, onFocused, view, onView, keepsBrief, briefNew, threadsNew, threadsCount, onClose, mode, onMode, renderBoard, briefFolded, onBriefFolded, briefFresh, briefUpdating, threads, onThreadFollowUp, contact, title, onOpenAlert, onQuote, canQuote, answers, onOpenTask, now, placement, width }: {
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
  onOpenTask: (id: string) => void;
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
  const brief = keepsBrief ? contact?.brief : undefined;
  // A Board picked on a node that keeps none (any more) shows all its tasks.
  const shownMode: OrgTaskMode = mode === 'board' && !renderBoard ? 'all' : mode;
  // Full screen is the same pop-up sheet a session panel opens into, and the same one state of the
  // tab (2026-11-02, the user: "that thread ... all full screens are that pop-up window"; it was a
  // widen beside the chat before): entering it here leaves a session's, a reload keeps it.
  const sheetAt = useSheetPlace('org-rail', row.key);
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen({ keepAcrossRoutes: true, place: sheetAt });
  return (<>
    {FullscreenBackdrop}
    <aside className={`org-rail is-${placement}${isFullscreen ? ' is-wide' : ''}${fullscreenClass}`} data-testid="org-rail" data-placement={placement} {...(isFullscreen ? { 'data-fullscreen': '1' } : {})} {...(width && !isFullscreen ? { style: { width } } : {})}>
      <div className="org-top has-switch" data-testid="org-top" data-view={view}>
        {/* Threads first (2026-11-04, the user: "this thread shoudl also be the first"), then Tasks and Brief. */}
        <div className="org-top-tabs" role="group" aria-label={keepsBrief ? 'Threads, Tasks or Brief' : 'Tasks'}>
          {keepsBrief && (
            <button type="button" aria-pressed={view === 'threads'} className={`org-top-tab${view === 'threads' ? ' is-on' : ''}`} data-testid="org-top-threads" onClick={() => onView('threads')}>
              Threads{threadsCount > 0 && <span className="org-top-count">{threadsCount}</span>}
              {threadsNew && <i className="org-top-new" data-testid="org-top-threads-new"><span className="org-sr-only">, news since you looked</span></i>}
            </button>
          )}
          <button type="button" aria-pressed={view === 'task'} className={`org-top-tab${view === 'task' ? ' is-on' : ''}`} data-testid="org-top-task" onClick={() => onView('task')}>
            Tasks<span className="org-top-count">{row.counts.open}</span>
          </button>
          {keepsBrief && (<>
            <button type="button" aria-pressed={view === 'brief'} className={`org-top-tab${view === 'brief' ? ' is-on' : ''}`} data-testid="org-top-brief" onClick={() => onView('brief')}>
              Brief{briefNew && <i className="org-top-new" data-testid="org-top-brief-new"><span className="org-sr-only">, rewritten since you read it</span></i>}
            </button>
          </>)}
        </div>
        {/* Its refresh turn is on its way (core/sessions/brief-refresh.ts): the chat and the Brief are being brought up to date. */}
        {view === 'task' && briefUpdating && <span className="org-top-updating" data-testid="org-top-updating">Updating…</span>}
        {view === 'brief' && brief?.text && (
          <button type="button" className="org-top-fold" data-testid="org-brief-fold" aria-expanded={!briefFolded} onClick={() => { onBriefFolded(!briefFolded); writeBriefFolded(!briefFolded); }}>
            {briefFolded ? 'Show all' : 'Fold'}
          </button>
        )}
        <span className="org-top-acts">
          <button type="button" className="org-rail-icon" data-testid="org-rail-fullscreen" aria-pressed={isFullscreen}
            aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'} title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            onClick={isFullscreen ? exitFullscreen : enterFullscreen}>{isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}</button>
          <button type="button" className="org-rail-close" data-testid="org-rail-close" aria-label="Close this panel" title="Close this panel" onClick={() => { exitFullscreen(); onClose(); }}>
            <span aria-hidden="true">×</span>
          </button>
        </span>
      </div>
      {view === 'brief' ? (
        <div className="org-rail-body">
          <OrgBrief owner={contact} tasks={tasks} name={title} onOpenTask={onOpenTask} now={now} folded={briefFolded} fresh={briefFresh} updating={briefUpdating} />
        </div>
      ) : view === 'threads' ? (
        <div className="org-rail-body">
          <OrgThreads name={title} owner={contact} state={threads} tasks={tasks} onOpenTask={onOpenTask} onFollowUp={onThreadFollowUp} now={now} />
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
              onOpenTask={onOpenTask} now={now}
            />
          )}
        </div>
      )}
    </aside>
  </>);
}
